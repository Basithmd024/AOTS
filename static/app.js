/**
 * AOTS — Automated Optical Testing System Client Engine (v2.6 CamScanner Edition)
 * Features:
 * - 5-Stage Real-Time Frame Noise Reduction & Edge Contour Tracking
 * - Interactive 4-Corner Draggable Crop Editor with 10-Second Auto-Countdown
 * - Custom Corner Coordinates homography submission to /api/scan
 * - Audio & Haptic Feedback
 */

document.addEventListener('DOMContentLoaded', () => {
  // ── State Variables ──
  let currentTab = 'scanner';
  let cameraStream = null;
  let isAnalyzing = false;
  let autoCaptureEnabled = true;
  let isCapturing = false;

  // Quad Stabilization History
  const quadHistory = [];
  const STABILITY_REQUIRED_FRAMES = 5;
  const MAX_CORNER_DRIFT_PX = 8.0;
  const MAX_AREA_DELTA_PCT = 3.5;

  // Corner Editor State
  let editorImage = null;
  let editorCorners = { tl: { x: 0, y: 0 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } };
  let editorTimer = null;
  let editorSecondsLeft = 10;
  let activeDragCorner = null;
  let capturedBlob = null;

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
  const mainPanelFooter = document.getElementById('main-panel-footer');

  // Corner Editor DOM
  const cornerEditorWrap = document.getElementById('corner-editor-wrap');
  const editorCanvas = document.getElementById('crop-editor-canvas');
  const editorContainer = document.getElementById('editor-canvas-container');
  const editorTimerBadge = document.getElementById('editor-timer-badge');
  const btnEditorRetake = document.getElementById('btn-editor-retake');
  const btnEditorAutoAlign = document.getElementById('btn-editor-auto-align');
  const btnEditorConfirm = document.getElementById('btn-editor-confirm');
  const handles = {
    tl: document.getElementById('handle-tl'),
    tr: document.getElementById('handle-tr'),
    br: document.getElementById('handle-br'),
    bl: document.getElementById('handle-bl')
  };

  const scorecardEmpty = document.getElementById('scorecard-empty');
  const scorecardResult = document.getElementById('scorecard-result');

  // Real-time canvas overlay for HUD
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
        if (viewfinderWrapper.style.display !== 'none' && cornerEditorWrap.style.display === 'none') {
          initCamera();
        }
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
  // Real-Time Frame Noise Reduction & Edge Contour Tracking
  // ───────────────────────────────────────────────────────────────────────────
  function processDetectionFrame() {
    if (!isAnalyzing || !videoStream.videoWidth || isCapturing) {
      if (isAnalyzing && !isCapturing) requestAnimationFrame(processDetectionFrame);
      return;
    }

    const vw = videoStream.videoWidth;
    const vh = videoStream.videoHeight;
    const procW = 240;
    const procH = Math.round((vh / vw) * procW);

    analysisCanvas.width = procW;
    analysisCanvas.height = procH;
    const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(videoStream, 0, 0, procW, procH);

    const frameData = ctx.getImageData(0, 0, procW, procH);
    const pixels = frameData.data;

    // Grayscale
    const gray = new Float32Array(procW * procH);
    for (let i = 0; i < pixels.length; i += 4) {
      gray[i / 4] = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
    }

    // 3x3 Gaussian convolution
    const blurred = new Float32Array(procW * procH);
    for (let y = 1; y < procH - 1; y++) {
      for (let x = 1; x < procW - 1; x++) {
        blurred[y * procW + x] = (
          gray[(y - 1) * procW + (x - 1)] * 1 + gray[(y - 1) * procW + x] * 2 + gray[(y - 1) * procW + (x + 1)] * 1 +
          gray[y * procW + (x - 1)] * 2       + gray[y * procW + x] * 4       + gray[y * procW + (x + 1)] * 2 +
          gray[(y + 1) * procW + (x - 1)] * 1 + gray[(y + 1) * procW + x] * 2 + gray[(y + 1) * procW + (x + 1)] * 1
        ) / 16.0;
      }
    }

    // Sobel Edge Gradient
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
        const area = 0.5 * Math.abs(
          (tl.x * tr.y - tr.x * tl.y) +
          (tr.x * br.y - br.x * tr.y) +
          (br.x * bl.y - bl.x * br.y) +
          (bl.x * tl.y - bl.x * bl.y)
        );

        const totalArea = procW * procH;
        const areaRatio = area / totalArea;

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

    drawLiveHUDOverlay(detectedQuad);

    if (detectedQuad) {
      quadHistory.push(detectedQuad);
      if (quadHistory.length > STABILITY_REQUIRED_FRAMES) quadHistory.shift();

      let isStabilized = false;
      if (quadHistory.length === STABILITY_REQUIRED_FRAMES) {
        const latest = quadHistory[quadHistory.length - 1];
        const prev = quadHistory[quadHistory.length - 2];
        const dTL = Math.hypot(latest.tl.x - prev.tl.x, latest.tl.y - prev.tl.y);
        const dTR = Math.hypot(latest.tr.x - prev.tr.x, latest.tr.y - prev.tr.y);
        const dBR = Math.hypot(latest.br.x - prev.br.x, latest.br.y - prev.br.y);
        const dBL = Math.hypot(latest.bl.x - prev.bl.x, latest.bl.y - prev.bl.y);
        const maxDrift = Math.max(dTL, dTR, dBR, dBL);
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

        openCornerAdjustmentModal(detectedQuad);
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
      setTimeout(() => requestAnimationFrame(processDetectionFrame), 70);
    }
  }

  function drawLiveHUDOverlay(quad) {
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

      [quad.tl, quad.tr, quad.br, quad.bl].forEach(pt => {
        ctx.beginPath();
        ctx.arc(pt.x * scaleX, pt.y * scaleY, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#10b981';
        ctx.fill();
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Interactive 4-Corner Draggable Crop Editor (CamScanner Mode)
  // ───────────────────────────────────────────────────────────────────────────
  async function openCornerAdjustmentModal(detectedQuad = null) {
    isCapturing = true;
    isAnalyzing = false;

    // Shutter flash & chime
    shutterFlash.classList.add('flash');
    playCaptureChime();
    setTimeout(() => shutterFlash.classList.remove('flash'), 300);

    // Snapshot full-res image
    snapshotCanvas.width = videoStream.videoWidth;
    snapshotCanvas.height = videoStream.videoHeight;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(videoStream, 0, 0);

    capturedBlob = await new Promise(res => snapshotCanvas.toBlob(res, 'image/png', 0.95));

    // Load into Editor Canvas
    editorImage = new Image();
    editorImage.onload = () => {
      viewfinderWrapper.style.display = 'none';
      fileDropzone.style.display = 'none';
      mainPanelFooter.style.display = 'none';
      cornerEditorWrap.style.display = 'block';

      setupCornerEditor(detectedQuad);
    };
    editorImage.src = URL.createObjectURL(capturedBlob);
  }

  function setupCornerEditor(detectedQuad) {
    const containerRect = editorContainer.getBoundingClientRect();
    editorCanvas.width = containerRect.width;
    editorCanvas.height = containerRect.height;

    const imgW = editorImage.width;
    const imgH = editorImage.height;
    const scaleX = containerRect.width / imgW;
    const scaleY = containerRect.height / imgH;

    // Position corners: use detected quad or standard margin defaults
    if (detectedQuad) {
      editorCorners.tl = { x: detectedQuad.tl.x * scaleX, y: detectedQuad.tl.y * scaleY };
      editorCorners.tr = { x: detectedQuad.tr.x * scaleX, y: detectedQuad.tr.y * scaleY };
      editorCorners.br = { x: detectedQuad.br.x * scaleX, y: detectedQuad.br.y * scaleY };
      editorCorners.bl = { x: detectedQuad.bl.x * scaleX, y: detectedQuad.bl.y * scaleY };
    } else {
      editorCorners.tl = { x: containerRect.width * 0.1, y: containerRect.height * 0.1 };
      editorCorners.tr = { x: containerRect.width * 0.9, y: containerRect.height * 0.1 };
      editorCorners.br = { x: containerRect.width * 0.9, y: containerRect.height * 0.9 };
      editorCorners.bl = { x: containerRect.width * 0.1, y: containerRect.height * 0.9 };
    }

    updateHandleDOMPositions();
    renderEditorCanvas();

    // Start 10-Second Auto-Countdown
    clearInterval(editorTimer);
    editorSecondsLeft = 10;
    updateTimerBadge();

    editorTimer = setInterval(() => {
      editorSecondsLeft--;
      updateTimerBadge();
      if (editorSecondsLeft <= 0) {
        clearInterval(editorTimer);
        submitWithAdjustedCorners();
      }
    }, 1000);
  }

  function updateTimerBadge() {
    editorTimerBadge.className = 'pill pill-warning';
    editorTimerBadge.textContent = `⏳ Auto-Grading in ${editorSecondsLeft}s... (Drag corners to adjust)`;
  }

  function pauseEditorTimer() {
    if (editorTimer) {
      clearInterval(editorTimer);
      editorTimer = null;
      editorTimerBadge.className = 'pill pill-detected';
      editorTimerBadge.textContent = '✏️ Corner Adjusted — Tap Grade Now when ready';
    }
  }

  function updateHandleDOMPositions() {
    Object.keys(handles).forEach(k => {
      const h = handles[k];
      const pos = editorCorners[k];
      h.style.left = `${pos.x}px`;
      h.style.top = `${pos.y}px`;
    });
  }

  function renderEditorCanvas() {
    const ctx = editorCanvas.getContext('2d');
    ctx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);

    // Draw background captured image
    ctx.drawImage(editorImage, 0, 0, editorCanvas.width, editorCanvas.height);

    // Draw quadrilateral boundary polygon
    ctx.beginPath();
    ctx.moveTo(editorCorners.tl.x, editorCorners.tl.y);
    ctx.lineTo(editorCorners.tr.x, editorCorners.tr.y);
    ctx.lineTo(editorCorners.br.x, editorCorners.br.y);
    ctx.lineTo(editorCorners.bl.x, editorCorners.bl.y);
    ctx.closePath();

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#10b981';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
    ctx.stroke();
    ctx.fill();

    // Draw grid cross guidelines
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Midpoint X
    const mTopX = (editorCorners.tl.x + editorCorners.tr.x) / 2;
    const mTopY = (editorCorners.tl.y + editorCorners.tr.y) / 2;
    const mBotX = (editorCorners.bl.x + editorCorners.br.x) / 2;
    const mBotY = (editorCorners.bl.y + editorCorners.br.y) / 2;
    ctx.moveTo(mTopX, mTopY);
    ctx.lineTo(mBotX, mBotY);

    // Midpoint Y
    const mLeftX = (editorCorners.tl.x + editorCorners.bl.x) / 2;
    const mLeftY = (editorCorners.tl.y + editorCorners.bl.y) / 2;
    const mRightX = (editorCorners.tr.x + editorCorners.br.x) / 2;
    const mRightY = (editorCorners.tr.y + editorCorners.br.y) / 2;
    ctx.moveTo(mLeftX, mLeftY);
    ctx.lineTo(mRightX, mRightY);
    ctx.stroke();
  }

  // ── Drag Event Handlers for Touch and Mouse ──
  Object.keys(handles).forEach(cornerKey => {
    const handle = handles[cornerKey];

    // Pointer Down
    const startDrag = (e) => {
      e.preventDefault();
      activeDragCorner = cornerKey;
      handle.classList.add('dragging');
      pauseEditorTimer();
    };

    handle.addEventListener('mousedown', startDrag);
    handle.addEventListener('touchstart', startDrag, { passive: false });
  });

  const moveDrag = (e) => {
    if (!activeDragCorner) return;
    e.preventDefault();
    const rect = editorContainer.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const posX = Math.max(10, Math.min(rect.width - 10, clientX - rect.left));
    const posY = Math.max(10, Math.min(rect.height - 10, clientY - rect.top));

    editorCorners[activeDragCorner] = { x: posX, y: posY };
    updateHandleDOMPositions();
    renderEditorCanvas();
  };

  const stopDrag = () => {
    if (activeDragCorner) {
      handles[activeDragCorner].classList.remove('dragging');
      activeDragCorner = null;
    }
  };

  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('touchmove', moveDrag, { passive: false });
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('touchend', stopDrag);

  // Editor Buttons
  btnEditorRetake.addEventListener('click', () => {
    clearInterval(editorTimer);
    cornerEditorWrap.style.display = 'none';
    viewfinderWrapper.style.display = 'block';
    mainPanelFooter.style.display = 'flex';
    resumeScanner();
  });

  btnEditorAutoAlign.addEventListener('click', () => {
    const w = editorCanvas.width;
    const h = editorCanvas.height;
    editorCorners.tl = { x: w * 0.08, y: h * 0.08 };
    editorCorners.tr = { x: w * 0.92, y: h * 0.08 };
    editorCorners.br = { x: w * 0.92, y: h * 0.92 };
    editorCorners.bl = { x: w * 0.08, y: h * 0.92 };
    updateHandleDOMPositions();
    renderEditorCanvas();
    showToast('Corners reset to full boundary.', 'info');
  });

  btnEditorConfirm.addEventListener('click', () => {
    clearInterval(editorTimer);
    submitWithAdjustedCorners();
  });

  async function submitWithAdjustedCorners() {
    detectionStatusPill.className = 'pill pill-evaluating';
    detectionStatusPill.textContent = 'Homography & Grading...';

    // Map screen canvas coordinates back to original full-resolution image coordinates
    const scaleX = editorImage.width / editorCanvas.width;
    const scaleY = editorImage.height / editorCanvas.height;

    const normalizedCorners = [
      [editorCorners.tl.x * scaleX, editorCorners.tl.y * scaleY],
      [editorCorners.tr.x * scaleX, editorCorners.tr.y * scaleY],
      [editorCorners.br.x * scaleX, editorCorners.br.y * scaleY],
      [editorCorners.bl.x * scaleX, editorCorners.bl.y * scaleY]
    ];

    cornerEditorWrap.style.display = 'none';
    viewfinderWrapper.style.display = 'block';
    mainPanelFooter.style.display = 'flex';

    await submitScan(capturedBlob, normalizedCorners);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Manual Trigger & Submit Scan
  // ───────────────────────────────────────────────────────────────────────────
  btnManualCapture.addEventListener('click', () => {
    if (viewfinderWrapper.style.display !== 'none' && videoStream.videoWidth > 0) {
      openCornerAdjustmentModal();
    } else if (currentUploadedBlob) {
      submitScan(currentUploadedBlob);
    } else {
      showToast('Please capture or upload an OMR sheet first.', 'warning');
    }
  });

  async function submitScan(blobToSend, customCorners = null) {
    btnManualCapture.disabled = true;
    btnManualCapture.innerHTML = '<span>⏳ Grading with CV Engine...</span>';

    const formData = new FormData();
    formData.append('file', blobToSend, 'sheet_scan.png');
    formData.append('test_code', document.getElementById('select-exam').value);
    formData.append('student_id', document.getElementById('input-student-id').value);

    if (customCorners) {
      formData.append('corners', JSON.stringify(customCorners));
    }

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
    showToast(`Auto-Capture ${autoCaptureEnabled ? 'Enabled' : 'Disabled (Manual Mode)'}`, 'info');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // File Upload & Sample Demo
  // ───────────────────────────────────────────────────────────────────────────
  btnSwitchSource.addEventListener('click', () => {
    if (viewfinderWrapper.style.display !== 'none' || cornerEditorWrap.style.display !== 'none') {
      switchToUploadMode();
    } else {
      switchToCameraMode();
    }
  });

  function switchToUploadMode() {
    stopCamera();
    clearInterval(editorTimer);
    cornerEditorWrap.style.display = 'none';
    viewfinderWrapper.style.display = 'none';
    fileDropzone.style.display = 'flex';
    mainPanelFooter.style.display = 'flex';
    btnSwitchSource.textContent = '📱 Live Camera';
  }

  function switchToCameraMode() {
    fileDropzone.style.display = 'none';
    cornerEditorWrap.style.display = 'none';
    viewfinderWrapper.style.display = 'block';
    mainPanelFooter.style.display = 'flex';
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
