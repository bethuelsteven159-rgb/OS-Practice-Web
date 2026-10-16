import { type AppConfig } from './config.ts';
import {
  type PublicPaper,
  type PublicQuestion,
  type PublicPart,
} from './schema.ts';
import {
  type AttemptSummaryRow,
  type TestSummaryRow,
  type QuestionReviewSnapshot,
  type PartReviewSnapshot,
} from './db.ts';
import { esc, inline, mathText, renderBlocks } from './markup.ts';

// ---------- SVG Icons matching Moodle 4 Boost screenshots ----------

const QUIZ_PINK_ICON_SVG = `
<svg class="quiz-activity-icon" viewBox="0 0 32 32" aria-hidden="true">
  <rect x="3" y="2" width="26" height="28" rx="4" fill="none" stroke="#F90086" stroke-width="2.4"/>
  <path d="M8 10.5l2 2 4-4" fill="none" stroke="#F90086" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="17" y1="10.5" x2="24" y2="10.5" stroke="#F90086" stroke-width="2.2" stroke-linecap="round"/>
  <line x1="17" y1="16" x2="24" y2="16" stroke="#F90086" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M8.5 14.5l3.5 3.5m0-3.5l-3.5 3.5" fill="none" stroke="#F90086" stroke-width="2" stroke-linecap="round"/>
  <path d="M8 22.5l2 2 4-4" fill="none" stroke="#F90086" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="17" y1="22" x2="24" y2="22" stroke="#F90086" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;

function flagIconSvg(flagged: boolean): string {
  const fill = flagged ? '#CA3120' : 'none';
  const stroke = flagged ? '#CA3120' : '#0F6CBF';
  return `<svg viewBox="0 0 12 13" aria-hidden="true">
    <line x1="2" y1="1.5" x2="2" y2="12" stroke="${stroke}" stroke-width="1.3"/>
    <path class="flag-fill" d="M2 2h7.5l-1.8 2.6 1.8 2.6H2z" fill="${fill}" stroke="${stroke}" stroke-width="1.1" stroke-linejoin="round"/>
  </svg>`;
}

const TILE_ICON_CORRECT = `<svg class="qn-status-icon" viewBox="0 0 12 12" aria-hidden="true">
  <circle cx="6" cy="6" r="4.6" fill="none" stroke="#306E2D" stroke-width="1.15"/>
  <path d="M3.7 6.1l1.5 1.5 3.1-3.2" fill="none" stroke="#306E2D" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const TILE_ICON_PARTIAL = `<svg class="qn-status-icon" viewBox="0 0 12 12" aria-hidden="true">
  <circle cx="6" cy="6" r="4.6" fill="none" stroke="#90682F" stroke-width="1.15" stroke-dasharray="1.7 1.3"/>
  <path d="M3.7 6.1l1.5 1.5 3.1-3.2" fill="none" stroke="#90682F" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const TILE_ICON_WRONG = `<svg class="qn-status-icon" viewBox="0 0 12 12" aria-hidden="true">
  <circle cx="6" cy="6" r="4.6" fill="none" stroke="#B62C1D" stroke-width="1.15"/>
  <path d="M4.1 4.1l3.8 3.8M7.9 4.1l-3.8 3.8" fill="none" stroke="#B62C1D" stroke-width="1.2" stroke-linecap="round"/>
</svg>`;

const BELL_SVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M8 16a2 2 0 0 0 1.985-1.75H6.015A2 2 0 0 0 8 16zm.995-14.901a1 1 0 1 0-1.99 0A5.002 5.002 0 0 0 3 6c0 1.098-.5 6-2 7h14c-1.5-1-2-5.902-2-7 0-2.42-1.72-4.44-4.005-4.901z"/>
</svg>`;

const COURSE_INDEX_ICON_SVG = `<svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor" aria-hidden="true">
  <circle cx="1.5" cy="2" r="1.2"/><rect x="4" y="1.1" width="9" height="1.8" rx="0.5"/>
  <circle cx="1.5" cy="6" r="1.2"/><rect x="4" y="5.1" width="9" height="1.8" rx="0.5"/>
  <circle cx="1.5" cy="10" r="1.2"/><rect x="4" y="9.1" width="9" height="1.8" rx="0.5"/>
</svg>`;

// ---------- Shared Shell Layout ----------

interface ShellOptions {
  title: string;
  cfg: AppConfig;
  courseName?: string | null;
  sectionName?: string | null;
  activityTitle?: string;
  rightDrawerHtml?: string;
  dataAttrs?: Record<string, string | number>;
  bodyHtml: string;
}

