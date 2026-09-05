import { compileDocument } from './document-compiler';
import { shippedTemplates } from './document-defaults';
import { DOCUMENT_TYPES, getDocumentType, sampleContext } from './document-types';
import { compileDocumentTemplate, renderDocumentTemplate } from './handlebars/env';
import { sanitizeTemplateHtml } from './html-sanitizer';

/**
 * The shipped templates are what a customer sees before they customize
 * anything, so a broken one is a broken product on day one. This suite drives
 * every one of them through the entire real path — compile, sanitize, render —
 * against the type's own sample data.
 */
describe('shipped templates', () => {
  const all = shippedTemplates();

  it('ships one for every declared type and locale', () => {
    const expected = DOCUMENT_TYPES.flatMap((t) => t.defaultLocales.map((l) => `${t.key}:${l}`));
    const actual = all.map((t) => `${t.typeKey}:${t.locale}`);
    expect(actual.sort()).toEqual(expected.sort());
  });

  it('has no duplicate (type, locale) pairs', () => {
    const keys = all.map((t) => `${t.typeKey}:${t.locale}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every block a unique, stable id', () => {
    // Ids key the publish diff, which uses them to tell a MOVE from a
    // delete-plus-add. Duplicates would report phantom changes.
    for (const t of all) {
      const ids = t.doc.body.map((b) => b.id);
      expect({ template: `${t.typeKey}:${t.locale}`, unique: new Set(ids).size === ids.length })
        .toEqual({ template: `${t.typeKey}:${t.locale}`, unique: true });
    }
  });

  it('produces identical ids on a second call', () => {
    // The seeder reconciles on every boot. Ids that changed per call would make
    // every restart look like an edit.
    const a = shippedTemplates().map((t) => t.doc.body.map((b) => b.id).join(','));
    const b = shippedTemplates().map((t) => t.doc.body.map((b) => b.id).join(','));
    expect(a).toEqual(b);
  });

  describe('every template compiles, sanitizes and renders', () => {
    for (const t of shippedTemplates()) {
      const label = `${t.typeKey} (${t.locale})`;

      it(`${label} survives the whole path`, () => {
        const compiled = compileDocument(t.doc);

        // Nothing the compiler emits may be stripped: a block that silently
        // disappears between save and render is a feature that does not work.
        const sanitized = sanitizeTemplateHtml(compiled.bodyHtml);
        expect({ label, removed: sanitized.removed }).toEqual({ label, removed: [] });

        const type = getDocumentType(t.typeKey)!;
        const html = renderDocumentTemplate(
          compileDocumentTemplate(sanitized.html),
          sampleContext(type),
        );

        expect(html.length).toBeGreaterThan(0);
        // An unresolved token means the template names a field the type does
        // not declare — which renders blank in production and is invisible
        // until somebody reads a printed document.
        expect({ label, leftovers: html.match(/\{\{[^}]+\}\}/g) ?? [] }).toEqual({
          label,
          leftovers: [],
        });
      });
    }
  });

  it('renders Arabic templates right-to-left', () => {
    const ar = all.filter((t) => t.locale === 'ar');
    expect(ar.length).toBeGreaterThan(0);
    for (const t of ar) {
      expect(t.doc.dir).toBe('rtl');
    }
  });

  it('prints wide reports landscape', () => {
    // Four money columns on A4 portrait wrap into unreadable stacks.
    const variance = all.find((t) => t.typeKey === 'PAYROLL_VARIANCE')!;
    expect(variance.doc.page.orientation).toBe('landscape');
  });

  it('does not put letterhead artwork on internal reports', () => {
    const register = all.find((t) => t.typeKey === 'PAYROLL_REGISTER')!;
    expect(register.doc.page.letterhead?.source).toBe('none');
  });

  it('puts letterhead on every letter', () => {
    for (const t of all.filter((x) => getDocumentType(x.typeKey)!.category === 'LETTER')) {
      expect(t.doc.page.letterhead?.source).toBe('company');
    }
  });

  it('gives a payslip both tables and a net-pay figure', () => {
    const p = all.find((t) => t.typeKey === 'PAYSLIP' && t.locale === 'en')!;
    const binds = p.doc.body
      .filter((b) => b.type === 'dataTable')
      .map((b: any) => b.props.bind);
    expect(binds).toEqual(['earnings', 'deductions']);
    const html = compileDocument(p.doc).bodyHtml;
    expect(html).toContain('{{netPay}}');
    expect(html).toContain('{{netPayInWords}}');
  });

  it('only prints the truncation warning when rows were actually cut', () => {
    // A report that silently cut rows reads as complete, which is the whole
    // failure mode this line exists to prevent — but printing it unconditionally
    // would be a lie in the other direction.
    const register = all.find((t) => t.typeKey === 'PAYROLL_REGISTER')!;
    const warn = register.doc.body.find((b) =>
      b.type === 'text' && (b.props as any).html.includes('Truncated'),
    );
    expect(warn?.visibleWhen).toEqual({ op: 'truthy', path: 'truncatedAt' });
  });
});
