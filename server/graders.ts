/**
 * Deterministic graders. Pure functions: (grader spec from private memo, raw student string) -> result.
 * No randomness, no language model. Every part type has documented accepted-format rules
 * (see IMPORT_GUIDE.md).
 */

export type ListItemType = 'integer' | 'decimal' | 'string' | 'binary';

export type Grader =
  | {
      type: 'integer';
      answer: number | string;
      accept?: (number | string)[];
      partialAccept?: Array<{ answer: number | string; fraction: number }>;
    }
  | {
      type: 'decimal';
      answer: number | string;
      absTol?: number;
      relTol?: number;
      partialAccept?: Array<{ answer: number | string; fraction: number; absTol?: number }>;
    }
  | { type: 'binary'; answer: string; width?: number }
  | {
      type: 'list';
      answer: unknown[];
      items?: ListItemType;
      ordered?: boolean;
      partial?: 'none' | 'positional';
      requireBrackets?: boolean;
      absTol?: number;
    }
  | { type: 'text'; accept: string[]; caseSensitive?: boolean; regex?: string[] }
  | { type: 'choice'; answer: string }
  | { type: 'multichoice'; answers: string[]; partial?: 'none' | 'proportional' };

export type GradeState = 'correct' | 'partial' | 'incorrect' | 'blank' | 'invalid' | 'needs_manual_review';

export interface ListMark {
  text: string;
  ok: boolean;
}

export interface GradeResult {
  state: GradeState;
  /** 0..1 */
  fraction: number;
  /** Interpreted value shown in the white "Your last answer was interpreted as follows" box. */
  normalized: string | null;
  /** Automatic feedback lines (inline markup). */
  messages: string[];
  /** Element-by-element comparison for lists of the right length (wrong ones shown in red). */
  listMarks?: ListMark[];
}

export const isBlank = (raw: unknown) => raw == null || String(raw).trim() === '';

// ---------- scalar parsers ----------

const INT_RE = /^[+-]?\d+$/;
const DEC_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const RATIO_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\/\s*((?:\d+(?:\.\d*)?|\.\d+))$/;

export function parseInteger(raw: string): { ok: true; value: bigint; display: string } | { ok: false } {
  const s = raw.trim();
  if (!INT_RE.test(s)) return { ok: false };
  const value = BigInt(s);
  return { ok: true, value, display: value.toString() };
}

export function parseDecimal(raw: string): { ok: true; value: number; display: string } | { ok: false } {
  const s = raw.trim();
  if (DEC_RE.test(s)) {
    const v = Number(s);
    if (!Number.isFinite(v)) return { ok: false };
    return { ok: true, value: v, display: s.replace(/^\+/, '') };
  }
  const m = RATIO_RE.exec(s);
  if (m) {
    const den = Number(m[2]);
    if (den === 0) return { ok: false };
    return { ok: true, value: Number(m[1]) / den, display: `${m[1].replace(/^\+/, '')}/${m[2]}` };
  }
  return { ok: false };
}

function numEq(a: number, b: number, absTol = 1e-9, relTol = 1e-9) {
  return Math.abs(a - b) <= Math.max(absTol, relTol * Math.abs(b));
}

// ---------- list parser ----------

export type LNode = string | LNode[];

