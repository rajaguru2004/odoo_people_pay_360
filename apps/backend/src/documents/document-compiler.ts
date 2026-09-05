import {
  Block,
  Condition,
  DOC_SCHEMA_VERSION,
  DocumentTemplateDoc,
  TableColumn,
} from './document-doc.model';

/**
 * Block document → Handlebars HTML.
 *
 * Pure, synchronous and total: no I/O, no settings read, no database. That
 * makes it exhaustively unit-testable, which matters because this is the one
 * place where a non-technical user's clicking turns into markup that a browser
 * engine will execute.
 *
 * Two rules shape everything below.
 *
 * 1. TABLE-BASED LAYOUT, not flexbox or grid. Chromium's print layout paginates
 *    tables reliably and flex containers badly — a flex row that overflows a
 *    page is simply clipped. The shipped letter templates already use tables
 *    for exactly this reason.
 * 2. EVERY interpolated value is escaped by Handlebars at render. The compiler
 *    emits `{{x}}`, never `{{{x}}}`, and the sanitizer rejects triple-stash
 *    outright, so a name containing `<` cannot break the document.
 */

export class DocumentCompileError extends Error {}

const ALIGN_CSS: Record<string, string> = {
  start: 'left',
  center: 'center',
  end: 'right',
  justify: 'justify',
};

/** Escape a literal that goes into markup as text rather than as a token. */
function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Neutralise braces that are NOT part of a well-formed token.
 *
 * The compiler has to be TOTAL: whatever an admin types, the output must
 * compile. This exists because it did not. Autosave persisted a half-typed
 * field — `{{positio` — the compiler passed the stray braces through as raw
 * Handlebars, and every render of that template from then on died with a parse
 * error before anything could say why. A draft that cannot be rendered is a
 * draft that cannot be repaired through the UI that produced it.
 *
 * `&#123;` renders as a literal `{` and is invisible to the Handlebars parser,
 * so half-typed input shows up on the page as the text the user actually typed
 * rather than taking the document down.
 */
function neutraliseBraces(value: string): string {
  return String(value ?? '').replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'));
}

/**
 * A token path, validated.
 *
 * Refused rather than escaped, because a path is not user-visible text — it is
 * an instruction to the template engine, and anything that is not a plain
 * dotted identifier is either a mistake or an attempt to reach a helper.
 */
function tokenPath(path: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) {
    throw new DocumentCompileError(
      `"${path}" is not a valid field name. Use letters, numbers and dots, e.g. employeeName or custom.jobGrade.`,
    );
  }
  return path;
}

/**
 * Interpolate `{{token}}` markers inside admin-entered text.
 *
 * The builder stores rich text with tokens already written as `{{path}}`. The
 * surrounding literal text is escaped; the tokens are passed through so
 * Handlebars resolves (and escapes) them at render.
 */
function interpolate(text: string): string {
  const parts = String(text ?? '').split(/(\{\{[^}]*\}\})/g);
  return parts
    .map((part) => {
      const m = /^\{\{\s*([^}\s]+)\s*\}\}$/.exec(part);
      if (!m) {
        // Not a well-formed token — including a half-typed one like
        // `{{positio`. Its braces are neutralised so it prints as text
        // instead of reaching the Handlebars parser.
        return neutraliseBraces(part);
      }
      try {
        return `{{${tokenPath(m[1])}}}`;
      } catch {
        // An unresolvable token renders as its own literal text rather than
        // failing the compile — the validator surfaces it as an error in the
        // UI, and a template that will not compile at all cannot be edited
        // back into shape.
        return neutraliseBraces(part);
      }
    })
    .join('');
}

/**
 * Rich-text HTML from the editor.
 *
 * Passed through structurally (the sanitizer is the gate, and it runs on the
 * compiled output) but with tokens normalised, so a token typed by hand into
 * the rich-text block behaves the same as one inserted from the picker.
 */
