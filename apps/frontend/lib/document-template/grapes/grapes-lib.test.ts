import { describe, expect, it } from 'vitest';
import {
  buildChipHtml,
  collectChipPaths,
  collectEachPaths,
  formatForToken,
} from './chips';
import { buildBlockDefs } from './blocks';
import {
  buildCanvasFrameCss,
  buildEditorConfig,
  pageDimensionsMm,
  PDF_SAFE_FONTS,
} from './editor-config';
import { validateGrapesHtml } from './validate-grapes';
import { diffTokenUsage } from './summary';
import { TokenManifest } from '@/types/document-template';

const manifest: TokenManifest = {
  documentType: 'PAYSLIP',
  name: 'Payslip',
  groups: [
    {
      group: 'Employee',
      tokens: [
        { path: 'employeeName', label: 'Employee name', type: 'string', sampleValue: 'Ahmed', alwaysPresent: true, columns: null },
        { path: 'baseSalary', label: 'Basic salary', type: 'money', sampleValue: '1,250.000', alwaysPresent: true, columns: null },
      ],
    },
  ],
  collections: [
    {
      path: 'earnings',
      label: 'Earnings',
      fields: [
        { name: 'label', label: 'Component', type: 'string' },
        { name: 'amount', label: 'Amount', type: 'money' },
      ],
      sampleRows: [],
    },
  ],
  sample: {},
};

describe('chips', () => {
  it('builds the span[data-var] contract, caret-atomic and label-visible', () => {
    const html = buildChipHtml({ path: 'employeeName', label: 'Employee Name' });
    expect(html).toContain('data-var="employeeName"');
    expect(html).toContain('contenteditable="false"');
    expect(html).toContain('@ Employee Name');
    expect(html).not.toContain('data-format');
  });

  it('escapes hostile labels and paths — a chip must never smuggle markup', () => {
    const html = buildChipHtml({ path: 'a"onmouseover="x', label: '<img src=x>' });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/data-var="a"on/);
  });

  it('maps manifest token types to server helper names', () => {
    expect(formatForToken({ type: 'money' })).toBe('money');
    expect(formatForToken({ type: 'number' })).toBe('num');
    expect(formatForToken({ type: 'date' })).toBe('date');
    expect(formatForToken({ type: 'string' })).toBeUndefined();
  });

  it('collects chip paths with their each-scope flag', () => {
    const html =
      '<p><span data-var="employeeName">@ N</span></p>' +
      '<table data-each="earnings"><tbody><tr><td><span data-var="amount">@ A</span></td></tr></tbody></table>';
    const chips = collectChipPaths(html);
    expect(chips).toEqual([
      { path: 'employeeName', inEach: false },
      { path: 'amount', inEach: true },
    ]);
    expect(collectEachPaths(html)).toEqual(['earnings']);
  });
});

describe('editor config as data', () => {
  const cfg = buildEditorConfig({
    containerId: 'c',
    pageSize: 'A4',
    orientation: 'portrait',
    dir: 'ltr',
  }) as Record<string, unknown>;

  it('never lets GrapesJS persist on its own', () => {
    expect(cfg.storageManager).toBe(false);
  });

  it('styles inline — id-keyed CSS dies at the sanitizer', () => {
    // THE load-bearing line: default #ixxx rules orphan when the sanitizer
    // strips id attributes, silently unstyling the whole document.
    expect(cfg.avoidInlineStyle).toBe(false);
  });

  it('silences the GrapesJS logger — the problems fixture fails on ANY console output', () => {
    expect(cfg.log).toEqual([]);
  });

  it('offers no free image path', () => {
    expect(cfg.assetManager).toMatchObject({ upload: false, assets: [], showUrlInput: false });
  });

  it('curates styles WITHOUT the print-pagination breakers', () => {
    const sectors = (cfg.styleManager as { sectors: { properties: unknown[] }[] }).sectors;
    const props = JSON.stringify(sectors);
    for (const banned of ['"position"', '"float"', '"transform"', '"z-index"', '"display"']) {
      expect(props).not.toContain(banned);
    }
  });

  it('offers only PDF-safe fonts — anything else silently falls back on the no-network render page', () => {
    expect(PDF_SAFE_FONTS.join(' ')).toContain('Noto Sans Arabic');
    expect(PDF_SAFE_FONTS.join(' ')).not.toMatch(/Poppins|Montserrat|Inter/);
  });

  it('sizes the sheet from the page setup', () => {
    expect(pageDimensionsMm({ pageSize: 'A4', orientation: 'portrait' })).toEqual({ widthMm: 210, heightMm: 297 });
    expect(pageDimensionsMm({ pageSize: 'A4', orientation: 'landscape' })).toEqual({ widthMm: 297, heightMm: 210 });
  });
});

