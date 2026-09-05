import {
  Block,
  DocumentTemplateDoc,
  GrapesTemplateDoc,
} from './document-doc.model';
import { getDocumentType } from './document-types';

/**
 * v1 block document → GrapesJS-editable HTML with CHIPS.
 *
 * The one-way conversion seed. It reuses the block model but emits
 * `span[data-var]` chips instead of `{{tokens}}`, `data-each` tables instead
 * of `{{#each}}`, and `data-page-break` markers — the visual editor's whole
 * vocabulary.
 *
 * NEVER seed the editor from the stored compiled bodyHtml: that string carries
 * `{{#if}}`/`{{#each}}` block helpers interleaved with markup, which have no
 * chip representation and would be mangled on the first save. This function is
 * total over the docJson instead, and returns `dropped[]` naming what has no
 * visual equivalent — shown to the admin BEFORE the conversion happens.
 */

export interface GrapesSeed {
  html: string;
  css: string;
  dropped: string[];
}

const esc = (v: string): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function labelFor(typeKey: string, path: string): string {
  const type = getDocumentType(typeKey);
  const hit = type?.variables.find((v) => v.name === path);
  if (hit) return hit.label;
  // Nested paths (signatory.hr.name) and custom.* fall back to the tail.
  return path.split('.').pop() ?? path;
}

function chip(typeKey: string, path: string, format?: string): string {
  const fmt = format ? ` data-format="${esc(format)}"` : '';
  return (
    `<span data-var="${esc(path)}"${fmt} class="ess-var-chip" contenteditable="false">` +
    `@ ${esc(labelFor(typeKey, path))}</span>`
  );
}

/** Replace {{tokens}} inside admin text with chips; leave plain text alone. */
function chipify(typeKey: string, text: string): string {
  return String(text ?? '').replace(
    /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g,
    (_m, path: string) => chip(typeKey, path),
  );
}

function alignCss(a?: string): string {
  const map: Record<string, string> = { start: 'left', center: 'center', end: 'right', justify: 'justify' };
  return map[a ?? 'start'] ?? 'left';
}

function seedBlock(typeKey: string, block: Block, dropped: string[]): string {
  const spacing = block.spacingAfterMm ? `margin-bottom:${block.spacingAfterMm}mm;` : '';
  if (block.visibleWhen && block.visibleWhen.op !== 'always') {
    // Conditions have no visual-editor equivalent yet. Named, not silent.
    dropped.push('a "show only when…" rule');
  }

  switch (block.type) {
    case 'heading': {
      const p = block.props;
      const tag = `h${p.level}`;
      const underline = p.underline ? 'text-decoration:underline;' : '';
      return `<${tag} style="text-align:${alignCss(p.align)};${underline}${spacing}">${chipify(typeKey, p.html)}</${tag}>`;
    }
    case 'text': {
      const p = block.props;
      const size = p.sizePt ? `font-size:${p.sizePt}pt;` : '';
      return `<div style="text-align:${alignCss(p.align)};${size}${spacing}">${chipify(typeKey, p.html)}</div>`;
    }
    case 'logo':
      return `<div style="text-align:${alignCss(block.props.align)};${spacing}"><img data-brand="logo" style="max-height:${block.props.maxHeightMm}mm" alt="Company logo"></div>`;
    case 'spacer':
      return `<div style="height:${block.props.heightMm}mm"></div>`;
    case 'divider':
      return `<hr style="border:none;border-top:${block.props.thicknessPt ?? 1}pt solid #d7dce3;${spacing}">`;
    case 'keyValue': {
      const p = block.props;
      const width = p.labelWidthPct ?? 40;
      if (p.hideEmptyRows) {
        // The hide-when-blank behaviour compiles to {{#unlessEmpty}}, which
        // has no chip form. The rows convert; the hiding does not.
        dropped.push('hide-empty-row behaviour on a detail list');
      }
      const rows = p.rows
        .map(
          (row) =>
            `<tr><td style="width:${width}%;color:#6b7280;padding:1.5mm 0;vertical-align:top">${chipify(typeKey, row.label)}</td>` +
            `<td style="padding:1.5mm 0">${chipify(typeKey, row.value)}</td></tr>`,
        )
        .join('');
      return `<table style="width:100%;border-collapse:collapse;${spacing}"><tbody>${rows}</tbody></table>`;
    }
    case 'dataTable': {
      const p = block.props;
      if (p.totalsRow) dropped.push(`the "${p.totalsRow.label}" totals row`);
      const headers = p.columns
        .map(
          (c) =>
            `<th style="text-align:${alignCss(c.align)};border-bottom:1pt solid #1f3a5f;padding:2mm 1.5mm">${esc(c.header)}</th>`,
        )
        .join('');
      const cells = p.columns
        .map(
          (c) =>
            `<td style="text-align:${alignCss(c.align)};padding:2mm 1.5mm;border-bottom:0.5pt solid #d7dce3">` +
            chip(typeKey, c.key, c.format === 'money' ? 'money' : c.format === 'date' ? 'date' : undefined) +
            '</td>',
        )
        .join('');
      return (
        `<table data-each="${esc(p.bind)}" style="width:100%;border-collapse:collapse;${spacing}">` +
        `<thead><tr>${headers}</tr></thead><tbody><tr>${cells}</tr></tbody></table>`
      );
    }
    case 'signature': {
      const p = block.props;
      const slot = p.slotKey ?? 'hr';
      return (
        `<div style="margin-top:12mm;display:inline-block;min-width:60mm;text-align:${alignCss(p.align)};${spacing}">` +
        `<div style="border-top:0.75pt solid #d7dce3;padding-top:1.5mm">${chip(typeKey, `signatory.${slot}.name`)}</div>` +
        `<div style="color:#6b7280;font-size:9pt">${chip(typeKey, `signatory.${slot}.title`)}</div></div>`
      );
    }
    case 'pageBreak':
      return '<div data-page-break="true" style="border-top:1px dashed #dc2626;margin:2mm 0"></div>';
    case 'rawHtml':
      return chipify(typeKey, block.props.html);
    default: {
      dropped.push(`an unsupported "${(block as { type?: string }).type}" block`);
      return '';
    }
  }
}

export function compileDocumentForEditor(doc: DocumentTemplateDoc): GrapesSeed {
  const dropped: string[] = [];
  const html = (doc.body ?? [])
    .map((b) => seedBlock(doc.documentType, b, dropped))
    .filter(Boolean)
    .join('\n');
  return { html, css: '', dropped: [...new Set(dropped)] };
}

/** A ready v2 doc for a converted draft — what the page saves after confirm. */
export function grapesDocFromSeed(v1: DocumentTemplateDoc, seed: GrapesSeed): GrapesTemplateDoc {
  return {
    schemaVersion: 2,
    kind: 'grapes',
    documentType: v1.documentType,
    locale: v1.locale,
    dir: v1.dir,
    page: v1.page,
    theme: v1.theme,
    // project intentionally empty: the editor builds it from html on first
    // load (setComponents) and the next autosave persists the real project.
    grapes: { project: {}, html: seed.html, css: seed.css },
    footer: v1.footer,
  };
}