function richText(html: string): string {
  // Well-formed tokens are normalised and kept; every other brace in the
  // fragment is neutralised afterwards, so a stray `{{` typed into rich text
  // cannot reach the parser either.
  const KEEP = '\u0000HB\u0000';
  const kept: string[] = [];
  const withTokens = String(html ?? '').replace(
    /\{\{\s*([^}\s]+)\s*\}\}/g,
    (whole, path: string) => {
      try {
        kept.push(`{{${tokenPath(path)}}}`);
      } catch {
        kept.push(neutraliseBraces(whole));
      }
      return `${KEEP}${kept.length - 1}${KEEP}`;
    },
  );
  return neutraliseBraces(withTokens).replace(
    new RegExp(`\u0000HB\u0000(\\d+)\u0000HB\u0000`, 'g'),
    (_m, i: string) => kept[Number(i)] ?? '',
  );
}

/** Condition tree → a Handlebars block expression. */
function conditionOpen(cond: Condition): string {
  switch (cond.op) {
    case 'always':
      return '';
    case 'empty':
      return `{{#unlessEmpty ${tokenPath(cond.path)}}}{{else}}`;
    case 'notEmpty':
      return `{{#unlessEmpty ${tokenPath(cond.path)}}}`;
    case 'truthy':
      return `{{#if ${tokenPath(cond.path)}}}`;
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const helper = {
        eq: 'ifEq', neq: 'ifNeq', gt: 'ifGt', gte: 'ifGte', lt: 'ifLt', lte: 'ifLte',
      }[cond.op];
      const literal =
        typeof cond.value === 'number' ? String(cond.value) : `"${esc(String(cond.value ?? ''))}"`;
      return `{{#${helper} ${tokenPath(cond.path)} ${literal}}}`;
    }
    case 'and':
    case 'or':
      // Handlebars has no n-ary boolean, so AND is nesting. OR is deliberately
      // NOT supported by nesting (it would need a helper that short-circuits
      // over rendered output); the builder offers AND only, and says so.
      if (cond.op === 'or') {
        throw new DocumentCompileError(
          'Combining conditions with OR is not supported yet. Use a separate block for each case.',
        );
      }
      return cond.all.map(conditionOpen).join('');
    default:
      return '';
  }
}

function conditionClose(cond: Condition): string {
  switch (cond.op) {
    case 'always':
      return '';
    case 'empty':
    case 'notEmpty':
      return '{{/unlessEmpty}}';
    case 'truthy':
      return '{{/if}}';
    case 'eq': return '{{/ifEq}}';
    case 'neq': return '{{/ifNeq}}';
    case 'gt': return '{{/ifGt}}';
    case 'gte': return '{{/ifGte}}';
    case 'lt': return '{{/ifLt}}';
    case 'lte': return '{{/ifLte}}';
    case 'and':
      return [...cond.all].reverse().map(conditionClose).join('');
    default:
      return '';
  }
}

/** Column value, wrapped in its format helper. */
function columnValue(col: TableColumn): string {
  const path = tokenPath(col.key);
  switch (col.format) {
    case 'money':
      return `{{money ${path} ../currency}}`;
    case 'num':
      return `{{num ${path} 2}}`;
    case 'date':
      return `{{date ${path}}}`;
    default:
      return `{{${path}}}`;
  }
}

