/**
 * AOTS — Automated Optical Testing System Client Application (Phase 4)
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let currentTab = 'scanner';
  let cameraStream = null;
  let activeExamCode = 'AOTS-ECET-003';
  let answerKeyBuilderState = {};
  let currentUploadedBlob = null;

  // DOM Elements
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const btnModeCamera = document.getElementById('btn-mode-camera');
  const btnModeFile = document.getElementById('btn-mode-file');
  const cameraContainer = document.getElementById('camera-container');
  const fileContainer = document.getElementById('file-container');
  const videoStream = document.getElementById('camera-stream');
  const captureCanvas = document.getElementById('capture-canvas');
  const fileInput = document.getElementById('file-input');
  const filePreviewWrap = document.getElementById('file-preview-wrap');
  const filePreviewImg = document.getElementById('file-preview-img');
  const btnScanGrade = document.getElementById('btn-scan-grade');
  const btnSampleDemo = document.getElementById('btn-sample-demo');
  const resultPlaceholder = document.getElementById('result-placeholder');
  const resultContent = document.getElementById('result-content');
  const scanStatusBadge = document.getElementById('scan-status-badge');

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Navigation Tabs
  // ───────────────────────────────────────────────────────────────────────────
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.dataset.tab;
      currentTab = tabId;
      document.getElementById(`tab-${tabId}`).classList.add('active');

      if (tabId === 'teacher') {
        loadActiveTests();
        initAnswerKeyBuilder();
      } else if (tabId === 'analytics') {
        loadAnalytics(activeExamCode);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Camera & File Upload Management
  // ───────────────────────────────────────────────────────────────────────────
  btnModeCamera.addEventListener('click', () => {
    btnModeCamera.classList.add('active');
    btnModeFile.classList.remove('active');
    cameraContainer.style.display = 'block';
    fileContainer.style.display = 'none';
    initCamera();
  });

  btnModeFile.addEventListener('click', () => {
    btnModeFile.classList.add('active');
    btnModeCamera.classList.remove('active');
    cameraContainer.style.display = 'none';
    fileContainer.style.display = 'flex';
    stopCamera();
  });

  async function initCamera() {
    try {
      if (cameraStream) stopCamera();
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      videoStream.srcObject = cameraStream;
    } catch (err) {
      console.warn('Camera access error or desktop environment:', err);
      showToast('Camera not available. Switched to File Upload mode.', 'warning');
      btnModeFile.click();
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = null;
    }
  }

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      currentUploadedBlob = file;
      const reader = new FileReader();
      reader.onload = (re) => {
        filePreviewImg.src = re.target.result;
        filePreviewWrap.style.display = 'block';
      };
      reader.readAsDataURL(file);
    }
  });

  // Load sample demo sheet directly
  btnSampleDemo.addEventListener('click', async () => {
    showToast('Loading pre-filled test sample...', 'info');
    try {
      const resp = await fetch('/static/test_sample.png');
      let blob;
      if (resp.ok) {
        blob = await resp.blob();
      } else {
        // Fallback: fetch template
        const fallbackResp = await fetch('/api/tests/template/download');
        blob = await fallbackResp.blob();
      }
      currentUploadedBlob = new File([blob], 'sample_omr_sheet.png', { type: 'image/png' });
      filePreviewImg.src = URL.createObjectURL(blob);
      filePreviewWrap.style.display = 'block';
      btnModeFile.click();
      showToast('Sample OMR Sheet Loaded! Click Scan to evaluate.', 'success');
    } catch (e) {
      showToast('Could not load sample sheet: ' + e.message, 'danger');
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Scan & Score Submission
  // ───────────────────────────────────────────────────────────────────────────
  btnScanGrade.addEventListener('click', async () => {
    let blobToSend = currentUploadedBlob;

    if (cameraContainer.style.display !== 'none' && videoStream.videoWidth > 0) {
      // Capture frame from webcam
      captureCanvas.width = videoStream.videoWidth;
      captureCanvas.height = videoStream.videoHeight;
      const ctx = captureCanvas.getContext('2d');
      ctx.drawImage(videoStream, 0, 0);
      blobToSend = await new Promise(resolve => captureCanvas.toBlob(resolve, 'image/png'));
    }

    if (!blobToSend) {
      showToast('Please capture a photo or upload an OMR sheet first.', 'warning');
      return;
    }

    // UI Loading state
    btnScanGrade.disabled = true;
    btnScanGrade.innerHTML = '<span>⏳ Processing CV Engine...</span>';
    scanStatusBadge.className = 'badge badge-locked';
    scanStatusBadge.textContent = 'Analyzing Bubbles...';

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

      displayScorecard(data.report, elapsedMs);
      showToast('Scorecard generated instantly!', 'success');
    } catch (err) {
      showToast('Scan Error: ' + err.message, 'danger');
      scanStatusBadge.className = 'badge badge-idle';
      scanStatusBadge.textContent = 'Scan Failed';
    } finally {
      btnScanGrade.disabled = false;
      btnScanGrade.innerHTML = '<span>🚀 Scan & Calculate Score</span>';
    }
  });

  function displayScorecard(report, elapsedMs) {
    resultPlaceholder.style.display = 'none';
    resultContent.style.display = 'block';

    const sum = report.summary;
    document.getElementById('res-score-value').textContent = sum.raw_score.toFixed(1);
    document.getElementById('res-score-max').textContent = `/ ${sum.max_marks.toFixed(1)}`;
    document.getElementById('res-accuracy').textContent = `${sum.accuracy_on_attempted_pct}%`;
    document.getElementById('res-percentage').textContent = `${sum.score_percentage}%`;
    document.getElementById('res-speed').textContent = `${elapsedMs}ms`;

    document.getElementById('res-correct').textContent = sum.correct;
    document.getElementById('res-wrong').textContent = sum.wrong;
    document.getElementById('res-unanswered').textContent = sum.unanswered;
    document.getElementById('res-multiple').textContent = sum.multiple_marks;

    scanStatusBadge.className = 'badge badge-success';
    scanStatusBadge.textContent = `Grade: ${sum.score_percentage}%`;

    // Render 50 question matrix
    const matrixGrid = document.getElementById('question-matrix');
    matrixGrid.innerHTML = '';

    report.detailed_results.forEach(q => {
      const box = document.createElement('div');
      const st = q.evaluation_status.toLowerCase();
      let statusClass = 'unattempted';
      if (st === 'correct') statusClass = 'correct';
      else if (st === 'wrong') statusClass = 'wrong';
      else if (st === 'multiple_marks') statusClass = 'multiple';

      box.className = `q-box ${statusClass}`;
      box.innerHTML = `
        <div class="q-box-num">Q${q.question}</div>
        <div class="q-box-ans">${q.student_answer || '—'}</div>
      `;
      matrixGrid.appendChild(box);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Teacher Answer Key Builder
  // ───────────────────────────────────────────────────────────────────────────
  function initAnswerKeyBuilder() {
    const grid = document.getElementById('key-picker-grid');
    if (grid.children.length > 0) return; // already initialized

    grid.innerHTML = '';
    const options = ['A', 'B', 'C', 'D'];

    for (let q = 1; q <= 50; q++) {
      const row = document.createElement('div');
      row.className = 'key-row';
      const qNum = document.createElement('span');
      qNum.className = 'key-row-num';
      qNum.textContent = `Q${q.toString().padStart(2, '0')}`;

      const btnGroup = document.createElement('div');
      btnGroup.className = 'opt-btn-group';

      // default selection
      const defOpt = options[(q - 1) % 4];
      answerKeyBuilderState[q.toString()] = defOpt;

      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `opt-btn ${opt === defOpt ? 'selected' : ''}`;
        btn.textContent = opt;
        btn.addEventListener('click', () => {
          btnGroup.querySelectorAll('.opt-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
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
      const opt = options[(q - 1) % 4];
      setBuilderOption(q, opt);
    }
  });

  document.getElementById('btn-key-random').addEventListener('click', () => {
    const options = ['A', 'B', 'C', 'D'];
    for (let q = 1; q <= 50; q++) {
      const opt = options[Math.floor(Math.random() * options.length)];
      setBuilderOption(q, opt);
    }
  });

  document.getElementById('btn-key-clear').addEventListener('click', () => {
    for (let q = 1; q <= 50; q++) {
      setBuilderOption(q, 'A');
    }
  });

  function setBuilderOption(q, opt) {
    answerKeyBuilderState[q.toString()] = opt;
    const row = document.getElementById('key-picker-grid').children[q - 1];
    if (row) {
      row.querySelectorAll('.opt-btn').forEach(b => {
        if (b.textContent === opt) b.classList.add('selected');
        else b.classList.remove('selected');
      });
    }
  }

  // Handle Test Creation Form
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
        body: json.dumps ? JSON.stringify({
          title,
          test_code,
          marks_per_correct: marks_c,
          negative_marks_per_wrong: marks_w,
          duration_mins: duration,
          total_questions: 50,
          answer_key: answerKeyBuilderState
        }) : JSON.stringify({
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

      showToast(`Test ${test_code} created & answer key encrypted!`, 'success');
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
          item.className = 'test-item';
          item.innerHTML = `
            <div class="test-info">
              <h4>${t.title}</h4>
              <p>Code: <strong>${t.test_code}</strong> • ${t.total_questions} Questions • ${t.duration_mins} Mins</p>
            </div>
            <a href="/api/tests/template/download" class="btn-xs" download>📄 OMR Sheet</a>
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
  // 5. Analytics & Item Difficulty Loading
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
          div.className = 'topper-item';
          div.innerHTML = `
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span class="topper-rank">#${top.rank}</span>
              <div>
                <strong>${top.name}</strong>
                <div style="font-size:0.7rem; color:var(--text-dim);">${top.student_id}</div>
              </div>
            </div>
            <div class="topper-score">${top.score} / ${top.max_marks} (${top.percentage}%)</div>
          `;
          toppersContainer.appendChild(div);
        });
      } else {
        toppersContainer.innerHTML = '<p class="empty-state">No submissions yet for this exam.</p>';
      }

      // Render Flagged Questions
      const flaggedContainer = document.getElementById('flagged-questions-container');
      flaggedContainer.innerHTML = '';
      if (an.flagged_hard_questions && an.flagged_hard_questions.length > 0) {
        an.flagged_hard_questions.forEach(fq => {
          const div = document.createElement('div');
          div.className = 'flagged-item';
          div.innerHTML = `
            <div>
              <strong>Question ${fq.question}</strong>
              <div style="font-size:0.75rem; color:var(--text-muted);">${fq.note}</div>
            </div>
            <span class="flagged-pct">${fq.wrong_pct}% Failed</span>
          `;
          flaggedContainer.appendChild(div);
        });
      } else {
        flaggedContainer.innerHTML = '<p style="color:var(--success); font-size:0.85rem;">🎉 No questions exceeded the 60% failure threshold.</p>';
      }

      // Render 50 Question Item Analysis Matrix
      const itemMatrix = document.getElementById('full-item-matrix');
      itemMatrix.innerHTML = '';
      if (an.question_item_analysis) {
        Object.entries(an.question_item_analysis).forEach(([qNum, qData]) => {
          const div = document.createElement('div');
          const isHard = qData.difficulty_level === 'HARD';
          div.className = `item-card ${isHard ? 'hard' : (qData.difficulty_level === 'EASY' ? 'easy' : '')}`;
          div.innerHTML = `
            <div style="font-weight:700;">Q${qNum}</div>
            <div style="font-size:0.65rem; margin-top:2px;">${qData.correct_pct}% Correct</div>
          `;
          itemMatrix.appendChild(div);
        });
      }

    } catch (e) {
      console.error(e);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Toast Notification Utility
  // ───────────────────────────────────────────────────────────────────────────
  function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show toast-${type}`;
    setTimeout(() => {
      toast.className = 'toast';
    }, 3200);
  }

  // Initial load
  loadActiveTests();
});
