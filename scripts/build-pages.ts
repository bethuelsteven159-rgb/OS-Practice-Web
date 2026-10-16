/**
 * Builds a self-contained static SPA bundle in `dist/` for GitHub Pages deployment.
 *
 * Uses Node's built-in `module.stripTypeScriptTypes` to compile the pure TypeScript
 * modules (`markup.ts`, `graders.ts`, `schema.ts`, `views.ts`) into standard ES modules
 * and pairs them with a browser `localStorage`-backed `BrowserExamStore` and SPA router.
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
  // Remove empty type-only imports (`import {   } from './...';`) and rewrite `.ts` to `.js`
  const browserJs = stripped
    .replace(/import\s*\{\s*\}\s*from\s*['"][^'"]+['"]\s*;?/g, '')
    .replace(/(from\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2');
  const outName = file.replace(/\.ts$/, '.js');
  fs.writeFileSync(path.join(APP_DIR, outName), browserJs, 'utf8');
}

// 3. Read fixture files so the GitHub Pages site comes pre-loaded with the sample fixture on first visit
const fixturePublicTxt = fs.readFileSync(
  path.join(ROOT, 'fixtures', 'artificial-fixture.public.txt'),
  'utf8',
);
const fixtureMemoTxt = fs.readFileSync(
  path.join(ROOT, 'fixtures', 'artificial-fixture.memo.txt'),
  'utf8',
);

fs.writeFileSync(
  path.join(APP_DIR, 'fixtures-data.js'),
  `export const FIXTURE_PUBLIC_TXT = ${JSON.stringify(fixturePublicTxt)};\nexport const FIXTURE_MEMO_TXT = ${JSON.stringify(fixtureMemoTxt)};\n`,
  'utf8',
);

// 4. Write BrowserExamStore (`dist/app/browser-store.js`) matching `server/db.ts`
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
import { FIXTURE_PUBLIC_TXT, FIXTURE_MEMO_TXT } from './fixtures-data.js';

const STORAGE_KEY = 'os_practice_web_state_v1';

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
    if (!this.state.seededInitialFixture) {
      this.importPairTxt(FIXTURE_PUBLIC_TXT, FIXTURE_MEMO_TXT);
      this.state.seededInitialFixture = true;
      this._save();
    }
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
      seededInitialFixture: false,
      tests: {},       // key: \`\${testId}@\${version}\` -> { paper, memo, importedAt }
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

  importPublicTxt(rawTxt) {
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

  importPairTxt(publicTxt, memoTxt) {
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

    this.importPublicTxt(publicTxt);
    this.importPrivateMemoTxt(memoTxt);
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
      const fa = a.paper.isFixture ? 1 : 0;
      const fb = b.paper.isFixture ? 1 : 0;
      if (fa !== fb) return fa - fb;
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

  clearFixtures() {
    let removed = 0;
    for (const [key, entry] of Object.entries(this.state.tests)) {
      if (entry.paper.isFixture) {
        delete this.state.tests[key];
        removed++;
        for (const [attId, att] of Object.entries(this.state.attempts)) {
          if (att.testId === entry.paper.testId && att.testVersion === entry.paper.version) {
            delete this.state.attempts[attId];
            delete this.state.responses[attId];
            delete this.state.flags[attId];
            delete this.state.reviews[attId];
          }
        }
      }
    }
    this._save();
    return removed;
  }

  restoreFixtures() {
    this.importPairTxt(FIXTURE_PUBLIC_TXT, FIXTURE_MEMO_TXT);
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

// 5. Write SPA Router & Client Controller (`dist/app/main.js`)
const mainJs = `
import { BrowserExamStore } from './browser-store.js';
import {
  renderLibraryPage,
  renderImportPage,
  renderTestSummaryPage,
  renderQuestionPage,
  renderFinishConfirmPage,
} from './views.js';

const cfg = {
  port: 3000,
  host: '127.0.0.1',
  dbPath: 'localStorage',
  siteShortName: 'MS',
  userInitials: 'BK',
  courseName: 'COMS3010A-OS-SM2-2026',
  sectionName: 'Practice tests',
  uiScale: 0.8,
  locale: 'en-GB',
  timeZone: '',
};

const store = new BrowserExamStore();
let activeIntervals = [];

function clearActiveIntervals() {
  for (const id of activeIntervals) clearInterval(id);
  activeIntervals = [];
}

// Background sweep every 1s
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

function renderHtmlStringToDom(htmlStr) {
  clearActiveIntervals();
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlStr, 'text/html');
  document.title = doc.title || 'OS Practice Quizzes';

  // Remove the server script tag since we initialize client behavior directly
  doc.querySelectorAll('script').forEach((s) => s.remove());

  // Rewrite internal links to hash links so hover/middle-click/bookmarks work seamlessly on GitHub Pages
  doc.querySelectorAll('a[href^="/"]').forEach((a) => {
    const rawHref = a.getAttribute('href');
    if (rawHref) {
      a.setAttribute('data-route-href', rawHref);
      a.setAttribute('href', '#' + rawHref);
    }
  });

  // If on the library page and no tests exist, offer a 1-click button to restore the demo fixture
  const actionRow = doc.querySelector('.moodle-box div[style*="display:flex;gap:8px;align-items:center;"]');
  if (actionRow && store.listTests().length === 0) {
    const restoreBtn = doc.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn-moodle';
    restoreBtn.textContent = 'Load sample fixture';
    restoreBtn.setAttribute('data-restore-fixture', '1');
    actionRow.appendChild(restoreBtn);
  }

  document.body.innerHTML = doc.body.innerHTML;
  window.scrollTo(0, 0);
  initExamPageInteractions();
}

function renderCurrentRoute() {
  const rawRoute = getRoutePath();
  const url = new URL(rawRoute, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const now = Date.now();

  if (pathname === '/' || pathname === '/practice') {
    const msg = url.searchParams.get('msg') ?? undefined;
    const tests = store.listTests(now);
    renderHtmlStringToDom(renderLibraryPage(cfg, tests, now, msg));
    return;
  }

  if (pathname === '/import') {
    renderHtmlStringToDom(renderImportPage(cfg));
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

// ---------- Page Interactions (Flagging, Autosave, Countdown, Forms) ----------

function initExamPageInteractions() {
  const root = document.querySelector('[data-exam-page]');
  if (!root) return;

  const mode = root.getAttribute('data-mode');
  const attemptId = root.getAttribute('data-attempt-id');
  const questionId = root.getAttribute('data-question-id');
  const testId = root.getAttribute('data-test-id');
  const deadlineAt = Number(root.getAttribute('data-deadline-at') || '0');

  // Restore fixture button
  const restoreBtn = document.querySelector('[data-restore-fixture]');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => {
      store.restoreFixtures();
      navigateTo('/practice?msg=' + encodeURIComponent('Restored sample developer fixture paper.'));
    });
  }

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
  e.preventDefault();

  const rawAction = form.getAttribute('action') || '';
  const url = new URL(rawAction, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const now = Date.now();

  if (pathname === '/admin/clear-fixtures') {
    const removed = store.clearFixtures();
    navigateTo(\`/practice?msg=\${encodeURIComponent(\`Removed \${removed} artificial fixture test(s).\`)}\`);
    return;
  }

  if (pathname === '/import') {
    const pubFileInput = form.querySelector('input[name="publicFile"]');
    const memoFileInput = form.querySelector('input[name="memoFile"]');
    const pubTextInput = form.querySelector('textarea[name="publicText"]');
    const memoTextInput = form.querySelector('textarea[name="memoText"]');

    let pubTxt = (pubTextInput?.value || '').trim();
    let memoTxt = (memoTextInput?.value || '').trim();

    if (pubFileInput?.files?.[0]) {
      pubTxt = (await pubFileInput.files[0].text()).trim();
    }
    if (memoFileInput?.files?.[0]) {
      memoTxt = (await memoFileInput.files[0].text()).trim();
    }

    if (!pubTxt && !memoTxt) {
      renderHtmlStringToDom(
        renderImportPage(cfg, {
          ok: false,
          errors: ['Please provide at least a public questions .txt file or a private memo .txt file.'],
          warnings: [],
        }),
      );
      return;
    }

    if (pubTxt && memoTxt) {
      const r = store.importPairTxt(pubTxt, memoTxt);
      renderHtmlStringToDom(
        renderImportPage(cfg, {
          ...r,
          message:
            r.ok && r.paper
              ? \`Successfully imported "\${r.paper.title}" (\${r.paper.testId} v\${r.paper.version}, \${r.paper.questions.length} questions, \${r.paper.totalMarks.toFixed(2)} marks) with validated private memo.\`
              : undefined,
        }),
      );
      return;
    }

    if (pubTxt) {
      const r = store.importPublicTxt(pubTxt);
      renderHtmlStringToDom(
        renderImportPage(cfg, {
          ...r,
          message:
            r.ok && r.paper
              ? \`Imported public paper "\${r.paper.title}" (\${r.paper.testId} v\${r.paper.version}). Import its matching private memo before starting an attempt.\`
              : undefined,
        }),
      );
      return;
    }

    const r = store.importPrivateMemoTxt(memoTxt);
    renderHtmlStringToDom(
      renderImportPage(cfg, {
        ...r,
        message:
          r.ok && r.memo
            ? \`Imported and validated private memo for "\${r.memo.testId}" v\${r.memo.version}. Ready to start attempts.\`
            : undefined,
      }),
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

renderCurrentRoute();
`;
fs.writeFileSync(path.join(APP_DIR, 'main.js'), mainJs.trimStart(), 'utf8');

// 6. Write `dist/index.html`, `dist/404.html`, and `dist/.nojekyll`
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>COMS3010A-OS-SM2-2026 - Practice Quizzes</title>
  <link rel="stylesheet" href="./public/moodle.css">
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
