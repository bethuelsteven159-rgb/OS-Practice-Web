/**
 * Tiny, safe markup used by imported test/memo files.
 *
 * Inline syntax (inside any text string):
 *   **bold**   *italic*   `code` (pink monospace)   \( math \) (serif, like MathJax)
 *   A newline inside a string becomes a line break.
 *
 * Block syntax: a content array whose items are either plain strings (paragraphs) or objects:
 *   { "type": "p", "text": "..." }
 *   { "type": "code", "text": "multi\nline", "boxed": true }      boxed = grey bordered listing
 *   { "type": "table", "header": ["A","B"], "rows": [["1","2"]] }  cells use inline syntax
 *   { "type": "ul" | "ol", "items": ["...", "..."] }
 *   { "type": "math", "text": "[3,3,4]" }                          centred display maths
 *   { "type": "hr" }
 *
 * Everything is HTML-escaped first; no raw HTML from files is ever emitted.
 */

export type Block =
  | string
  | { type: 'p'; text: string }
  | { type: 'code'; text: string; boxed?: boolean }
  | { type: 'table'; header?: string[]; rows: string[][] }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'math'; text: string }
  | { type: 'hr' };

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** MathJax puts a little space after commas in lists; mimic that. */
export function mathText(s: string): string {
  return esc(String(s).trim().replace(/\s*,\s*/g, ', '));
}

export function inline(src: unknown): string {
  const holders: string[] = [];
  const hold = (html: string) => `\u0000${holders.push(html) - 1}\u0000`;
  let s = String(src ?? '');
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_m, m: string) => hold(`<span class="math">${mathText(m)}</span>`));
  s = esc(s);
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?![\s*])([\s\S]+?)(?<![\s*])\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\r?\n/g, '<br>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => holders[Number(i)]);
  return s;
}

export function normalizeBlocks(b: unknown): Block[] {
  if (b == null) return [];
  if (typeof b === 'string') return [b];
  if (Array.isArray(b)) return b as Block[];
  return [b as Block];
}

export function renderBlocks(input: unknown): string {
  return normalizeBlocks(input).map(renderBlock).join('\n');
}

function renderBlock(b: Block): string {
  if (typeof b === 'string') return `<p>${inline(b)}</p>`;
  switch (b.type) {
    case 'p':
      return `<p>${inline(b.text)}</p>`;
    case 'code':
      return `<pre class="qcode${b.boxed ? ' boxed' : ''}">${esc(b.text)}</pre>`;
    case 'table': {
      const head = b.header?.length
        ? `<thead><tr>${b.header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead>`
        : '';
      const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      return `<table class="qtable">${head}<tbody>${rows}</tbody></table>`;
    }
    case 'ul':
    case 'ol':
      return `<${b.type}>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${b.type}>`;
    case 'math':
      return `<p class="mathdisplay"><span class="math">${mathText(b.text)}</span></p>`;
    case 'hr':
      return '<hr>';
    default:
      return '';
  }
}

/** Validate a block array; returns error strings (empty = ok). */
export function checkBlocks(b: unknown, where: string): string[] {
  const errs: string[] = [];
  for (const [i, blk] of normalizeBlocks(b).entries()) {
    const at = `${where}[${i}]`;
    if (typeof blk === 'string') continue;
    if (!blk || typeof blk !== 'object') {
      errs.push(`${at}: block must be a string or an object`);
      continue;
    }
    const t = (blk as { type?: unknown }).type;
    const o = blk as Record<string, unknown>;
    if (t === 'p' || t === 'math' || t === 'code') {
      if (typeof o.text !== 'string') errs.push(`${at}: "${t}" block needs a "text" string`);
    } else if (t === 'table') {
      if (!Array.isArray(o.rows) || !o.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string')))
        errs.push(`${at}: table "rows" must be an array of arrays of strings`);
      if (o.header !== undefined && !(Array.isArray(o.header) && o.header.every((c) => typeof c === 'string')))
        errs.push(`${at}: table "header" must be an array of strings`);
    } else if (t === 'ul' || t === 'ol') {
      if (!Array.isArray(o.items) || !o.items.every((x) => typeof x === 'string'))
        errs.push(`${at}: list "items" must be an array of strings`);
    } else if (t !== 'hr') {
      errs.push(`${at}: unknown block type ${JSON.stringify(t)}`);
    }
  }
  return errs;
}
