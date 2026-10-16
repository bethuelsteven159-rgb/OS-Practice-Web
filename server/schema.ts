/**
 * Paired TXT file contract, parser and validator.
 *
 * Each practice paper consists of TWO UTF-8 .txt files:
 *   1. PUBLIC QUESTIONS file  (safe to view/load; no answers or solutions)
 *   2. PRIVATE MEMO file      (stored server-side only; never sent to browser before submission)
 *
 * Both files may be written either as:
 *   - UTF-8 JSON (with optional // or # line comments and optional ```json fences), OR
 *   - Tagged plain-text blocks (`=== OS-PRACTICE-PUBLIC v1 ===` / `=== OS-PRACTICE-MEMO v1 ===`).
 */

import { type Block, checkBlocks, normalizeBlocks } from './markup.ts';
import { type Grader, canonicalTyped, grade } from './graders.ts';

export type PartType =
  | 'integer'
  | 'decimal'
  | 'binary'
  | 'list'
  | 'ordered_list'
  | 'text'
  | 'dropdown'
  | 'radio'
  | 'checkbox';

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface PublicPart {
  id: string;
  /** Displayed as `(a)`, `(b)`, ... when present. Omit or "" for single-part questions. */
  label?: string;
  type: PartType;
  marks: number;
  prompt?: Block[] | string;
  /** Small grey instruction under the control, e.g. `(a whole number - do not type the unit)`. */
  answerInputHint?: string;
  /** Width of text input in characters (default ~12 for scalar, ~22 for list). */
  inputWidth?: number;
  choices?: ChoiceOption[];
  constraints?: {
    bitWidth?: number;
    listLength?: number;
    requireBrackets?: boolean;
  };
}

export interface PublicQuestion {
  id: string;
  number: number;
  marks: number;
  stem: Block[] | string;
  parts: PublicPart[];
}

export interface PublicPaper {
  schemaVersion: string;
  kind: 'public_questions';
  testId: string;
  version: number;
  title: string;
  courseName?: string;
  sectionName?: string;
  durationSeconds: number;
  totalMarks: number;
  isFixture?: boolean;
  description?: string;
  questions: PublicQuestion[];
}

export interface PrivatePartMemo {
  marks: number;
  grader: Grader;
  /** Shown after `Correct answer, well done.` / `Incorrect answer.` when present. */
  feedback?: Block[] | string;
  /** Optional override for the bottom `The answer ..., which can be typed as ..., would be correct.` line. */
  acceptedAnswerLine?: string;
}

export interface PrivateQuestionMemo {
  /** Worked solution paragraphs rendered in the cream outcome block after per-part verdicts. */
  solution?: Block[] | string;
  /** Optional green `Comment:` box below the cream outcome panel (as seen on Q21 screenshot). */
  comment?: Block[] | string;
  parts: Record<string, PrivatePartMemo>;
}

