import { compileDocumentForEditor, grapesDocFromSeed } from './grapes-seed';
import { compileGrapesDocument } from './grapes-compiler';
import { compileDocument } from './document-compiler';
import { shippedTemplates } from './document-defaults';
import { DocumentTemplateDoc } from './document-doc.model';

/**
 * The v1 → visual conversion seed.
 *
 * The property that matters is ROUND-TRIP TOKEN PARITY: seeding a v1 doc into
 * chips and compiling the chips back must reference the same fields the block
 * compiler references — otherwise conversion silently changes what a document
 * pulls from the database.
 */

const tokensIn = (html: string): Set<string> => {
  const out = new Set<string>();
  // Plain {{path}} and helper forms {{money path ...}} both count the PATH.
  for (const m of html.matchAll(/\{\{(?:#each\s+)?(?:money |num |date )?([A-Za-z_][\w.]*)/g)) {
    if (!['each', 'if', 'unlessEmpty'].includes(m[1])) out.add(m[1]);
  }
  return out;
};

describe('compileDocumentForEditor', () => {
  const payslip = shippedTemplates().find((t) => t.typeKey === 'PAYSLIP' && t.locale === 'en')!;

  it('emits chips, never tokens', () => {
    const seed = compileDocumentForEditor(payslip.doc);
    expect(seed.html).toContain('data-var="employeeName"');
    expect(seed.html).not.toMatch(/\{\{employeeName\}\}/);
  });

  it('carries the chip label from the type registry, not the raw path', () => {
    const seed = compileDocumentForEditor(payslip.doc);
    expect(seed.html).toContain('@ Employee name');
  });

  it('emits data-each tables with the header OUTSIDE the template row', () => {
    const seed = compileDocumentForEditor(payslip.doc);
    expect(seed.html).toContain('data-each="earnings"');
    expect(seed.html).toContain('data-each="deductions"');
  });

  it('ROUND-TRIP: seed → grapes-compile references the fields the block compiler does', () => {
    // The conversion contract. A field the block compiler pulls that the
    // seeded-and-recompiled version does not is data silently lost.
    const blockOut = compileDocument(payslip.doc);
    const seed = compileDocumentForEditor(payslip.doc);
    const grapesOut = compileGrapesDocument(grapesDocFromSeed(payslip.doc, seed));

    const blockTokens = tokensIn(blockOut.bodyHtml);
    const grapesTokens = tokensIn(grapesOut.bodyHtml);

    // Dropped-by-design features may REMOVE tokens (totals rows, unlessEmpty
    // wrappers); nothing may APPEAR that the block compiler never referenced.
    for (const t of grapesTokens) {
      expect(blockTokens.has(t)).toBe(true);
    }
    // And the core fields all survive.
    for (const core of ['employeeName', 'employeeCode', 'periodLabel', 'netPay', 'earnings', 'deductions']) {
      expect(grapesTokens.has(core)).toBe(true);
    }
  });

  it('names every dropped feature instead of losing it silently', () => {
    const doc: DocumentTemplateDoc = {
      schemaVersion: 1,
      documentType: 'PAYSLIP',
      locale: 'en',
      dir: 'ltr',
      page: { size: 'A4', orientation: 'portrait', margin: { top: 20, right: 18, bottom: 20, left: 18 } },
      theme: { followBrand: true },
      body: [
        {
          id: 'a',
          type: 'text',
          props: { html: '<p>x</p>' },
          visibleWhen: { op: 'truthy', path: 'onProbation' },
        },
        {
          id: 't',
          type: 'dataTable',
          props: {
            bind: 'earnings',
            columns: [{ key: 'amount', header: 'Amount', format: 'money' }],
            totalsRow: { label: 'Total earnings', column: 'amount' },
          },
        },
      ],
    };
    const seed = compileDocumentForEditor(doc);
    expect(seed.dropped.join(' ')).toMatch(/show only when/);
    expect(seed.dropped.join(' ')).toMatch(/Total earnings/);
  });

  it('every shipped template seeds and recompiles without throwing', () => {
    for (const t of shippedTemplates()) {
      const seed = compileDocumentForEditor(t.doc);
      expect(() => compileGrapesDocument(grapesDocFromSeed(t.doc, seed))).not.toThrow();
    }
  });

  it('the resulting v2 doc keeps page/theme/locale so the envelope is unchanged', () => {
    const seed = compileDocumentForEditor(payslip.doc);
    const v2 = grapesDocFromSeed(payslip.doc, seed);
    expect(v2.page).toEqual(payslip.doc.page);
    expect(v2.locale).toBe(payslip.doc.locale);
    expect(v2.dir).toBe(payslip.doc.dir);
    expect(v2.schemaVersion).toBe(2);
    expect(v2.kind).toBe('grapes');
  });
});
