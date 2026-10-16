/**
 * Builds a self-contained static SPA bundle in `dist/` for GitHub Pages deployment,
 * backed by live Supabase Auth (Google + Publisher Username), Community Published Tests,
 * and Cloud Attempt Progress Saving (`https://jmlnhajwghcczyxqthsy.supabase.co`).
 */

import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APP_DIR = path.join(DIST, 'app');
const PUB_DIR = path.join(DIST, 'public');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.mkdirSync(PUB_DIR, { recursive: true });

// 1. Copy static CSS
fs.copyFileSync(path.join(ROOT, 'public', 'moodle.css'), path.join(PUB_DIR, 'moodle.css'));

// 2. Strip TypeScript types from pure shared modules (`markup.ts`, `graders.ts`, `schema.ts`, `views.ts`)
const sharedModules = ['markup.ts', 'graders.ts', 'schema.ts', 'views.ts'];
for (const file of sharedModules) {
  const srcPath = path.join(ROOT, 'server', file);
  const rawTs = fs.readFileSync(srcPath, 'utf8');
  const stripped = module.stripTypeScriptTypes(rawTs, { mode: 'strip' });
  const browserJs = stripped
    .replace(/import\s*\{\s*\}\s*from\s*['"][^'"]+['"]\s*;?/g, '')
    .replace(/(from\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2');
  const outName = file.replace(/\.ts$/, '.js');
  fs.writeFileSync(path.join(APP_DIR, outName), browserJs, 'utf8');
}

// 3. Write BrowserExamStore (`dist/app/browser-store.js`) with live Supabase Cloud Sync
const browserStoreJs = `
import {
  parseTxtPayload,
  validatePublicPaper,
  validatePrivateMemo,
  round2,
} from './schema.js';
import {
  grade,
  isBlank,
  canonicalTyped,
  canonicalDisplay,
} from './graders.js';

export const SUPABASE_URL = 'https://jmlnhajwghcczyxqthsy.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImptbG5oYWp3Z2hjY3p5eHF0aHN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNzYyOTQsImV4cCI6MjEwNzc1MjI5NH0.CdnxAlPB1gb6W9yfXn4-d-6w-pSSiMLl07J1pphG-_c';
export const GOOGLE_CLIENT_ID = '978326581212-5d4k827fn4ao9ttd0nko2747scdndor4.apps.googleusercontent.com';

const STORAGE_KEY = 'os_practice_web_state_v2';
const SESSION_KEY = 'os_practice_sb_session_v1';

export function getSavedSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(sess) {
  try {
    if (!sess) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
  } catch {
    // Ignore storage errors
  }
}

export async function sbFetch(path, opts = {}) {
  const sess = getSavedSession();
  const token = opts.token || sess?.access_token || SUPABASE_ANON_KEY;
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: \`Bearer \${token}\`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const res = await fetch(\`\${SUPABASE_URL}\${path}\`, {
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

function randomHex(bytes = 8) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function buildAcceptedLine(part, pMemo) {
  if (pMemo.acceptedAnswerLine) {
    return {
      kind: 'typed',
      displayAnswer: canonicalDisplay(pMemo.grader),
      typedAnswer: canonicalTyped(pMemo.grader),
      overrideText: pMemo.acceptedAnswerLine,
    };
  }
  if (pMemo.grader.type === 'choice') {
    const opt = (part.choices || []).find((c) => c.id === pMemo.grader.answer);
    return {
      kind: 'choice',
      displayAnswer: opt ? opt.label : pMemo.grader.answer,
    };
  }
  if (pMemo.grader.type === 'multichoice') {
    const ansSet = new Set(pMemo.grader.answers);
    const labels = (part.choices || []).filter((c) => ansSet.has(c.id)).map((c) => c.label);
    return {
      kind: 'choice',
      displayAnswer: labels.join('; '),
    };
  }
  return {
    kind: 'typed',
    displayAnswer: canonicalDisplay(pMemo.grader),
    typedAnswer: canonicalTyped(pMemo.grader),
  };
}

export class BrowserExamStore {
  constructor() {
    this.state = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {
      // Ignore storage errors
    }
    return {
      tests: {},       // key: \`\${testId}@\${version}\` -> { paper, memo, importedAt, publisherUsername, publisherId }
      attempts: {},    // key: attemptId -> AttemptSummaryRow
      responses: {},   // key: attemptId -> { [questionId]: { [partId]: rawValue } }
      flags: {},       // key: attemptId -> { [questionId]: boolean }
      reviews: {},     // key: attemptId -> { [questionId]: QuestionReviewSnapshot }
    };
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore quota errors
    }
  }

  _testKey(testId, version) {
    return \`\${testId}@\${version}\`;
  }

  async syncFromSupabase() {
    try {
      // 1. Pull all community published tests
      const tRes = await sbFetch('/rest/v1/published_tests?select=*&order=created_at.asc', {
        token: SUPABASE_ANON_KEY,
      });
      if (tRes.ok && Array.isArray(tRes.data)) {
        for (const row of tRes.data) {
          const paper = row.public_payload;
          const memo = row.memo_payload;
          if (!paper || !paper.testId) continue;
          const key = this._testKey(paper.testId, paper.version || row.version || 1);
          this.state.tests[key] = {
            paper,
            memo: memo || null,
            importedAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
            publisherUsername: row.publisher_username || 'community',
            publisherId: row.publisher_id || null,
          };
        }
      }

      // 2. If signed in, pull user's cloud attempts
      const sess = getSavedSession();
      if (sess?.user?.id && sess?.access_token) {
        const aRes = await sbFetch(
          \`/rest/v1/user_attempts?user_id=eq.\${encodeURIComponent(sess.user.id)}&select=*&order=started_at.asc\`,
          { token: sess.access_token },
        );
        if (aRes.ok && Array.isArray(aRes.data)) {
          for (const row of aRes.data) {
            const attId = row.attempt_id;
            this.state.attempts[attId] = {
              attemptId: attId,
              testId: row.test_id,
              testVersion: Number(row.test_version || 1),
              startedAt: Number(row.started_at),
              deadlineAt: Number(row.deadline_at),
              submittedAt: row.submitted_at != null ? Number(row.submitted_at) : null,
              status: row.status,
              marksAwarded: row.marks_awarded != null ? Number(row.marks_awarded) : null,
              totalMarks: Number(row.total_marks),
            };
            if (row.responses_json && typeof row.responses_json === 'object') {
              this.state.responses[attId] = row.responses_json;
            }
            if (row.flags_json && typeof row.flags_json === 'object') {
              this.state.flags[attId] = row.flags_json;
            }
            if (row.review_json && typeof row.review_json === 'object') {
              this.state.reviews[attId] = row.review_json;
            }
          }
        }
      }
      this._save();
    } catch {
      // Offline fallback uses local state
    }
  }

  async publishTestToSupabase(paper, memo, publisherUsername, publisherId) {
    const sess = getSavedSession();
    const pubUser = (publisherUsername || sess?.username || 'community').replace(/^@/, '').trim() || 'community';
    const pubId = publisherId || sess?.user?.id || null;
    try {
      const res = await sbFetch('/rest/v1/published_tests?on_conflict=test_id,version', {
        method: 'POST',
        token: sess?.access_token || SUPABASE_ANON_KEY,
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          test_id: paper.testId,
          version: paper.version,
          title: paper.title,
          course_name: paper.courseName || null,
          section_name: paper.sectionName || null,
          duration_seconds: paper.durationSeconds,
          total_marks: paper.totalMarks,
          question_count: paper.questions.length,
          public_payload: paper,
          memo_payload: memo,
          publisher_id: pubId,
          publisher_username: pubUser,
          updated_at: new Date().toISOString(),
        }),
      });
      return { ok: res.ok, data: res.data };
    } catch {
      return { ok: false };
    }
  }

  async syncAttemptToSupabase(attemptId) {
    const sess = getSavedSession();
    if (!sess?.user?.id || !sess?.access_token) return;
    const att = this.state.attempts[attemptId];
    if (!att) return;
    try {
      await sbFetch('/rest/v1/user_attempts?on_conflict=attempt_id', {
        method: 'POST',
        token: sess.access_token,
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          attempt_id: att.attemptId,
          user_id: sess.user.id,
          test_id: att.testId,
          test_version: att.testVersion,
          started_at: att.startedAt,
          deadline_at: att.deadlineAt,
          submitted_at: att.submittedAt,
          status: att.status,
          marks_awarded: att.marksAwarded,
          total_marks: att.totalMarks,
          responses_json: this.state.responses[attemptId] || {},
          flags_json: this.state.flags[attemptId] || {},
          review_json: this.state.reviews[attemptId] || {},
          updated_at: new Date().toISOString(),
        }),
      });
    } catch {
      // Ignore transient network errors
    }
  }

  importPublicTxt(rawTxt, publisherUsername = 'community', publisherId = null) {
    const parsed = parseTxtPayload(rawTxt);
    if (!parsed.ok) return { ok: false, errors: [parsed.error], warnings: [] };
    const v = validatePublicPaper(parsed.data);
    if (!v.ok || !v.paper) return v;

    const p = v.paper;
    const key = this._testKey(p.testId, p.version);
    const existing = this.state.tests[key];
    this.state.tests[key] = {
      paper: p,
      memo: existing ? existing.memo : null,
      importedAt: Date.now(),
      publisherUsername: (publisherUsername || 'community').replace(/^@/, '').trim() || 'community',
      publisherId: publisherId || null,
    };
    this._save();
    return v;
  }

  importPrivateMemoTxt(rawTxt) {
    const parsed = parseTxtPayload(rawTxt);
    if (!parsed.ok) return { ok: false, errors: [parsed.error], warnings: [] };

    const rawObj = parsed.data || {};
    const testId = typeof rawObj.testId === 'string' ? rawObj.testId : '';
    const version = Number(rawObj.version ?? 1);

    const publicPaper = testId ? this.getPublicPaper(testId, version) : null;
    if (!publicPaper) {
      return {
        ok: false,
        errors: [
          \`Cannot import private memo: public questions for testId="\${testId}" version=\${version} have not been imported yet. Import the public questions file first or together with the memo.\`,
        ],
        warnings: [],
      };
    }

    const v = validatePrivateMemo(parsed.data, publicPaper);
    if (!v.ok || !v.memo) return v;

    const key = this._testKey(v.memo.testId, v.memo.version);
    this.state.tests[key].memo = v.memo;
    this._save();
    return v;
  }

  importPairTxt(publicTxt, memoTxt, publisherUsername = 'community', publisherId = null) {
    const pubParsed = parseTxtPayload(publicTxt);
    if (!pubParsed.ok) return { ok: false, errors: [\`Public file: \${pubParsed.error}\`], warnings: [] };
    const pubVal = validatePublicPaper(pubParsed.data);
    if (!pubVal.ok || !pubVal.paper) {
      return {
        ok: false,
        errors: pubVal.errors.map((e) => \`Public file: \${e}\`),
        warnings: pubVal.warnings,
      };
    }

    const memoParsed = parseTxtPayload(memoTxt);
    if (!memoParsed.ok) return { ok: false, errors: [\`Private memo: \${memoParsed.error}\`], warnings: [] };
    const memoVal = validatePrivateMemo(memoParsed.data, pubVal.paper);
    if (!memoVal.ok || !memoVal.memo) {
      return {
        ok: false,
        errors: memoVal.errors.map((e) => \`Private memo: \${e}\`),
        warnings: [...pubVal.warnings, ...memoVal.warnings],
      };
    }

    this.importPublicTxt(publicTxt, publisherUsername, publisherId);
    this.importPrivateMemoTxt(memoTxt);
    this.publishTestToSupabase(pubVal.paper, memoVal.memo, publisherUsername, publisherId);
    return {
      ok: true,
      errors: [],
      warnings: [...pubVal.warnings, ...memoVal.warnings],
      paper: pubVal.paper,
      memo: memoVal.memo,
    };
  }

  SweepExpiredAttempts(now = Date.now()) {
    let changed = false;
    for (const att of Object.values(this.state.attempts)) {
      if (att.status === 'in_progress' && att.deadlineAt <= now) {
        this._finalizeAttempt(att.attemptId, 'timed_out', att.deadlineAt);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  listTests(now = Date.now()) {
    this.SweepExpiredAttempts(now);
    const entries = Object.values(this.state.tests);
    entries.sort((a, b) => {
      if (a.importedAt !== b.importedAt) return a.importedAt - b.importedAt;
      if (a.paper.testId !== b.paper.testId) return a.paper.testId.localeCompare(b.paper.testId);
      return b.paper.version - a.paper.version;
    });

    return entries.map((entry) => {
      const p = entry.paper;
      return {
        testId: p.testId,
        version: p.version,
        title: p.title,
        courseName: p.courseName ?? null,
        sectionName: p.sectionName ?? null,
        durationSeconds: p.durationSeconds,
        totalMarks: p.totalMarks,
        questionCount: p.questions.length,
        hasMemo: Boolean(entry.memo),
        isFixture: Boolean(p.isFixture),
        importedAt: entry.importedAt,
        publisherUsername: entry.publisherUsername || 'community',
        publisherId: entry.publisherId || null,
        attempts: this.listAttemptsForTest(p.testId, p.version),
      };
    });
  }

  listAttemptsForTest(testId, version) {
    return Object.values(this.state.attempts)
      .filter((a) => a.testId === testId && (version === undefined || a.testVersion === version))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  getLatestVersion(testId) {
    const versions = Object.values(this.state.tests)
      .filter((t) => t.paper.testId === testId)
      .map((t) => t.paper.version);
    return versions.length > 0 ? Math.max(...versions) : null;
  }

  getPublicPaper(testId, version) {
    const v = version ?? this.getLatestVersion(testId);
    if (v == null) return null;
    const entry = this.state.tests[this._testKey(testId, v)];
    if (!entry) return null;
    const copy = JSON.parse(JSON.stringify(entry.paper));
    copy.questions.sort((a, b) => a.number - b.number);
    return copy;
  }

  hasPrivateMemo(testId, version) {
    const v = version ?? this.getLatestVersion(testId);
    if (v == null) return false;
    const entry = this.state.tests[this._testKey(testId, v)];
    return Boolean(entry && entry.memo);
  }

  startAttempt(testId, version, now = Date.now()) {
    const v = version ?? this.getLatestVersion(testId);
    if (v == null) throw new Error(\`Test "\${testId}" not found.\`);
    const paper = this.getPublicPaper(testId, v);
    if (!paper) throw new Error(\`Test "\${testId}" v\${v} not found.\`);
    if (!this.hasPrivateMemo(testId, v)) {
      throw new Error(
        \`Cannot start a graded attempt for "\${paper.title}": the matching private memo has not been imported yet.\`,
      );
    }

    this.SweepExpiredAttempts(now);

    const attemptId = randomHex(8);
    const startedAt = now;
    const deadlineAt = startedAt + Math.round(paper.durationSeconds * 1000);

    const att = {
      attemptId,
      testId,
      testVersion: v,
      startedAt,
      deadlineAt,
      submittedAt: null,
      status: 'in_progress',
      marksAwarded: null,
      totalMarks: paper.totalMarks,
    };

    this.state.attempts[attemptId] = att;
    this.state.responses[attemptId] = {};
    this.state.flags[attemptId] = {};
    for (const q of paper.questions) {
      this.state.flags[attemptId][q.id] = false;
    }
    this._save();
    this.syncAttemptToSupabase(attemptId);
    return att;
  }

  getAttempt(attemptId, now = Date.now()) {
    const att = this.state.attempts[attemptId];
    if (!att) return null;
    if (att.status === 'in_progress' && now >= att.deadlineAt) {
      this._finalizeAttempt(attemptId, 'timed_out', att.deadlineAt);
    }
    return this.state.attempts[attemptId] || null;
  }

  saveResponses(attemptId, questionId, parts, now = Date.now()) {
    const att = this.getAttempt(attemptId, now);
    if (!att) throw new Error('Attempt not found.');
    if (att.status !== 'in_progress') {
      return { ok: false, expired: att.status === 'timed_out', revision: 0, savedAt: now };
    }
    const paper = this.getPublicPaper(att.testId, att.testVersion);
    const q = paper?.questions.find((x) => x.id === questionId);
    if (!q) throw new Error(\`Question "\${questionId}" not found.\`);

    const validPartIds = new Set(q.parts.map((p) => p.id));
    if (!this.state.responses[attemptId]) this.state.responses[attemptId] = {};
    if (!this.state.responses[attemptId][questionId]) this.state.responses[attemptId][questionId] = {};

    for (const [partId, val] of Object.entries(parts)) {
      if (!validPartIds.has(partId)) continue;
      this.state.responses[attemptId][questionId][partId] = String(val ?? '');
    }
    this._save();
    this.syncAttemptToSupabase(attemptId);
    return { ok: true, revision: 1, savedAt: now };
  }

  toggleFlag(attemptId, questionId, flagged) {
    const att = this.state.attempts[attemptId];
    if (!att) throw new Error('Attempt not found.');
    if (!this.state.flags[attemptId]) this.state.flags[attemptId] = {};
    const cur = Boolean(this.state.flags[attemptId][questionId]);
    const next = flagged !== undefined ? Boolean(flagged) : !cur;
    this.state.flags[attemptId][questionId] = next;
    this._save();
    this.syncAttemptToSupabase(attemptId);
    return next;
  }

  getAttemptResponses(attemptId) {
    return this.state.responses[attemptId] || {};
  }

  getAttemptFlags(attemptId) {
    return this.state.flags[attemptId] || {};
  }

  submitAttempt(attemptId, now = Date.now()) {
    const att = this.getAttempt(attemptId, now);
    if (!att) throw new Error('Attempt not found.');
    if (att.status !== 'in_progress') return att;
    return this._finalizeAttempt(attemptId, 'submitted', now);
  }

  _finalizeAttempt(attemptId, finalStatus, submittedAt) {
    const att = this.state.attempts[attemptId];
    if (!att || att.status !== 'in_progress') return att;

    const entry = this.state.tests[this._testKey(att.testId, att.testVersion)];
    if (!entry || !entry.paper || !entry.memo) {
      throw new Error('Test paper or private memo missing during grading.');
    }

    const paper = entry.paper;
    const memoByQ = entry.memo.questions;
    const responses = this.getAttemptResponses(attemptId);
    const reviewByQ = {};
    let totalAwarded = 0;

    for (const q of paper.questions) {
      const qMemo = memoByQ[q.id];
      const qResp = responses[q.id] || {};
      const partSnapshots = {};
      let qAwarded = 0;
      let anyAnswered = false;

      for (const part of q.parts) {
        const pMemo = qMemo.parts[part.id];
        const rawVal = qResp[part.id] ?? '';
        if (!isBlank(rawVal)) anyAnswered = true;

        const choiceIds = part.choices?.map((c) => c.id);
        const gRes = grade(pMemo.grader, rawVal, { choiceIds });
        const pts = round2(Math.min(part.marks, Math.max(0, gRes.fraction * part.marks)));
        qAwarded += pts;

        partSnapshots[part.id] = {
          partId: part.id,
          label: part.label,
          state: gRes.state,
          pointsAwarded: pts,
          pointsPossible: part.marks,
          rawValue: rawVal,
          normalizedValue: gRes.normalized,
          messages: gRes.messages,
          listMarks: gRes.listMarks,
          feedback: pMemo.feedback,
          acceptedLine: buildAcceptedLine(part, pMemo),
        };
      }

      qAwarded = round2(Math.min(q.marks, Math.max(0, qAwarded)));
      totalAwarded += qAwarded;

      const qState =
        qAwarded >= q.marks - 1e-6
          ? 'correct'
          : qAwarded > 0
            ? 'partial'
            : anyAnswered
              ? 'incorrect'
              : 'unanswered';

      reviewByQ[q.id] = {
        questionId: q.id,
        number: q.number,
        state: qState,
        pointsAwarded: qAwarded,
        pointsPossible: q.marks,
        solution: qMemo.solution,
        comment: qMemo.comment,
        parts: partSnapshots,
      };
    }

    att.status = finalStatus;
    att.submittedAt = submittedAt;
    att.marksAwarded = round2(totalAwarded);
    this.state.reviews[attemptId] = reviewByQ;
    this._save();
    this.syncAttemptToSupabase(attemptId);
    return att;
  }

  getReviewSnapshots(attemptId, now = Date.now()) {
    const att = this.getAttempt(attemptId, now);
    if (!att) throw new Error('Attempt not found.');
    if (att.status === 'in_progress') {
      throw new Error('Forbidden: review data is locked while the attempt is in progress.');
    }
    return this.state.reviews[attemptId] || {};
  }
}
`;
fs.writeFileSync(path.join(APP_DIR, 'browser-store.js'), browserStoreJs.trimStart(), 'utf8');

// 4. Write SPA Router & Client Controller (`dist/app/main.js`)
const mainJs = `
import {
  BrowserExamStore,
  SUPABASE_URL,
  GOOGLE_CLIENT_ID,
  getSavedSession,
  saveSession,
  sbFetch,
} from './browser-store.js';
import {
  renderLibraryPage,
  renderImportPage,
  renderAuthPage,
  renderTestSummaryPage,
  renderQuestionPage,
  renderFinishConfirmPage,
  GUIDE_DOWNLOAD_TEXT,
  SAMPLE_PUBLIC_TEMPLATE,
  SAMPLE_MEMO_TEMPLATE,
} from './views.js';

const cfg = {
  port: 3000,
  host: '127.0.0.1',
  dbPath: 'localStorage',
  siteShortName: 'MS',
  userInitials: 'U',
  courseName: 'COMS3010A-OS-SM2-2026',
  sectionName: 'Practice tests',
  uiScale: 0.8,
  locale: 'en-GB',
  timeZone: '',
};

const store = new BrowserExamStore();
let activeIntervals = [];

function getCurrentUserInfo() {
  const sess = getSavedSession();
  if (sess && sess.user && sess.username) {
    return {
      id: sess.user.id,
      username: sess.username,
      email: sess.user.email,
    };
  }
  return null;
}

function clearActiveIntervals() {
  for (const id of activeIntervals) clearInterval(id);
  activeIntervals = [];
}

setInterval(() => {
  store.SweepExpiredAttempts(Date.now());
}, 1000);

function getRoutePath() {
  const hash = window.location.hash;
  if (hash && hash.startsWith('#/')) {
    return hash.slice(1);
  }
  return '/practice';
}

function navigateTo(pathWithQuery, replace = false) {
  const targetHash = '#' + (pathWithQuery.startsWith('/') ? pathWithQuery : '/' + pathWithQuery);
  if (replace) {
    history.replaceState(null, '', targetHash);
    renderCurrentRoute();
  } else if (window.location.hash === targetHash) {
    renderCurrentRoute();
  } else {
    window.location.hash = targetHash;
  }
}

function triggerTextDownload(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderHtmlStringToDom(htmlStr) {
  clearActiveIntervals();
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlStr, 'text/html');
  document.title = doc.title || 'OS Practice Quizzes';

  doc.querySelectorAll('script').forEach((s) => s.remove());

  doc.querySelectorAll('a[href^="/"]').forEach((a) => {
    if (a.hasAttribute('data-download-guide')) return;
    const rawHref = a.getAttribute('href');
    if (rawHref) {
      a.setAttribute('data-route-href', rawHref);
      a.setAttribute('href', '#' + rawHref);
    }
  });

  document.body.innerHTML = doc.body.innerHTML;
  window.scrollTo(0, 0);
  initExamPageInteractions();
}

function renderCurrentRoute() {
  const rawRoute = getRoutePath();
  const url = new URL(rawRoute, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const now = Date.now();
  const currentUser = getCurrentUserInfo();

  if (pathname === '/' || pathname === '/practice') {
    const msg = url.searchParams.get('msg') ?? undefined;
    const publisher = url.searchParams.get('publisher') ?? undefined;
    const tests = store.listTests(now);
    renderHtmlStringToDom(renderLibraryPage(cfg, tests, now, msg, publisher, currentUser));
    return;
  }

  if (pathname === '/login') {
    const sess = getSavedSession();
    const needsUsernameOnly = Boolean(sess?.user && !sess?.username);
    const suggestedUsername = (sess?.user?.user_metadata?.full_name || sess?.user?.email?.split('@')[0] || '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .toLowerCase();
    renderHtmlStringToDom(
      renderAuthPage(cfg, {
        needsUsernameOnly,
        suggestedUsername,
        currentUser,
      }),
    );
    return;
  }

  if (pathname === '/import') {
    renderHtmlStringToDom(renderImportPage(cfg, undefined, currentUser));
    return;
  }

  const startMatch = /^\\/practice\\/([^/]+)\\/start$/.exec(pathname);
  if (startMatch) {
    const testId = startMatch[1];
    const reqVersion = url.searchParams.get('version') ? Number(url.searchParams.get('version')) : undefined;
    const paper = store.getPublicPaper(testId, reqVersion);
    if (!paper) {
      navigateTo('/practice', true);
      return;
    }
    store.SweepExpiredAttempts(now);
    const attempts = store.listAttemptsForTest(testId, paper.version);
    const hasMemo = store.hasPrivateMemo(testId, paper.version);
    renderHtmlStringToDom(
      renderTestSummaryPage({
        cfg,
        paper,
        attempts,
        hasMemo,
        serverNow: now,
      }),
    );
    return;
  }

  const bareQMatch = /^\\/practice\\/([^/]+)\\/question\\/\\d+$/.exec(pathname);
  if (bareQMatch) {
    navigateTo(\`/practice/\${encodeURIComponent(bareQMatch[1])}/start\`, true);
    return;
  }

  const attemptQMatch = /^\\/practice\\/([^/]+)\\/attempt\\/([^/]+)\\/(?:question|attempt)\\/(\\d+)$/.exec(pathname);
  if (attemptQMatch) {
    const [, testId, attemptId, qNumStr] = attemptQMatch;
    const att = store.getAttempt(attemptId, now);
    if (!att || att.testId !== testId) {
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/start\`, true);
      return;
    }
    if (att.status !== 'in_progress') {
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/attempt/\${encodeURIComponent(attemptId)}/summary\`, true);
      return;
    }
    const paper = store.getPublicPaper(att.testId, att.testVersion);
    if (!paper) {
      navigateTo('/practice', true);
      return;
    }
    const qNum = Number(qNumStr);
    const question = paper.questions.find((q) => q.number === qNum) ?? paper.questions[0];
    const responses = store.getAttemptResponses(attemptId);
    const flags = store.getAttemptFlags(attemptId);

    renderHtmlStringToDom(
      renderQuestionPage({
        cfg,
        mode: 'attempt',
        paper,
        attempt: att,
        question,
        responses,
        flags,
        serverNow: now,
      }),
    );
    return;
  }

  const finishMatch = /^\\/practice\\/([^/]+)\\/attempt\\/([^/]+)\\/finish$/.exec(pathname);
  if (finishMatch) {
    const [, testId, attemptId] = finishMatch;
    const att = store.getAttempt(attemptId, now);
    if (!att || att.testId !== testId) {
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/start\`, true);
      return;
    }
    if (att.status !== 'in_progress') {
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/attempt/\${encodeURIComponent(attemptId)}/summary\`, true);
      return;
    }
    const paper = store.getPublicPaper(att.testId, att.testVersion);
    const responses = store.getAttemptResponses(attemptId);
    const flags = store.getAttemptFlags(attemptId);

    renderHtmlStringToDom(
      renderFinishConfirmPage({
        cfg,
        paper,
        attempt: att,
        responses,
        flags,
        serverNow: now,
      }),
    );
    return;
  }

  const summaryMatch = /^\\/practice\\/([^/]+)\\/attempt\\/([^/]+)\\/summary$/.exec(pathname);
  if (summaryMatch) {
    const [, testId, attemptId] = summaryMatch;
    const att = store.getAttempt(attemptId, now);
    if (!att || att.testId !== testId) {
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/start\`, true);
      return;
    }
    if (att.status === 'in_progress') {
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/attempt/\${encodeURIComponent(attemptId)}/finish\`, true);
      return;
    }
    const paper = store.getPublicPaper(att.testId, att.testVersion);
    const attempts = store.listAttemptsForTest(testId, att.testVersion);
    const hasMemo = store.hasPrivateMemo(testId, att.testVersion);

    renderHtmlStringToDom(
      renderTestSummaryPage({
        cfg,
        paper,
        attempts,
        focusedAttempt: att,
        hasMemo,
        serverNow: now,
      }),
    );
    return;
  }

  const reviewQMatch = /^\\/practice\\/([^/]+)\\/attempt\\/([^/]+)\\/review\\/(\\d+)$/.exec(pathname);
  if (reviewQMatch) {
    const [, testId, attemptId, qNumStr] = reviewQMatch;
    const att = store.getAttempt(attemptId, now);
    if (!att || att.testId !== testId) {
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/start\`, true);
      return;
    }
    if (att.status === 'in_progress') {
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/attempt/\${encodeURIComponent(attemptId)}/question/1\`, true);
      return;
    }
    const paper = store.getPublicPaper(att.testId, att.testVersion);
    const qNum = Number(qNumStr);
    const question = paper.questions.find((q) => q.number === qNum) ?? paper.questions[0];
    const responses = store.getAttemptResponses(attemptId);
    const flags = store.getAttemptFlags(attemptId);
    const reviewSnapshots = store.getReviewSnapshots(attemptId, now);

    renderHtmlStringToDom(
      renderQuestionPage({
        cfg,
        mode: 'review',
        paper,
        attempt: att,
        question,
        responses,
        flags,
        reviewSnapshots,
        serverNow: now,
      }),
    );
    return;
  }

  navigateTo('/practice', true);
}

async function fetchProfile(userId, accessToken) {
  const r = await sbFetch(\`/rest/v1/profiles?id=eq.\${encodeURIComponent(userId)}&select=*\`, {
    token: accessToken,
  });
  if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
    return r.data[0];
  }
  return null;
}

async function upsertProfile(userId, username, email, accessToken) {
  const cleanUsername = String(username || '').replace(/^@/, '').trim();
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

function initExamPageInteractions() {
  // Sign out button
  document.querySelectorAll('[data-signout-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      saveSession(null);
      navigateTo('/practice?msg=' + encodeURIComponent('Signed out.'));
    });
  });

  // Download guide / template buttons
  document.querySelectorAll('[data-download-guide]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const kind = btn.getAttribute('data-download-guide') || 'full';
      if (kind === 'public') {
        triggerTextDownload('sample.public.txt', SAMPLE_PUBLIC_TEMPLATE);
      } else if (kind === 'memo') {
        triggerTextDownload('sample.memo.txt', SAMPLE_MEMO_TEMPLATE);
      } else {
        triggerTextDownload('TEST_CREATION_GUIDE.txt', GUIDE_DOWNLOAD_TEXT);
      }
    });
  });

  // Publisher Filter Bar
  const searchInput = document.getElementById('publisher-search-input');
  const selectInput = document.getElementById('publisher-select');
  const clearBtn = document.getElementById('publisher-clear-btn');
  const countEl = document.getElementById('publisher-filter-count');

  function applyPublisherFilter(rawQuery) {
    const q = String(rawQuery || '').trim().replace(/^@/, '').toLowerCase();
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
      countEl.innerHTML = \`Showing <strong>\${visible}</strong> of <strong>\${rows.length}</strong> published test(s)\`;
    }
  }

  if (searchInput) searchInput.addEventListener('input', () => applyPublisherFilter(searchInput.value));
  if (selectInput) selectInput.addEventListener('change', () => applyPublisherFilter(selectInput.value));
  if (clearBtn) clearBtn.addEventListener('click', () => applyPublisherFilter(''));
  document.querySelectorAll('[data-filter-publisher]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      applyPublisherFilter(btn.getAttribute('data-filter-publisher') || '');
    });
  });

  // Auth page interactions
  const gsiContainer = document.getElementById('google-gsi-button');
  if (gsiContainer && window.google?.accounts?.id) {
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response) => {
        const errBox = document.getElementById('auth-error-box');
        if (errBox) errBox.style.display = 'none';
        try {
          const r = await sbFetch('/auth/v1/token?grant_type=id_token', {
            method: 'POST',
            body: JSON.stringify({ provider: 'google', id_token: response.credential }),
          });
          if (!r.ok || !r.data?.access_token) {
            throw new Error(r.data?.error_description || r.data?.msg || 'Google sign-in failed.');
          }
          const { access_token, refresh_token, user } = r.data;
          const prof = await fetchProfile(user.id, access_token);
          saveSession({ access_token, refresh_token, user, username: prof?.username || null });
          await store.syncFromSupabase();
          if (prof?.username) {
            navigateTo('/practice?msg=' + encodeURIComponent(\`Signed in as @\${prof.username}\`));
          } else {
            navigateTo('/login');
          }
        } catch (err) {
          if (errBox) {
            errBox.textContent = err.message || String(err);
            errBox.style.display = '';
          }
        }
      },
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
      const redirectTo = window.location.origin + window.location.pathname;
      window.location.href = \`\${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=\${encodeURIComponent(redirectTo)}\`;
    });
  }

  const usernameForm = document.getElementById('complete-username-form');
  if (usernameForm) {
    usernameForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('auth-error-box');
      if (errBox) errBox.style.display = 'none';
      const curSess = getSavedSession();
      if (!curSess?.user) return;
      const username = document.getElementById('choose-username-input')?.value?.trim() || '';
      try {
        const prof = await upsertProfile(curSess.user.id, username, curSess.user.email, curSess.access_token);
        curSess.username = prof.username;
        saveSession(curSess);
        await store.syncFromSupabase();
        navigateTo('/practice?msg=' + encodeURIComponent(\`Welcome, @\${prof.username}!\`));
      } catch (err) {
        if (errBox) {
          errBox.textContent = err.message || String(err);
          errBox.style.display = '';
        }
      }
    });
  }

  const signInForm = document.getElementById('email-signin-form');
  if (signInForm) {
    signInForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('auth-error-box');
      if (errBox) errBox.style.display = 'none';
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
        await store.syncFromSupabase();
        navigateTo('/practice?msg=' + encodeURIComponent(\`Signed in as @\${finalUsername}\`));
      } catch (err) {
        if (errBox) {
          errBox.textContent = err.message || String(err);
          errBox.style.display = '';
        }
      }
    });
  }

  const regForm = document.getElementById('email-register-form');
  if (regForm) {
    regForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('auth-error-box');
      if (errBox) errBox.style.display = 'none';
      const username = document.getElementById('reg-username')?.value?.replace(/^@/, '').trim() || '';
      const email = document.getElementById('reg-email')?.value?.trim() || '';
      const password = document.getElementById('reg-password')?.value || '';
      try {
        const check = await sbFetch(\`/rest/v1/profiles?username=ilike.\${encodeURIComponent(username)}&select=id\`);
        if (check.ok && Array.isArray(check.data) && check.data.length > 0) {
          throw new Error(\`Username "@\${username}" is already taken. Please choose another.\`);
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
          await store.syncFromSupabase();
          navigateTo('/practice?msg=' + encodeURIComponent(\`Registered and signed in as @\${username}!\`));
        }
      } catch (err) {
        if (errBox) {
          errBox.textContent = err.message || String(err);
          errBox.style.display = '';
        }
      }
    });
  }

  const root = document.querySelector('[data-exam-page]');
  if (!root) return;

  const mode = root.getAttribute('data-mode');
  const attemptId = root.getAttribute('data-attempt-id');
  const questionId = root.getAttribute('data-question-id');
  const testId = root.getAttribute('data-test-id');
  const deadlineAt = Number(root.getAttribute('data-deadline-at') || '0');

  // Mobile drawer toggle
  const drawer = document.getElementById('moodle-right-drawer');
  const openBtn = document.getElementById('mobile-drawer-toggle');
  const closeBtn = document.getElementById('drawer-close-btn');
  if (openBtn && drawer) {
    openBtn.addEventListener('click', () => drawer.classList.toggle('drawer-open'));
  }
  if (closeBtn && drawer) {
    closeBtn.addEventListener('click', () => drawer.classList.remove('drawer-open'));
  }

  // Flag question toggle
  const flagBtn = document.getElementById('flag-question-btn');
  if (flagBtn && attemptId && questionId) {
    flagBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const flagged = store.toggleFlag(attemptId, questionId);
      flagBtn.setAttribute('aria-pressed', flagged ? 'true' : 'false');
      const labelEl = flagBtn.querySelector('.flag-label');
      if (labelEl) labelEl.textContent = flagged ? 'Remove flag' : 'Flag question';
      const svgPoly = flagBtn.querySelector('path.flag-fill');
      if (svgPoly) {
        svgPoly.setAttribute('fill', flagged ? '#CA3120' : 'none');
        svgPoly.setAttribute('stroke', flagged ? '#CA3120' : '#0F6CBF');
      }
      const navTile = document.querySelector(\`.qnbutton[data-question-id="\${questionId}"]\`);
      if (navTile) {
        navTile.classList.toggle('flagged', Boolean(flagged));
      }
    });
  }

  if (mode !== 'attempt' || !attemptId) return;

  const saveInd = document.getElementById('autosave-indicator');
  const stateLine = document.getElementById('que-state-line');
  const form = document.getElementById('question-attempt-form');
  let dirty = false;
  let saveTimer = null;

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
        const checked = Array.from(node.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);
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
      const tile = document.querySelector(\`.qnbutton[data-question-id="\${questionId}"]\`);
      if (tile) {
        tile.classList.remove('attempt-saved', 'attempt-incomplete');
        if (nonBlank === total && total > 0) tile.classList.add('attempt-saved');
        else if (nonBlank > 0) tile.classList.add('attempt-incomplete');
      }
    }
  }

  function flushSave() {
    if (!questionId || !form) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const parts = collectPartValues();
    updateLocalStatusUI(parts);
    dirty = false;
    const saved = store.saveResponses(attemptId, questionId, parts, Date.now());
    if (saved.expired) {
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/attempt/\${encodeURIComponent(attemptId)}/summary\`);
      return;
    }
    if (saveInd) saveInd.textContent = 'Saved';
  }

  function scheduleSave() {
    dirty = true;
    const parts = collectPartValues();
    updateLocalStatusUI(parts);
    if (saveInd) saveInd.textContent = 'Saving...';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      flushSave();
    }, 250);
  }

  if (form) {
    form.addEventListener('input', scheduleSave);
    form.addEventListener('change', () => flushSave());
    form.addEventListener('focusout', () => {
      if (dirty) flushSave();
    });
  }

  document.querySelectorAll('a[data-save-before-nav]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const routeHref = link.getAttribute('data-route-href');
      if (!routeHref || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (dirty) flushSave();
      navigateTo(routeHref);
    });
  });

  // Countdown timer
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
    return \`\${hrs}:\${String(mins).padStart(2, '0')}:\${String(secs).padStart(2, '0')}\`;
  }

  function tickTimer() {
    if (!deadlineAt) return;
    const remSec = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
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
    if (remSec <= 0 && !expiring) {
      expiring = true;
      if (dirty) flushSave();
      store.SweepExpiredAttempts(Date.now());
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/attempt/\${encodeURIComponent(attemptId)}/summary\`);
    }
  }

  tickTimer();
  activeIntervals.push(setInterval(tickTimer, 500));
}

// Intercept internal link clicks (for links without data-save-before-nav)
document.addEventListener('click', (e) => {
  const link = e.target instanceof Element ? e.target.closest('a[data-route-href]') : null;
  if (!link || link.hasAttribute('data-save-before-nav')) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  const routeHref = link.getAttribute('data-route-href');
  if (!routeHref) return;
  e.preventDefault();
  navigateTo(routeHref);
});

// Intercept POST form submissions globally
document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (
    form.id === 'complete-username-form' ||
    form.id === 'email-signin-form' ||
    form.id === 'email-register-form' ||
    form.id === 'question-attempt-form'
  ) {
    return;
  }
  e.preventDefault();

  const rawAction = form.getAttribute('action') || '';
  const url = new URL(rawAction, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const now = Date.now();
  const currentUser = getCurrentUserInfo();

  if (pathname === '/import') {
    const pubFileInput = form.querySelector('input[name="publicFile"]');
    const memoFileInput = form.querySelector('input[name="memoFile"]');
    const pubTextInput = form.querySelector('textarea[name="publicText"]');
    const memoTextInput = form.querySelector('textarea[name="memoText"]');
    const pubUserInput = form.querySelector('input[name="publisherUsername"]');

    let pubTxt = (pubTextInput?.value || '').trim();
    let memoTxt = (memoTextInput?.value || '').trim();
    const publisherUsername =
      (currentUser?.username || pubUserInput?.value || 'community').replace(/^@/, '').trim() || 'community';

    if (pubFileInput?.files?.[0]) {
      pubTxt = (await pubFileInput.files[0].text()).trim();
    }
    if (memoFileInput?.files?.[0]) {
      memoTxt = (await memoFileInput.files[0].text()).trim();
    }

    if (!pubTxt && !memoTxt) {
      renderHtmlStringToDom(
        renderImportPage(
          cfg,
          {
            ok: false,
            errors: ['Please provide at least a public questions .txt file or a private memo .txt file.'],
            warnings: [],
          },
          currentUser,
        ),
      );
      return;
    }

    if (pubTxt && memoTxt) {
      const r = store.importPairTxt(pubTxt, memoTxt, publisherUsername, currentUser?.id || null);
      renderHtmlStringToDom(
        renderImportPage(
          cfg,
          {
            ...r,
            message:
              r.ok && r.paper
                ? \`Successfully validated and published "\${r.paper.title}" (\${r.paper.testId} v\${r.paper.version}, \${r.paper.questions.length} questions, \${r.paper.totalMarks.toFixed(2)} marks) by @\${publisherUsername}.\`
                : undefined,
          },
          currentUser,
        ),
      );
      return;
    }

    if (pubTxt) {
      const r = store.importPublicTxt(pubTxt, publisherUsername, currentUser?.id || null);
      renderHtmlStringToDom(
        renderImportPage(
          cfg,
          {
            ...r,
            message:
              r.ok && r.paper
                ? \`Imported public paper "\${r.paper.title}" (\${r.paper.testId} v\${r.paper.version}) by @\${publisherUsername}. Import its matching private memo before starting an attempt.\`
                : undefined,
          },
          currentUser,
        ),
      );
      return;
    }

    const r = store.importPrivateMemoTxt(memoTxt);
    renderHtmlStringToDom(
      renderImportPage(
        cfg,
        {
          ...r,
          message:
            r.ok && r.memo
              ? \`Imported and validated private memo for "\${r.memo.testId}" v\${r.memo.version}. Ready to start attempts.\`
              : undefined,
        },
        currentUser,
      ),
    );
    return;
  }

  const startMatch = /^\\/practice\\/([^/]+)\\/start$/.exec(pathname);
  if (startMatch) {
    const testId = startMatch[1];
    const fd = new FormData(form);
    const v = fd.get('version') ? Number(fd.get('version')) : undefined;
    try {
      const att = store.startAttempt(testId, v, now);
      navigateTo(\`/practice/\${encodeURIComponent(testId)}/attempt/\${encodeURIComponent(att.attemptId)}/question/1\`);
    } catch (err) {
      const paper = store.getPublicPaper(testId, v);
      if (paper) {
        renderHtmlStringToDom(
          renderTestSummaryPage({
            cfg,
            paper,
            attempts: store.listAttemptsForTest(testId, paper.version),
            hasMemo: store.hasPrivateMemo(testId, paper.version),
            errorMsg: err.message,
            serverNow: now,
          }),
        );
      }
    }
    return;
  }

  const submitMatch = /^\\/practice\\/([^/]+)\\/attempt\\/([^/]+)\\/submit$/.exec(pathname);
  if (submitMatch) {
    const [, testId, attemptId] = submitMatch;
    store.submitAttempt(attemptId, now);
    navigateTo(\`/practice/\${encodeURIComponent(testId)}/attempt/\${encodeURIComponent(attemptId)}/summary\`);
    return;
  }
});

window.addEventListener('hashchange', () => {
  renderCurrentRoute();
});

// Check OAuth Redirect Hash (#access_token=...) before initial render
async function bootstrapApp() {
  const hash = window.location.hash || '';
  if (hash.includes('access_token=')) {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (accessToken) {
      history.replaceState(null, '', window.location.pathname + '#/practice');
      const uRes = await sbFetch('/auth/v1/user', { token: accessToken });
      if (uRes.ok && uRes.data?.id) {
        const user = uRes.data;
        const prof = await fetchProfile(user.id, accessToken);
        saveSession({
          access_token: accessToken,
          refresh_token: refreshToken,
          user,
          username: prof?.username || null,
        });
        if (!prof?.username) {
          history.replaceState(null, '', window.location.pathname + '#/login');
        }
      }
    }
  }
  renderCurrentRoute();
  await store.syncFromSupabase();
  renderCurrentRoute();
}

bootstrapApp();
`;
fs.writeFileSync(path.join(APP_DIR, 'main.js'), mainJs.trimStart(), 'utf8');

// 5. Write `dist/index.html`, `dist/404.html`, and `dist/.nojekyll`
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>COMS3010A-OS-SM2-2026 - Practice Quizzes</title>
  <link rel="stylesheet" href="./public/moodle.css">
  <script src="https://accounts.google.com/gsi/client" async defer></script>
</head>
<body>
  <noscript>JavaScript is required to run the OS Practice Exam Simulator on GitHub Pages.</noscript>
  <script type="module" src="./app/main.js"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(DIST, 'index.html'), indexHtml, 'utf8');
fs.writeFileSync(path.join(DIST, '404.html'), indexHtml, 'utf8');
fs.writeFileSync(path.join(DIST, '.nojekyll'), '', 'utf8');

console.log('Built static GitHub Pages bundle in dist/');
