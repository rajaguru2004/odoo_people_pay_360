/**
 * The tiny template language letter bodies are written in.
 *
 * Two forms only — `{{value}}` and `{{#if value}}…{{else}}…{{/if}}` — which is
 * everything the shipped letters use. A full templating engine is not pulled in
 * for it: the bodies are edited by HR through the API, so the language they can
 * write in is part of the security boundary. Anything richer would let a
 * template reach for data it was never handed, and the context below is a flat
 * whitelist for exactly that reason.
 *
 * Values are HTML-escaped on the way in. A letter is a legal document rendered
 * from employee-supplied text (an addressee, a purpose), and an unescaped
 * apostrophe in a company name is the smallest version of the same problem.
 */

export type LetterContext = Record<string, unknown>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Resolve `a.b.c` against the context, so `{{custom.jobGrade}}` works. */
function lookup(context: LetterContext, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)[key]
          : undefined,
      context,
    );
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

const KEY = String.raw`[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*`;

/**
 * Innermost-first, so a nested conditional is resolved before the block that
 * contains it. The pattern refuses `{{#if}}` inside its own body, which is what
 * makes "innermost" true rather than merely likely.
 */
const IF_BLOCK = new RegExp(
  String.raw`\{\{#if\s+(${KEY})\}\}((?:(?!\{\{#if)[\s\S])*?)\{\{\/if\}\}`,
);

const ELSE_SPLIT = /\{\{else\}\}/;

const INTERPOLATION = new RegExp(String.raw`\{\{\s*(${KEY})\s*\}\}`, 'g');

export function renderLetterTemplate(
  source: string,
  context: LetterContext,
): string {
  let out = source;

  // Conditionals first: an unresolved `{{#if}}` would otherwise have its
  // condition interpolated into the markup as a literal.
  for (let guard = 0; guard < 200; guard += 1) {
    const match = IF_BLOCK.exec(out);
    if (!match) break;
    const [whole, key, body] = match;
    const [whenTrue, whenFalse = ''] = body.split(ELSE_SPLIT);
    out = out.replace(
      whole,
      isTruthy(lookup(context, key)) ? whenTrue : whenFalse,
    );
  }

  // A key the context does not carry renders empty rather than leaving the
  // placeholder on the page — a template referring to a field somebody later
  // removed should produce a blank, not the literal `{{jobGrade}}`.
  return out.replace(INTERPOLATION, (_whole, key: string) => {
    const value = lookup(context, key);
    if (value === null || value === undefined) return '';
    return escapeHtml(String(value));
  });
}