describe('canvas frame css', () => {
  it('draws the letterhead ghost as canvas background — which never exports', () => {
    const css = buildCanvasFrameCss({
      widthMm: 210,
      heightMm: 297,
      safe: { top: 35, right: 18, bottom: 25, left: 18 },
      letterheadDataUrl: 'blob:xyz',
      dir: 'ltr',
      chipCss: '.ess-var-chip{}',
    });
    expect(css).toContain('url("blob:xyz")');
    expect(css).toContain('padding: 35mm 18mm 25mm 18mm');
    expect(css).toContain('width: 210mm');
  });

  it('mirrors direction for RTL documents', () => {
    const css = buildCanvasFrameCss({
      widthMm: 210, heightMm: 297,
      safe: { top: 20, right: 18, bottom: 20, left: 18 },
      letterheadDataUrl: null, dir: 'rtl', chipCss: '',
    });
    expect(css).toContain('direction: rtl');
    expect(css).not.toContain('url(');
  });
});

describe('block defs from the manifest', () => {
  const defs = buildBlockDefs(manifest);

  it('builds one pre-wired table per collection, chips seeded', () => {
    const table = defs.find((d) => d.id === 'ess-table-earnings')!;
    expect(table.content).toContain('data-each="earnings"');
    expect(table.content).toContain('data-var="amount"');
    expect(table.content).toContain('data-format="money"');
  });

  it('lays out multi-column blocks as TABLES, never flex', () => {
    // Flex rows crossing a page boundary are clipped by Chromium print layout.
    const two = defs.find((d) => d.id === 'ess-two-columns')!;
    expect(two.content).toContain('<table');
    expect(two.content).not.toContain('display:flex');
  });

  it('offers the brand logo as the only image block', () => {
    const imgs = defs.filter((d) => d.content.includes('<img'));
    expect(imgs).toHaveLength(1);
    expect(imgs[0].content).toContain('data-brand="logo"');
  });
});

describe('validateGrapesHtml', () => {
  it('errors on an unknown chip with a suggestion', () => {
    const issues = validateGrapesHtml('<p><span data-var="employeNam">@ x</span></p>', manifest);
    const err = issues.find((i) => i.code === 'UNKNOWN_TOKEN');
    expect(err?.level).toBe('error');
    expect(err?.detail).toContain('employeeName');
  });

  it('accepts a RELATIVE chip inside a data-each region', () => {
    const html =
      '<table data-each="earnings"><tbody><tr><td><span data-var="amount">@ A</span></td></tr></tbody></table>';
    expect(validateGrapesHtml(html, manifest).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('errors on an unbound data-each', () => {
    const issues = validateGrapesHtml('<div data-each="nothing">x</div>', manifest);
    expect(issues.some((i) => i.code === 'UNBOUND_COLLECTION' && i.level === 'error')).toBe(true);
  });

  it('WARNS on typed braces without blocking — the server prints them as text', () => {
    const issues = validateGrapesHtml('<p>{{employeeName}}</p>', manifest);
    const warn = issues.find((i) => i.code === 'MALFORMED_TOKEN');
    expect(warn?.level).toBe('warning');
    expect(warn?.message).toContain('@');
  });

  it('accepts custom.* wholesale', () => {
    const issues = validateGrapesHtml('<p><span data-var="custom.jobGrade">@ g</span></p>', manifest);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('errors on an empty document', () => {
    expect(validateGrapesHtml('  ', manifest).some((i) => i.code === 'EMPTY_BLOCK')).toBe(true);
  });
});

describe('diffTokenUsage', () => {
  it('reports fields and tables added/removed as sets', () => {
    const oldHtml = '<span data-var="a">x</span><div data-each="t1">y</div>';
    const newHtml = '<span data-var="a">x</span><span data-var="b">y</span><div data-each="t2">z</div>';
    expect(diffTokenUsage(oldHtml, newHtml)).toEqual({
      addedFields: ['b'],
      removedFields: [],
      addedTables: ['t2'],
      removedTables: ['t1'],
    });
  });

  it('treats a first version as all additions', () => {
    expect(diffTokenUsage(null, '<span data-var="a">x</span>').addedFields).toEqual(['a']);
  });
});