export function parseList(raw: string, requireBrackets = false): { ok: true; value: LNode[] } | { ok: false; error: string } {
  let s = raw.trim();
  if (!s.startsWith('[')) {
    if (requireBrackets) return { ok: false, error: 'Your answer should be a list in square brackets, for example \\([1,2,3]\\).' };
    s = `[${s}]`;
  }
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const value = (): LNode => {
    ws();
    if (s[i] === '[') {
      i++;
      const out: LNode[] = [];
      ws();
      if (s[i] === ']') {
        i++;
        return out;
      }
      for (;;) {
        out.push(value());
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === ']') {
          i++;
          return out;
        }
        throw new Error('Your list is not properly closed with "]" or has a missing comma.');
      }
    }
    const start = i;
    while (i < s.length && !',[]'.includes(s[i])) i++;
    const tok = s.slice(start, i).trim();
    if (tok === '') throw new Error('Your list has an empty element (two commas in a row?).');
    return tok.replace(/^["']|["']$/g, '');
  };
  try {
    const v = value();
    ws();
    if (i !== s.length) return { ok: false, error: 'Unexpected characters after the end of the list.' };
    if (!Array.isArray(v)) return { ok: false, error: 'A list in square brackets is expected.' };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function formatList(v: LNode): string {
  return Array.isArray(v) ? `[${v.map(formatList).join(', ')}]` : v;
}

export function typedList(v: LNode): string {
  return Array.isArray(v) ? `[${v.map(typedList).join(',')}]` : v;
}

function toNode(x: unknown): LNode {
  return Array.isArray(x) ? x.map(toNode) : String(x);
}

/** Compare a student node against an answer node. Returns null if the student token is malformed. */
function nodeEq(stu: LNode, ans: LNode, g: Extract<Grader, { type: 'list' }>): boolean | null {
  if (Array.isArray(ans) || Array.isArray(stu)) {
    if (!Array.isArray(ans) || !Array.isArray(stu) || ans.length !== stu.length) return false;
    let allOk: boolean | null = true;
    for (let k = 0; k < ans.length; k++) {
      const r = nodeEq(stu[k], ans[k], g);
      if (r === null) return null;
      if (!r) allOk = false;
    }
    return allOk;
  }
  const items = g.items ?? 'integer';
  if (items === 'integer') {
    const p = parseInteger(stu);
    if (!p.ok) return null;
    return p.value === BigInt(ans);
  }
  if (items === 'decimal') {
    const p = parseDecimal(stu);
    if (!p.ok) return null;
    return numEq(p.value, Number(ans), g.absTol ?? 1e-9);
  }
  if (items === 'binary') {
    if (!/^[01]+$/.test(stu)) return null;
    return stu === ans;
  }
  return stu.trim().toLowerCase() === ans.trim().toLowerCase();
}

function normalizeNode(n: LNode, items: ListItemType): LNode {
  if (Array.isArray(n)) return n.map((x) => normalizeNode(x, items));
  if (items === 'integer') {
    const p = parseInteger(n);
    return p.ok ? p.display : n;
  }
  return n;
}

// ---------- main entry ----------

export interface GradeOptions {
  /** For choice/multichoice: the set of valid option ids for this part. */
  choiceIds?: string[];
}

export function grade(g: Grader, rawIn: string | null | undefined, opts: GradeOptions = {}): GradeResult {
  const raw = rawIn ?? '';
  if (isBlank(raw)) return { state: 'blank', fraction: 0, normalized: null, messages: [] };
  const res = (fraction: number, normalized: string | null, messages: string[] = [], listMarks?: ListMark[]): GradeResult => ({
    state: fraction >= 1 - 1e-12 ? 'correct' : fraction > 0 ? 'partial' : 'incorrect',
    fraction: Math.min(1, Math.max(0, fraction)),
    normalized,
    messages,
    listMarks,
  });
  const invalid = (message: string): GradeResult => ({ state: 'invalid', fraction: 0, normalized: null, messages: [message] });

  switch (g.type) {
    case 'integer': {
      const p = parseInteger(raw);
      if (!p.ok) return invalid('This answer is invalid. A whole number is expected (digits only — do not type units).');
      const accepted = [g.answer, ...(g.accept ?? [])].map((a) => BigInt(String(a)));
      if (accepted.some((a) => a === p.value)) return res(1, p.display);
      if (g.partialAccept) {
        const hit = g.partialAccept.find((pa) => BigInt(String(pa.answer)) === p.value);
        if (hit) return res(hit.fraction, p.display);
      }
      return res(0, p.display);
    }
    case 'decimal': {
      const p = parseDecimal(raw);
      if (!p.ok) return invalid('This answer is invalid. A number is expected (do not type units).');
      if (numEq(p.value, Number(g.answer), g.absTol, g.relTol)) return res(1, p.display);
      if (g.partialAccept) {
        const hit = g.partialAccept.find((pa) => numEq(p.value, Number(pa.answer), pa.absTol ?? g.absTol, g.relTol));
        if (hit) return res(hit.fraction, p.display);
      }
      return res(0, p.display);
    }
    case 'binary': {
      const s = raw.trim();
      if (!/^[01]+$/.test(s)) return invalid('This answer is invalid. Only the digits 0 and 1 are allowed.');
      const width = g.width ?? g.answer.length;
      if (s.length !== width) {
        return res(0, s, [`Your answer should have \\(${width}\\) binary digits, but it actually has \\(${s.length}\\).`]);
      }
      return res(s === g.answer ? 1 : 0, s);
    }
    case 'list': {
      const p = parseList(raw, g.requireBrackets ?? false);
      if (!p.ok) return invalid(`This answer is invalid. ${p.error}`);
      const items = g.items ?? 'integer';
      const stu = p.value;
      const ans = g.answer.map(toNode);
      const display = formatList(normalizeNode(stu, items));
      if (stu.length !== ans.length) {
        return res(0, display, [`Your list should have \\(${ans.length}\\) elements, but it actually has \\(${stu.length}\\).`]);
      }
      const ordered = g.ordered ?? true;
      let matches = 0;
      const marks: ListMark[] = [];
      if (ordered) {
        for (let k = 0; k < ans.length; k++) {
          const r = nodeEq(stu[k], ans[k], g);
          if (r === null) return invalid(`This answer is invalid. The element "${formatList(stu[k])}" is not of the expected kind (${items}).`);
          if (r) matches++;
          marks.push({ text: formatList(normalizeNode(stu[k], items)), ok: r });
        }
      } else {
        const used = new Array(ans.length).fill(false);
        for (const s of stu) {
          let hit = false;
          for (let k = 0; k < ans.length; k++) {
            if (used[k]) continue;
            const r = nodeEq(s, ans[k], g);
            if (r === null) return invalid(`This answer is invalid. The element "${formatList(s)}" is not of the expected kind (${items}).`);
            if (r) {
              used[k] = true;
              hit = true;
              break;
            }
          }
          if (hit) matches++;
          marks.push({ text: formatList(normalizeNode(s, items)), ok: hit });
        }
      }
      const fraction = matches === ans.length ? 1 : (g.partial ?? 'none') === 'positional' ? matches / ans.length : 0;
      return res(fraction, display, [], fraction < 1 ? marks : undefined);
    }
    case 'text': {
      const norm = (x: string) => {
        const t = x.trim().replace(/\s+/g, ' ');
        return g.caseSensitive ? t : t.toLowerCase();
      };
      const s = norm(raw);
      let ok = g.accept.some((a) => norm(a) === s);
      if (!ok && g.regex) ok = g.regex.some((r) => new RegExp(`^(?:${r})$`, g.caseSensitive ? '' : 'i').test(raw.trim()));
      return res(ok ? 1 : 0, raw.trim().replace(/\s+/g, ' '));
    }
    case 'choice': {
      const id = raw.trim();
      if (opts.choiceIds && !opts.choiceIds.includes(id)) return invalid('This answer is invalid (unknown option).');
      return res(id === g.answer ? 1 : 0, null);
    }
    case 'multichoice': {
      const chosen = [...new Set(raw.split(',').map((x) => x.trim()).filter(Boolean))];
      if (opts.choiceIds && chosen.some((c) => !opts.choiceIds!.includes(c))) return invalid('This answer is invalid (unknown option).');
      const right = new Set(g.answers);
      const nRight = chosen.filter((c) => right.has(c)).length;
      const nWrong = chosen.length - nRight;
      if (nRight === right.size && nWrong === 0) return res(1, null);
      if ((g.partial ?? 'none') === 'proportional') return res(Math.max(0, (nRight - nWrong) / right.size), null);
      return res(0, null);
    }
    default:
      return { state: 'needs_manual_review', fraction: 0, normalized: null, messages: ['This part cannot be marked automatically.'] };
  }
}

/** The canonical string a student could type to get full marks (used for memo self-check and "can be typed as"). */
export function canonicalTyped(g: Grader): string {
  switch (g.type) {
    case 'integer':
    case 'decimal':
      return String(g.answer);
    case 'binary':
      return g.answer;
    case 'list':
      return typedList(g.answer.map(toNode));
    case 'text':
      return g.accept[0] ?? '';
    case 'choice':
      return g.answer;
    case 'multichoice':
      return g.answers.join(',');
  }
}

/** The canonical maths-style display of the correct answer. */
export function canonicalDisplay(g: Grader): string {
  if (g.type === 'list') return formatList(g.answer.map(toNode));
  return canonicalTyped(g);
}
