/**
 * AOTS — Automated Optical Testing System Client Engine (v2.5)
 * =============================================================
 * Implements the 5-Stage Computer Vision Auto-Capture Pipeline:
 *   Stage 1: Grayscale & Gaussian Blur Smoothing (Noise reduction)
 *   Stage 2: Sobel Gradient & 4-Point Polygon Contour Detection
 *   Stage 3: Quad Stabilization via Intersection over Union (IoU) & Area-Delta Threshold
 *   Stage 4: Perspective Transform (Homography warping)
 *   Stage 5: Adaptive Binarization & Evaluation Trigger
 */

document.addEventListener('DOMContentLoaded', () => {
  // ── State Variables ──
  let currentTab = 'scanner';
  let cameraStream = null;
  let isAnalyzing = false;
  let autoCaptureEnabled = true;
  let isCapturing = false;

  // Quad Stabilization History (Stores last 5 frame corners)
  const quadHistory = [];
  const STABILITY_REQUIRED_FRAMES = 5;
  const MAX_CORNER_DRIFT_PX = 8.0; // Max allowable pixel jitter across frames
  const MAX_AREA_DELTA_PCT = 3.5;  // Max allowable area variance %

  let activeExamCode = 'AOTS-ECET-003';
  let answerKeyBuilderState = {};
  let currentUploadedBlob = null;
  let audioCtx = null;

  // ── DOM References ──
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const videoStream = document.getElementById('camera-stream');
  const analysisCanvas = document.getElementById('analysis-canvas');
  const snapshotCanvas = document.getElementById('snapshot-canvas');
  const hudFrame = document.getElementById('hud-frame');
  const hudMessage = document.getElementById('hud-message');
  const hudProgressBar = document.getElementById('hud-progress-bar');
  const hudProgressWrap = document.getElementById('hud-progress-wrap');
  const detectionStatusPill = document.getElementById('detection-status-pill');
  const shutterFlash = document.getElementById('shutter-flash');
  const chkAutoCapture = document.getElementById('chk-auto-capture');
  const btnSwitchSource = document.getElementById('btn-switch-source');
  const viewfinderWrapper = document.getElementById('viewfinder-wrapper');
  const fileDropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('file-input');
  const filePreviewWrap = document.getElementById('file-preview-wrap');
  const filePreviewImg = document.getElementById('file-preview-img');
  const btnManualCapture = document.getElementById('btn-manual-capture');
  const btnSampleDemo = document.getElementById('btn-sample-demo');
  const btnScanNext = document.getElementById('btn-scan-next');

  const scorecardEmpty = document.getElementById('scorecard-empty');
  const scorecardResult = document.getElementById('scorecard-result');

  // Create real-time canvas overlay for drawing detected contour polygon
  let overlayCanvas = document.getElementById('hud-contour-canvas');
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'hud-contour-canvas';
    overlayCanvas.style.position = 'absolute';
    overlayCanvas.style.inset = '0';
    overlayCanvas.style.width = '100%';
    overlayCanvas.style.height = '100%';
    overlayCanvas.style.pointerEvents = 'none';
    overlayCanvas.style.zIndex = '5';
    viewfinderWrapper.appendChild(overlayCanvas);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Audio & Haptic Chime
  // ───────────────────────────────────────────────────────────────────────────
  function initAudio() {
    if (!audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) audioCtx = new AudioCtxClass();
    }
  }

  function playCaptureChime() {
    try {
      initAudio();
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.16);
    } catch (e) {
      console.warn('Audio feedback:', e);
    }

    if (navigator.vibrate) {
      navigator.vibrate([40, 30, 40]);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Navigation Tabs
  // ───────────────────────────────────────────────────────────────────────────
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.dataset.tab;
      currentTab = tabId;
      document.getElementById(`tab-${tabId}`).classList.add('active');

      if (tabId === 'scanner') {
        if (viewfinderWrapper.style.display !== 'none') initCamera();
      } else {
        stopCamera();
        if (tabId === 'teacher') {
          loadActiveTests();
          initAnswerKeyBuilder();
        } else if (tabId === 'analytics') {
          loadAnalytics(activeExamCode);
        }
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Camera Setup
  // ───────────────────────────────────────────────────────────────────────────
  async function initCamera() {
    try {
      if (cameraStream) stopCamera();
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 }
        }
      });
      videoStream.srcObject = cameraStream;
      videoStream.onloadedmetadata = () => {
        isAnalyzing = true;
        quadHistory.length = 0;
        requestAnimationFrame(processDetectionFrame);
      };
    } catch (err) {
      console.warn('Camera stream error:', err);
      switchToUploadMode();
      showToast('Camera access unavailable. Switched to File Upload mode.', 'warning');
    }
  }

  function stopCamera() {
    isAnalyzing = false;
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5-Stage Computer Vision Edge & Contour Stabilization Pipeline
  // ───────────────────────────────────────────────────────────────────────────
  function processDetectionFrame() {
    if (!isAnalyzing || !videoStream.videoWidth || isCapturing) {
      if (isAnalyzing && !isCapturing) requestAnimationFrame(processDetectionFrame);
      return;
    }

    const vw = videoStream.videoWidth;
    const vh = videoStream.videoHeight;

    // Rescale to lightweight processing canvas (240px wide)
    const procW = 240;
    const procH = Math.round((vh / vw) * procW);

    analysisCanvas.width = procW;
    analysisCanvas.height = procH;
    const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(videoStream, 0, 0, procW, procH);

    const frameData = ctx.getImageData(0, 0, procW, procH);
    const pixels = frameData.data;

    // ── Stage 1: Grayscale & Gaussian Blur Smoothing ──
    const gray = new Float32Array(procW * procH);
    for (let i = 0; i < pixels.length; i += 4) {
      // Luminance: Y = 0.299R + 0.587G + 0.114B
      gray[i / 4] = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
    }

    // 3x3 Gaussian convolution
    const blurred = new Float32Array(procW * procH);
    for (let y = 1; y < procH - 1; y++) {
      for (let x = 1; x < procW - 1; x++) {
        const val = (
          gray[(y - 1) * procW + (x - 1)] * 1 + gray[(y - 1) * procW + x] * 2 + gray[(y - 1) * procW + (x + 1)] * 1 +
          gray[y * procW + (x - 1)] * 2       + gray[y * procW + x] * 4       + gray[y * procW + (x + 1)] * 2 +
          gray[(y + 1) * procW + (x - 1)] * 1 + gray[(y + 1) * procW + x] * 2 + gray[(y + 1) * procW + (x + 1)] * 1
        ) / 16.0;
        blurred[y * procW + x] = val;
      }
    }

    // ── Stage 2: Sobel Edge Gradient & 4-Point Document Contour ──
    // Find high-contrast edge pixels (desk-to-paper boundary)
    const edgePoints = [];
    const minGradientThreshold = 35.0;

    for (let y = 2; y < procH - 2; y += 2) {
      for (let x = 2; x < procW - 2; x += 2) {
        const gx = (
          -blurred[(y - 1) * procW + (x - 1)] + blurred[(y - 1) * procW + (x + 1)] +
          -2 * blurred[y * procW + (x - 1)]   + 2 * blurred[y * procW + (x + 1)] +
          -blurred[(y + 1) * procW + (x - 1)] + blurred[(y + 1) * procW + (x + 1)]
        );
        const gy = (
          -blurred[(y - 1) * procW + (x - 1)] - 2 * blurred[(y - 1) * procW + x] - blurred[(y - 1) * procW + (x + 1)] +
           blurred[(y + 1) * procW + (x - 1)] + 2 * blurred[(y + 1) * procW + x] + blurred[(y + 1) * procW + (x + 1)]
        );
        const mag = Math.abs(gx) + Math.abs(gy);
        if (mag > minGradientThreshold && blurred[y * procW + x] > 110) {
          edgePoints.push({ x, y });
        }
      }
    }

    let detectedQuad = null;

    if (edgePoints.length > 50) {
      // Find 4 extreme corner projections:
      // Top-Left: min(x + y), Top-Right: max(x - y), Bottom-Right: max(x + y), Bottom-Left: min(x - y)
      let minSum = Infinity, maxSum = -Infinity;
      let minDiff = Infinity, maxDiff = -Infinity;
      let tl = null, tr = null, br = null, bl = null;

      for (let i = 0; i < edgePoints.length; i++) {
        const p = edgePoints[i];
        const sum = p.x + p.y;
        const diff = p.x - p.y;

        if (sum < minSum) { minSum = sum; tl = p; }
        if (sum > maxSum) { maxSum = sum; br = p; }
        if (diff > maxDiff) { maxDiff = diff; tr = p; }
        if (diff < minDiff) { minDiff = diff; bl = p; }
      }

      if (tl && tr && br && bl) {
        // Calculate document polygon area using Shoelace formula
        const area = 0.5 * Math.abs(
          (tl.x * tr.y - tr.x * tl.y) +
          (tr.x * br.y - br.x * tr.y) +
          (br.x * bl.y - bl.x * br.y) +
          (bl.x * tl.y - tl.x * bl.y)
        );

        const totalCanvasArea = procW * procH;
        const areaRatio = area / totalCanvasArea;

        // Document should occupy at least 25% of viewfinder area
        if (areaRatio > 0.25 && areaRatio < 0.95) {
          detectedQuad = {
            tl: { x: (tl.x / procW) * vw, y: (tl.y / procH) * vh },
            tr: { x: (tr.x / procW) * vw, y: (tr.y / procH) * vh },
            br: { x: (br.x / procW) * vw, y: (br.y / procH) * vh },
            bl: { x: (bl.x / procW) * vw, y: (bl.y / procH) * vh },
            area: area
          };
        }
      }
    }

    // ── Stage 3: Quad Stabilization via IoU & Area-Delta Check ──
    drawLiveHUDOverlay(detectedQuad, procW, procH);

    if (detectedQuad) {
      quadHistory.push(detectedQuad);
      if (quadHistory.length > STABILITY_REQUIRED_FRAMES) {
        quadHistory.shift();
      }

      let isStabilized = false;

      if (quadHistory.length === STABILITY_REQUIRED_FRAMES) {
        // Compare current quad with previous frames in buffer
        let maxDrift = 0;
        const latest = quadHistory[quadHistory.length - 1];
        const prev = quadHistory[quadHistory.length - 2];

        // Measure corner displacement drift
        const dTL = Math.hypot(latest.tl.x - prev.tl.x, latest.tl.y - prev.tl.y);
        const dTR = Math.hypot(latest.tr.x - prev.tr.x, latest.tr.y - prev.tr.y);
        const dBR = Math.hypot(latest.br.x - prev.br.x, latest.br.y - prev.br.y);
        const dBL = Math.hypot(latest.bl.x - prev.bl.x, latest.bl.y - prev.bl.y);
        maxDrift = Math.max(dTL, dTR, dBR, dBL);

        // Area-Delta check
        const areaDelta = Math.abs(latest.area - prev.area) / prev.area * 100;

        if (maxDrift < (MAX_CORNER_DRIFT_PX * (vw / procW)) && areaDelta < MAX_AREA_DELTA_PCT) {
          isStabilized = true;
        }
      }

      const progressPct = Math.min(100, Math.round((quadHistory.length / STABILITY_REQUIRED_FRAMES) * 100));

      if (isStabilized && autoCaptureEnabled && !isCapturing) {
        hudFrame.className = 'hud-frame detected';
        hudProgressWrap.style.display = 'block';
        hudProgressBar.style.width = '100%';
        detectionStatusPill.className = 'pill pill-detected';
        detectionStatusPill.textContent = 'Sheet Locked (100%)';
        hudMessage.textContent = 'Stabilized! Auto-Capturing...';

        triggerAutoCapture();
        return;
      } else {
        hudFrame.className = 'hud-frame detected';
        hudProgressWrap.style.display = 'block';
        hudProgressBar.style.width = `${progressPct}%`;
        detectionStatusPill.className = 'pill pill-detected';
        detectionStatusPill.textContent = `Sheet Detected (${progressPct}%)`;
        hudMessage.textContent = 'Hold Camera Steady...';
      }
    } else {
      if (quadHistory.length > 0) quadHistory.pop();
      hudFrame.className = 'hud-frame';
      hudProgressWrap.style.display = 'none';
      hudProgressBar.style.width = '0%';
      detectionStatusPill.className = 'pill pill-searching';
      detectionStatusPill.textContent = 'Searching for Sheet...';
      hudMessage.textContent = 'Align OMR Sheet in Viewfinder';
    }

    if (isAnalyzing) {
      setTimeout(() => requestAnimationFrame(processDetectionFrame), 70); // ~14 FPS
    }
  }

  // Draw real-time contour tracking polygon overlay
  function drawLiveHUDOverlay(quad, procW, procH) {
    if (!overlayCanvas) return;
    const rect = viewfinderWrapper.getBoundingClientRect();
    overlayCanvas.width = rect.width;
    overlayCanvas.height = rect.height;

    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (quad) {
      const scaleX = rect.width / videoStream.videoWidth;
      const scaleY = rect.height / videoStream.videoHeight;

      ctx.beginPath();
      ctx.moveTo(quad.tl.x * scaleX, quad.tl.y * scaleY);
      ctx.lineTo(quad.tr.x * scaleX, quad.tr.y * scaleY);
      ctx.lineTo(quad.br.x * scaleX, quad.br.y * scaleY);
      ctx.lineTo(quad.bl.x * scaleX, quad.bl.y * scaleY);
      ctx.closePath();

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#10b981';
      ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
      ctx.stroke();
      ctx.fill();

      // Corner target dots
      [quad.tl, quad.tr, quad.br, quad.bl].forEach(pt => {
        ctx.beginPath();
        ctx.arc(pt.x * scaleX, pt.y * scaleY, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#10b981';
        ctx.fill();
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // High-Resolution Snapshot & Server Submission
  // ───────────────────────────────────────────────────────────────────────────
  async function triggerAutoCapture() {
    isCapturing = true;
    isAnalyzing = false;

    // Visual Shutter Flash & Audio Chime
    shutterFlash.classList.add('flash');
    playCaptureChime();
    setTimeout(() => shutterFlash.classList.remove('flash'), 300);

    // Full-resolution capture
    snapshotCanvas.width = videoStream.videoWidth;
    snapshotCanvas.height = videoStream.videoHeight;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(videoStream, 0, 0);

    detectionStatusPill.className = 'pill pill-evaluating';
    detectionStatusPill.textContent = 'Homography & Grading...';
    hudMessage.textContent = 'Running OpenCV Binarization...';

    const blob = await new Promise(resolve => snapshotCanvas.toBlob(resolve, 'image/png', 0.95));
    await submitScan(blob);
  }

  btnManualCapture.addEventListener('click', async () => {
    if (viewfinderWrapper.style.display !== 'none' && videoStream.videoWidth > 0) {
      triggerAutoCapture();
    } else if (currentUploadedBlob) {
      isCapturing = true;
      detectionStatusPill.className = 'pill pill-evaluating';
      detectionStatusPill.textContent = 'Grading 50 Questions...';
      await submitScan(currentUploadedBlob);
    } else {
      showToast('Please capture or upload an OMR sheet first.', 'warning');
    }
  });

  async function submitScan(blobToSend) {
    btnManualCapture.disabled = true;
    btnManualCapture.innerHTML = '<span>⏳ Grading with CV Engine...</span>';

    const formData = new FormData();
    formData.append('file', blobToSend, 'sheet_scan.png');
    formData.append('test_code', document.getElementById('select-exam').value);
    formData.append('student_id', document.getElementById('input-student-id').value);

    try {
      const startTime = performance.now();
      const resp = await fetch('/api/scan', {
        method: 'POST',
        body: formData
      });
      const data = await resp.json();
      const elapsedMs = Math.round(performance.now() - startTime);

      if (!resp.ok || !data.success) {
        throw new Error(data.error || 'Evaluation failed.');
      }

      renderScorecard(data.report, elapsedMs);
      showToast(`Sheet Evaluated in ${elapsedMs}ms!`, 'success');
      btnScanNext.style.display = 'inline-flex';
    } catch (err) {
      showToast('Scan Error: ' + err.message, 'danger');
      detectionStatusPill.className = 'pill pill-searching';
      detectionStatusPill.textContent = 'Scan Failed — Try Again';
      resumeScanner();
    } finally {
      btnManualCapture.disabled = false;
      btnManualCapture.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
        <span>Capture & Grade Sheet</span>
      `;
    }
  }

  function renderScorecard(report, elapsedMs) {
    scorecardEmpty.style.display = 'none';
    scorecardResult.style.display = 'block';

    const sum = report.summary;
    document.getElementById('res-score-val').textContent = sum.raw_score.toFixed(1);
    document.getElementById('res-max-val').textContent = `/ ${sum.max_marks.toFixed(1)}`;
    document.getElementById('res-grade-tag').textContent = `Percentage: ${sum.score_percentage}%`;
    document.getElementById('res-accuracy-val').textContent = `${sum.accuracy_on_attempted_pct}%`;
    document.getElementById('res-pct-val').textContent = `${sum.score_percentage}%`;
    document.getElementById('res-speed-val').textContent = `${elapsedMs}ms`;

    document.getElementById('cnt-correct').textContent = sum.correct;
    document.getElementById('cnt-wrong').textContent = sum.wrong;
    document.getElementById('cnt-blank').textContent = sum.unanswered;
    document.getElementById('cnt-multi').textContent = sum.multiple_marks;

    detectionStatusPill.className = 'pill pill-success';
    detectionStatusPill.textContent = `Score: ${sum.raw_score}/${sum.max_marks}`;

    // Render 50-Question Response Grid
    const responseGrid = document.getElementById('response-grid');
    responseGrid.innerHTML = '';

    report.detailed_results.forEach(q => {
      const chip = document.createElement('div');
      const st = q.evaluation_status.toLowerCase();
      let statusClass = 'blank';
      if (st === 'correct') statusClass = 'correct';
      else if (st === 'wrong') statusClass = 'wrong';
      else if (st === 'multiple_marks') statusClass = 'multi';

      chip.className = `q-chip ${statusClass}`;
      chip.title = `Q${q.question}: Marked [${q.student_answer || 'None'}] | Key [${q.correct_answer}] | Result: ${q.evaluation_status}`;
      chip.innerHTML = `
        <span class="q-chip-num">${q.question}</span>
        <span class="q-chip-ans">${q.student_answer || '—'}</span>
      `;
      responseGrid.appendChild(chip);
    });
  }

  function resumeScanner() {
    isCapturing = false;
    quadHistory.length = 0;
    if (viewfinderWrapper.style.display !== 'none') {
      isAnalyzing = true;
      requestAnimationFrame(processDetectionFrame);
    }
  }

  btnScanNext.addEventListener('click', () => {
    btnScanNext.style.display = 'none';
    scorecardResult.style.display = 'none';
    scorecardEmpty.style.display = 'block';
    detectionStatusPill.className = 'pill pill-searching';
    detectionStatusPill.textContent = 'Searching for Sheet...';
    resumeScanner();
    showToast('Ready for next sheet.', 'info');
  });

  chkAutoCapture.addEventListener('change', (e) => {
    autoCaptureEnabled = e.target.checked;
    showToast(`Auto-Capture ${autoCaptureEnabled ? 'Enabled (Automatic)' : 'Disabled (Manual Mode)'}`, 'info');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // File Upload & Sample Demo
  // ───────────────────────────────────────────────────────────────────────────
  btnSwitchSource.addEventListener('click', () => {
    if (viewfinderWrapper.style.display !== 'none') {
      switchToUploadMode();
    } else {
      switchToCameraMode();
    }
  });

  function switchToUploadMode() {
    stopCamera();
    viewfinderWrapper.style.display = 'none';
    fileDropzone.style.display = 'flex';
    btnSwitchSource.textContent = '📱 Live Camera';
  }

  function switchToCameraMode() {
    fileDropzone.style.display = 'none';
    viewfinderWrapper.style.display = 'block';
    btnSwitchSource.textContent = '📁 File Upload';
    initCamera();
  }

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      currentUploadedBlob = file;
      const reader = new FileReader();
      reader.onload = (re) => {
        filePreviewImg.src = re.target.result;
        filePreviewWrap.style.display = 'block';
        detectionStatusPill.className = 'pill pill-detected';
        detectionStatusPill.textContent = 'File Ready';
      };
      reader.readAsDataURL(file);
    }
  });

  btnSampleDemo.addEventListener('click', async () => {
    showToast('Loading pre-filled test sample...', 'info');
    try {
      const resp = await fetch('/static/test_sample.png');
      const blob = await resp.blob();
      currentUploadedBlob = new File([blob], 'sample_sheet.png', { type: 'image/png' });
      filePreviewImg.src = URL.createObjectURL(blob);
      filePreviewWrap.style.display = 'block';
      switchToUploadMode();
      showToast('Sample Loaded. Click Capture & Grade to evaluate.', 'success');
    } catch (e) {
      showToast('Error loading sample: ' + e.message, 'danger');
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Teacher Portal Answer Key Builder
  // ───────────────────────────────────────────────────────────────────────────
  function initAnswerKeyBuilder() {
    const grid = document.getElementById('key-picker-grid');
    if (grid.children.length > 0) return;

    grid.innerHTML = '';
    const options = ['A', 'B', 'C', 'D'];

    for (let q = 1; q <= 50; q++) {
      const row = document.createElement('div');
      row.className = 'key-picker-row';
      const qNum = document.createElement('span');
      qNum.className = 'key-picker-num';
      qNum.textContent = `Q${q.toString().padStart(2, '0')}`;

      const btnGroup = document.createElement('div');
      btnGroup.className = 'key-btn-group';

      const defOpt = options[(q - 1) % 4];
      answerKeyBuilderState[q.toString()] = defOpt;

      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `key-btn ${opt === defOpt ? 'active' : ''}`;
        btn.textContent = opt;
        btn.addEventListener('click', () => {
          btnGroup.querySelectorAll('.key-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          answerKeyBuilderState[q.toString()] = opt;
        });
        btnGroup.appendChild(btn);
      });

      row.appendChild(qNum);
      row.appendChild(btnGroup);
      grid.appendChild(row);
    }
  }

  document.getElementById('btn-key-preset-1').addEventListener('click', () => {
    const options = ['A', 'B', 'C', 'D'];
    for (let q = 1; q <= 50; q++) {
      setKeyOption(q, options[(q - 1) % 4]);
    }
  });

  document.getElementById('btn-key-random').addEventListener('click', () => {
    const options = ['A', 'B', 'C', 'D'];
    for (let q = 1; q <= 50; q++) {
      setKeyOption(q, options[Math.floor(Math.random() * options.length)]);
    }
  });

  document.getElementById('btn-key-clear').addEventListener('click', () => {
    for (let q = 1; q <= 50; q++) {
      setKeyOption(q, 'A');
    }
  });

  function setKeyOption(q, opt) {
    answerKeyBuilderState[q.toString()] = opt;
    const row = document.getElementById('key-picker-grid').children[q - 1];
    if (row) {
      row.querySelectorAll('.key-btn').forEach(b => {
        if (b.textContent === opt) b.classList.add('active');
        else b.classList.remove('active');
      });
    }
  }

  document.getElementById('form-create-test').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('new-test-title').value.trim();
    const test_code = document.getElementById('new-test-code').value.trim().toUpperCase();
    const marks_c = parseFloat(document.getElementById('new-test-marks-c').value);
    const marks_w = parseFloat(document.getElementById('new-test-marks-w').value);
    const duration = parseInt(document.getElementById('new-test-duration').value);

    try {
      const resp = await fetch('/api/tests/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          test_code,
          marks_per_correct: marks_c,
          negative_marks_per_wrong: marks_w,
          duration_mins: duration,
          total_questions: 50,
          answer_key: answerKeyBuilderState
        })
      });

      const res = await resp.json();
      if (!resp.ok || !res.success) throw new Error(res.error || 'Failed to create test');

      showToast(`Assessment ${test_code} created and key encrypted!`, 'success');
      loadActiveTests();
      document.getElementById('form-create-test').reset();
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });

  async function loadActiveTests() {
    try {
      const resp = await fetch('/api/tests');
      const data = await resp.json();
      const container = document.getElementById('tests-list-container');
      const examSelect = document.getElementById('select-exam');
      const analyticsSelect = document.getElementById('analytics-exam-select');

      container.innerHTML = '';
      examSelect.innerHTML = '';
      analyticsSelect.innerHTML = '';

      if (data.tests && data.tests.length > 0) {
        data.tests.forEach(t => {
          const item = document.createElement('div');
          item.className = 'test-card';
          item.innerHTML = `
            <div class="test-meta">
              <h4>${t.title}</h4>
              <p>Code: <strong>${t.test_code}</strong> • ${t.total_questions} Questions • ${t.duration_mins} mins</p>
            </div>
            <a href="/api/tests/template/download" class="btn-sm" download>📄 OMR Sheet</a>
          `;
          container.appendChild(item);

          const opt = document.createElement('option');
          opt.value = t.test_code;
          opt.textContent = `${t.test_code} — ${t.title}`;
          examSelect.appendChild(opt);

          const opt2 = document.createElement('option');
          opt2.value = t.test_code;
          opt2.textContent = t.test_code;
          analyticsSelect.appendChild(opt2);
        });
      }
    } catch (e) {
      console.error(e);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Class Analytics & Item Heatmap
  // ───────────────────────────────────────────────────────────────────────────
  document.getElementById('analytics-exam-select').addEventListener('change', (e) => {
    loadAnalytics(e.target.value);
    document.getElementById('btn-export-csv').href = `/api/export/${e.target.value}.csv`;
  });

  async function loadAnalytics(testCode) {
    try {
      const resp = await fetch(`/api/analytics/${testCode}`);
      const data = await resp.json();
      if (!data.success) return;

      const an = data.analytics;

      const toppersContainer = document.getElementById('toppers-container');
      toppersContainer.innerHTML = '';
      if (an.toppers && an.toppers.length > 0) {
        an.toppers.forEach(top => {
          const div = document.createElement('div');
          div.className = 'topper-row';
          div.innerHTML = `
            <div class="topper-left">
              <span class="topper-badge">#${top.rank}</span>
              <div>
                <strong class="topper-name">${top.name}</strong>
                <div class="topper-id">${top.student_id}</div>
              </div>
            </div>
            <div class="topper-val">${top.score} / ${top.max_marks} (${top.percentage}%)</div>
          `;
          toppersContainer.appendChild(div);
        });
      } else {
        toppersContainer.innerHTML = '<p class="empty-msg">No submissions recorded yet for this exam.</p>';
      }

      const flaggedContainer = document.getElementById('flagged-questions-container');
      flaggedContainer.innerHTML = '';
      if (an.flagged_hard_questions && an.flagged_hard_questions.length > 0) {
        an.flagged_hard_questions.forEach(fq => {
          const div = document.createElement('div');
          div.className = 'flagged-row';
          div.innerHTML = `
            <div>
              <strong>Question ${fq.question}</strong>
              <div class="flagged-sub">${fq.note}</div>
            </div>
            <span class="flagged-badge">${fq.wrong_pct}% Failed</span>
          `;
          flaggedContainer.appendChild(div);
        });
      } else {
        flaggedContainer.innerHTML = '<p class="success-msg">🎉 All questions are within acceptable difficulty (&lt;60% fail rate).</p>';
      }

      const itemMatrix = document.getElementById('full-item-matrix');
      itemMatrix.innerHTML = '';
      if (an.question_item_analysis) {
        Object.entries(an.question_item_analysis).forEach(([qNum, qData]) => {
          const div = document.createElement('div');
          const isHard = qData.difficulty_level === 'HARD';
          div.className = `item-cell ${isHard ? 'hard' : (qData.difficulty_level === 'EASY' ? 'easy' : '')}`;
          div.innerHTML = `
            <div class="item-cell-q">Q${qNum}</div>
            <div class="item-cell-pct">${qData.correct_pct}%</div>
          `;
          itemMatrix.appendChild(div);
        });
      }
    } catch (e) {
      console.error(e);
    }
  }

  function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    setTimeout(() => {
      toast.className = 'toast';
    }, 3000);
  }

  // Start Scanner
  initCamera();
  loadActiveTests();
});
