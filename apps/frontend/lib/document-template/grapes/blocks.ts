import { TokenManifest } from '@/types/document-template';
import { buildChipHtml, formatForToken } from './chips';

/**
 * Block palette for the visual editor, built from the document type's
 * manifest — PURE data, node-testable.
 *
 * Every block is print-safe by construction: multi-column layout is a
 * `<table>` (Chromium paginates tables reliably and flex/grid badly — the
 * same rule the block compiler's header states), and the only image is the
 * brand logo.
 */

export interface EssBlockDef {
  id: string;
  label: string;
  category: string;
  content: string;
}

const LAYOUT = 'Layout';
const CONTENT = 'Content';
const DATA = 'Data';

export function buildBlockDefs(manifest: TokenManifest | null): EssBlockDef[] {
  const blocks: EssBlockDef[] = [
    {
      id: 'ess-heading',
      label: 'Heading',
      category: CONTENT,
      content: '<h1 style="text-align:center; font-size:16pt">Heading</h1>',
    },
    {
      id: 'ess-text',
      label: 'Text',
      category: CONTENT,
      content: '<p>Write here…</p>',
    },
    {
      id: 'ess-two-columns',
      label: 'Two columns',
      category: LAYOUT,
      // A table, NOT flex: flex rows that cross a page boundary are clipped by
      // Chromium's print layout; table rows paginate.
      content:
        '<table style="width:100%; border-collapse:collapse"><tbody><tr>' +
        '<td style="width:50%; vertical-align:top; padding:2mm"><p>Left</p></td>' +
        '<td style="width:50%; vertical-align:top; padding:2mm"><p>Right</p></td>' +
        '</tr></tbody></table>',
    },
    {
      id: 'ess-divider',
      label: 'Divider',
      category: LAYOUT,
      content: '<hr style="border:none; border-top:1pt solid #d7dce3; margin:4mm 0">',
    },
    {
      id: 'ess-spacer',
      label: 'Spacer',
      category: LAYOUT,
      content: '<div style="height:8mm"></div>',
    },
    {
      id: 'ess-page-break',
      label: 'Page break',
      category: LAYOUT,
      content:
        '<div data-page-break="true" style="border-top:1px dashed #dc2626; margin:2mm 0; text-align:center; color:#dc2626; font-size:8pt">page break</div>',
    },
    {
      id: 'ess-logo',
      label: 'Company logo',
      category: CONTENT,
      content: '<img data-brand="logo" style="max-height:16mm" alt="Company logo">',
    },
    {
      id: 'ess-signature',
      label: 'Signature',
      category: CONTENT,
      content:
        '<div style="margin-top:12mm; display:inline-block; min-width:60mm">' +
        '<div style="border-top:0.75pt solid #d7dce3; padding-top:1.5mm">' +
        buildChipHtml({ path: 'signatory.hr.name', label: 'HR signatory name' }) +
        '</div><div style="color:#6b7280; font-size:9pt">' +
        buildChipHtml({ path: 'signatory.hr.title', label: 'HR signatory title' }) +
        '</div></div>',
    },
  ];

  // One ready-made table per manifest collection, template row pre-seeded with
  // chips — so "add the earnings table" is one click, not a construction task.
  for (const coll of manifest?.collections ?? []) {
    const headers = coll.fields
      .map((f) => `<th style="text-align:start; border-bottom:1pt solid #1f3a5f; padding:2mm 1.5mm">${f.label}</th>`)
      .join('');
    const cells = coll.fields
      .map(
        (f) =>
          `<td style="padding:2mm 1.5mm; border-bottom:0.5pt solid #d7dce3">` +
          buildChipHtml({
            path: f.name,
            label: f.label,
            format: formatForToken({ type: f.type }),
          }) +
          '</td>',
      )
      .join('');
    blocks.push({
      id: `ess-table-${coll.path}`,
      label: `${coll.label} table`,
      category: DATA,
      content:
        `<table data-each="${coll.path}" style="width:100%; border-collapse:collapse">` +
        `<thead><tr>${headers}</tr></thead>` +
        `<tbody><tr>${cells}</tr></tbody></table>`,
    });
  }

  return blocks;
}
