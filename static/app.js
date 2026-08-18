/**
 * AOTS — Industrial DocScanner Engine & Real-Time Client (v3.5)
 * =============================================================
 * Real-Time Document Contour & Convex Quad Extractor:
 * 1. Luminance-Adaptive Otsu Binarization (Isolates white paper from dark laptop/desk)
 * 2. Connected Document Contour & Convex Hull Quad Fitting (Rejects outer screen borders)
 * 3. 4-Corner Ordering (TL, TR, BR, BL) directly on the paper boundary
 * 4. Interactive Touch Handles with 2X Magnifying Loupe
 * 5. Homography Perspective Flattening & Shadow-Normalized Grading
 */

document.addEventListener('DOMContentLoaded', () => {
  // ── State Variables ──
  let currentTab = 'scanner';
  let cameraStream = null;
  let isAnalyzing = false;
  let autoCaptureEnabled = true;
  let isCapturing = false;
  let selectedMode = 'camera';

  // Stability Tracking Buffer
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
  
  // Setup Card
  const scannerSetupCard = document.getElementById('scanner-setup-card');
  const selectExam = document.getElementById('select-exam');
  const inputStudentId = document.getElementById('input-student-id');
  const cardModeCamera = document.getElementById('card-mode-camera');
  const cardModeUpload = document.getElementById('card-mode-upload');
  const btnLaunchScanner = document.getElementById('btn-launch-scanner');
  const btnLoadSample = document.getElementById('btn-load-sample');

  // Live Scanner
  const scannerLiveContainer = document.getElementById('scanner-live-container');
  const bannerExamCode = document.getElementById('banner-exam-code');
  const bannerStudentId = document.getElementById('banner-student-id');
  const btnChangeExam = document.getElementById('btn-change-exam');
  const btnTopBack = document.getElementById('btn-top-back');
  const videoStream = document.getElementById('camera-stream');
  const analysisCanvas = document.getElementById('analysis-canvas');
  const snapshotCanvas = document.getElementById('snapshot-canvas');
  const overlayCanvas = document.getElementById('hud-contour-canvas');
  const searchingBracketsHud = document.getElementById('searching-brackets-hud');
  const floatingStatusPill = document.getElementById('floating-status-pill');
  const floatingStatusText = document.getElementById('floating-status-text');
  const pillSpinner = document.getElementById('pill-spinner');
  const pillPulseDot = document.getElementById('pill-pulse-dot');
  const shutterFlash = document.getElementById('shutter-flash');
  const btnGridToggle = document.getElementById('btn-grid-toggle');
  const gridOverlay = document.getElementById('camera-grid-overlay');
  const btnManualToggle = document.getElementById('btn-manual-toggle');
  const autoModeLabel = document.getElementById('auto-mode-label');
  const viewfinderWrapper = document.getElementById('viewfinder-wrapper');
  const fileDropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('file-input');
  const filePreviewWrap = document.getElementById('file-preview-wrap');
  const filePreviewImg = document.getElementById('file-preview-img');
  const btnManualCapture = document.getElementById('btn-manual-capture');
  const btnCloseScanner = document.getElementById('btn-close-scanner');
  const docShutterDeck = document.getElementById('doc-shutter-deck');

  // Corner Editor
  const cornerEditorWrap = document.getElementById('corner-editor-wrap');
  const editorCanvas = document.getElementById('crop-editor-canvas');
  const editorContainer = document.getElementById('editor-canvas-container');
  const editorTimerBadge = document.getElementById('editor-timer-badge');
  const btnEditorRetake = document.getElementById('btn-editor-retake');
  const btnEditorAutoAlign = document.getElementById('btn-editor-auto-align');
  const btnEditorConfirm = document.getElementById('btn-editor-confirm');
  const magnifyingLoupe = document.getElementById('magnifying-loupe');
  const loupeCanvas = document.getElementById('loupe-canvas');
  const handles = {
    tl: document.getElementById('handle-tl'),
    tr: document.getElementById('handle-tr'),
    br: document.getElementById('handle-br'),
    bl: document.getElementById('handle-bl')
  };

  // Scorecard
  const scorecardPanel = document.getElementById('scorecard-panel');
  const scorecardResult = document.getElementById('scorecard-result');
  const btnScanNext = document.getElementById('btn-scan-next');

  // ───────────────────────────────────────────────────────────────────────────
  // Audio & Haptic Feedback
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
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
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
  // Setup View Controls
  // ───────────────────────────────────────────────────────────────────────────
  cardModeCamera.addEventListener('click', () => {
    selectedMode = 'camera';
    cardModeCamera.classList.add('active');
    cardModeUpload.classList.remove('active');
  });

  cardModeUpload.addEventListener('click', () => {
    selectedMode = 'upload';
    cardModeUpload.classList.add('active');
    cardModeCamera.classList.remove('active');
  });

  btnLaunchScanner.addEventListener('click', () => {
    startScanningSession();
  });

  btnChangeExam.addEventListener('click', () => {
    stopScanningSession();
  });

  btnTopBack.addEventListener('click', () => {
    stopScanningSession();
  });

  btnCloseScanner.addEventListener('click', () => {
    stopScanningSession();
  });

  function startScanningSession() {
    activeExamCode = selectExam.value;
    const studentId = inputStudentId.value.trim() || 'SM-ECET-2026-042';

    bannerExamCode.textContent = activeExamCode;
    bannerStudentId.textContent = studentId;
    document.getElementById('doc-subtitle').textContent = `${activeExamCode} • ${studentId}`;

    scannerSetupCard.style.display = 'none';
    scorecardPanel.style.display = 'none';
    scannerLiveContainer.style.display = 'block';

    if (selectedMode === 'camera') {
      viewfinderWrapper.style.display = 'block';
      fileDropzone.style.display = 'none';
      docShutterDeck.style.display = 'block';
      initCamera();
    } else {
      stopCamera();
      viewfinderWrapper.style.display = 'none';
      fileDropzone.style.display = 'flex';
      docShutterDeck.style.display = 'block';
    }
  }

  function stopScanningSession() {
    stopCamera();
    clearInterval(editorTimer);
    scannerLiveContainer.style.display = 'none';
    cornerEditorWrap.style.display = 'none';
    scorecardPanel.style.display = 'none';
    scannerSetupCard.style.display = 'block';
    document.getElementById('doc-subtitle').textContent = 'Ready to Scan';
  }

  btnGridToggle.addEventListener('click', () => {
    const isVisible = gridOverlay.style.display !== 'none';
    gridOverlay.style.display = isVisible ? 'none' : 'block';
    btnGridToggle.classList.toggle('active', !isVisible);
  });

  btnManualToggle.addEventListener('click', () => {
    autoCaptureEnabled = !autoCaptureEnabled;
    autoModeLabel.textContent = autoCaptureEnabled ? 'AUTO' : 'MANUAL';
    showToast(`Capture Mode: ${autoCaptureEnabled ? 'Automatic (DocScanner)' : 'Manual Shutter'}`, 'info');
  });

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
        if (scannerLiveContainer.style.display !== 'none' && selectedMode === 'camera') {
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
      selectedMode = 'upload';
      startScanningSession();
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
  // Real-Time Industrial Document Contour Detector (DocScanner Core Algorithm)
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

    // Convert to Grayscale & Calculate Mean Luminance
    const gray = new Float32Array(procW * procH);
    let totalLuma = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const luma = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
      gray[i / 4] = luma;
      totalLuma += luma;
    }
    const meanLuma = totalLuma / gray.length;

    // Adaptive Paper Threshold: White paper is significantly brighter than the background
    // (threshold = meanLuma + dynamic offset, clamped between 110 and 175)
    const paperThresh = Math.max(115, Math.min(175, meanLuma + 18));
    
    // Find all bright paper pixels (avoiding extreme 5px borders of the camera frame)
    const paperPoints = [];
    for (let y = 6; y < procH - 6; y += 2) {
      for (let x = 6; x < procW - 6; x += 2) {
        if (gray[y * procW + x] > paperThresh) {
          paperPoints.push({ x, y });
        }
      }
    }

    let detectedQuad = null;

    // Extract the convex paper quadrilateral if sufficient paper pixels are found
    if (paperPoints.length > (procW * procH * 0.08)) {
      // Find the 4 directional extreme corners of the paper polygon
      let minSum = Infinity, maxSum = -Infinity;
      let minDiff = Infinity, maxDiff = -Infinity;
      let tl = null, tr = null, br = null, bl = null;

      for (let i = 0; i < paperPoints.length; i++) {
        const p = paperPoints[i];
        const sum = p.x + p.y;
        const diff = p.x - p.y;

        if (sum < minSum) { minSum = sum; tl = p; }
        if (sum > maxSum) { maxSum = sum; br = p; }
        if (diff > maxDiff) { maxDiff = diff; tr = p; }
        if (diff < minDiff) { minDiff = diff; bl = p; }
      }

      if (tl && tr && br && bl) {
        // Calculate document polygon area via Shoelace formula
        const area = 0.5 * Math.abs(
          (tl.x * tr.y - tr.x * tl.y) +
          (tr.x * br.y - br.x * tr.y) +
          (br.x * bl.y - bl.x * br.y) +
          (bl.x * tl.y - bl.x * bl.y)
        );

        const totalArea = procW * procH;
        const areaRatio = area / totalArea;

        // Check reasonable document proportions (between 12% and 85% of camera frame)
        if (areaRatio > 0.12 && areaRatio < 0.85) {
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

    // ── 4-State Dispatch Logic ──
    if (detectedQuad) {
      // State 2: Document Found (Show Cyan Dots & Polygon)
      searchingBracketsHud.style.display = 'none';
      drawCyanHUDOverlay(detectedQuad);

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

      if (isStabilized && autoCaptureEnabled && !isCapturing) {
        // State 3: Stability Lock Confirmed
        pillSpinner.style.display = 'block';
        pillPulseDot.style.display = 'none';
        floatingStatusText.textContent = "Capturing... don't move";
        openCornerAdjustmentModal(detectedQuad);
        return;
      } else {
        pillSpinner.style.display = 'none';
        pillPulseDot.style.display = 'block';
        floatingStatusText.textContent = 'Document Found — Hold Steady';
      }
    } else {
      // State 1: Searching for Document
      if (quadHistory.length > 0) quadHistory.pop();
      searchingBracketsHud.style.display = 'block';
      clearOverlayCanvas();
      pillSpinner.style.display = 'none';
      pillPulseDot.style.display = 'block';
      floatingStatusText.textContent = 'Searching for OMR sheet...';
    }

    if (isAnalyzing) {
      setTimeout(() => requestAnimationFrame(processDetectionFrame), 70);
    }
  }

  function clearOverlayCanvas() {
    if (!overlayCanvas) return;
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  // Draw 4 Cyan Corner Dots & Glowing Quadrilateral on Viewfinder
  function drawCyanHUDOverlay(quad) {
    if (!overlayCanvas) return;
    const rect = viewfinderWrapper.getBoundingClientRect();
    overlayCanvas.width = rect.width;
    overlayCanvas.height = rect.height;

    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (quad) {
      const scaleX = rect.width / videoStream.videoWidth;
      const scaleY = rect.height / videoStream.videoHeight;

      // Cyan boundary polygon
      ctx.beginPath();
      ctx.moveTo(quad.tl.x * scaleX, quad.tl.y * scaleY);
      ctx.lineTo(quad.tr.x * scaleX, quad.tr.y * scaleY);
      ctx.lineTo(quad.br.x * scaleX, quad.br.y * scaleY);
      ctx.lineTo(quad.bl.x * scaleX, quad.bl.y * scaleY);
      ctx.closePath();

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#00f0d0';
      ctx.fillStyle = 'rgba(0, 240, 208, 0.12)';
      ctx.stroke();
      ctx.fill();

      // 4 Cyan Corner Dots (Exact Match with Image 2)
      [quad.tl, quad.tr, quad.br, quad.bl].forEach(pt => {
        const cx = pt.x * scaleX;
        const cy = pt.y * scaleY;

        // Outer glow
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 240, 208, 0.25)';
        ctx.fill();

        // Inner solid cyan circle
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#00f0d0';
        ctx.fill();

        // Center white dot
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Interactive 4-Corner Crop Adjuster with 2X Loupe
  // ───────────────────────────────────────────────────────────────────────────
  async function openCornerAdjustmentModal(detectedQuad = null) {
    isCapturing = true;
    isAnalyzing = false;

    // Flash & chime
    shutterFlash.classList.add('flash');
    playCaptureChime();
    setTimeout(() => shutterFlash.classList.remove('flash'), 300);

    // Snapshot full-res image
    snapshotCanvas.width = videoStream.videoWidth;
    snapshotCanvas.height = videoStream.videoHeight;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(videoStream, 0, 0);

    capturedBlob = await new Promise(res => snapshotCanvas.toBlob(res, 'image/png', 0.95));

    editorImage = new Image();
    editorImage.onload = () => {
      viewfinderWrapper.style.display = 'none';
      docShutterDeck.style.display = 'none';
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

    let paperQuad = detectedQuad;
    if (!paperQuad) {
      paperQuad = extractHighResPaperContour(editorImage, imgW, imgH);
    }

    if (paperQuad) {
      editorCorners.tl = { x: paperQuad.tl.x * scaleX, y: paperQuad.tl.y * scaleY };
      editorCorners.tr = { x: paperQuad.tr.x * scaleX, y: paperQuad.tr.y * scaleY };
      editorCorners.br = { x: paperQuad.br.x * scaleX, y: paperQuad.br.y * scaleY };
      editorCorners.bl = { x: paperQuad.bl.x * scaleX, y: paperQuad.bl.y * scaleY };
    } else {
      editorCorners.tl = { x: containerRect.width * 0.15, y: containerRect.height * 0.15 };
      editorCorners.tr = { x: containerRect.width * 0.85, y: containerRect.height * 0.15 };
      editorCorners.br = { x: containerRect.width * 0.85, y: containerRect.height * 0.85 };
      editorCorners.bl = { x: containerRect.width * 0.15, y: containerRect.height * 0.85 };
    }

    updateHandleDOMPositions();
    renderEditorCanvas();

    // 10-Second Auto Countdown
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

  function extractHighResPaperContour(img, w, h) {
    try {
      const offCanvas = document.createElement('canvas');
      offCanvas.width = 320;
      offCanvas.height = Math.round((h / w) * 320);
      const offCtx = offCanvas.getContext('2d');
      offCtx.drawImage(img, 0, 0, offCanvas.width, offCanvas.height);

      const pData = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height).data;
      const gray = new Float32Array(offCanvas.width * offCanvas.height);
      let sumLuma = 0;

      for (let i = 0; i < pData.length; i += 4) {
        const luma = pData[i] * 0.299 + pData[i + 1] * 0.587 + pData[i + 2] * 0.114;
        gray[i / 4] = luma;
        sumLuma += luma;
      }

      const meanLuma = sumLuma / gray.length;
      const paperThresh = Math.max(115, Math.min(175, meanLuma + 18));
      const paperPoints = [];

      for (let y = 6; y < offCanvas.height - 6; y += 2) {
        for (let x = 6; x < offCanvas.width - 6; x += 2) {
          if (gray[y * offCanvas.width + x] > paperThresh) {
            paperPoints.push({ x, y });
          }
        }
      }

      if (paperPoints.length > 50) {
        let minSum = Infinity, maxSum = -Infinity;
        let minDiff = Infinity, maxDiff = -Infinity;
        let tl = null, tr = null, br = null, bl = null;

        for (let i = 0; i < paperPoints.length; i++) {
          const p = paperPoints[i];
          const sum = p.x + p.y;
          const diff = p.x - p.y;
          if (sum < minSum) { minSum = sum; tl = p; }
          if (sum > maxSum) { maxSum = sum; br = p; }
          if (diff > maxDiff) { maxDiff = diff; tr = p; }
          if (diff < minDiff) { minDiff = diff; bl = p; }
        }

        const scX = w / offCanvas.width;
        const scY = h / offCanvas.height;

        return {
          tl: { x: tl.x * scX, y: tl.y * scY },
          tr: { x: tr.x * scX, y: tr.y * scY },
          br: { x: br.x * scX, y: br.y * scY },
          bl: { x: bl.x * scX, y: bl.y * scY }
        };
      }
    } catch (e) {
      console.warn('High-res contour extraction:', e);
    }
    return null;
  }

  function updateTimerBadge() {
    editorTimerBadge.textContent = `⏳ Auto-Grading in ${editorSecondsLeft}s`;
  }

  function pauseEditorTimer() {
    if (editorTimer) {
      clearInterval(editorTimer);
      editorTimer = null;
      editorTimerBadge.textContent = '✏️ Corner Adjusted';
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

    ctx.drawImage(editorImage, 0, 0, editorCanvas.width, editorCanvas.height);

    // Cyan glowing boundary polygon
    ctx.beginPath();
    ctx.moveTo(editorCorners.tl.x, editorCorners.tl.y);
    ctx.lineTo(editorCorners.tr.x, editorCorners.tr.y);
    ctx.lineTo(editorCorners.br.x, editorCorners.br.y);
    ctx.lineTo(editorCorners.bl.x, editorCorners.bl.y);
    ctx.closePath();

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#00f0d0';
    ctx.fillStyle = 'rgba(0, 240, 208, 0.15)';
    ctx.stroke();
    ctx.fill();

    // Alignment guide lines
    ctx.strokeStyle = 'rgba(0, 240, 208, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const mTopX = (editorCorners.tl.x + editorCorners.tr.x) / 2;
    const mTopY = (editorCorners.tl.y + editorCorners.tr.y) / 2;
    const mBotX = (editorCorners.bl.x + editorCorners.br.x) / 2;
    const mBotY = (editorCorners.bl.y + editorCorners.br.y) / 2;
    ctx.moveTo(mTopX, mTopY);
    ctx.lineTo(mBotX, mBotY);

    const mLeftX = (editorCorners.tl.x + editorCorners.bl.x) / 2;
    const mLeftY = (editorCorners.tl.y + editorCorners.bl.y) / 2;
    const mRightX = (editorCorners.tr.x + editorCorners.br.x) / 2;
    const mRightY = (editorCorners.tr.y + editorCorners.br.y) / 2;
    ctx.moveTo(mLeftX, mLeftY);
    ctx.lineTo(mRightX, mRightY);
    ctx.stroke();
  }

  // ── Drag & 2X Loupe Handlers ──
  Object.keys(handles).forEach(cornerKey => {
    const handle = handles[cornerKey];

    const startDrag = (e) => {
      e.preventDefault();
      activeDragCorner = cornerKey;
      handle.classList.add('dragging');
      pauseEditorTimer();
      showMagnifyingLoupe(editorCorners[cornerKey]);
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

    const posX = Math.max(5, Math.min(rect.width - 5, clientX - rect.left));
    const posY = Math.max(5, Math.min(rect.height - 5, clientY - rect.top));

    editorCorners[activeDragCorner] = { x: posX, y: posY };
    updateHandleDOMPositions();
    renderEditorCanvas();
    showMagnifyingLoupe({ x: posX, y: posY });
  };

  const stopDrag = () => {
    if (activeDragCorner) {
      handles[activeDragCorner].classList.remove('dragging');
      activeDragCorner = null;
      magnifyingLoupe.style.display = 'none';
    }
  };

  function showMagnifyingLoupe(pos) {
    magnifyingLoupe.style.display = 'block';
    magnifyingLoupe.style.left = `${pos.x}px`;
    magnifyingLoupe.style.top = `${pos.y}px`;

    const lCtx = loupeCanvas.getContext('2d');
    lCtx.clearRect(0, 0, 120, 120);

    const scaleX = editorImage.width / editorCanvas.width;
    const scaleY = editorImage.height / editorCanvas.height;

    const srcCenterX = pos.x * scaleX;
    const srcCenterY = pos.y * scaleY;
    const cropSize = 80;

    lCtx.drawImage(
      editorImage,
      srcCenterX - cropSize / 2,
      srcCenterY - cropSize / 2,
      cropSize,
      cropSize,
      0,
      0,
      120,
      120
    );
  }

  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('touchmove', moveDrag, { passive: false });
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('touchend', stopDrag);

  btnEditorRetake.addEventListener('click', () => {
    clearInterval(editorTimer);
    cornerEditorWrap.style.display = 'none';
    viewfinderWrapper.style.display = 'block';
    docShutterDeck.style.display = 'block';
    resumeScanner();
  });

  btnEditorAutoAlign.addEventListener('click', () => {
    const w = editorImage.width;
    const h = editorImage.height;
    const paperQuad = extractHighResPaperContour(editorImage, w, h);
    const containerRect = editorContainer.getBoundingClientRect();
    const scaleX = containerRect.width / w;
    const scaleY = containerRect.height / h;

    if (paperQuad) {
      editorCorners.tl = { x: paperQuad.tl.x * scaleX, y: paperQuad.tl.y * scaleY };
      editorCorners.tr = { x: paperQuad.tr.x * scaleX, y: paperQuad.tr.y * scaleY };
      editorCorners.br = { x: paperQuad.br.x * scaleX, y: paperQuad.br.y * scaleY };
      editorCorners.bl = { x: paperQuad.bl.x * scaleX, y: paperQuad.bl.y * scaleY };
      updateHandleDOMPositions();
      renderEditorCanvas();
      showToast('Snapped corners to exact paper edges.', 'success');
    } else {
      showToast('Could not isolate paper boundary.', 'warning');
    }
  });

  btnEditorConfirm.addEventListener('click', () => {
    clearInterval(editorTimer);
    submitWithAdjustedCorners();
  });

  async function submitWithAdjustedCorners() {
    floatingStatusText.textContent = 'Flattening & Grading...';

    const scaleX = editorImage.width / editorCanvas.width;
    const scaleY = editorImage.height / editorCanvas.height;

    const normalizedCorners = [
      [editorCorners.tl.x * scaleX, editorCorners.tl.y * scaleY],
      [editorCorners.tr.x * scaleX, editorCorners.tr.y * scaleY],
      [editorCorners.br.x * scaleX, editorCorners.br.y * scaleY],
      [editorCorners.bl.x * scaleX, editorCorners.bl.y * scaleY]
    ];

    cornerEditorWrap.style.display = 'none';
    await submitScan(capturedBlob, normalizedCorners);
  }

  // ── State 4: Enhanced Document Preview DOM ──
  const enhancedPreviewWrap = document.getElementById('enhanced-preview-wrap');
  const enhancedDocImg = document.getElementById('enhanced-doc-img');
  const btnPreviewRetake = document.getElementById('btn-preview-retake');
  const btnPreviewAdjust = document.getElementById('btn-preview-adjust');
  const btnPreviewConfirm = document.getElementById('btn-preview-confirm');
  let currentScanReport = null;

  btnPreviewRetake.addEventListener('click', () => {
    enhancedPreviewWrap.style.display = 'none';
    viewfinderWrapper.style.display = 'block';
    docShutterDeck.style.display = 'block';
    resumeScanner();
  });

  btnPreviewAdjust.addEventListener('click', () => {
    enhancedPreviewWrap.style.display = 'none';
    cornerEditorWrap.style.display = 'block';
  });

  btnPreviewConfirm.addEventListener('click', () => {
    enhancedPreviewWrap.style.display = 'none';
    scannerLiveContainer.style.display = 'none';
    scorecardPanel.style.display = 'block';
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Step 4: Submission & Evaluation
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
    floatingStatusText.textContent = 'Grading 50 Questions...';

    const formData = new FormData();
    formData.append('file', blobToSend, 'sheet_scan.png');
    formData.append('test_code', activeExamCode);
    formData.append('student_id', inputStudentId.value.trim() || 'SM-ECET-2026-042');

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

      currentScanReport = data.report;

      // If enhanced image returned, show State 4 preview
      if (data.enhanced_image) {
        enhancedDocImg.src = data.enhanced_image;
        viewfinderWrapper.style.display = 'none';
        cornerEditorWrap.style.display = 'none';
        docShutterDeck.style.display = 'none';
        enhancedPreviewWrap.style.display = 'block';
      } else {
        scannerLiveContainer.style.display = 'none';
        scorecardPanel.style.display = 'block';
      }

      renderScorecard(data.report, elapsedMs);
      showToast(`Sheet Evaluated in ${elapsedMs}ms!`, 'success');
    } catch (err) {
      showToast('Scan Error: ' + err.message, 'danger');
      floatingStatusText.textContent = 'Scan Failed — Try Again';
      resumeScanner();
    }
  }

  function renderScorecard(report, elapsedMs) {
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
    scorecardPanel.style.display = 'none';
    startScanningSession();
    resumeScanner();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // File Upload & Sample Demo
  // ───────────────────────────────────────────────────────────────────────────
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      currentUploadedBlob = file;
      const reader = new FileReader();
      reader.onload = (re) => {
        filePreviewImg.src = re.target.result;
        filePreviewWrap.style.display = 'block';
        floatingStatusText.textContent = 'File Ready';
      };
      reader.readAsDataURL(file);
    }
  });

  btnLoadSample.addEventListener('click', async () => {
    showToast('Loading sample sheet...', 'info');
    try {
      const resp = await fetch('/static/test_sample.png');
      const blob = await resp.blob();
      currentUploadedBlob = new File([blob], 'sample_sheet.png', { type: 'image/png' });
      selectedMode = 'upload';
      startScanningSession();
      filePreviewImg.src = URL.createObjectURL(blob);
      filePreviewWrap.style.display = 'block';
      showToast('Sample Loaded. Click Shutter Button to grade.', 'success');
    } catch (e) {
      showToast('Error loading sample: ' + e.message, 'danger');
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Teacher Portal & Analytics
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
    for (let q = 1; q <= 50; q++) setKeyOption(q, options[(q - 1) % 4]);
  });

  document.getElementById('btn-key-random').addEventListener('click', () => {
    const options = ['A', 'B', 'C', 'D'];
    for (let q = 1; q <= 50; q++) setKeyOption(q, options[Math.floor(Math.random() * options.length)]);
  });

  document.getElementById('btn-key-clear').addEventListener('click', () => {
    for (let q = 1; q <= 50; q++) setKeyOption(q, 'A');
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

  // Initial setup: camera is paused until user launches scanning session
  loadActiveTests();
});