function compileBlock(block: Block): string {
  const align = (a?: string) => ALIGN_CSS[a ?? 'start'] ?? 'left';
  const spacing = block.spacingAfterMm ? `margin-bottom:${block.spacingAfterMm}mm;` : '';
  let html = '';

  switch (block.type) {
    case 'text': {
      const p = block.props;
      const size = p.sizePt ? `font-size:${p.sizePt}pt;` : '';
      html = `<div class="b-text" style="text-align:${align(p.align)};${size}${spacing}">${richText(p.html)}</div>`;
      break;
    }
    case 'heading': {
      const p = block.props;
      const tag = `h${p.level}`;
      const underline = p.underline ? 'text-decoration:underline;' : '';
      html = `<${tag} class="b-heading" style="text-align:${align(p.align)};${underline}${spacing}">${richText(p.html)}</${tag}>`;
      break;
    }
    case 'logo': {
      const p = block.props;
      // The src is a token, never a URL: the renderer inlines the logo as a
      // data: URI because the page has no network. This is the block-level
      // counterpart of the defect that left every issued letter logo-less.
      html =
        `<div class="b-logo" style="text-align:${align(p.align)};${spacing}">` +
        `{{#if companyLogoUrl}}<img src="{{companyLogoUrl}}" alt="{{companyName}}" ` +
        `style="max-height:${p.maxHeightMm}mm" />{{/if}}</div>`;
      break;
    }
    case 'spacer':
      html = `<div class="b-spacer" style="height:${block.props.heightMm}mm"></div>`;
      break;
    case 'divider': {
      const p = block.props;
      const color = p.color && !String(p.color).startsWith('@') ? esc(String(p.color)) : 'var(--doc-rule)';
      html = `<hr class="b-divider" style="border:none;border-top:${p.thicknessPt ?? 1}pt solid ${color};${spacing}" />`;
      break;
    }
    case 'keyValue': {
      const p = block.props;
      const labelWidth = p.labelWidthPct ?? 40;
      const rows = p.rows
        .map((row) => {
          const cell = `<tr><td class="kv-label" style="width:${labelWidth}%">${interpolate(row.label)}</td>` +
            `<td class="kv-value">${interpolate(row.value)}</td></tr>`;
          if (!p.hideEmptyRows) return cell;
          // Hide the whole ROW when its value is blank, rather than printing a
          // label with nothing beside it — an empty "Passport number:" on a
          // salary certificate reads as missing data rather than as not
          // applicable.
          const m = /^\{\{\s*([^}\s]+)\s*\}\}$/.exec(row.value.trim());
          return m ? `{{#unlessEmpty ${tokenPath(m[1])}}}${cell}{{/unlessEmpty}}` : cell;
        })
        .join('');
      html = `<table class="b-kv" style="${spacing}"><tbody>${rows}</tbody></table>`;
      break;
    }
    case 'dataTable': {
      const p = block.props;
      if (!p.columns?.length) {
        throw new DocumentCompileError(
          'A table block needs at least one column before the template can be published.',
        );
      }
      const bind = tokenPath(p.bind);
      const head =
        p.showHeader === false
          ? ''
          : `<thead><tr>${p.columns
              .map(
                (c) =>
                  `<th style="text-align:${align(c.align)}${c.widthPct ? `;width:${c.widthPct}%` : ''}">${esc(c.header)}</th>`,
              )
              .join('')}</tr></thead>`;
      const body = p.columns
        .map((c) => `<td style="text-align:${align(c.align)}">${columnValue(c)}</td>`)
        .join('');
      const totals = p.totalsRow
        ? `<tfoot><tr><td colspan="${p.columns.length - 1}">${esc(p.totalsRow.label)}</td>` +
          `<td style="text-align:right">{{money (sum ${bind} "${esc(p.totalsRow.column)}") currency}}</td></tr></tfoot>`
        : '';
      const empty = p.emptyText
        ? `{{else}}<p class="doc-empty">${esc(p.emptyText)}</p>`
        : '{{else}}';
      // thead inside a real <table> is what repeats across a page break in
      // Chromium's print layout. Nothing else does.
      html =
        `{{#if ${bind}}}<table class="b-table${p.zebra ? ' zebra' : ''}" style="${spacing}">${head}` +
        `<tbody>{{#each ${bind}}}<tr>${body}</tr>{{/each}}</tbody>${totals}</table>${empty}{{/if}}`;
      break;
    }
    case 'signature': {
      const p = block.props;
      const slot = p.slotKey ? tokenPath(`signatory.${p.slotKey}`) : null;
      const name = slot ? `{{${slot}.name}}` : interpolate(p.name ?? '');
      const title = slot ? `{{${slot}.title}}` : interpolate(p.designation ?? '');
      const image =
        p.showImage && slot
          ? `{{#if ${slot}.image}}<img class="sig-img" src="{{${slot}.image}}" alt="" />{{/if}}`
          : '';
      const stamp = p.showStamp ? `{{#if stampImage}}<img class="sig-stamp" src="{{stampImage}}" alt="" />{{/if}}` : '';
      // `break-inside: avoid` so a signature block never lands split across
      // two pages, which on a legal document looks like a forgery.
      html =
        `<div class="b-signature" style="text-align:${align(p.align)};break-inside:avoid;${spacing}">` +
        `${image}${stamp}<div class="sig-rule"></div>` +
        `<div class="sig-name">${name}</div><div class="sig-title">${title}</div></div>`;
      break;
    }
    case 'pageBreak':
      html = '<div style="break-after:page"></div>';
      break;
    case 'rawHtml':
      // Trusted no more than any other block: the sanitizer runs over the whole
      // compiled document afterwards. Authoring one is gated behind developer
      // mode in the UI; rendering one is not, so an operator-authored template
      // still works for everybody.
      html = richText(block.props.html);
      break;
    default: {
      const unknown = block as { type?: string };
      throw new DocumentCompileError(
        `Unknown block type "${unknown.type}". This template was made by a newer version of the builder.`,
      );
    }
  }

  if (block.visibleWhen && block.visibleWhen.op !== 'always') {
    return conditionOpen(block.visibleWhen) + html + conditionClose(block.visibleWhen);
  }
  return html;
}

