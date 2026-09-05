import sanitizeHtml from 'sanitize-html';

/**
 * Save-time sanitizer for admin-authored template HTML.
 *
 * Runs BEFORE the row is written, so what is stored is what was reviewed. That
 * ordering is the point: sanitizing at render instead would mean the database
 * holds markup nobody approved, and any future code path that reads bodyHtml
 * without going through the renderer inherits the hole.
 *
 * This is one of TWO independent layers. The other is PdfService aborting every
 * non-`data:` request at the page level. Neither is sufficient alone —
 * sanitizers are pattern matchers and get bypassed, and a network block does
 * nothing about markup that corrupts the document itself — but together, a
 * `<script>` that survives this has nothing left to talk to.
 *
 * Handlebars is NOT a sandbox. `{{lookup}}` and `{{#with}}` walk whatever object
 * they are handed, which is why the render context is a whitelisted plain object
 * built by a resolver rather than a Prisma model.
 */

export class TemplateSanitizeError extends Error {}

/**
 * Placeholder that stands in for a Handlebars expression during the HTML pass.
 *
 * Deliberately a VALID `data:` URI rather than a word. The shipped templates
 * write `<img src="{{companyLogoUrl}}">`, and the scheme allow-list below
 * permits only `data:` on an image — so a plain-word placeholder would fail the
 * scheme check and sanitize-html would silently drop the `src`, removing the
 * logo from every template it touched. Encoding the placeholder as a data URI
 * lets the expression survive without weakening the rule that matters: a
 * genuine `http://` image src is still stripped.
 *
 * Known limitation, accepted: `<a href="{{x}}">` loses its href, because `a`
 * does not allow the `data:` scheme. A hyperlink is inert on paper, so the
 * visible text is what carries the meaning.
 */
const TOKEN_PREFIX = 'data:x-hb,';
const TOKEN_RE = /data:x-hb,(\d+)/g;

const ALLOWED_TAGS = [
  'html', 'head', 'body', 'meta', 'style', 'title',
  'div', 'span', 'p', 'br', 'hr', 'section', 'article', 'header', 'footer', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'bdi', 'bdo',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'img', 'a', 'blockquote', 'pre', 'code', 'figure', 'figcaption',
];

/**
 * Refused outright, whatever the attributes.
 *
 * `svg`/`foreignObject` are here because SVG is a scripting surface, and this
 * markup is about to be rendered by a real browser engine. `link`/`base` are
 * here because they reintroduce remote loading through the back door.
 */
const FORBIDDEN_TAGS = [
  'script', 'iframe', 'object', 'embed', 'applet', 'form', 'input', 'button',
  'select', 'textarea', 'link', 'base', 'svg', 'foreignobject', 'math',
  'noscript', 'template', 'frame', 'frameset', 'audio', 'video', 'source',
];

/**
 * Strip anything in a style value that can reach the network or execute.
 *
 * `url(...)` is permitted only for a `data:` URI, because the engine inlines
 * brand assets itself and a remote background is both an exfil channel and an
 * image that provably cannot paint on a no-network page.
 */
function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'void(')
    .replace(/(behavior|-moz-binding)\s*:[^;}]*/gi, '')
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match, _q, url: string) =>
      /^data:/i.test(String(url).trim()) ? match : 'none',
    );
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    '*': ['style', 'class', 'dir', 'lang', 'align', 'colspan', 'rowspan', 'width', 'height'],
    img: ['src', 'alt', 'style', 'class', 'width', 'height'],
    a: ['href', 'style', 'class'],
    meta: ['charset'],
    td: ['style', 'class', 'colspan', 'rowspan', 'align', 'valign'],
    th: ['style', 'class', 'colspan', 'rowspan', 'align', 'valign', 'scope'],
  },
  // The single most important line in this file. A remote image src is not a
  // feature the engine needs — brand assets are inlined server-side — and it is
  // how a template exfiltrates whatever it can see to whoever authored it.
  allowedSchemesByTag: { img: ['data'], a: ['http', 'https', 'mailto'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  // <style> content is kept (documents need real CSS) but scrubbed.
  allowedStyles: {},
  // Acknowledges `style` in allowedTags. Keeping it is deliberate: a document
  // is a print layout, and stripping <style> would leave templates unable to
  // set page geometry at all. The risk the library warns about — CSS reaching
  // the network or executing — is handled by cleanCss() below, and again by the
  // renderer aborting every non-`data:` request. Without this flag the library
  // logs a warning on EVERY template save, and a console this repo has worked
  // hard to keep silent stops being a signal.
  allowVulnerableTags: true,
  nonTextTags: ['script', 'textarea', 'option', 'noscript'],
  transformTags: {
    style: (tagName, attribs) => ({ tagName, attribs }),
  },
};

export interface SanitizeResult {
  html: string;
  /** What was removed, so the UI can say so rather than silently changing the design. */
  removed: string[];
}

/**
 * Sanitize a Handlebars template body.
 *
 * Handlebars expressions are lifted out and put back around the HTML pass. A
 * sanitizer run over raw `{{#if x}}` mangles the braces into entities and
 * breaks the template in a way that only shows up at render time.
 */
export function sanitizeTemplateHtml(source: string): SanitizeResult {
  const removed: string[] = [];

  // Triple-stash disables escaping. Refused rather than stripped, because
  // silently turning {{{x}}} into {{x}} changes what the document says.
  if (/\{\{\{[^}]*\}\}\}/.test(source)) {
    throw new TemplateSanitizeError(
      'Raw output ({{{ }}}) is not permitted in a template. The engine escapes ' +
        'values so that a name containing < or & cannot break the layout. Use {{ }}.',
    );
  }

  const expressions: string[] = [];
  const lifted = source.replace(/\{\{[^}]*\}\}/g, (m) => {
    expressions.push(m);
    return `${TOKEN_PREFIX}${expressions.length - 1}`;
  });

  for (const tag of FORBIDDEN_TAGS) {
    if (new RegExp(`<\\s*${tag}\\b`, 'i').test(lifted)) removed.push(`<${tag}>`);
  }
  if (/\son[a-z]+\s*=/i.test(lifted)) removed.push('event handler attributes');

  let cleaned = sanitizeHtml(lifted, OPTIONS);

  // sanitize-html keeps <style> text verbatim; scrub it separately.
  cleaned = cleaned.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open: string, css: string, close: string) => open + cleanCss(css) + close,
  );
  // Inline style attributes get the same treatment.
  cleaned = cleaned.replace(
    /style="([^"]*)"/gi,
    (_m, css: string) => `style="${cleanCss(css)}"`,
  );

  // Neutralise every brace that is NOT part of a lifted expression.
  //
  // This has to happen HERE, after sanitize-html and before the placeholders
  // go back, and the ordering is the whole point. Doing it in the compiler
  // does not work: sanitize-html decodes `&#123;` back to a literal `{` on the
  // way through, so the escape is undone by the very pass it has to survive.
  //
  // Everything well-formed is currently a `data:x-hb,N` placeholder, so any
  // brace still present is a stray one — a half-typed `{{positio`, which is
  // what took every render of a real template down with a parse error.
  // `<style>` is excluded because CSS is nothing but braces.
  const neutralised = cleaned
    .split(/(<style[^>]*>[\s\S]*?<\/style>)/i)
    .map((part) =>
      /^<style/i.test(part)
        ? part
        : part.replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;')),
    )
    .join('');

  const restored = neutralised.replace(
    TOKEN_RE,
    (_m, i: string) => expressions[Number(i)] ?? '',
  );

  return { html: restored, removed: [...new Set(removed)] };
}