function renderShell(opts: ShellOptions): string {
  const { cfg } = opts;
  const course = opts.courseName || cfg.courseName;
  const section = opts.sectionName || cfg.sectionName;
  const attrs = Object.entries(opts.dataAttrs ?? {})
    .map(([k, v]) => `data-${k}="${esc(v)}"`)
    .join(' ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)}</title>
  <link rel="stylesheet" href="/public/moodle.css">
</head>
<body>
  <header class="moodle-navbar">
    <div class="navbar-left">
      <a class="brand-ms" href="/practice">${esc(cfg.siteShortName)}</a>
      <ul class="nav-links">
        <li><a href="/practice">Home</a></li>
        <li><a href="/practice">Dashboard</a></li>
        <li><a href="/practice" class="active">My courses</a></li>
      </ul>
    </div>
    <div class="navbar-right">
      ${
        opts.rightDrawerHtml
          ? `<button type="button" id="mobile-drawer-toggle" class="btn-moodle mobile-nav-toggle">Quiz navigation</button>`
          : ''
      }
      <span class="bell-wrapper" title="Notifications">
        ${BELL_SVG}
        <span class="bell-badge">95</span>
      </span>
      <span class="user-menu">
        <span class="user-avatar">${esc(cfg.userInitials)}</span>
        <span class="user-caret">▾</span>
      </span>
    </div>
  </header>

  <a class="course-index-tab" href="/practice" title="Open course index" aria-label="Open course index">
    ${COURSE_INDEX_ICON_SVG}
  </a>

  <div class="moodle-shell" data-exam-page="1" ${attrs}>
    <main class="moodle-main">
      ${
        opts.activityTitle
          ? `<div class="page-header-wrap">
              <nav class="breadcrumb-nav" aria-label="Navigation bar">
                <a href="/practice">${esc(course)}</a>
                <span class="breadcrumb-sep">/</span>
                <a href="/practice">${esc(section)}</a>
                <span class="breadcrumb-sep">/</span>
                <span>${esc(opts.activityTitle)}</span>
              </nav>
              <div class="activity-header-row">
                ${QUIZ_PINK_ICON_SVG}
                <h1 class="activity-title">${esc(opts.activityTitle)}</h1>
              </div>
            </div>`
          : ''
      }
      ${opts.bodyHtml}
    </main>

    ${
      opts.rightDrawerHtml
        ? `<aside id="moodle-right-drawer" class="moodle-drawer" aria-label="Block drawer">
            <div class="drawer-close-row">
              <button type="button" id="drawer-close-btn" class="drawer-close-btn" title="Close block drawer" aria-label="Close block drawer">✕</button>
            </div>
            ${opts.rightDrawerHtml}
          </aside>`
        : `<aside class="moodle-drawer" aria-hidden="true"></aside>`
    }
  </div>

  <button type="button" class="floating-help-btn" title="Help" aria-label="Help">?</button>
  <div id="timer-a11y-live" role="status" aria-live="polite" style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;"></div>
  <script src="/public/exam-client.js"></script>
</body>
</html>`;
}

// ---------- One-Question-Per-Page Attempt & Review View ----------

export interface QuestionPageParams {
  cfg: AppConfig;
  mode: 'attempt' | 'review';
  paper: PublicPaper;
  attempt: AttemptSummaryRow;
  question: PublicQuestion;
  responses: Record<string, Record<string, string>>;
  flags: Record<string, boolean>;
  reviewSnapshots?: Record<string, QuestionReviewSnapshot>;
  serverNow: number;
}

export function renderQuestionPage(p: QuestionPageParams): string {
  const { cfg, mode, paper, attempt, question, responses, flags, reviewSnapshots, serverNow } = p;
  const isReview = mode === 'review';
  const qResp = responses[question.id] ?? {};
  const qSnap = isReview ? reviewSnapshots?.[question.id] : undefined;
  const isFlagged = Boolean(flags[question.id]);

  // Left 84px Question Status Block
  let stateText = 'Not yet answered';
  let markLine = `Marked out of ${question.marks.toFixed(2)}`;
  if (!isReview) {
    const answeredCount = question.parts.filter((pt) => String(qResp[pt.id] ?? '').trim() !== '').length;
    stateText =
      answeredCount === 0
        ? 'Not yet answered'
        : answeredCount < question.parts.length
          ? 'Incomplete answer'
          : 'Answer saved';
  } else if (qSnap) {
    stateText =
      qSnap.state === 'correct'
        ? 'Correct'
        : qSnap.state === 'partial'
          ? 'Partially correct'
          : qSnap.state === 'unanswered'
            ? 'Not answered'
            : 'Incorrect';
    markLine = `Mark ${qSnap.pointsAwarded.toFixed(2)} out of ${qSnap.pointsPossible.toFixed(2)}`;
  }

  const infoHtml = `
    <div class="que-info">
      <div class="qno-line">Question <span class="qno-num">${question.number}</span></div>
      <div id="que-state-line" class="state-line">${esc(stateText)}</div>
      <div class="grade-line">${esc(markLine)}</div>
      <button type="button" id="flag-question-btn" class="flag-btn" aria-pressed="${isFlagged ? 'true' : 'false'}">
        ${flagIconSvg(isFlagged)}
        <span class="flag-label">${isFlagged ? 'Remove flag' : 'Flag question'}</span>
      </button>
    </div>`;

  // Cyan Formulation Panel (Stem + Subparts)
  const stemHtml = renderBlocks(question.stem);
  const subpartsHtml = question.parts
    .map((part) => renderSubpartControl(part, qResp[part.id] ?? '', isReview, qSnap?.parts[part.id]))
    .join('\n');

  const formulationHtml = `
    <form id="question-attempt-form" class="formulation" onsubmit="return false;">
      <div class="qstem">${stemHtml}</div>
      ${subpartsHtml}
    </form>`;

  // Cream Post-Submission Outcome Panel (Review Mode ONLY)
  const outcomeHtml = isReview && qSnap ? renderOutcomePanel(question, qSnap) : '';
  const commentHtml =
    isReview && qSnap?.comment
      ? `<div class="comment-panel"><div>Comment:</div>${renderBlocks(qSnap.comment)}</div>`
      : '';

  // Bottom Navigation Links
  const totalQ = paper.questions.length;
  const idx = paper.questions.findIndex((q) => q.number === question.number);
  const prevQ = idx > 0 ? paper.questions[idx - 1] : null;
  const nextQ = idx >= 0 && idx < totalQ - 1 ? paper.questions[idx + 1] : null;

  const basePath = `/practice/${encodeURIComponent(paper.testId)}/attempt/${encodeURIComponent(attempt.attemptId)}`;
  const saveAttr = !isReview ? 'data-save-before-nav="1"' : '';

  const prevLinkHtml = prevQ
    ? `<a class="nav-prev" ${saveAttr} href="${basePath}/${mode}/${prevQ.number}">◄ Previous page</a>`
    : `<span></span>`;

  let nextLinkHtml = '';
  if (nextQ) {
    nextLinkHtml = `<a class="nav-next" ${saveAttr} href="${basePath}/${mode}/${nextQ.number}">Next page ►</a>`;
  } else if (isReview) {
    nextLinkHtml = `<a class="nav-next" href="${basePath}/summary">Finish review</a>`;
  } else {
    nextLinkHtml = `<a class="nav-next" ${saveAttr} href="${basePath}/finish">Finish attempt...</a>`;
  }

  // Timer strip (Active Attempt Mode ONLY)
  const remSec = Math.max(0, Math.ceil((attempt.deadlineAt - serverNow) / 1000));
  const timerHtml = !isReview
    ? `<div class="timer-strip">
        <span id="autosave-indicator" class="autosave-indicator">Saved</span>
        <div id="quiz-timer-box" class="timer-box">
          <span>Time left</span>
          <strong id="quiz-timer-value">${formatHMS(remSec)}</strong>
        </div>
      </div>`
    : '';

  // Right Quiz Navigation Card
  const navTilesHtml = paper.questions
    .map((q) => {
      const isCurrent = q.number === question.number;
      const qFlag = Boolean(flags[q.id]);
      let statusClass = '';
      let iconHtml = '<span class="qn-status-icon" aria-hidden="true"></span>';
      let srStatus = 'Not yet answered';

      if (isReview) {
        const snap = reviewSnapshots?.[q.id];
        const st = snap?.state ?? 'unanswered';
        if (st === 'correct') {
          statusClass = 'review-correct';
          iconHtml = TILE_ICON_CORRECT;
          srStatus = 'Correct';
        } else if (st === 'partial') {
          statusClass = 'review-partial';
          iconHtml = TILE_ICON_PARTIAL;
          srStatus = 'Partially correct';
        } else {
          statusClass = st === 'unanswered' ? 'review-unanswered' : 'review-incorrect';
          iconHtml = TILE_ICON_WRONG;
          srStatus = st === 'unanswered' ? 'Not answered' : 'Incorrect';
        }
      } else {
        const qr = responses[q.id] ?? {};
        const nAns = q.parts.filter((pt) => String(qr[pt.id] ?? '').trim() !== '').length;
        if (nAns === q.parts.length && q.parts.length > 0) {
          statusClass = 'attempt-saved';
          srStatus = 'Answer saved';
        } else if (nAns > 0) {
          statusClass = 'attempt-incomplete';
          srStatus = 'Incomplete answer';
        }
      }

      const classes = [
        'qnbutton',
        statusClass,
        isCurrent ? 'thispage' : '',
        qFlag ? 'flagged' : '',
      ]
        .filter(Boolean)
        .join(' ');

      return `<a class="${classes}"
        data-question-id="${esc(q.id)}"
        ${saveAttr}
        href="${basePath}/${mode}/${q.number}"
        ${isCurrent ? 'aria-current="page"' : ''}
        title="Question ${q.number}: ${srStatus}${qFlag ? ' (Flagged)' : ''}">
        <span>${q.number}</span>
        ${iconHtml}
      </a>`;
    })
    .join('\n');

  const rightDrawerHtml = `
    <section class="quiz-nav-card" aria-label="Quiz navigation">
      <h2 class="quiz-nav-title">Quiz navigation</h2>
      <div class="qn-buttons">
        ${navTilesHtml}
      </div>
      <div class="othernav">
        ${
          isReview
            ? `<span class="non-link-mode" title="One-question-per-page mode is enforced">Show all questions on one page</span>
               <a href="${basePath}/summary">Finish review</a>`
            : `<a ${saveAttr} href="${basePath}/finish">Finish attempt...</a>`
        }
      </div>
    </section>`;

  const bodyHtml = `
    ${timerHtml}
    <div class="que-row">
      ${infoHtml}
      <div class="que-content">
        ${formulationHtml}
        ${outcomeHtml}
        ${commentHtml}
        <div class="submitbtns">
          ${prevLinkHtml}
          ${nextLinkHtml}
        </div>
      </div>
    </div>`;

  return renderShell({
    title: `${paper.title} - Question ${question.number}`,
    cfg,
    courseName: paper.courseName,
    sectionName: paper.sectionName,
    activityTitle: paper.title,
    rightDrawerHtml,
    dataAttrs: {
      mode,
      'test-id': paper.testId,
      'attempt-id': attempt.attemptId,
      'question-id': question.id,
      'deadline-at': attempt.deadlineAt,
      'server-now': serverNow,
    },
    bodyHtml,
  });
}

function renderSubpartControl(
  part: PublicPart,
  rawVal: string,
  isReview: boolean,
  snap?: PartReviewSnapshot,
): string {
  const labelHtml = part.label ? `<span class="subpart-label">${esc(part.label)}</span> ` : '';
  const promptHtml = part.prompt ? renderBlocks(part.prompt) : '';
  const hasPrompt = Boolean(part.label || part.prompt);

  let controlHtml = '';
  const readonlyAttr = isReview ? 'readonly' : '';
  const disabledAttr = isReview ? 'disabled' : '';

  if (part.type === 'dropdown') {
    const options = [
      `<option value="" ${rawVal === '' ? 'selected' : ''}>Choose...</option>`,
      ...(part.choices ?? []).map(
        (c) => `<option value="${esc(c.id)}" ${rawVal === c.id ? 'selected' : ''}>${esc(c.label)}</option>`,
      ),
    ].join('');
    controlHtml = `<div><select class="ans-select" aria-label="${esc(part.label || part.id)}" ${disabledAttr}>${options}</select></div>`;
  } else if (part.type === 'radio') {
    const items = (part.choices ?? [])
      .map(
        (c) => `<label class="choice-item">
          <input type="radio" name="part_${esc(part.id)}" value="${esc(c.id)}" ${rawVal === c.id ? 'checked' : ''} ${disabledAttr}>
          <span>${inline(c.label)}</span>
        </label>`,
      )
      .join('');
    controlHtml = `<div class="choice-list">${items}</div>`;
  } else if (part.type === 'checkbox') {
    const selected = new Set(
      rawVal
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );
    const items = (part.choices ?? [])
      .map(
        (c) => `<label class="choice-item">
          <input type="checkbox" value="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''} ${disabledAttr}>
          <span>${inline(c.label)}</span>
        </label>`,
      )
      .join('');
    controlHtml = `<div class="choice-list">${items}</div>`;
  } else {
    const defaultChars =
      part.type === 'list' || part.type === 'ordered_list'
        ? 22
        : part.type === 'binary'
          ? Math.max(14, part.constraints?.bitWidth ?? 14)
          : part.type === 'text'
            ? 28
            : 11;
    const chars = part.inputWidth ?? defaultChars;
    const pxWidth = Math.max(88, Math.round(chars * 7.8));
    controlHtml = `<div><input type="text" class="ans-input" style="width:${pxWidth}px" value="${esc(rawVal)}" aria-label="${esc(part.label || part.id)}" ${readonlyAttr}></div>`;
  }

  // White "Your last answer was interpreted as follows:" box in REVIEW mode for scalar/list/binary/text inputs
  let interpHtml = '';
  const isTypedControl =
    part.type !== 'dropdown' && part.type !== 'radio' && part.type !== 'checkbox';
  if (isReview && isTypedControl && snap) {
    if (snap.normalizedValue !== null) {
      interpHtml = `
        <div class="stack-interp-box">
          <div class="stack-interp-title">Your last answer was interpreted as follows:</div>
          <div class="stack-interp-value">${mathText(snap.normalizedValue)}</div>
        </div>`;
    } else if (snap.state === 'invalid' && snap.messages.length > 0) {
      interpHtml = `
        <div class="stack-interp-box">
          <div class="stack-interp-title">Your last answer was interpreted as follows:</div>
          <div class="stack-interp-value">${esc(rawVal)}</div>
          <div class="stack-validation-error">${inline(snap.messages[0])}</div>
        </div>`;
    }
  }

  const hintHtml = part.answerInputHint
    ? `<div class="input-syntax-hint">${esc(part.answerInputHint)}</div>`
    : '';

  return `
    <div class="subpart-block" data-part-id="${esc(part.id)}" data-part-type="${esc(part.type)}">
      ${hasPrompt ? `<div class="subpart-prompt">${labelHtml}${promptHtml}</div>` : ''}
      ${controlHtml}
      ${interpHtml}
      ${hintHtml}
    </div>`;
}

function renderOutcomePanel(question: PublicQuestion, qSnap: QuestionReviewSnapshot): string {
  const partVerdictsHtml = question.parts
    .map((part) => {
      const ps = qSnap.parts[part.id];
      if (!ps) return '';
      const verdict =
        ps.state === 'correct'
          ? 'Correct answer, well done.'
          : ps.state === 'partial'
            ? 'Your answer is partially correct.'
            : ps.state === 'blank'
              ? 'No answer was given.'
              : 'Incorrect answer.';

      const msgLines = ps.messages.map((m) => `<p class="verdict-line">${inline(m)}</p>`).join('');

      let listDiffHtml = '';
      if (ps.listMarks && ps.listMarks.length > 0) {
        const inner = ps.listMarks
          .map((item) =>
            item.ok
              ? `<span>${esc(item.text)}</span>`
              : `<span class="list-diff-wrong">${esc(item.text)}</span>`,
          )
          .join(', ');
        listDiffHtml = `<div class="list-diff-line">[${inner}]</div>`;
      }

      const partFbHtml = ps.feedback ? renderBlocks(ps.feedback) : '';

      return `<div class="part-feedback-group">
        <p class="verdict-line">${esc(verdict)}</p>
        ${msgLines}
        ${listDiffHtml}
        ${partFbHtml}
      </div>`;
    })
    .join('\n');

  const solutionHtml = qSnap.solution ? renderBlocks(qSnap.solution) : '';

  const acceptedLinesHtml = question.parts
    .map((part) => {
      const ps = qSnap.parts[part.id];
      if (!ps) return '';
      const acc = ps.acceptedLine;
      if (acc.overrideText) {
        return `<p class="accepted-answer-line">${inline(acc.overrideText)}</p>`;
      }
      if (acc.kind === 'choice') {
        return `<p class="accepted-answer-line">A correct answer is: <span class="accepted-typed">"${highlightKeywords(acc.displayAnswer)}"</span></p>`;
      }
      return `<p class="accepted-answer-line">The answer <span class="math">${mathText(acc.displayAnswer)}</span>, which can be typed as <span class="accepted-typed">${esc(acc.typedAnswer ?? acc.displayAnswer)}</span>, would be correct.</p>`;
    })
    .join('\n');

  return `
    <div class="outcome" role="region" aria-label="Feedback and solution">
      ${partVerdictsHtml}
      ${solutionHtml}
      <hr class="outcome-divider">
      ${acceptedLinesHtml}
    </div>`;
}

/** In Moodle's syntax highlighter, words like "kernel" inside quoted correct answers render in dark ink. */
function highlightKeywords(text: string): string {
  return esc(text).replace(/\b(kernel)\b/g, '<span class="kw-black">$1</span>');
}

// ---------- Start / Overview / Summary Page ----------

export interface SummaryPageParams {
  cfg: AppConfig;
  paper: PublicPaper;
  attempts: AttemptSummaryRow[];
  focusedAttempt?: AttemptSummaryRow | null;
  hasMemo: boolean;
  errorMsg?: string;
  serverNow: number;
}

export function renderTestSummaryPage(p: SummaryPageParams): string {
  const { cfg, paper, attempts, focusedAttempt, hasMemo, errorMsg, serverNow } = p;
  const activeAttempt = attempts.find((a) => a.status === 'in_progress');
  const latestDone =
    focusedAttempt && focusedAttempt.status !== 'in_progress'
      ? focusedAttempt
      : [...attempts].reverse().find((a) => a.status !== 'in_progress');

  let focusedTableHtml = '';
  if (latestDone) {
    const durationSec = Math.max(
      0,
      Math.round(((latestDone.submittedAt ?? latestDone.deadlineAt) - latestDone.startedAt) / 1000),
    );
    const awarded = latestDone.marksAwarded ?? 0;
    const pct = paper.totalMarks > 0 ? (awarded / paper.totalMarks) * 100 : 0;
    const statusText =
      latestDone.status === 'timed_out' ? 'Finished (Auto-submitted at timeout)' : 'Finished';

    focusedTableHtml = `
      <table class="quiz-summary-table" aria-label="Attempt summary">
        <tbody>
          <tr><th>Status</th><td>${esc(statusText)}</td></tr>
          <tr><th>Started</th><td>${esc(formatDateTime(latestDone.startedAt, cfg))}</td></tr>
          <tr><th>Completed</th><td>${esc(formatDateTime(latestDone.submittedAt ?? latestDone.deadlineAt, cfg))}</td></tr>
          <tr><th>Duration</th><td>${esc(formatDurationWords(durationSec))}</td></tr>
          <tr><th>Marks</th><td>${awarded.toFixed(2)}/${paper.totalMarks.toFixed(2)}</td></tr>
          <tr><th>Grade</th><td><strong>${pct.toFixed(2)}</strong> out of 100.00</td></tr>
        </tbody>
      </table>
      <div style="margin: 12px 0 22px 0; display:flex; gap:10px; align-items:center;">
        <a class="btn-moodle btn-moodle-primary" href="/practice/${encodeURIComponent(paper.testId)}/attempt/${encodeURIComponent(latestDone.attemptId)}/review/1">Review attempt</a>
        <a class="btn-moodle" href="/practice">Back to course</a>
      </div>`;
  }

  let historyHtml = '';
  if (attempts.length > 0) {
    const rows = attempts
      .map((a, i) => {
        const isOpen = a.status === 'in_progress';
        const rem = Math.max(0, Math.ceil((a.deadlineAt - serverNow) / 1000));
        const stLabel = isOpen
          ? `In progress (${formatHMS(rem)} left)`
          : a.status === 'timed_out'
            ? `Finished (Timed out)<br><span style="color:#6A737B;font-size:11px;">Submitted ${esc(formatDateTime(a.submittedAt ?? a.deadlineAt, cfg))}</span>`
            : `Finished<br><span style="color:#6A737B;font-size:11px;">Submitted ${esc(formatDateTime(a.submittedAt ?? a.deadlineAt, cfg))}</span>`;
        const marksCell = isOpen ? '' : (a.marksAwarded ?? 0).toFixed(2);
        const gradeCell =
          isOpen || paper.totalMarks <= 0
            ? ''
            : (((a.marksAwarded ?? 0) / paper.totalMarks) * 100).toFixed(2);
        const actionCell = isOpen
          ? `<a href="/practice/${encodeURIComponent(paper.testId)}/attempt/${encodeURIComponent(a.attemptId)}/question/1">Continue attempt</a>`
          : `<a href="/practice/${encodeURIComponent(paper.testId)}/attempt/${encodeURIComponent(a.attemptId)}/review/1">Review</a>`;

        return `<tr>
          <td>${i + 1}</td>
          <td>${stLabel}</td>
          <td>${marksCell}</td>
          <td>${gradeCell}</td>
          <td>${actionCell}</td>
        </tr>`;
      })
      .join('');

    historyHtml = `
      <h2 style="font-size:15px;margin:20px 0 8px 0;">Summary of your previous attempts</h2>
      <table class="generaltable">
        <thead>
          <tr>
            <th>Attempt</th>
            <th>State</th>
            <th>Marks / ${paper.totalMarks.toFixed(2)}</th>
            <th>Grade / 100.00</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  let startActionHtml = '';
  if (!hasMemo) {
    startActionHtml = `
      <div class="alert-moodle alert-warn">
        <strong>Private memo not yet imported.</strong> This public paper has ${paper.questions.length} questions (${paper.totalMarks.toFixed(2)} marks), but a graded attempt cannot start until its matching private memo (<code>${esc(paper.testId)}</code> v${paper.version}) is imported.
        <div style="margin-top:8px;"><a class="btn-moodle" href="/import">Import private memo</a></div>
      </div>`;
  } else if (activeAttempt) {
    const rem = Math.max(0, Math.ceil((activeAttempt.deadlineAt - serverNow) / 1000));
    startActionHtml = `
      <div style="margin-top:16px;">
        <p>You have an attempt in progress (time remaining: <strong>${formatHMS(rem)}</strong>).</p>
        <a class="btn-moodle btn-moodle-primary" href="/practice/${encodeURIComponent(paper.testId)}/attempt/${encodeURIComponent(activeAttempt.attemptId)}/question/1">Continue the last attempt</a>
      </div>`;
  } else {
    const btnText = attempts.length > 0 ? 'Re-attempt quiz' : 'Attempt quiz now';
    startActionHtml = `
      <form method="POST" action="/practice/${encodeURIComponent(paper.testId)}/start" style="margin-top:16px;">
        <input type="hidden" name="version" value="${paper.version}">
        <button type="submit" class="btn-moodle btn-moodle-primary">${btnText}</button>
      </form>`;
  }

  const bodyHtml = `
    <div class="moodle-box">
      ${errorMsg ? `<div class="alert-moodle alert-error">${esc(errorMsg)}</div>` : ''}
      <p style="margin:0 0 6px 0;">Time limit: ${esc(formatDurationWords(paper.durationSeconds))}</p>
      <p style="margin:0 0 14px 0;">navigation method: Free (one question per page)</p>
      ${focusedTableHtml}
      ${historyHtml}
      ${startActionHtml}
    </div>`;

  return renderShell({
    title: paper.title,
    cfg,
    courseName: paper.courseName,
    sectionName: paper.sectionName,
    activityTitle: paper.title,
    bodyHtml,
  });
}

// ---------- Finish Attempt Confirmation Page ----------

export interface FinishConfirmParams {
  cfg: AppConfig;
  paper: PublicPaper;
  attempt: AttemptSummaryRow;
  responses: Record<string, Record<string, string>>;
  flags: Record<string, boolean>;
  serverNow: number;
}

export function renderFinishConfirmPage(p: FinishConfirmParams): string {
  const { cfg, paper, attempt, responses, flags, serverNow } = p;
  const basePath = `/practice/${encodeURIComponent(paper.testId)}/attempt/${encodeURIComponent(attempt.attemptId)}`;
  const remSec = Math.max(0, Math.ceil((attempt.deadlineAt - serverNow) / 1000));

  let unansweredQuestions = 0;
  let incompleteQuestions = 0;

  const rowsHtml = paper.questions
    .map((q) => {
      const qr = responses[q.id] ?? {};
      const nAns = q.parts.filter((pt) => String(qr[pt.id] ?? '').trim() !== '').length;
      const flagged = Boolean(flags[q.id]);
      let status = 'Answer saved';
      if (nAns === 0) {
        status = 'Not yet answered';
        unansweredQuestions++;
      } else if (nAns < q.parts.length) {
        status = `Incomplete answer (${nAns}/${q.parts.length} parts answered)`;
        incompleteQuestions++;
      }
      return `<tr>
        <td><a href="${basePath}/attempt/${q.number}">${q.number}</a>${flagged ? ' <span style="color:#CA3120;font-size:10.5px;">(Flagged)</span>' : ''}</td>
        <td>${esc(status)}</td>
      </tr>`;
    })
    .join('');

  const warnHtml =
    unansweredQuestions > 0 || incompleteQuestions > 0
      ? `<div class="alert-moodle alert-warn">
          Warning: You have ${unansweredQuestions} unanswered question(s) and ${incompleteQuestions} partially answered question(s).
        </div>`
      : '';

  const bodyHtml = `
    <div class="moodle-box">
      <h2 style="font-size:16px;margin:0 0 12px 0;">Summary of attempt</h2>
      ${warnHtml}
      <table class="generaltable">
        <thead>
          <tr><th>Question</th><th>Status</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <div style="text-align:center;margin:20px 0;">
        <p style="margin-bottom:10px;">
          <a class="btn-moodle" href="${basePath}/attempt/1">Return to attempt</a>
        </p>
        <p style="margin:8px 0;">Time left <strong>${formatHMS(remSec)}</strong></p>
        <p style="color:#6A737B;font-size:11px;margin-bottom:10px;">
          Once you submit, you will no longer be able to change your answers for this attempt.
        </p>
        <form method="POST" action="${basePath}/submit">
          <button type="submit" class="btn-moodle btn-moodle-primary">Submit all and finish</button>
        </form>
      </div>
    </div>`;

  return renderShell({
    title: `${paper.title} - Summary of attempt`,
    cfg,
    courseName: paper.courseName,
    sectionName: paper.sectionName,
    activityTitle: paper.title,
    dataAttrs: {
      mode: 'attempt',
      'test-id': paper.testId,
      'attempt-id': attempt.attemptId,
      'deadline-at': attempt.deadlineAt,
      'server-now': serverNow,
    },
    bodyHtml,
  });
}

// ---------- Practice Exam Library Index (`/practice`) ----------

export function renderLibraryPage(cfg: AppConfig, tests: TestSummaryRow[], serverNow: number, msg?: string): string {
  const emptyHtml = `
    <div class="alert-moodle alert-warn" style="margin-top:12px;">
      <strong>No test imported</strong>
      <p style="margin:6px 0 0 0;">
        No practice papers are currently loaded. Import a paired <strong>PUBLIC questions (.txt)</strong> file and <strong>PRIVATE memo (.txt)</strong> file via the <a href="/import">Import test files</a> screen or via the CLI command:
      </p>
      <pre class="qcode boxed" style="margin-top:8px;">npm run import -- --public path/to/practice1.public.txt --memo path/to/practice1.memo.txt</pre>
    </div>`;

  const tableHtml =
    tests.length === 0
      ? emptyHtml
      : `<table class="generaltable">
          <thead>
            <tr>
              <th>Quiz</th>
              <th>Version</th>
              <th>Questions</th>
              <th>Marks</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Best / Last Grade</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${tests
              .map((t) => {
                const openAtt = t.attempts.find((a) => a.status === 'in_progress');
                const finished = t.attempts.filter((a) => a.status !== 'in_progress');
                const lastDone = finished[finished.length - 1];

                let stateBadge = 'Not started';
                if (!t.hasMemo) {
                  stateBadge = 'Public only (awaiting memo)';
                } else if (openAtt) {
                  const rem = Math.max(0, Math.ceil((openAtt.deadlineAt - serverNow) / 1000));
                  stateBadge = `In progress (${formatHMS(rem)} left)`;
                } else if (lastDone) {
                  stateBadge =
                    lastDone.status === 'timed_out' ? 'Auto-submitted at timeout' : 'Submitted';
                }

                const gradeStr =
                  lastDone && t.totalMarks > 0
                    ? `${(lastDone.marksAwarded ?? 0).toFixed(2)} / ${t.totalMarks.toFixed(2)} (${(((lastDone.marksAwarded ?? 0) / t.totalMarks) * 100).toFixed(2)}%)`
                    : '—';

                const primaryHref = openAtt
                  ? `/practice/${encodeURIComponent(t.testId)}/attempt/${encodeURIComponent(openAtt.attemptId)}/question/1`
                  : `/practice/${encodeURIComponent(t.testId)}/start?version=${t.version}`;
                const primaryLabel = openAtt
                  ? 'Continue attempt'
                  : lastDone
                    ? 'View / Re-attempt'
                    : 'Open quiz';

                return `<tr>
                  <td>
                    <a href="/practice/${encodeURIComponent(t.testId)}/start?version=${t.version}"><strong>${esc(t.title)}</strong></a>
                    ${t.isFixture ? `<span class="fixture-tag">ARTIFICIAL FIXTURE</span>` : ''}
                  </td>
                  <td>v${t.version}</td>
                  <td>${t.questionCount}</td>
                  <td>${t.totalMarks.toFixed(2)}</td>
                  <td>${esc(formatDurationWords(t.durationSeconds))}</td>
                  <td>${esc(stateBadge)}</td>
                  <td>${esc(gradeStr)}</td>
                  <td>
                    <a class="btn-moodle" href="${primaryHref}">${primaryLabel}</a>
                    ${
                      lastDone
                        ? ` <a class="btn-moodle" href="/practice/${encodeURIComponent(t.testId)}/attempt/${encodeURIComponent(lastDone.attemptId)}/review/1">Review</a>`
                        : ''
                    }
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>`;

  const hasFixtures = tests.some((t) => t.isFixture);

  const bodyHtml = `
    <div class="moodle-box" style="margin-left:0;max-width:1000px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div>
          <nav class="breadcrumb-nav">
            <span>${esc(cfg.courseName)}</span>
            <span class="breadcrumb-sep">/</span>
            <span>${esc(cfg.sectionName)}</span>
          </nav>
          <h1 class="activity-title" style="font-size:20px;">Practice Quizzes</h1>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <a class="btn-moodle btn-moodle-primary" href="/import">Import paired TXT files</a>
          ${
            hasFixtures
              ? `<form method="POST" action="/admin/clear-fixtures" onsubmit="return confirm('Remove all artificial developer fixture papers and their attempts? Real practice attempts will not be touched.');" style="margin:0;">
                  <button type="submit" class="btn-moodle">Clear fixture data</button>
                </form>`
              : ''
          }
        </div>
      </div>
      ${msg ? `<div class="alert-moodle alert-ok">${esc(msg)}</div>` : ''}
      ${tableHtml}
    </div>`;

  return renderShell({
    title: `${cfg.courseName} - Practice Quizzes`,
    cfg,
    bodyHtml,
  });
}

// ---------- Local Admin Import Page (`/import`) ----------

export function renderImportPage(
  cfg: AppConfig,
  result?: { ok: boolean; errors: string[]; warnings: string[]; message?: string },
): string {
  const reportHtml = result
    ? `<div class="alert-moodle ${result.ok ? 'alert-ok' : 'alert-error'}">
        <strong>${result.ok ? esc(result.message || 'Import succeeded.') : 'Import validation failed:'}</strong>
        ${
          result.errors.length
            ? `<ul style="margin:6px 0 0 18px;">${result.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
            : ''
        }
        ${
          result.warnings.length
            ? `<ul style="margin:6px 0 0 18px;">${result.warnings.map((w) => `<li>Warning: ${esc(w)}</li>`).join('')}</ul>`
            : ''
        }
      </div>`
    : '';

  const bodyHtml = `
    <div class="moodle-box" style="margin-left:0;max-width:920px;">
      <nav class="breadcrumb-nav">
        <a href="/practice">${esc(cfg.courseName)}</a>
        <span class="breadcrumb-sep">/</span>
        <span>Import paired TXT files</span>
      </nav>
      <h1 class="activity-title" style="font-size:20px;margin-bottom:12px;">Import Practice Test Pair (.txt)</h1>
      ${reportHtml}
      <p>
        Supply the <strong>PUBLIC QUESTIONS (.txt)</strong> file and the matching <strong>PRIVATE MEMO (.txt)</strong> file.
        You may also import the public file alone to preview its metadata, and import the private memo afterwards before starting an attempt.
      </p>

      <form method="POST" action="/import" enctype="multipart/form-data" style="background:#F8F9FA;border:1px solid #CAD0D7;padding:14px;border-radius:4px;margin-top:12px;">
        <div style="margin-bottom:12px;">
          <label style="display:block;font-weight:700;margin-bottom:4px;" for="publicFile">1. Public Questions (.txt)</label>
          <input type="file" id="publicFile" name="publicFile" accept=".txt,.json">
          <div style="margin-top:6px;">
            <textarea name="publicText" rows="6" style="width:100%;font-family:var(--font-mono);font-size:11px;" placeholder="Or paste the PUBLIC questions .txt content here..."></textarea>
          </div>
        </div>

        <div style="margin-bottom:12px;">
          <label style="display:block;font-weight:700;margin-bottom:4px;" for="memoFile">2. Private Answer Memo / Solution (.txt)</label>
          <input type="file" id="memoFile" name="memoFile" accept=".txt,.json">
          <div style="margin-top:6px;">
            <textarea name="memoText" rows="6" style="width:100%;font-family:var(--font-mono);font-size:11px;" placeholder="Or paste the PRIVATE memo .txt content here..."></textarea>
          </div>
        </div>

        <div style="display:flex;gap:10px;align-items:center;">
          <button type="submit" class="btn-moodle btn-moodle-primary">Validate &amp; Import</button>
          <a class="btn-moodle" href="/practice">Return to Practice Quizzes</a>
        </div>
      </form>
    </div>`;

  return renderShell({
    title: 'Import Practice Test Pair',
    cfg,
    bodyHtml,
  });
}

// ---------- Formatting Helpers ----------

export function formatHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatDurationWords(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts: string[] = [];
  if (hrs > 0) parts.push(`${hrs} ${hrs === 1 ? 'hour' : 'hours'}`);
  if (mins > 0) parts.push(`${mins} ${mins === 1 ? 'min' : 'mins'}`);
  if (hrs === 0 && secs > 0) parts.push(`${secs} ${secs === 1 ? 'sec' : 'secs'}`);
  return parts.length > 0 ? parts.join(' ') : '0 secs';
}

export function formatDateTime(ms: number, cfg: AppConfig): string {
  try {
    const d = new Date(ms);
    const opts: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    };
    if (cfg.timeZone) opts.timeZone = cfg.timeZone;
    return new Intl.DateTimeFormat(cfg.locale || 'en-GB', opts).format(d);
  } catch {
    return new Date(ms).toISOString();
  }
}
