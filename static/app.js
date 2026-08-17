/**
 * AOTS — Automated Optical Testing System Client Engine (Phase 4.2)
 * Features:
 * - Real-time client-side sheet detection & automatic hands-free capture
 * - Audio & haptic feedback upon capture lock
 * - Fast scoring & question item analysis
 */

document.addEventListener('DOMContentLoaded', () => {
  // Application State
  let currentTab = 'scanner';
  let cameraStream = null;
  let isAnalyzing = false;
  let autoCaptureEnabled = true;
  let isCapturing = false;
  let sheetStableFrames = 0;
  const STABILITY_THRESHOLD_FRAMES = 6; // ~600ms of stable detection required

  let activeExamCode = 'AOTS-ECET-003';
  let answerKeyBuilderState = {};
  let currentUploadedBlob = null;
  let audioCtx = null;

  // DOM Elements
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

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Audio & Haptic Feedback System
  // ───────────────────────────────────────────────────────────────────────────
  function initAudio() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
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
      osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5 note
      osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.12); // A6 note
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.16);
    } catch (e) {
      console.warn('Audio feedback:', e);
    }

    // Haptic vibration for mobile devices
    if (navigator.vibrate) {
      navigator.vibrate([40, 30, 40]);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Navigation Tabs
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
  // 3. Camera Setup & Real-Time Auto-Detection Loop
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
        sheetStableFrames = 0;
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
  // 4. Real-Time OMR Sheet Quality & Alignment Analyzer
  // ───────────────────────────────────────────────────────────────────────────
  function processDetectionFrame() {
    if (!isAnalyzing || !videoStream.videoWidth || isCapturing) {
      if (isAnalyzing && !isCapturing) requestAnimationFrame(processDetectionFrame);
      return;
    }

    const vw = videoStream.videoWidth;
    const vh = videoStream.videoHeight;
    const sampleW = 240;
    const sampleH = Math.round((vh / vw) * sampleW);

    analysisCanvas.width = sampleW;
    analysisCanvas.height = sampleH;
    const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(videoStream, 0, 0, sampleW, sampleH);

    const imgData = ctx.getImageData(0, 0, sampleW, sampleH);
    const data = imgData.data;

    // Fast luminance & contrast analysis on central region vs borders
    let centerLuma = 0;
    let centerSamples = 0;
    const cx1 = Math.round(sampleW * 0.25);
    const cx2 = Math.round(sampleW * 0.75);
    const cy1 = Math.round(sampleH * 0.25);
    const cy2 = Math.round(sampleH * 0.75);

    for (let y = cy1; y < cy2; y += 4) {
      for (let x = cx1; x < cx2; x += 4) {
        const idx = (y * sampleW + x) * 4;
        centerLuma += (data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114);
        centerSamples++;
      }
    }
    const avgCenter = centerLuma / Math.max(centerSamples, 1);

    // Corner darkness check (looking for 4 high-contrast fiducials)
    const corners = [
      { x: Math.round(sampleW * 0.15), y: Math.round(sampleH * 0.15) },
      { x: Math.round(sampleW * 0.85), y: Math.round(sampleH * 0.15) },
      { x: Math.round(sampleW * 0.85), y: Math.round(sampleH * 0.85) },
      { x: Math.round(sampleW * 0.15), y: Math.round(sampleH * 0.85) }
    ];

    let cornerDarkCount = 0;
    corners.forEach(c => {
      let darkPx = 0;
      for (let dy = -6; dy <= 6; dy += 3) {
        for (let dx = -6; dx <= 6; dx += 3) {
          const px = Math.min(Math.max(c.x + dx, 0), sampleW - 1);
          const py = Math.min(Math.max(c.y + dy, 0), sampleH - 1);
          const idx = (py * sampleW + px) * 4;
          const luma = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
          if (luma < 120) darkPx++;
        }
      }
      if (darkPx >= 2) cornerDarkCount++;
    });

    // Determine Alignment Detection State
    const isWhitePaperPresent = avgCenter > 135;
    const isSheetAligned = isWhitePaperPresent && (cornerDarkCount >= 2);

    if (isSheetAligned) {
      sheetStableFrames++;
      const progressPct = Math.min(100, Math.round((sheetStableFrames / STABILITY_THRESHOLD_FRAMES) * 100));

      hudFrame.className = 'hud-frame detected';
      hudProgressWrap.style.display = 'block';
      hudProgressBar.style.width = `${progressPct}%`;
      detectionStatusPill.className = 'pill pill-detected';
      detectionStatusPill.textContent = `Sheet Locked (${progressPct}%)`;
      hudMessage.textContent = 'Hold Steady — Auto-Capturing...';

      if (sheetStableFrames >= STABILITY_THRESHOLD_FRAMES && autoCaptureEnabled && !isCapturing) {
        triggerAutoCapture();
        return;
      }
    } else {
      sheetStableFrames = Math.max(0, sheetStableFrames - 2);
      hudFrame.className = 'hud-frame';
      hudProgressWrap.style.display = 'none';
      hudProgressBar.style.width = '0%';
      detectionStatusPill.className = 'pill pill-searching';
      detectionStatusPill.textContent = 'Searching for Sheet...';
      hudMessage.textContent = 'Point camera at OMR Sheet';
    }

    if (isAnalyzing) {
      setTimeout(() => requestAnimationFrame(processDetectionFrame), 80); // ~12 FPS
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. High-Resolution Capture & Grade Trigger
  // ───────────────────────────────────────────────────────────────────────────
  async function triggerAutoCapture() {
    isCapturing = true;
    isAnalyzing = false;

    // Visual Flash & Audio Chime
    shutterFlash.classList.add('flash');
    playCaptureChime();
    setTimeout(() => shutterFlash.classList.remove('flash'), 300);

    // Snapshot full resolution from video stream
    snapshotCanvas.width = videoStream.videoWidth;
    snapshotCanvas.height = videoStream.videoHeight;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(videoStream, 0, 0);

    detectionStatusPill.className = 'pill pill-evaluating';
    detectionStatusPill.textContent = 'Grading 50 Questions...';
    hudMessage.textContent = 'Analyzing Bubbles with OpenCV...';

    const blob = await new Promise(resolve => snapshotCanvas.toBlob(resolve, 'image/png', 0.95));
    await submitScan(blob);
  }

  // Manual Trigger
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
    sheetStableFrames = 0;
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
    showToast(`Auto-Capture ${autoCaptureEnabled ? 'Enabled' : 'Disabled (Manual Click Mode)'}`, 'info');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Source Switching & File Dropzone
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
  // 7. Teacher Portal Answer Key Builder
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
  // 8. Class Analytics & Item Heatmap
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

      // Render Toppers
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

      // Render Flagged Questions
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

      // Render 50 Question Matrix
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

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Toast Alerts
  // ───────────────────────────────────────────────────────────────────────────
  function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    setTimeout(() => {
      toast.className = 'toast';
    }, 3000);
  }

  // Start Scanner on load
  initCamera();
  loadActiveTests();
});
