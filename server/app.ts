import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { type AppConfig, ROOT } from './config.ts';
import { ExamStore } from './db.ts';
import {
  renderLibraryPage,
  renderImportPage,
  renderTestSummaryPage,
  renderQuestionPage,
  renderFinishConfirmPage,
} from './views.ts';

export interface AppInstance {
  server: http.Server;
  store: ExamStore;
  cfg: AppConfig;
  nowFn: () => number;
  setNowFn: (fn: () => number) => void;
}

export function createApp(cfg: AppConfig, customNow?: () => number): AppInstance {
  const store = new ExamStore(cfg.dbPath);
  let nowFn = customNow ?? (() => Date.now());

  // Background sweep timer so open attempts auto-finalize on the server even if the browser tab is closed
  const sweepInterval = setInterval(() => {
    try {
      store.SweepExpiredAttempts(nowFn());
    } catch {
      // Ignore if DB closed
    }
  }, 1000);
  sweepInterval.unref();

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, store, cfg, nowFn);
    } catch (err) {
      console.error('Unhandled request error:', err);
      if (!res.headersSent) {
        sendHtml(res, 500, `<h1>Internal Server Error</h1><pre>${ String((err as Error)?.message ?? err) }</pre>`);
      }
    }
  });

  server.on('close', () => {
    clearInterval(sweepInterval);
  });

  return {
    server,
    store,
    cfg,
    get nowFn() {
      return nowFn;
    },
    setNowFn(fn: () => number) {
      nowFn = fn;
    },
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: ExamStore,
  cfg: AppConfig,
  nowFn: () => number,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const now = nowFn();

  // Static files in /public/*
  if (method === 'GET' && pathname.startsWith('/public/')) {
    const rel = pathname.slice('/public/'.length);
    if (rel.includes('..') || rel.includes('/') || rel.includes('\\')) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    const filePath = path.join(ROOT, 'public', rel);
    if (!fs.existsSync(filePath)) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'application/javascript; charset=utf-8'
          : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(filePath));
    return;
  }

  // Root redirect
  if (method === 'GET' && pathname === '/') {
    redirect(res, '/practice');
    return;
  }

  // Practice Library Index
  if (method === 'GET' && pathname === '/practice') {
    const msg = url.searchParams.get('msg') ?? undefined;
    const tests = store.listTests(now);
    sendHtml(res, 200, renderLibraryPage(cfg, tests, now, msg));
    return;
  }

  // Clear artificial fixtures
  if (method === 'POST' && pathname === '/admin/clear-fixtures') {
    const removed = store.clearFixtures();
    redirect(res, `/practice?msg=${encodeURIComponent(`Removed ${removed} artificial fixture test(s).`)}`);
    return;
  }

  // Import UI
  if (method === 'GET' && pathname === '/import') {
    sendHtml(res, 200, renderImportPage(cfg));
    return;
  }

  if (method === 'POST' && pathname === '/import') {
    const fields = await parseFormOrMultipart(req);
    const pubTxt = (fields.publicFile || fields.publicText || '').trim();
    const memoTxt = (fields.memoFile || fields.memoText || '').trim();

    if (!pubTxt && !memoTxt) {
      sendHtml(
        res,
        400,
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
      sendHtml(
        res,
        r.ok ? 200 : 400,
        renderImportPage(cfg, {
          ...r,
          message: r.ok && r.paper
            ? `Successfully imported "${r.paper.title}" (${r.paper.testId} v${r.paper.version}, ${r.paper.questions.length} questions, ${r.paper.totalMarks.toFixed(2)} marks) with validated private memo.`
            : undefined,
        }),
      );
      return;
    }

    if (pubTxt) {
      const r = store.importPublicTxt(pubTxt);
      sendHtml(
        res,
        r.ok ? 200 : 400,
        renderImportPage(cfg, {
          ...r,
          message: r.ok && r.paper
            ? `Imported public paper "${r.paper.title}" (${r.paper.testId} v${r.paper.version}). Import its matching private memo before starting an attempt.`
            : undefined,
        }),
      );
      return;
    }

    const r = store.importPrivateMemoTxt(memoTxt);
    sendHtml(
      res,
      r.ok ? 200 : 400,
      renderImportPage(cfg, {
        ...r,
        message: r.ok && r.memo
          ? `Imported and validated private memo for "${r.memo.testId}" v${r.memo.version}. Ready to start attempts.`
          : undefined,
      }),
    );
    return;
  }

  // ---------- JSON APIs ----------

  if (method === 'GET' && pathname === '/api/tests') {
    sendJson(res, 200, { serverNow: now, tests: store.listTests(now) });
    return;
  }

  if (method === 'POST' && pathname === '/api/import') {
    const body = (await readJsonBody(req)) as { publicTxt?: string; memoTxt?: string };
    if (body.publicTxt && body.memoTxt) {
      const r = store.importPairTxt(body.publicTxt, body.memoTxt);
      sendJson(res, r.ok ? 200 : 400, { ok: r.ok, errors: r.errors, warnings: r.warnings, testId: r.paper?.testId, version: r.paper?.version });
      return;
    }
    if (body.publicTxt) {
      const r = store.importPublicTxt(body.publicTxt);
      sendJson(res, r.ok ? 200 : 400, { ok: r.ok, errors: r.errors, warnings: r.warnings, testId: r.paper?.testId, version: r.paper?.version });
      return;
    }
    if (body.memoTxt) {
      const r = store.importPrivateMemoTxt(body.memoTxt);
      sendJson(res, r.ok ? 200 : 400, { ok: r.ok, errors: r.errors, warnings: r.warnings, testId: r.memo?.testId, version: r.memo?.version });
      return;
    }
    sendJson(res, 400, { ok: false, errors: ['Missing publicTxt or memoTxt'] });
    return;
  }

  const apiStatusMatch = /^\/api\/attempts\/([^/]+)\/status$/.exec(pathname);
  if (method === 'GET' && apiStatusMatch) {
    const attemptId = apiStatusMatch[1];
    const att = store.getAttempt(attemptId, now);
    if (!att) {
      sendJson(res, 404, { error: 'Attempt not found' });
      return;
    }
    const remainingSeconds =
      att.status === 'in_progress' ? Math.max(0, Math.ceil((att.deadlineAt - now) / 1000)) : 0;
    sendJson(res, 200, {
      attemptId: att.attemptId,
      status: att.status,
      serverNow: now,
      deadlineAt: att.deadlineAt,
      remainingSeconds,
    });
    return;
  }

  const apiRespMatch = /^\/api\/attempts\/([^/]+)\/responses$/.exec(pathname);
  if (method === 'PATCH' && apiRespMatch) {
    const attemptId = apiRespMatch[1];
    const body = (await readJsonBody(req)) as { questionId?: string; parts?: Record<string, string> };
    if (!body.questionId || !body.parts || typeof body.parts !== 'object') {
      sendJson(res, 400, { ok: false, error: 'Invalid payload' });
      return;
    }
    try {
      const saved = store.saveResponses(attemptId, body.questionId, body.parts, now);
      sendJson(res, saved.ok ? 200 : 409, saved);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: (e as Error).message });
    }
    return;
  }

  const apiFlagMatch = /^\/api\/attempts\/([^/]+)\/flag$/.exec(pathname);
  if (method === 'POST' && apiFlagMatch) {
    const attemptId = apiFlagMatch[1];
    const body = (await readJsonBody(req)) as { questionId?: string; flagged?: boolean };
    if (!body.questionId) {
      sendJson(res, 400, { ok: false, error: 'Missing questionId' });
      return;
    }
    try {
      const flagged = store.toggleFlag(attemptId, body.questionId, body.flagged);
      sendJson(res, 200, { ok: true, flagged });
    } catch (e) {
      sendJson(res, 404, { ok: false, error: (e as Error).message });
    }
    return;
  }

  const apiSubmitMatch = /^\/api\/attempts\/([^/]+)\/submit$/.exec(pathname);
  if (method === 'POST' && apiSubmitMatch) {
    const attemptId = apiSubmitMatch[1];
    try {
      const att = store.submitAttempt(attemptId, now);
      sendJson(res, 200, { ok: true, attempt: att });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: (e as Error).message });
    }
    return;
  }

  const apiReviewMatch = /^\/api\/attempts\/([^/]+)\/review$/.exec(pathname);
  if (method === 'GET' && apiReviewMatch) {
    const attemptId = apiReviewMatch[1];
    const att = store.getAttempt(attemptId, now);
    if (!att) {
      sendJson(res, 404, { error: 'Attempt not found' });
      return;
    }
    if (att.status === 'in_progress') {
      sendJson(res, 403, { error: 'Forbidden: review is locked until the attempt is submitted or expires.' });
      return;
    }
    const review = store.getReviewSnapshots(attemptId, now);
    sendJson(res, 200, { attempt: att, review });
    return;
  }

  // ---------- Exam Flow HTML Routes ----------

  // /practice/:testId/start
  const startMatch = /^\/practice\/([^/]+)\/start$/.exec(pathname);
  if (startMatch) {
    const testId = startMatch[1];
    const reqVersion = url.searchParams.get('version') ? Number(url.searchParams.get('version')) : undefined;
    const paper = store.getPublicPaper(testId, reqVersion);
    if (!paper) {
      redirect(res, '/practice');
      return;
    }

    if (method === 'GET') {
      store.SweepExpiredAttempts(now);
      const attempts = store.listAttemptsForTest(testId, paper.version);
      const hasMemo = store.hasPrivateMemo(testId, paper.version);
      sendHtml(
        res,
        200,
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

    if (method === 'POST') {
      const form = await parseFormOrMultipart(req);
      const v = form.version ? Number(form.version) : paper.version;
      try {
        const att = store.startAttempt(testId, v, now);
        redirect(
          res,
          `/practice/${encodeURIComponent(testId)}/attempt/${encodeURIComponent(att.attemptId)}/question/1`,
        );
      } catch (e) {
        const attempts = store.listAttemptsForTest(testId, paper.version);
        const hasMemo = store.hasPrivateMemo(testId, paper.version);
        sendHtml(
          res,
          400,
          renderTestSummaryPage({
            cfg,
            paper,
            attempts,
            hasMemo,
            errorMsg: (e as Error).message,
            serverNow: now,
          }),
        );
      }
      return;
    }
  }

  // Direct navigation to /practice/:testId/question/:n without attempt -> redirect to start
  const bareQMatch = /^\/practice\/([^/]+)\/question\/\d+$/.exec(pathname);
  if (method === 'GET' && bareQMatch) {
    redirect(res, `/practice/${encodeURIComponent(bareQMatch[1])}/start`);
    return;
  }

  // /practice/:testId/attempt/:attemptId/(question|attempt)/:qNum
  const attemptQMatch = /^\/practice\/([^/]+)\/attempt\/([^/]+)\/(?:question|attempt)\/(\d+)$/.exec(pathname);
  if (method === 'GET' && attemptQMatch) {
    const [, testId, attemptId, qNumStr] = attemptQMatch;
    const att = store.getAttempt(attemptId, now);
    if (!att || att.testId !== testId) {
      redirect(res, `/practice/${encodeURIComponent(testId)}/start`);
      return;
    }
    if (att.status !== 'in_progress') {
      redirect(res, `/practice/${encodeURIComponent(testId)}/attempt/${encodeURIComponent(attemptId)}/summary`);
      return;
    }
    const paper = store.getPublicPaper(att.testId, att.testVersion);
    if (!paper) {
      redirect(res, '/practice');
      return;
    }
    const qNum = Number(qNumStr);
    const question = paper.questions.find((q) => q.number === qNum) ?? paper.questions[0];
    const responses = store.getAttemptResponses(attemptId);
    const flags = store.getAttemptFlags(attemptId);

    sendHtml(
      res,
      200,
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

  // /practice/:testId/attempt/:attemptId/finish
  const finishMatch = /^\/practice\/([^/]+)\/attempt\/([^/]+)\/finish$/.exec(pathname);
  if (method === 'GET' && finishMatch) {
    const [, testId, attemptId] = finishMatch;
    const att = store.getAttempt(attemptId, now);
    if (!att || att.testId !== testId) {
      redirect(res, `/practice/${encodeURIComponent(testId)}/start`);
      return;
    }
    if (att.status !== 'in_progress') {
      redirect(res, `/practice/${encodeURIComponent(testId)}/attempt/${encodeURIComponent(attemptId)}/summary`);
      return;
    }
    const paper = store.getPublicPaper(att.testId, att.testVersion)!;
    const responses = store.getAttemptResponses(attemptId);
    const flags = store.getAttemptFlags(attemptId);

    sendHtml(
      res,
      200,
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

  // POST /practice/:testId/attempt/:attemptId/submit
  const submitMatch = /^\/practice\/([^/]+)\/attempt\/([^/]+)\/submit$/.exec(pathname);
  if (method === 'POST' && submitMatch) {
    const [, testId, attemptId] = submitMatch;
    const att = store.getAttempt(attemptId, now);
    if (!att || att.testId !== testId) {
      redirect(res, `/practice/${encodeURIComponent(testId)}/start`);
      return;
    }
    store.submitAttempt(attemptId, now);
    redirect(res, `/practice/${encodeURIComponent(testId)}/attempt/${encodeURIComponent(attemptId)}/summary`);
    return;
  }

  // GET /practice/:testId/attempt/:attemptId/summary
  const summaryMatch = /^\/practice\/([^/]+)\/attempt\/([^/]+)\/summary$/.exec(pathname);
  if (method === 'GET' && summaryMatch) {
    const [, testId, attemptId] = summaryMatch;
    const att = store.getAttempt(attemptId, now);
    if (!att || att.testId !== testId) {
      redirect(res, `/practice/${encodeURIComponent(testId)}/start`);
      return;
    }
    if (att.status === 'in_progress') {
      redirect(res, `/practice/${encodeURIComponent(testId)}/attempt/${encodeURIComponent(attemptId)}/finish`);
      return;
    }
    const paper = store.getPublicPaper(att.testId, att.testVersion)!;
    const attempts = store.listAttemptsForTest(testId, att.testVersion);
    const hasMemo = store.hasPrivateMemo(testId, att.testVersion);

    sendHtml(
      res,
      200,
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

  // GET /practice/:testId/attempt/:attemptId/review/:qNum
  const reviewQMatch = /^\/practice\/([^/]+)\/attempt\/([^/]+)\/review\/(\d+)$/.exec(pathname);
  if (method === 'GET' && reviewQMatch) {
    const [, testId, attemptId, qNumStr] = reviewQMatch;
    const att = store.getAttempt(attemptId, now);
    if (!att || att.testId !== testId) {
      redirect(res, `/practice/${encodeURIComponent(testId)}/start`);
      return;
    }
    if (att.status === 'in_progress') {
      redirect(res, `/practice/${encodeURIComponent(testId)}/attempt/${encodeURIComponent(attemptId)}/question/1`);
      return;
    }
    const paper = store.getPublicPaper(att.testId, att.testVersion)!;
    const qNum = Number(qNumStr);
    const question = paper.questions.find((q) => q.number === qNum) ?? paper.questions[0];
    const responses = store.getAttemptResponses(attemptId);
    const flags = store.getAttemptFlags(attemptId);
    const reviewSnapshots = store.getReviewSnapshots(attemptId, now);

    sendHtml(
      res,
      200,
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

  sendHtml(res, 404, `<h1>404 Not Found</h1><p><a href="/practice">Return to Practice Quizzes</a></p>`);
}

// ---------- HTTP Body Helpers ----------

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

function readRawBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const buf = await readRawBuffer(req);
  const str = buf.toString('utf8').trim();
  return str ? JSON.parse(str) : {};
}

async function parseFormOrMultipart(req: http.IncomingMessage): Promise<Record<string, string>> {
  const ct = req.headers['content-type'] ?? '';
  const buf = await readRawBuffer(req);
  const out: Record<string, string> = {};

  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(buf.toString('utf8'));
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }

  const mBoundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (mBoundary) {
    const boundary = `--${(mBoundary[1] || mBoundary[2]).trim()}`;
    const raw = buf.toString('utf8');
    const parts = raw.split(boundary);
    for (const part of parts) {
      if (!part || part === '--' || part === '--\r\n') continue;
      const sepIdx = part.indexOf('\r\n\r\n');
      if (sepIdx < 0) continue;
      const head = part.slice(0, sepIdx);
      let body = part.slice(sepIdx + 4);
      if (body.endsWith('\r\n')) body = body.slice(0, -2);
      const nameMatch = /name="([^"]+)"/i.exec(head);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      if (body.trim()) out[name] = body;
    }
  }
  return out;
}
