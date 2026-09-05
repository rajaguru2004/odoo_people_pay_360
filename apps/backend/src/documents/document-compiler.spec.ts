import { compileDocument, DocumentCompileError } from './document-compiler';
import {
  Block,
  DocumentTemplateDoc,
  defaultPageSetup,
  defaultTheme,
} from './document-doc.model';
import { compileDocumentTemplate, renderDocumentTemplate } from './handlebars/env';
import { sanitizeTemplateHtml } from './html-sanitizer';

function doc(body: Block[], extra: Partial<DocumentTemplateDoc> = {}): DocumentTemplateDoc {
  return {
    schemaVersion: 1,
    documentType: 'SALARY_CERTIFICATE',
    locale: 'en',
    dir: 'ltr',
    page: defaultPageSetup(),
    theme: defaultTheme(),
    body,
    ...extra,
  };
}

/** Compile → sanitize → render, i.e. exactly what a real save-and-render does. */
function endToEnd(body: Block[], context: Record<string, unknown>): string {
  const compiled = compileDocument(doc(body));
  const safe = sanitizeTemplateHtml(compiled.bodyHtml).html;
  return renderDocumentTemplate(compileDocumentTemplate(safe), context);
}

describe('compileDocument', () => {
  it('compiles a text block, keeping its tokens', () => {
    const out = compileDocument(
      doc([{ id: 'a', type: 'text', props: { html: '<p>Dear {{employeeName}}</p>' } }]),
    );
    expect(out.bodyHtml).toContain('{{employeeName}}');
  });

  it('escapes literal text but passes tokens through', () => {
    const html = endToEnd(
      [{ id: 'a', type: 'keyValue', props: { rows: [{ label: 'A & B', value: '{{employeeName}}' }] } }],
      { employeeName: 'Ahmed' },
    );
    expect(html).toContain('A &amp; B');
    expect(html).toContain('Ahmed');
  });

  it('escapes a VALUE that contains markup, so a name cannot break the layout', () => {
    // The reason the compiler never emits triple-stash: employee data is not
    // trusted markup, and a name is a place real angle brackets show up.
    const html = endToEnd(
      [{ id: 'a', type: 'text', props: { html: '<p>{{employeeName}}</p>' } }],
      { employeeName: '<script>alert(1)</script>' },
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  describe('field names', () => {
    it('refuses a path that is not a plain dotted identifier', () => {
      expect(() =>
        compileDocument(
          doc([
            {
              id: 'a',
              type: 'dataTable',
              props: { bind: 'rows; drop', columns: [{ key: 'a', header: 'A' }] },
            },
          ]),
        ),
      ).toThrow(DocumentCompileError);
    });

    it('accepts the custom.* namespace', () => {
      const out = compileDocument(
        doc([{ id: 'a', type: 'text', props: { html: '<p>{{custom.jobGrade}}</p>' } }]),
      );
      expect(out.bodyHtml).toContain('{{custom.jobGrade}}');
    });
  });

  describe('tables', () => {
    const table: Block = {
      id: 't',
      type: 'dataTable',
      props: {
        bind: 'earnings',
        columns: [
          { key: 'label', header: 'Component' },
          { key: 'amount', header: 'Amount', align: 'end', format: 'money' },
        ],
        totalsRow: { label: 'Total', column: 'amount' },
        emptyText: 'No earnings this period',
      },
    };

    it('emits a real thead, which is what repeats across a page break', () => {
      // Chromium's print layout repeats a table header and nothing else —
      // position:fixed does not repeat and paged-media running elements are
      // unimplemented. A 60-line payslip depends on this.
      const out = compileDocument(doc([table]));
      expect(out.bodyHtml).toContain('<thead>');
      expect(out.bodyHtml).toContain('<th');
    });

    it('renders one row per record with the format helper applied', () => {
      const html = endToEnd([table], {
        currency: 'OMR',
        earnings: [
          { label: 'Basic', amount: 1250 },
          { label: 'Housing', amount: 250 },
        ],
      });
      expect(html).toContain('Basic');
      // OMR is a 3-decimal currency; rounding it to 2 loses real money.
      expect(html).toContain('1,250.000');
      expect(html).toContain('250.000');
    });

    it('totals the bound column rather than trusting a precomputed field', () => {
      const html = endToEnd([table], {
        currency: 'OMR',
        earnings: [{ label: 'A', amount: 100 }, { label: 'B', amount: 25.5 }],
      });
      expect(html).toContain('125.500');
    });

    it('shows the empty text instead of an empty table', () => {
      const html = endToEnd([table], { currency: 'OMR', earnings: [] });
      expect(html).toContain('No earnings this period');
      expect(html).not.toContain('<thead>');
    });

    it('refuses a table with no columns, before publish rather than at render', () => {
      expect(() =>
        compileDocument(doc([{ id: 't', type: 'dataTable', props: { bind: 'rows', columns: [] } }])),
      ).toThrow(/at least one column/);
    });
  });

  describe('conditions', () => {
    const conditional = (visibleWhen: any): Block => ({
      id: 'c',
      type: 'text',
      props: { html: '<p>PROBATION</p>' },
      visibleWhen,
    });

    it('renders a truthy block only when the field is set', () => {
      expect(endToEnd([conditional({ op: 'truthy', path: 'onProbation' })], { onProbation: true }))
        .toContain('PROBATION');
      expect(endToEnd([conditional({ op: 'truthy', path: 'onProbation' })], { onProbation: false }))
        .not.toContain('PROBATION');
    });

    it('compares equality', () => {
      const b = conditional({ op: 'eq', path: 'status', value: 'ACTIVE' });
      expect(endToEnd([b], { status: 'ACTIVE' })).toContain('PROBATION');
      expect(endToEnd([b], { status: 'LEFT' })).not.toContain('PROBATION');
    });

    it('compares numbers as numbers, not as strings', () => {
      // '9' > '10' is true for strings and false for numbers, and a salary
      // threshold that flips at 10 is exactly where that surfaces.
      const b = conditional({ op: 'gt', path: 'salary', value: 10 });
      expect(endToEnd([b], { salary: 9 })).not.toContain('PROBATION');
      expect(endToEnd([b], { salary: 11 })).toContain('PROBATION');
    });

    it('treats notEmpty and empty as opposites', () => {
      const ne = conditional({ op: 'notEmpty', path: 'purpose' });
      expect(endToEnd([ne], { purpose: 'Bank' })).toContain('PROBATION');
      expect(endToEnd([ne], { purpose: '' })).not.toContain('PROBATION');
    });

    it('nests AND', () => {
      const b = conditional({
        op: 'and',
        all: [
          { op: 'truthy', path: 'a' },
          { op: 'eq', path: 'b', value: 'x' },
        ],
      });
      expect(endToEnd([b], { a: true, b: 'x' })).toContain('PROBATION');
      expect(endToEnd([b], { a: true, b: 'y' })).not.toContain('PROBATION');
      expect(endToEnd([b], { a: false, b: 'x' })).not.toContain('PROBATION');
    });

    it('says plainly that OR is not supported yet', () => {
      // Better an explicit refusal at publish than a template that quietly
      // renders the wrong branch.
      expect(() =>
        compileDocument(doc([conditional({ op: 'or', all: [{ op: 'truthy', path: 'a' }] })])),
      ).toThrow(/OR is not supported/);
    });
  });

  describe('key/value rows', () => {
    it('hides a row whose value is blank, when asked', () => {
      // An empty "Passport number:" on a salary certificate reads as missing
      // data rather than as not applicable.
      const b: Block = {
        id: 'k',
        type: 'keyValue',
        props: {
          rows: [
            { label: 'Name', value: '{{employeeName}}' },
            { label: 'Passport', value: '{{passportNumber}}' },
          ],
          hideEmptyRows: true,
        },
      };
      const html = endToEnd([b], { employeeName: 'Ahmed', passportNumber: '' });
      expect(html).toContain('Name');
      expect(html).not.toContain('Passport');
    });

    it('keeps the row when hideEmptyRows is off', () => {
      const b: Block = {
        id: 'k',
        type: 'keyValue',
        props: { rows: [{ label: 'Passport', value: '{{passportNumber}}' }] },
      };
      expect(endToEnd([b], { passportNumber: '' })).toContain('Passport');
    });
  });

  it('keeps a signature block from splitting across a page', () => {
    // A signature separated from its name by a page break reads as a forgery.
    const out = compileDocument(
      doc([{ id: 's', type: 'signature', props: { slotKey: 'hr', showImage: true } }]),
    );
    expect(out.bodyHtml).toContain('break-inside:avoid');
    expect(out.bodyHtml).toContain('{{signatory.hr.name}}');
  });

  it('emits only the body — never the page envelope', () => {
    // The envelope (html/@page/letterhead/base CSS) belongs to the renderer.
    // If an admin could emit it, they could delete the Arabic font stack and
    // turn every Arabic document into tofu.
    const out = compileDocument(doc([{ id: 'a', type: 'text', props: { html: '<p>x</p>' } }]));
    expect(out.bodyHtml).not.toMatch(/<html|@page|<!doctype/i);
  });

  describe('half-typed input — the compiler must be TOTAL', () => {
    // The defect: autosave persisted a field the user was part-way through
    // typing (`{{positio`), the compiler emitted the stray braces as raw
    // Handlebars, and EVERY render of that template from then on died with a
    // parse error before anything could say why — including the preview the
    // author would have used to spot it. A draft that cannot be rendered is a
    // draft that cannot be repaired through the UI that produced it.
    const halfTyped = (value: string) =>
      doc([{ id: 'k', type: 'keyValue', props: { rows: [{ label: 'Designation', value }] } }]);

    it('compiles a half-typed field instead of emitting broken Handlebars', () => {
      const out = compileDocument(halfTyped('{{positio'));
      expect(out.bodyHtml).not.toContain('{{positio');
      expect(out.bodyHtml).toContain('&#123;&#123;positio');
    });

    it('and the result actually parses and renders', () => {
      const html = endToEnd(
        [{ id: 'k', type: 'keyValue', props: { rows: [{ label: 'Designation', value: '{{positio' }] } }],
        {},
      );
      // Rendered as an ENTITY, which the browser paints as the literal
      // `{{positio` the author typed — so they can see and fix it — while the
      // Handlebars parser never sees an opening brace at all.
      expect(html).toContain('&#123;&#123;positio');
      expect(html).not.toMatch(/\{\{positio/);
    });

    it('survives every shape of stray brace', () => {
      for (const value of ['{{', '}}', '{{ }}', '{{a', 'a}}', '{{{x', '{{a}}{{b', '{']) {
        expect(() =>
          endToEnd([{ id: 'k', type: 'keyValue', props: { rows: [{ label: 'L', value }] } }], {}),
        ).not.toThrow();
      }
    });

    it('handles a half-typed token in RICH TEXT too', () => {
      const html = endToEnd(
        [{ id: 't', type: 'text', props: { html: '<p>Dear {{employeeNam and {{employeeName}}</p>' } }],
        { employeeName: 'Ahmed' },
      );
      // The complete one still binds; the incomplete one prints as text.
      expect(html).toContain('Ahmed');
      expect(html).toContain('&#123;&#123;employeeNam');
    });

    it('still renders the whole shipped payslip when ONE field is half-typed', () => {
      // The real shape of the failure: one bad field took down a document that
      // was otherwise entirely fine.
      const body: Block[] = [
        { id: 'h', type: 'heading', props: { html: 'PAYSLIP', level: 1 } },
        {
          id: 'k',
          type: 'keyValue',
          props: {
            rows: [
              { label: 'Employee', value: '{{employeeName}}' },
              { label: 'Designation', value: '{{positio' },
              { label: 'Department', value: '{{department}}' },
            ],
            hideEmptyRows: true,
          },
        },
      ];
      const html = endToEnd(body, { employeeName: 'Ahmed', department: 'Ops' });
      expect(html).toContain('Ahmed');
      expect(html).toContain('Ops');
      expect(html).toContain('PAYSLIP');
    });
  });

  it('refuses a document from a newer builder rather than guessing', () => {
    expect(() => compileDocument(doc([], { schemaVersion: 2 as any }))).toThrow(
      /newer version of the builder/,
    );
  });

  it('refuses an unknown block type by name', () => {
    expect(() =>
      compileDocument(doc([{ id: 'x', type: 'hologram', props: {} } as any])),
    ).toThrow(/hologram/);
  });

  it('produces markup the sanitizer leaves intact', () => {
    // The two stages have to agree: anything the compiler emits and the
    // sanitizer then strips is a feature that silently does not work.
    const compiled = compileDocument(
      doc([
        { id: 'a', type: 'heading', props: { html: 'SALARY CERTIFICATE', level: 1, align: 'center' } },
        { id: 'b', type: 'logo', props: { source: 'brand', maxHeightMm: 15, align: 'center' } },
        { id: 'c', type: 'text', props: { html: '<p>Dear {{employeeName}}</p>' } },
        { id: 'd', type: 'divider', props: {} },
        { id: 'e', type: 'signature', props: { slotKey: 'hr' } },
      ]),
    );
    const res = sanitizeTemplateHtml(compiled.bodyHtml);
    expect(res.removed).toEqual([]);
    expect(res.html).toContain('{{employeeName}}');
    expect(res.html).toContain('src="{{companyLogoUrl}}"');
    expect(res.html).toContain('{{signatory.hr.name}}');
  });
});