export interface PrivateMemo {
  schemaVersion: string;
  kind: 'private_memo';
  testId: string;
  version: number;
  totalMarks: number;
  questions: Record<string, PrivateQuestionMemo>;
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// ---------- flexible TXT parser (JSON or tagged text) ----------

function stripBomAndFences(raw: string): string {
  let s = raw.replace(/^\uFEFF/, '').trim();
  const fence = /^```(?:json|txt)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(s);
  if (fence) s = fence[1].trim();
  return s;
}

/** Parse either JSON-in-TXT or tagged plain-text format into a raw object. */
export function parseTxtPayload(rawText: string): { ok: true; data: unknown } | { ok: false; error: string } {
  const s = stripBomAndFences(rawText);
  if (!s) return { ok: false, error: 'File is empty.' };

  if (s.startsWith('=== OS-PRACTICE-PUBLIC') || s.startsWith('=== OS-PRACTICE-MEMO')) {
    return parseTaggedText(s);
  }

  try {
    return { ok: true, data: JSON.parse(s) };
  } catch (e1) {
    // Allow leading # or // comment lines before JSON object
    const withoutHeaderComments = s
      .split(/\r?\n/)
      .filter((line) => !/^\s*(#|\/\/)/.test(line))
      .join('\n')
      .trim();
    try {
      return { ok: true, data: JSON.parse(withoutHeaderComments) };
    } catch {
      return { ok: false, error: `Invalid JSON in TXT file: ${(e1 as Error).message}` };
    }
  }
}

/**
 * Tagged plain-text format support:
 *   === OS-PRACTICE-PUBLIC v1 ===
 *   testId: practice-1
 *   version: 1
 *   title: Practice Test 1
 *   durationSeconds: 7200
 *   totalMarks: 5
 *   --- QUESTION q1 | number=1 | marks=5 ---
 *   Stem text here...
 *   --- PART a | label=(a) | type=integer | marks=5 | hint=(a whole number) ---
 *   Part prompt here...
 */
function parseTaggedText(src: string): { ok: true; data: unknown } | { ok: false; error: string } {
  const lines = src.split(/\r?\n/);
  const headerLine = lines[0].trim();
  const isPublic = headerLine.startsWith('=== OS-PRACTICE-PUBLIC');
  const isMemo = headerLine.startsWith('=== OS-PRACTICE-MEMO');
  if (!isPublic && !isMemo) {
    return { ok: false, error: 'Unrecognized tagged header.' };
  }

  try {
    if (isPublic) {
      const meta: Record<string, string> = {};
      const questions: PublicQuestion[] = [];
      let i = 1;
      while (i < lines.length && !lines[i].startsWith('--- QUESTION')) {
        const m = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(lines[i].trim());
        if (m) meta[m[1]] = m[2].trim();
        i++;
      }
      while (i < lines.length) {
        const qHead = lines[i].trim();
        const qm = /^---\s*QUESTION\s+([^\s|]+)(?:\s*\|\s*(.*?))?\s*---$/.exec(qHead);
        if (!qm) {
          i++;
          continue;
        }
        const qId = qm[1];
        const qAttrs = parsePipeAttrs(qm[2] ?? '');
        i++;
        const stemLines: string[] = [];
        while (i < lines.length && !lines[i].startsWith('--- PART') && !lines[i].startsWith('--- QUESTION')) {
          stemLines.push(lines[i]);
          i++;
        }
        const parts: PublicPart[] = [];
        while (i < lines.length && lines[i].startsWith('--- PART')) {
          const pm = /^---\s*PART\s+([^\s|]+)(?:\s*\|\s*(.*?))?\s*---$/.exec(lines[i].trim());
          if (!pm) break;
          const pId = pm[1];
          const pAttrs = parsePipeAttrs(pm[2] ?? '');
          i++;
          const pLines: string[] = [];
          const choices: ChoiceOption[] = [];
          while (i < lines.length && !lines[i].startsWith('--- PART') && !lines[i].startsWith('--- QUESTION')) {
            const cm = /^\s*\*\s*\[([A-Za-z0-9_-]+)\]\s*(.+)$/.exec(lines[i]);
            if (cm) choices.push({ id: cm[1], label: cm[2].trim() });
            else pLines.push(lines[i]);
            i++;
          }
          parts.push({
            id: pId,
            label: pAttrs.label,
            type: (pAttrs.type ?? 'integer') as PartType,
            marks: Number(pAttrs.marks ?? 1),
            prompt: pLines.join('\n').trim() || undefined,
            answerInputHint: pAttrs.hint,
            inputWidth: pAttrs.width ? Number(pAttrs.width) : undefined,
            choices: choices.length ? choices : undefined,
          });
        }
        questions.push({
          id: qId,
          number: Number(qAttrs.number ?? questions.length + 1),
          marks: Number(qAttrs.marks ?? parts.reduce((s, p) => s + p.marks, 0)),
          stem: parseTaggedBlocks(stemLines.join('\n').trim()),
          parts,
        });
      }
      const paper: PublicPaper = {
        schemaVersion: '1.0',
        kind: 'public_questions',
        testId: meta.testId ?? '',
        version: Number(meta.version ?? 1),
        title: meta.title ?? '',
        courseName: meta.courseName,
        sectionName: meta.sectionName,
        durationSeconds: Number(meta.durationSeconds ?? 7200),
        totalMarks: Number(meta.totalMarks ?? questions.reduce((s, q) => s + q.marks, 0)),
        isFixture: meta.isFixture === 'true',
        description: meta.description,
        questions,
      };
      return { ok: true, data: paper };
    } else {
      const meta: Record<string, string> = {};
      const questions: Record<string, PrivateQuestionMemo> = {};
      let i = 1;
      while (i < lines.length && !lines[i].startsWith('--- QUESTION')) {
        const m = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(lines[i].trim());
        if (m) meta[m[1]] = m[2].trim();
        i++;
      }
      while (i < lines.length) {
        const qm = /^---\s*QUESTION\s+([^\s|]+)\s*---$/.exec(lines[i].trim());
        if (!qm) {
          i++;
          continue;
        }
        const qId = qm[1];
        i++;
        const solLines: string[] = [];
        while (i < lines.length && !lines[i].startsWith('--- PART') && !lines[i].startsWith('--- QUESTION')) {
          solLines.push(lines[i]);
          i++;
        }
        const parts: Record<string, PrivatePartMemo> = {};
        while (i < lines.length && lines[i].startsWith('--- PART')) {
          const pm = /^---\s*PART\s+([^\s|]+)(?:\s*\|\s*(.*?))?\s*---$/.exec(lines[i].trim());
          if (!pm) break;
          const pId = pm[1];
          const pAttrs = parsePipeAttrs(pm[2] ?? '');
          i++;
          const fbLines: string[] = [];
          while (i < lines.length && !lines[i].startsWith('--- PART') && !lines[i].startsWith('--- QUESTION')) {
            fbLines.push(lines[i]);
            i++;
          }
          const grader = buildTaggedGrader(pAttrs);
          parts[pId] = {
            marks: Number(pAttrs.marks ?? 1),
            grader,
            feedback: fbLines.join('\n').trim() ? parseTaggedBlocks(fbLines.join('\n').trim()) : undefined,
            acceptedAnswerLine: pAttrs.acceptedLine,
          };
        }
        questions[qId] = {
          solution: solLines.join('\n').trim() ? parseTaggedBlocks(solLines.join('\n').trim()) : undefined,
          parts,
        };
      }
      const memo: PrivateMemo = {
        schemaVersion: '1.0',
        kind: 'private_memo',
        testId: meta.testId ?? '',
        version: Number(meta.version ?? 1),
        totalMarks: Number(meta.totalMarks ?? 0),
        questions,
      };
      return { ok: true, data: memo };
    }
  } catch (e) {
    return { ok: false, error: `Failed to parse tagged TXT file: ${(e as Error).message}` };
  }
}

function parsePipeAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const seg of s.split('|')) {
    const idx = seg.indexOf('=');
    if (idx > 0) out[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
  }
  return out;
}

function parseTaggedBlocks(s: string): Block[] {
  if (!s) return [];
  return s
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function buildTaggedGrader(a: Record<string, string>): Grader {
  const t = a.grader ?? 'integer';
  if (t === 'integer') return { type: 'integer', answer: a.answer ?? '0' };
  if (t === 'decimal')
    return {
      type: 'decimal',
      answer: a.answer ?? '0',
      absTol: a.absTol ? Number(a.absTol) : undefined,
      relTol: a.relTol ? Number(a.relTol) : undefined,
    };
  if (t === 'binary')
    return { type: 'binary', answer: a.answer ?? '0', width: a.width ? Number(a.width) : undefined };
  if (t === 'list')
    return {
      type: 'list',
      answer: JSON.parse(a.answer ?? '[]'),
      items: (a.items as 'integer' | 'decimal' | 'string' | 'binary') ?? 'integer',
      ordered: a.ordered ? a.ordered !== 'false' : true,
      partial: (a.partial as 'none' | 'positional') ?? 'none',
    };
  if (t === 'choice') return { type: 'choice', answer: a.answer ?? '' };
  if (t === 'multichoice')
    return {
      type: 'multichoice',
      answers: (a.answer ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      partial: (a.partial as 'none' | 'proportional') ?? 'none',
    };
  return {
    type: 'text',
    accept: (a.answer ?? '').split('|').map((x) => x.trim()).filter(Boolean),
    caseSensitive: a.caseSensitive === 'true',
  };
}

// ---------- structural + cross-file validation ----------

const VALID_PART_TYPES = new Set<PartType>([
  'integer',
  'decimal',
  'binary',
  'list',
  'ordered_list',
  'text',
  'dropdown',
  'radio',
  'checkbox',
]);

const PRIVATE_KEYS_FORBIDDEN_IN_PUBLIC = [
  'grader',
  'acceptedAnswers',
  'correctAnswer',
  'answer',
  'answers',
  'solution',
  'feedback',
  'privateMemo',
];

export function validatePublicPaper(raw: unknown): ValidationReport & { paper?: PublicPaper } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Public file root must be a JSON object.'], warnings };
  }
  const o = raw as Record<string, unknown>;
  if (o.kind && o.kind !== 'public_questions') {
    errors.push(`Expected kind "public_questions", got ${JSON.stringify(o.kind)}.`);
  }
  if (typeof o.testId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(o.testId)) {
    errors.push('testId must be a non-empty alphanumeric/slug string (e.g. "practice-1").');
  }
  const version = Number(o.version ?? 1);
  if (!Number.isInteger(version) || version < 1) {
    errors.push('version must be a positive integer (1, 2, ...).');
  }
  if (typeof o.title !== 'string' || !o.title.trim()) {
    errors.push('title must be a non-empty string.');
  }
  const durationSeconds = Number(o.durationSeconds ?? 7200);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1) {
    errors.push('durationSeconds must be a positive number (default 7200 for 2 hours).');
  }
  if (!Array.isArray(o.questions) || o.questions.length === 0) {
    errors.push('questions must be a non-empty array.');
    return { ok: false, errors, warnings };
  }

  const seenQIds = new Set<string>();
  const seenNumbers = new Set<number>();
  let sumQMarks = 0;

  for (const [qi, qRaw] of o.questions.entries()) {
    const qAt = `questions[${qi}]`;
    if (!qRaw || typeof qRaw !== 'object') {
      errors.push(`${qAt}: must be an object.`);
      continue;
    }
    const q = qRaw as Record<string, unknown>;
    for (const k of PRIVATE_KEYS_FORBIDDEN_IN_PUBLIC) {
      if (k in q) errors.push(`${qAt}: public question must not contain private field "${k}".`);
    }
    const qId = String(q.id ?? '');
    if (!qId) errors.push(`${qAt}: missing question "id".`);
    if (seenQIds.has(qId)) errors.push(`${qAt}: duplicate question id "${qId}".`);
    seenQIds.add(qId);

    const num = Number(q.number ?? qi + 1);
    if (!Number.isInteger(num) || num < 1) errors.push(`${qAt} (${qId}): "number" must be a positive integer.`);
    if (seenNumbers.has(num)) errors.push(`${qAt} (${qId}): duplicate question number ${num}.`);
    seenNumbers.add(num);

    errors.push(...checkBlocks(q.stem, `${qAt}.stem`));

    if (!Array.isArray(q.parts) || q.parts.length === 0) {
      errors.push(`${qAt} (${qId}): "parts" must be a non-empty array.`);
      continue;
    }

    const seenPIds = new Set<string>();
    let sumPMarks = 0;
    for (const [pi, pRaw] of q.parts.entries()) {
      const pAt = `${qAt}.parts[${pi}]`;
      if (!pRaw || typeof pRaw !== 'object') {
        errors.push(`${pAt}: must be an object.`);
        continue;
      }
      const p = pRaw as Record<string, unknown>;
      for (const k of PRIVATE_KEYS_FORBIDDEN_IN_PUBLIC) {
        if (k in p) errors.push(`${pAt}: public part must not contain private field "${k}".`);
      }
      const pId = String(p.id ?? '');
      if (!pId) errors.push(`${pAt}: missing part "id".`);
      if (seenPIds.has(pId)) errors.push(`${pAt}: duplicate part id "${pId}" in question "${qId}".`);
      seenPIds.add(pId);

      const pType = String(p.type ?? '') as PartType;
      if (!VALID_PART_TYPES.has(pType)) {
        errors.push(`${pAt} (${qId}.${pId}): invalid part type "${pType}".`);
      }
      const pMarks = Number(p.marks);
      if (!Number.isFinite(pMarks) || pMarks <= 0) {
        errors.push(`${pAt} (${qId}.${pId}): "marks" must be a positive number.`);
      } else {
        sumPMarks += pMarks;
      }
      if (p.prompt !== undefined) errors.push(...checkBlocks(p.prompt, `${pAt}.prompt`));

      if (pType === 'dropdown' || pType === 'radio' || pType === 'checkbox') {
        if (!Array.isArray(p.choices) || p.choices.length < 2) {
          errors.push(`${pAt} (${qId}.${pId}): "${pType}" requires at least 2 choices.`);
        } else {
          const cIds = new Set<string>();
          for (const [ci, cRaw] of p.choices.entries()) {
            const c = cRaw as Record<string, unknown>;
            if (!c || typeof c.id !== 'string' || !c.id || typeof c.label !== 'string' || !c.label) {
              errors.push(`${pAt}.choices[${ci}]: each choice needs non-empty string "id" and "label".`);
            } else if (cIds.has(c.id)) {
              errors.push(`${pAt}.choices[${ci}]: duplicate choice id "${c.id}".`);
            } else {
              cIds.add(c.id);
            }
            if (c && ('isCorrect' in c || 'correct' in c)) {
              errors.push(`${pAt}.choices[${ci}]: public choice must not mark which option is correct.`);
            }
          }
        }
      }
    }

    const qMarks = Number(q.marks ?? sumPMarks);
    if (Math.abs(qMarks - sumPMarks) > 1e-6) {
      errors.push(
        `${qAt} (${qId}): question marks (${qMarks}) do not equal sum of part marks (${round2(sumPMarks)}).`,
      );
    }
    sumQMarks += qMarks;
  }

  const declaredTotal = Number(o.totalMarks ?? sumQMarks);
  if (Math.abs(declaredTotal - sumQMarks) > 1e-6) {
    errors.push(`Paper totalMarks (${declaredTotal}) does not equal sum of question marks (${round2(sumQMarks)}).`);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const paper: PublicPaper = {
    schemaVersion: String(o.schemaVersion ?? '1.0'),
    kind: 'public_questions',
    testId: String(o.testId),
    version,
    title: String(o.title).trim(),
    courseName: typeof o.courseName === 'string' ? o.courseName : undefined,
    sectionName: typeof o.sectionName === 'string' ? o.sectionName : undefined,
    durationSeconds,
    totalMarks: round2(declaredTotal),
    isFixture: Boolean(o.isFixture),
    description: typeof o.description === 'string' ? o.description : undefined,
    questions: (o.questions as PublicQuestion[]).map((q) => ({
      ...q,
      stem: normalizeBlocks(q.stem),
      parts: q.parts.map((p) => ({
        ...p,
        prompt: p.prompt !== undefined ? normalizeBlocks(p.prompt) : undefined,
      })),
    })),
  };

  return { ok: true, errors, warnings, paper };
}

export function validatePrivateMemo(
  raw: unknown,
  publicPaper?: PublicPaper,
): ValidationReport & { memo?: PrivateMemo } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Private memo root must be a JSON object.'], warnings };
  }
  const o = raw as Record<string, unknown>;
  if (o.kind && o.kind !== 'private_memo') {
    errors.push(`Expected kind "private_memo", got ${JSON.stringify(o.kind)}.`);
  }
  if (typeof o.testId !== 'string' || !o.testId) {
    errors.push('Memo testId must be a non-empty string.');
  }
  const version = Number(o.version ?? 1);
  if (!Number.isInteger(version) || version < 1) {
    errors.push('Memo version must be a positive integer.');
  }
  if (!o.questions || typeof o.questions !== 'object' || Array.isArray(o.questions)) {
    errors.push('Memo "questions" must be an object keyed by question_id.');
    return { ok: false, errors, warnings };
  }

  const qMap = o.questions as Record<string, unknown>;
  let sumMemoMarks = 0;

  for (const [qId, qVal] of Object.entries(qMap)) {
    const qAt = `questions["${qId}"]`;
    if (!qVal || typeof qVal !== 'object') {
      errors.push(`${qAt}: must be an object.`);
      continue;
    }
    const qm = qVal as Record<string, unknown>;
    if (qm.solution !== undefined) errors.push(...checkBlocks(qm.solution, `${qAt}.solution`));
    if (qm.comment !== undefined) errors.push(...checkBlocks(qm.comment, `${qAt}.comment`));
    if (!qm.parts || typeof qm.parts !== 'object' || Array.isArray(qm.parts)) {
      errors.push(`${qAt}: "parts" must be an object keyed by part_id.`);
      continue;
    }
    for (const [pId, pVal] of Object.entries(qm.parts as Record<string, unknown>)) {
      const pAt = `${qAt}.parts["${pId}"]`;
      if (!pVal || typeof pVal !== 'object') {
        errors.push(`${pAt}: must be an object.`);
        continue;
      }
      const pm = pVal as Record<string, unknown>;
      const m = Number(pm.marks);
      if (!Number.isFinite(m) || m <= 0) {
        errors.push(`${pAt}: "marks" must be a positive number.`);
      } else {
        sumMemoMarks += m;
      }
      if (pm.feedback !== undefined) errors.push(...checkBlocks(pm.feedback, `${pAt}.feedback`));
      const gErr = validateGrader(pm.grader, pAt);
      errors.push(...gErr);
    }
  }

  const declaredTotal = Number(o.totalMarks ?? sumMemoMarks);
  if (Math.abs(declaredTotal - sumMemoMarks) > 1e-6) {
    errors.push(`Memo totalMarks (${declaredTotal}) does not equal sum of part marks (${round2(sumMemoMarks)}).`);
  }

  if (publicPaper) {
    if (o.testId !== publicPaper.testId) {
      errors.push(`Memo testId "${o.testId}" does not match public paper testId "${publicPaper.testId}".`);
    }
    if (version !== publicPaper.version) {
      errors.push(`Memo version (${version}) does not match public paper version (${publicPaper.version}).`);
    }
    if (Math.abs(declaredTotal - publicPaper.totalMarks) > 1e-6) {
      errors.push(
        `Memo totalMarks (${declaredTotal}) does not match public paper totalMarks (${publicPaper.totalMarks}).`,
      );
    }

    const pubQIds = new Set(publicPaper.questions.map((q) => q.id));
    for (const qId of Object.keys(qMap)) {
      if (!pubQIds.has(qId)) errors.push(`Memo contains unknown question id "${qId}" not in public paper.`);
    }

    for (const pq of publicPaper.questions) {
      const mq = qMap[pq.id] as PrivateQuestionMemo | undefined;
      if (!mq || !mq.parts) {
        errors.push(`Memo is missing question "${pq.id}".`);
        continue;
      }
      const pubPIds = new Set(pq.parts.map((p) => p.id));
      for (const pId of Object.keys(mq.parts)) {
        if (!pubPIds.has(pId)) {
          errors.push(`Memo question "${pq.id}" contains unknown part id "${pId}".`);
        }
      }
      for (const pp of pq.parts) {
        const mp = mq.parts[pp.id];
        if (!mp) {
          errors.push(`Memo question "${pq.id}" is missing part "${pp.id}".`);
          continue;
        }
        if (Math.abs(Number(mp.marks) - pp.marks) > 1e-6) {
          errors.push(
            `Marks mismatch at ${pq.id}.${pp.id}: public has ${pp.marks}, memo has ${mp.marks}.`,
          );
        }
        if (mp.grader) {
          const compatErr = checkPartGraderCompatibility(pp, mp.grader, `${pq.id}.${pp.id}`);
          errors.push(...compatErr);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const memo: PrivateMemo = {
    schemaVersion: String(o.schemaVersion ?? '1.0'),
    kind: 'private_memo',
    testId: String(o.testId),
    version,
    totalMarks: round2(declaredTotal),
    questions: qMap as Record<string, PrivateQuestionMemo>,
  };

  return { ok: true, errors, warnings, memo };
}

function validateGrader(gRaw: unknown, at: string): string[] {
  const errs: string[] = [];
  if (!gRaw || typeof gRaw !== 'object') return [`${at}.grader: missing grader object.`];
  const g = gRaw as Grader;
  switch (g.type) {
    case 'integer':
      if (g.answer === undefined || !/^[+-]?\d+$/.test(String(g.answer).trim())) {
        errs.push(`${at}.grader: integer grader requires an integer "answer".`);
      }
      break;
    case 'decimal':
      if (g.answer === undefined || !Number.isFinite(Number(g.answer))) {
        errs.push(`${at}.grader: decimal grader requires a numeric "answer".`);
      }
      break;
    case 'binary':
      if (typeof g.answer !== 'string' || !/^[01]+$/.test(g.answer)) {
        errs.push(`${at}.grader: binary grader requires a 0/1 string "answer".`);
      }
      if (g.width !== undefined && g.answer && g.width !== g.answer.length) {
        errs.push(`${at}.grader: binary "width" (${g.width}) does not match length of "answer" (${g.answer.length}).`);
      }
      break;
    case 'list':
      if (!Array.isArray(g.answer)) {
        errs.push(`${at}.grader: list grader requires an array "answer".`);
      }
      break;
    case 'text':
      if (!Array.isArray(g.accept) || g.accept.length === 0 || !g.accept.every((s) => typeof s === 'string' && s.trim())) {
        errs.push(`${at}.grader: text grader requires a non-empty string array "accept".`);
      }
      break;
    case 'choice':
      if (typeof g.answer !== 'string' || !g.answer.trim()) {
        errs.push(`${at}.grader: choice grader requires a non-empty string "answer" (choice id).`);
      }
      break;
    case 'multichoice':
      if (!Array.isArray(g.answers) || g.answers.length === 0) {
        errs.push(`${at}.grader: multichoice grader requires a non-empty array "answers".`);
      }
      break;
    default:
      errs.push(`${at}.grader: unsupported grader type ${JSON.stringify((g as { type?: unknown }).type)}.`);
  }
  if (errs.length === 0) {
    // Self-check: feeding the canonical answer into the grader must score 1.0
    const self = grade(g, canonicalTyped(g));
    if (self.state !== 'correct' || Math.abs(self.fraction - 1) > 1e-9) {
      errs.push(`${at}.grader: self-check failed — canonical answer "${canonicalTyped(g)}" did not score 100%.`);
    }
  }
  return errs;
}

function checkPartGraderCompatibility(part: PublicPart, g: Grader, loc: string): string[] {
  const errs: string[] = [];
  const choiceTypes = new Set<PartType>(['dropdown', 'radio']);
  if (choiceTypes.has(part.type)) {
    if (g.type !== 'choice') {
      errs.push(`${loc}: public part type "${part.type}" requires grader type "choice", got "${g.type}".`);
    } else {
      const ids = new Set((part.choices ?? []).map((c) => c.id));
      if (!ids.has(g.answer)) {
        errs.push(`${loc}: memo choice answer "${g.answer}" is not one of the public choice ids [${[...ids].join(', ')}].`);
      }
    }
  } else if (part.type === 'checkbox') {
    if (g.type !== 'multichoice') {
      errs.push(`${loc}: public part type "checkbox" requires grader type "multichoice", got "${g.type}".`);
    } else {
      const ids = new Set((part.choices ?? []).map((c) => c.id));
      for (const a of g.answers) {
        if (!ids.has(a)) errs.push(`${loc}: memo multichoice answer "${a}" is not in public choices.`);
      }
    }
  } else if (part.type === 'list' || part.type === 'ordered_list') {
    if (g.type !== 'list') {
      errs.push(`${loc}: public part type "${part.type}" requires grader type "list", got "${g.type}".`);
    }
  } else if (part.type !== g.type) {
    errs.push(`${loc}: public part type "${part.type}" does not match memo grader type "${g.type}".`);
  }
  return errs;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
