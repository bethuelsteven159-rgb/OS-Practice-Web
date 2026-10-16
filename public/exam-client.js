(() => {
  const SUPABASE_URL = 'https://jmlnhajwghcczyxqthsy.supabase.co';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImptbG5oYWp3Z2hjY3p5eHF0aHN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNzYyOTQsImV4cCI6MjEwNzc1MjI5NH0.CdnxAlPB1gb6W9yfXn4-d-6w-pSSiMLl07J1pphG-_c';
  const GOOGLE_CLIENT_ID =
    '978326581212-5d4k827fn4ao9ttd0nko2747scdndor4.apps.googleusercontent.com';
  const SESSION_KEY = 'os_practice_sb_session_v1';

  // ---------- Lightweight Supabase Auth & PostgREST Helper ----------
  function getSavedSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveSession(sess) {
    try {
      if (!sess) localStorage.removeItem(SESSION_KEY);
      else localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    } catch {
      // Ignore storage errors
    }
  }

  async function sbFetch(path, opts = {}) {
    const sess = getSavedSession();
    const token = opts.token || sess?.access_token || SUPABASE_ANON_KEY;
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    };
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      ...opts,
      headers,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  }

  async function fetchProfile(userId, accessToken) {
    const r = await sbFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`, {
      token: accessToken,
    });
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
      return r.data[0];
    }
    return null;
  }

  async function upsertProfile(userId, username, email, accessToken) {
    const cleanUsername = String(username || '')
      .replace(/^@/, '')
      .trim();
    const r = await sbFetch('/rest/v1/profiles?on_conflict=id', {
      method: 'POST',
      token: accessToken,
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        id: userId,
        username: cleanUsername,
        display_name: cleanUsername,
        email: email || null,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      const msg = r.data?.message || r.data?.details || 'Username is already taken or invalid.';
      throw new Error(msg);
    }
    return Array.isArray(r.data) ? r.data[0] : r.data;
  }

  function getInitials(name) {
    const clean = String(name || '').replace(/^@/, '').trim();
    if (!clean) return 'U';
    const parts = clean.split(/[\s._-]+/).filter(Boolean);
    return parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : clean.slice(0, 2).toUpperCase();
  }

  function renderNavbarUser() {
    const slot = document.getElementById('navbar-user-slot');
    if (!slot) return;
    const sess = getSavedSession();
    if (sess && sess.user && sess.username) {
      slot.innerHTML = `
        <span class="nav-publisher-pill" title="Logged in publisher username">@${sess.username}</span>
        <span class="user-menu" title="${sess.user.email || sess.username}">
          <span class="user-avatar">${getInitials(sess.username)}</span>
        </span>
        <button type="button" class="btn-moodle btn-sm-nav" data-signout-btn="1">Sign out</button>
      `;
      const pubInput = document.getElementById('publisherUsernameInput');
      if (pubInput && !pubInput.value) {
        pubInput.value = sess.username;
        pubInput.readOnly = true;
      }
      const guestBanner = document.getElementById('import-guest-banner');
      if (guestBanner) {
        guestBanner.className = 'alert-moodle alert-ok';
        guestBanner.innerHTML = `<div>Publishing as <strong>@${sess.username}</strong> — your test will be automatically published to all users upon import.</div>`;
      }
    } else {
      slot.innerHTML = `<a class="btn-moodle btn-moodle-primary btn-sm-nav" href="/login">Sign in / Register</a>`;
    }

    slot.querySelectorAll('[data-signout-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveSession(null);
        window.location.href = '/practice';
      });
    });
  }

  // Handle OAuth Redirect Hash (#access_token=...)
  async function checkOAuthRedirectHash() {
    const hash = window.location.hash || '';
    if (!hash.includes('access_token=')) return;
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken) return;

    history.replaceState(null, '', window.location.pathname + window.location.search);
    const uRes = await sbFetch('/auth/v1/user', { token: accessToken });
    if (!uRes.ok || !uRes.data?.id) return;

    const user = uRes.data;
    const prof = await fetchProfile(user.id, accessToken);
    saveSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      user,
      username: prof?.username || null,
    });
    renderNavbarUser();
    if (!prof?.username && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  }

  checkOAuthRedirectHash().then(() => {
    renderNavbarUser();
    initAuthPage();
  });

  // ---------- Publisher Filter Bar on /practice ----------
  const searchInput = document.getElementById('publisher-search-input');
  const selectInput = document.getElementById('publisher-select');
  const clearBtn = document.getElementById('publisher-clear-btn');
  const countEl = document.getElementById('publisher-filter-count');

  function applyPublisherFilter(rawQuery) {
    const q = String(rawQuery || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (searchInput && searchInput.value.replace(/^@/, '').toLowerCase() !== q) {
      searchInput.value = q;
    }
    if (selectInput) {
      const matchOpt = Array.from(selectInput.options).find((o) => o.value.toLowerCase() === q);
      selectInput.value = matchOpt ? matchOpt.value : '';
    }
    if (clearBtn) {
      clearBtn.style.display = q ? '' : 'none';
    }
    const rows = document.querySelectorAll('tr[data-test-row]');
    let visible = 0;
    rows.forEach((row) => {
      const pub = (row.getAttribute('data-publisher') || '').toLowerCase();
      const title = (row.getAttribute('data-title') || '').toLowerCase();
      const show = !q || pub.includes(q) || title.includes(q);
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    if (countEl && rows.length > 0) {
      countEl.innerHTML = `Showing <strong>${visible}</strong> of <strong>${rows.length}</strong> published test(s)`;
    }
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => applyPublisherFilter(searchInput.value));
  }
  if (selectInput) {
    selectInput.addEventListener('change', () => applyPublisherFilter(selectInput.value));
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => applyPublisherFilter(''));
  }
  document.querySelectorAll('[data-filter-publisher]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const pub = btn.getAttribute('data-filter-publisher') || '';
      applyPublisherFilter(pub);
    });
  });

  // ---------- Auth Page (/login) Interactions ----------
  function showAuthError(msg) {
    const el = document.getElementById('auth-error-box');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  function showCompleteUsernamePrompt(suggested) {
    const card = document.getElementById('complete-username-card');
    const mainPanels = document.getElementById('main-auth-panels');
    const input = document.getElementById('choose-username-input');
    if (card) card.style.display = '';
    if (mainPanels) mainPanels.style.display = 'none';
    if (input && suggested && !input.value) input.value = suggested;
  }

  async function handleGoogleCredentialResponse(response) {
    showAuthError('');
    try {
      const r = await sbFetch('/auth/v1/token?grant_type=id_token', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'google',
          id_token: response.credential,
        }),
      });
      if (!r.ok || !r.data?.access_token) {
        throw new Error(r.data?.error_description || r.data?.msg || 'Google sign-in failed.');
      }
      const { access_token, refresh_token, user } = r.data;
      const prof = await fetchProfile(user.id, access_token);
      saveSession({
        access_token,
        refresh_token,
        user,
        username: prof?.username || null,
      });
      renderNavbarUser();
      if (prof?.username) {
        window.location.href = '/practice?msg=' + encodeURIComponent(`Signed in as @${prof.username}`);
      } else {
        const suggested = (user.user_metadata?.full_name || user.email?.split('@')[0] || '')
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .toLowerCase();
        showCompleteUsernamePrompt(suggested);
      }
    } catch (err) {
      showAuthError(err.message || String(err));
    }
  }

  function initAuthPage() {
    const sess = getSavedSession();
    if (sess?.user && !sess?.username && document.getElementById('complete-username-card')) {
      const suggested = (sess.user.user_metadata?.full_name || sess.user.email?.split('@')[0] || '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .toLowerCase();
      showCompleteUsernamePrompt(suggested);
    }

    const gsiContainer = document.getElementById('google-gsi-button');
    if (gsiContainer && window.google?.accounts?.id) {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCredentialResponse,
      });
      window.google.accounts.id.renderButton(gsiContainer, {
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        width: 250,
      });
    }

    const oauthBtn = document.getElementById('google-oauth-btn');
    if (oauthBtn) {
      oauthBtn.addEventListener('click', () => {
        const redirectTo = window.location.origin + '/login';
        window.location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
      });
    }

    const usernameForm = document.getElementById('complete-username-form');
    if (usernameForm) {
      usernameForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        showAuthError('');
        const curSess = getSavedSession();
        if (!curSess?.user) {
          showAuthError('Please sign in first.');
          return;
        }
        const username = document.getElementById('choose-username-input')?.value?.trim() || '';
        try {
          const prof = await upsertProfile(curSess.user.id, username, curSess.user.email, curSess.access_token);
          curSess.username = prof.username;
          saveSession(curSess);
          renderNavbarUser();
          window.location.href = '/practice?msg=' + encodeURIComponent(`Welcome, @${prof.username}!`);
        } catch (err) {
          showAuthError(err.message || String(err));
        }
      });
    }

    const signInForm = document.getElementById('email-signin-form');
    if (signInForm) {
      signInForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        showAuthError('');
        const email = document.getElementById('signin-email')?.value?.trim() || '';
        const password = document.getElementById('signin-password')?.value || '';
        try {
          const r = await sbFetch('/auth/v1/token?grant_type=password', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          });
          if (!r.ok || !r.data?.access_token) {
            throw new Error(r.data?.error_description || r.data?.msg || 'Invalid email or password.');
          }
          const { access_token, refresh_token, user } = r.data;
          const prof = await fetchProfile(user.id, access_token);
          const fallbackUsername = user.user_metadata?.username || email.split('@')[0];
          if (!prof) {
            await upsertProfile(user.id, fallbackUsername, user.email, access_token);
          }
          const finalUsername = prof?.username || fallbackUsername;
          saveSession({ access_token, refresh_token, user, username: finalUsername });
          renderNavbarUser();
          window.location.href = '/practice?msg=' + encodeURIComponent(`Signed in as @${finalUsername}`);
        } catch (err) {
          showAuthError(err.message || String(err));
        }
      });
    }

    const regForm = document.getElementById('email-register-form');
    if (regForm) {
      regForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        showAuthError('');
        const username = document.getElementById('reg-username')?.value?.replace(/^@/, '').trim() || '';
        const email = document.getElementById('reg-email')?.value?.trim() || '';
        const password = document.getElementById('reg-password')?.value || '';
        if (username.length < 2) {
          showAuthError('Publisher username must be at least 2 characters.');
          return;
        }
        try {
          // Check if username is already taken
          const check = await sbFetch(`/rest/v1/profiles?username=ilike.${encodeURIComponent(username)}&select=id`);
          if (check.ok && Array.isArray(check.data) && check.data.length > 0) {
            throw new Error(`Username "@${username}" is already taken. Please choose another.`);
          }
          const r = await sbFetch('/auth/v1/signup', {
            method: 'POST',
            body: JSON.stringify({ email, password, data: { username } }),
          });
          if (!r.ok) {
            throw new Error(r.data?.msg || r.data?.error_description || 'Registration failed.');
          }
          const accessToken = r.data?.access_token;
          const refreshToken = r.data?.refresh_token;
          const user = r.data?.user || r.data;
          if (accessToken && user?.id) {
            await upsertProfile(user.id, username, email, accessToken);
            saveSession({ access_token: accessToken, refresh_token: refreshToken, user, username });
            renderNavbarUser();
            window.location.href = '/practice?msg=' + encodeURIComponent(`Registered and signed in as @${username}!`);
          } else {
            showAuthError('Account created! Please sign in on the left.');
          }
        } catch (err) {
          showAuthError(err.message || String(err));
        }
      });
    }
  }

  // ---------- Exam Attempt & Review Logic ----------
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