export interface CompiledTemplate {
  bodyHtml: string;
  styleCss: string;
  footerHtml: string | null;
}

/**
 * Compile a block document.
 *
 * Emits only the BODY and its CSS — not `<html>`, not `@page`, not the
 * letterhead. Those belong to the envelope the renderer composes, which the
 * admin does not own and cannot delete. That split is what stops an admin
 * removing the Arabic font stack and turning every Arabic document into tofu.
 */
export function compileDocument(doc: DocumentTemplateDoc): CompiledTemplate {
  if (!doc || typeof doc !== 'object') {
    throw new DocumentCompileError('The template document is empty.');
  }
  if (doc.schemaVersion > DOC_SCHEMA_VERSION) {
    throw new DocumentCompileError(
      `This template was saved by a newer version of the builder (v${doc.schemaVersion}). Update before editing it.`,
    );
  }
  if (!Array.isArray(doc.body)) {
    throw new DocumentCompileError('The template document has no blocks.');
  }

  const bodyHtml = doc.body.map(compileBlock).join('\n');

  const theme = doc.theme ?? { followBrand: true };
  const fontSize = theme.baseFontSizePt ?? 11;
  const lineHeight = theme.lineHeight ?? 1.6;
  // A brand reference is emitted as a CSS variable the envelope defines, so a
  // rebrand changes the document without touching the stored template.
  const primary =
    theme.primary && !String(theme.primary).startsWith('@')
      ? esc(String(theme.primary))
      : 'var(--brand-primary)';

  const styleCss = `
.doc-body { font-size: ${fontSize}pt; line-height: ${lineHeight}; }
.b-heading { color: ${primary}; margin: 0 0 4mm; }
.b-kv { width: 100%; border-collapse: collapse; }
.b-kv td { padding: 1.5mm 0; vertical-align: top; }
.b-kv .kv-label { color: var(--doc-muted); }
.b-table { width: 100%; border-collapse: collapse; }
.b-table th { border-bottom: 1pt solid ${primary}; padding: 2mm 1.5mm; font-weight: 600; }
.b-table td { border-bottom: 0.5pt solid var(--doc-rule); padding: 2mm 1.5mm; }
.b-table tfoot td { border-top: 1pt solid ${primary}; border-bottom: none; font-weight: 600; }
.b-table.zebra tbody tr:nth-child(even) td { background: var(--doc-zebra); }
.b-signature { margin-top: 12mm; display: inline-block; min-width: 60mm; }
.b-signature .sig-rule { border-top: 0.75pt solid var(--doc-rule); margin-top: 2mm; padding-top: 1.5mm; }
.b-signature .sig-img, .b-signature .sig-stamp { max-height: 18mm; display: block; }
.b-signature .sig-name { font-weight: 600; }
.b-signature .sig-title { color: var(--doc-muted); font-size: 0.9em; }
.doc-empty { color: var(--doc-muted); font-style: italic; }
`.trim();

  const footerHtml = doc.footer?.html ? interpolate(doc.footer.html) : null;

  return { bodyHtml, styleCss, footerHtml };
}
