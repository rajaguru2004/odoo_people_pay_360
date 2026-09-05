import { TokenDef } from '@/types/document-template';

/**
 * Chip serialization — the ONE place the `span[data-var]` contract lives.
 *
 * A chip is the only sanctioned path to a live token: the server neutralises
 * every typed brace, so anything that is not a `data-var` span prints as
 * literal text. The inner label is presentation only and is discarded by the
 * server transform — renaming a field later never changes what renders.
 */

export interface ChipSpec {
  path: string;
  label: string;
  /** Server helper to wrap the value in: money | num | date | none. */
  format?: 'money' | 'num' | 'date';
}

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const escapeText = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The HTML inserted at the caret. `contenteditable="false"` is what makes the
 *  browser treat it as one caret-atomic unit: arrows skip it, one Backspace
 *  removes it whole. */
export function buildChipHtml(chip: ChipSpec): string {
  const format = chip.format ? ` data-format="${escapeAttr(chip.format)}"` : '';
  return (
    `<span data-var="${escapeAttr(chip.path)}"${format} ` +
    `class="ess-var-chip" contenteditable="false">@ ${escapeText(chip.label)}</span>`
  );
}

/** Format a manifest token declares, mapped to the server helper name. */
export function formatForToken(token: Pick<TokenDef, 'type'>): ChipSpec['format'] {
  switch (token.type) {
    case 'money':
      return 'money';
    case 'number':
      return 'num';
    case 'date':
      return 'date';
    default:
      return undefined;
  }
}

/** Chip styling injected into the CANVAS FRAME only — never exported, because
 *  the server replaces the whole span with a token anyway. */
export const CHIP_CANVAS_CSS = `
.ess-var-chip {
  display: inline-block;
  padding: 0 0.35em;
  border-radius: 4px;
  background: rgba(31, 58, 95, 0.12);
  color: #1f3a5f;
  font-weight: 600;
  white-space: nowrap;
  cursor: default;
}
`;

/** Every data-var path present in an HTML string, with its each-scope flag. */
export function collectChipPaths(html: string): { path: string; inEach: boolean }[] {
  const out: { path: string; inEach: boolean }[] = [];
  // Track data-each nesting positionally: good enough for validation because
  // the server rejects nested data-each outright.
  const eachRanges: [number, number][] = [];
  const eachRe = /data-each="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = eachRe.exec(html))) {
    // Approximate the scope as "from this attribute to the end" — the compiler
    // enforces the real structure; this only decides relative-path validation.
    eachRanges.push([m.index, html.length]);
  }
  const varRe = /data-var="([^"]*)"/g;
  while ((m = varRe.exec(html))) {
    const idx = m.index;
    out.push({
      path: m[1],
      inEach: eachRanges.some(([s, e]) => idx > s && idx < e),
    });
  }
  return out;
}

/** Every data-each collection named in an HTML string. */
export function collectEachPaths(html: string): string[] {
  const out: string[] = [];
  const re = /data-each="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
