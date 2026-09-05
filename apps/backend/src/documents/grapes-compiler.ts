import { DomHandler, Parser } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import { Text as DomText } from 'domhandler';
import render from 'dom-serializer';
import * as DomUtils from 'domutils';
import { DocumentCompileError, CompiledTemplate } from './document-compiler';
import { GrapesTemplateDoc } from './document-doc.model';

/**
 * GrapesJS export → Handlebars HTML.
 *
 * Pure, synchronous and TOTAL — the same contract `document-compiler.ts`
 * holds, for the same reason: this is where freeform editor output becomes
 * markup a browser engine executes, and a half-typed anything must degrade to
 * text, never to a parse error that bricks the template (the D-18 lesson).
 *
 * Parsed with htmlparser2 rather than regex-walked: freeform editor HTML is
 * exactly the input a regex walk mishandles, and "total against malformed
 * input" is the bar this module family holds.
 *
 * THE ORDER OF THE STEPS IS THE SECURITY ARGUMENT:
 *
 *   1. Every brace in every text node and attribute is neutralised FIRST, so
 *      by the time tokens are emitted the document contains zero braces.
 *      Chips (`span[data-var]`) are therefore the ONLY path to a live token —
 *      an admin who types `{{employeeName}}` gets that literal text printed.
 *   2. Only then are chips, data-each regions, brand images and page breaks
 *      rewritten into Handlebars.
 *
 * The output still flows through the UNCHANGED `sanitizeTemplateHtml`, whose
 * scheme allowlists, triple-stash rejection and CSS scrub all apply on top —
 * this transform is additive, not substitutive.
 */

/** Style properties that break Chromium print pagination silently. */
const BLOCKED_STYLE_PROPS = new Set([
  'position',
  'float',
  'transform',
  'filter',
  'z-index',
  // Inset offsets only mean anything WITH positioning, which is blocked above;
  // letting them through leaves misleading dead declarations in stored HTML.
  'top',
  'right',
  'bottom',
  'left',
  'inset',
]);

/** display values that break print pagination; other display values pass. */
const BLOCKED_DISPLAY = /\b(flex|grid|fixed|inline-flex|inline-grid)\b/i;

/** Editor bookkeeping that must never reach stored HTML. */
const STRIP_ATTRS = ['id', 'draggable', 'contenteditable', 'data-gjs-type', 'spellcheck'];

const neutralise = (v: string): string =>
  v.replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'));

/** Serializer note: emitted entities must not be re-escaped. */
const serialize = (nodes: ChildNode[]): string =>
  render(nodes, { encodeEntities: false });

function parse(html: string): ChildNode[] {
  let dom: ChildNode[] = [];
  const handler = new DomHandler((err, nodes) => {
    if (err) throw new DocumentCompileError(`The document could not be read: ${err.message}`);
    dom = nodes;
  });
  const parser = new Parser(handler, { lowerCaseAttributeNames: true });
  parser.write(html ?? '');
  parser.end();
  return dom;
}

/**
 * Scrub one style attribute value against the blocked-property list.
 *
 * The client's curated StyleManager never offers these, so this is the SERVER
 * twin that makes the curation security rather than UX. `position: static` is
 * allowed through (it is the default and harmless).
 */
export function scrubStyleValue(style: string): string {
  return style
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => {
      if (!decl) return false;
      const [prop, ...rest] = decl.split(':');
      const name = prop.trim().toLowerCase();
      const value = rest.join(':').trim().toLowerCase();
      if (BLOCKED_STYLE_PROPS.has(name)) return name === 'position' && value === 'static';
      if (name === 'display' && BLOCKED_DISPLAY.test(value)) return false;
      return true;
    })
    .join('; ');
}

/**
 * Scrub the exported stylesheet: blocked properties out, `#id` rules dropped.
 *
 * `#id` rules are dropped because the sanitizer strips `id` attributes — an
 * id-keyed rule would silently orphan and the document would unstyle with
 * nothing in any log to say why. The editor is configured with
 * `avoidInlineStyle: false` precisely so styling lands inline instead, but a
 * pasted or legacy project can still carry them.
 */
export function scrubCss(css: string): string {
  const withoutIdRules = (css ?? '').replace(/(^|})\s*#[^{}]+\{[^{}]*\}/g, '$1');
  return withoutIdRules.replace(/\{([^{}]*)\}/g, (_m, body: string) => {
    const cleaned = scrubStyleValue(body);
    return `{${cleaned}}`;
  });
}

const isElement = (n: ChildNode): n is Element => n.type === 'tag';

/** Nearest ancestor with data-each — decides relative vs absolute money paths. */
function inEachScope(el: Element): boolean {
  let cur: Element | null = el.parent && isElement(el.parent as ChildNode) ? (el.parent as Element) : null;
  while (cur) {
    if (cur.attribs?.['data-each']) return true;
    cur = cur.parent && isElement(cur.parent as ChildNode) ? (cur.parent as Element) : null;
  }
  return false;
}

/** A chip's Handlebars expression, mirroring the block compiler's helper grammar. */
export function tokenFor(path: string, format: string | undefined, eachScope: boolean): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) {
    // Not a plain dotted identifier — neutralised text, never an expression.
    return neutralise(`{{${path}}}`);
  }
  // Prototype segments are already dead at render (allowProtoPropertiesByDefault
  // is off), but refusing them HERE means the poisoned path never even reaches
  // the stored template — defence in depth over trusting one runtime option.
  if (/(^|\.)(constructor|__proto__|prototype)(\.|$)/.test(path)) {
    return neutralise(`{{${path}}}`);
  }
  switch (format) {
    case 'money':
      return eachScope ? `{{money ${path} ../currency}}` : `{{money ${path} currency}}`;
    case 'num':
      return `{{num ${path} 2}}`;
    case 'date':
      return `{{date ${path}}}`;
    default:
      return `{{${path}}}`;
  }
}

