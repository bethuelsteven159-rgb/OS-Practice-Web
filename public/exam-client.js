(() => {
  const root = document.querySelector('[data-exam-page]');
  if (!root) return;

  const mode = root.getAttribute('data-mode'); // 'attempt' | 'review' | 'summary'
  const attemptId = root.getAttribute('data-attempt-id');
  const questionId = root.getAttribute('data-question-id');
  const testId = root.getAttribute('data-test-id');
  const deadlineAt = Number(root.getAttribute('data-deadline-at') || '0');
  const initialServerNow = Number(root.getAttribute('data-server-now') || String(Date.now()));
  let clockOffsetMs = initialServerNow - Date.now();

  // ---------- Mobile drawer toggle ----------
  const drawer = document.getElementById('moodle-right-drawer');
  const openBtn = document.getElementById('mobile-drawer-toggle');
  const closeBtn = document.getElementById('drawer-close-btn');
  if (openBtn && drawer) {
    openBtn.addEventListener('click', () => drawer.classList.toggle('drawer-open'));
  }
  if (closeBtn && drawer) {
    closeBtn.addEventListener('click', () => drawer.classList.remove('drawer-open'));
  }

  // ---------- Flag question toggle ----------
  const flagBtn = document.getElementById('flag-question-btn');
  if (flagBtn && attemptId && questionId) {
    flagBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const res = await fetch(`/api/attempts/${encodeURIComponent(attemptId)}/flag`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        flagBtn.setAttribute('aria-pressed', data.flagged ? 'true' : 'false');
        const labelEl = flagBtn.querySelector('.flag-label');
        if (labelEl) labelEl.textContent = data.flagged ? 'Remove flag' : 'Flag question';
        const svgPoly = flagBtn.querySelector('path.flag-fill');
        if (svgPoly) {
          svgPoly.setAttribute('fill', data.flagged ? '#CA3120' : 'none');
          svgPoly.setAttribute('stroke', data.flagged ? '#CA3120' : '#0F6CBF');
        }
        const navTile = document.querySelector(`.qnbutton[data-question-id="${questionId}"]`);
        if (navTile) {
          navTile.classList.toggle('flagged', Boolean(data.flagged));
        }
      } catch {
        // Ignore transient network errors
      }
    });
  }

  // ---------- Active attempt: Autosave & Countdown ----------
  if (mode !== 'attempt' || !attemptId) return;

  const saveInd = document.getElementById('autosave-indicator');
  const stateLine = document.getElementById('que-state-line');
  const form = document.getElementById('question-attempt-form');

  let dirty = false;
  let saveTimer = null;
  let inflightPromise = null;

  function collectPartValues() {
    const parts = {};
    if (!form) return parts;
    const partNodes = form.querySelectorAll('[data-part-id]');
    partNodes.forEach((node) => {
      const partId = node.getAttribute('data-part-id');
      const partType = node.getAttribute('data-part-type');
      if (!partId) return;
      if (partType === 'radio') {
        const checked = node.querySelector('input[type="radio"]:checked');
        parts[partId] = checked ? checked.value : '';
      } else if (partType === 'checkbox') {
        const checked = Array.from(node.querySelectorAll('input[type="checkbox"]:checked')).map(
          (c) => c.value,
        );
        parts[partId] = checked.join(',');
      } else {
        const input = node.querySelector('input, select, textarea');
        parts[partId] = input ? input.value : '';
      }
    });
    return parts;
  }

  function updateLocalStatusUI(parts) {
    const vals = Object.values(parts);
    const nonBlank = vals.filter((v) => String(v || '').trim() !== '').length;
    const total = vals.length;
    if (stateLine) {
      stateLine.textContent =
        nonBlank === 0 ? 'Not yet answered' : nonBlank < total ? 'Incomplete answer' : 'Answer saved';
    }
    if (questionId) {
      const tile = document.querySelector(`.qnbutton[data-question-id="${questionId}"]`);
      if (tile) {
        tile.classList.remove('attempt-saved', 'attempt-incomplete');
        if (nonBlank === total && total > 0) tile.classList.add('attempt-saved');
        else if (nonBlank > 0) tile.classList.add('attempt-incomplete');
      }
    }
  }

  async function flushSave() {
    if (!questionId || !form) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const parts = collectPartValues();
    updateLocalStatusUI(parts);
    if (saveInd) saveInd.textContent = 'Saving...';
    dirty = false;

    const p = (async () => {
      try {
        const res = await fetch(`/api/attempts/${encodeURIComponent(attemptId)}/responses`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionId, parts }),
          keepalive: true,
        });
        const data = await res.json();
        if (data.expired) {
          window.location.href = `/practice/${encodeURIComponent(testId)}/attempt/${encodeURIComponent(attemptId)}/summary`;
          return;
        }
        if (saveInd) saveInd.textContent = 'Saved';
      } catch {
        if (saveInd) saveInd.textContent = 'Offline (will retry)';
      }
    })();

    inflightPromise = p;
    await p;
  }

  function scheduleSave() {
    dirty = true;
    const parts = collectPartValues();
    updateLocalStatusUI(parts);
    if (saveInd) saveInd.textContent = 'Saving...';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      flushSave();
    }, 350);
  }

  if (form) {
    form.addEventListener('input', scheduleSave);
    form.addEventListener('change', () => flushSave());
    form.addEventListener('focusout', () => {
      if (dirty) flushSave();
    });
  }

  // Intercept navigation links so pending edits are always saved before changing question/summary
  document.querySelectorAll('a[data-save-before-nav]').forEach((link) => {
    link.addEventListener('click', async (e) => {
      const href = link.getAttribute('href');
      if (!href || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (dirty) {
        await flushSave();
      } else if (inflightPromise) {
        await inflightPromise;
      }
      window.location.href = href;
    });
  });

  // ---------- Authoritative Server Countdown ----------
  const timerEl = document.getElementById('quiz-timer-value');
  const timerBox = document.getElementById('quiz-timer-box');
  const a11yLive = document.getElementById('timer-a11y-live');
  let announced5m = false;
  let announced1m = false;
  let expiring = false;

  function formatHMS(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  async function handleExpiry() {
    if (expiring) return;
    expiring = true;
    if (dirty) {
      try {
        await flushSave();
      } catch {
        // Ignore if already past deadline
      }
    }
    try {
      await fetch(`/api/attempts/${encodeURIComponent(attemptId)}/status`);
    } catch {
      // Ignore
    }
    window.location.href = `/practice/${encodeURIComponent(testId)}/attempt/${encodeURIComponent(attemptId)}/summary`;
  }

  function tickTimer() {
    if (!deadlineAt) return;
    const nowServer = Date.now() + clockOffsetMs;
    const remSec = Math.max(0, Math.ceil((deadlineAt - nowServer) / 1000));
    if (timerEl) timerEl.textContent = formatHMS(remSec);
    if (timerBox) {
      timerBox.classList.toggle('timer-warn', remSec > 60 && remSec <= 300);
      timerBox.classList.toggle('timer-danger', remSec <= 60);
    }
    if (remSec <= 300 && !announced5m) {
      announced5m = true;
      if (a11yLive) a11yLive.textContent = '5 minutes remaining in the quiz attempt.';
    }
    if (remSec <= 60 && !announced1m) {
      announced1m = true;
      if (a11yLive) a11yLive.textContent = '1 minute remaining in the quiz attempt.';
    }
    if (remSec <= 0) {
      handleExpiry();
    }
  }

  tickTimer();
  setInterval(tickTimer, 500);

  // Periodic server clock & status sync every 15s (survives background tab throttling)
  setInterval(async () => {
    try {
      const res = await fetch(`/api/attempts/${encodeURIComponent(attemptId)}/status`);
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.serverNow === 'number') {
        clockOffsetMs = data.serverNow - Date.now();
      }
      if (data.status !== 'in_progress') {
        window.location.href = `/practice/${encodeURIComponent(testId)}/attempt/${encodeURIComponent(attemptId)}/summary`;
      }
    } catch {
      // Ignore transient errors
    }
  }, 15000);
})();