interface WalkState {
  removed: string[];
  eachSeen: boolean;
}

function walk(nodes: ChildNode[], state: WalkState, insideEach: boolean): void {
  for (const node of [...nodes]) {
    if (node.type === 'text') {
      // Step 1 for text: braces become entities before any token exists.
      (node as DomText).data = neutralise((node as DomText).data);
      continue;
    }
    if (!isElement(node)) continue;
    const el = node;
    const tag = el.tagName.toLowerCase();

    // ── Chips: the ONLY sanctioned token path ────────────────────────────
    if (el.attribs['data-var'] !== undefined) {
      const token = tokenFor(
        el.attribs['data-var'],
        el.attribs['data-format'],
        insideEach || inEachScope(el),
      );
      // Children (the visible "@ Label") are presentation only — discarded, so
      // renaming a field's label later never changes what renders.
      DomUtils.replaceElement(el, new DomText(token));
      continue;
    }

    // ── Brand logo: the only image path ──────────────────────────────────
    if (tag === 'img') {
      const isBrandLogo = el.attribs['data-brand'] === 'logo';
      if (!isBrandLogo && !(el.attribs.src ?? '').startsWith('data:')) {
        // The sanitizer's scheme allowlist would strip the src anyway; removing
        // the element here lets `removed[]` SAY so instead of shipping a broken
        // image silently.
        state.removed.push(`image (${(el.attribs.src ?? 'no source').slice(0, 60)})`);
        DomUtils.removeElement(el);
        continue;
      }
      delete el.attribs['data-brand'];
      // Clean FIRST, set the token LAST — the first version of this branch set
      // the src and then let the generic attribute pass neutralise its braces,
      // shipping a logo whose src was the literal text {{companyLogoUrl}}.
      // Caught by the spec's end-to-end sanitizer-parity case.
      cleanElementAttrs(el);
      if (isBrandLogo) el.attribs.src = '{{companyLogoUrl}}';
      continue;
    }

    // ── Page break: the identical markup the v1 compiler emits ───────────
    if (el.attribs['data-page-break'] !== undefined) {
      delete el.attribs['data-page-break'];
      el.attribs.style = 'break-after:page';
      el.children = [];
    }

    // ── Repetition ───────────────────────────────────────────────────────
    const each = el.attribs['data-each'];
    if (each) {
      if (insideEach) {
        throw new DocumentCompileError(
          'A repeating table inside another repeating table is not supported.',
        );
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(each)) {
        throw new DocumentCompileError(`"${each}" is not a list this document can repeat over.`);
      }
      delete el.attribs['data-each'];
      state.eachSeen = true;

      // For a table, wrap the BODY rows; the header row stays outside the
      // loop, which is what makes it a <thead> that repeats across printed
      // pages rather than a row repeated per record.
      const target =
        tag === 'table'
          ? (el.children.filter(isElement).find((c) => c.tagName.toLowerCase() === 'tbody') ?? el)
          : el;

      walk(target.children, state, true);
      cleanElementAttrs(target);
      const inner = serialize(target.children);
      target.children = [];
      DomUtils.appendChild(target, new DomText(`{{#each ${each}}}${inner}{{/each}}`));

      if (target !== el) {
        // The rest of the table (thead/tfoot/caption) still needs the pass.
        for (const child of el.children) {
          if (isElement(child) && child !== target) walk([child], state, false);
        }
        cleanElementAttrs(el);
      }
      continue;
    }

    // ── Ordinary element: neutralise attrs, scrub style, strip artifacts ──
    cleanElementAttrs(el);
    walk(el.children, state, insideEach);
  }
}

function cleanElementAttrs(el: Element): void {
  for (const name of Object.keys(el.attribs)) {
    if (STRIP_ATTRS.includes(name)) {
      delete el.attribs[name];
      continue;
    }
    // Step 1 for attributes: no attribute value may carry a live brace.
    el.attribs[name] = neutralise(el.attribs[name]);
  }
  if (el.attribs.style !== undefined) {
    const scrubbed = scrubStyleValue(el.attribs.style);
    if (scrubbed) el.attribs.style = scrubbed;
    else delete el.attribs.style;
  }
}

/**
 * Compile a GrapesJS document.
 *
 * Emits only the BODY and its CSS — the envelope (`@page`, base CSS, Arabic
 * stack, letterhead compositing, watermark) stays with the renderer, exactly
 * as for v1, so an admin cannot delete the floor.
 */
export function compileGrapesDocument(doc: GrapesTemplateDoc): CompiledTemplate & {
  removed: string[];
} {
  if (!doc?.grapes || typeof doc.grapes.html !== 'string') {
    throw new DocumentCompileError('The visual document is empty.');
  }

  const state: WalkState = { removed: [], eachSeen: false };
  const dom = parse(doc.grapes.html);
  walk(dom, state, false);
  const bodyHtml = serialize(dom);

  const styleCss = scrubCss(doc.grapes.css ?? '');

  // Footer through the same discipline: chips only, braces neutralised.
  let footerHtml: string | null = null;
  if (doc.footer?.html) {
    const footerDom = parse(doc.footer.html);
    walk(footerDom, state, false);
    footerHtml = serialize(footerDom);
  }

  return { bodyHtml, styleCss, footerHtml, removed: state.removed };
}
