import { compileGrapesDocument, scrubCss, scrubStyleValue, tokenFor } from './grapes-compiler';
import { compileAnyDocument } from './compile-dispatch';
import { DocumentCompileError } from './document-compiler';
import { GrapesTemplateDoc } from './document-doc.model';
import { compileDocumentTemplate, renderDocumentTemplate } from './handlebars/env';
import { sanitizeTemplateHtml } from './html-sanitizer';

const doc = (html: string, css = '', over: Partial<GrapesTemplateDoc> = {}): GrapesTemplateDoc => ({
  schemaVersion: 2,
  kind: 'grapes',
  documentType: 'SALARY_CERTIFICATE',
  locale: 'en',
  dir: 'ltr',
  page: {
    size: 'A4',
    orientation: 'portrait',
    margin: { top: 20, right: 18, bottom: 20, left: 18 },
    letterhead: { source: 'company', firstPageOnly: true },
  },
  theme: { followBrand: true },
  grapes: { project: {}, html, css },
  ...over,
});

/** Compile → sanitize → render — the exact path a real save-and-render takes. */
function endToEnd(html: string, context: Record<string, unknown>): string {
  const compiled = compileGrapesDocument(doc(html));
  const safe = sanitizeTemplateHtml(compiled.bodyHtml).html;
  return renderDocumentTemplate(compileDocumentTemplate(safe), context);
}

describe('compileGrapesDocument', () => {
  describe('chips are the ONLY token path', () => {
    it('turns a chip into a live token and discards its label text', () => {
      // The inner "@ Employee Name" is presentation only: renaming a field's
      // label later must never change what renders.
      const html = endToEnd(
        '<p>Dear <span data-var="employeeName">@ Employee Name</span>,</p>',
        { employeeName: 'Ahmed' },
      );
      expect(html).toContain('Ahmed');
      expect(html).not.toContain('@ Employee Name');
    });

    it('prints a TYPED {{token}} as literal text — never a live expression', () => {
      // The security line: an admin typing Handlebars gets ink, not execution.
      const html = endToEnd('<p>{{employeeName}}</p>', { employeeName: 'LEAKED' });
      expect(html).not.toContain('LEAKED');
      // Entity form — the browser paints it as the literal {{employeeName}}
      // the admin typed, and the Handlebars parser never sees a brace.
      expect(html).toContain('&#123;&#123;employeeName&#125;&#125;');
    });

    it('neutralises braces inside ATTRIBUTES too', () => {
      const out = compileGrapesDocument(doc('<p title="{{x}}">hi</p>'));
      expect(out.bodyHtml).not.toMatch(/title="\{\{/);
    });

    it('survives every half-typed shape — the compiler stays TOTAL', () => {
      for (const html of ['{{', '<p>{{positio</p>', '<p>a}}b</p>', '<p>{{a}}{{</p>', '{']) {
        expect(() => endToEnd(html, {})).not.toThrow();
      }
    });

    it('rejects a chip path that is not a plain dotted identifier', () => {
      // A hostile data-var becomes neutralised text, never an expression.
      // `constructor.constructor` matches the dotted-identifier shape, so the
      // format check alone let it through — dead at render (proto access is
      // off) but still stored. Refused by the explicit segment blocklist now.
      const out = compileGrapesDocument(
        doc('<p><span data-var="constructor.constructor">x</span></p>'),
      );
      expect(out.bodyHtml).not.toContain('{{constructor');
      expect(out.bodyHtml).toContain('&#123;');
    });
  });

  describe('format helpers mirror the block compiler grammar', () => {
    it.each([
      ['money', 'baseSalary', '{{money baseSalary currency}}'],
      ['num', 'workedDays', '{{num workedDays 2}}'],
      ['date', 'startDate', '{{date startDate}}'],
      [undefined, 'employeeName', '{{employeeName}}'],
    ])('format=%s', (format, path, expected) => {
      expect(tokenFor(path as string, format as string | undefined, false)).toBe(expected);
    });

    it('uses ../currency inside a data-each scope', () => {
      // Handlebars-relative resolution inside {{#each}} — the exact grammar
      // columnValue() in the block compiler emits.
      expect(tokenFor('amount', 'money', true)).toBe('{{money amount ../currency}}');
    });
  });

  describe('repetition', () => {
    const table =
      '<table data-each="earnings"><thead><tr><th>Component</th><th>Amount</th></tr></thead>' +
      '<tbody><tr><td><span data-var="label">@ Component</span></td>' +
      '<td><span data-var="amount" data-format="money">@ Amount</span></td></tr></tbody></table>';

    it('wraps the tbody rows in {{#each}}, keeping the thead OUTSIDE the loop', () => {
      // The thead outside the loop is what repeats across printed pages;
      // inside it would print once per record.
      const out = compileGrapesDocument(doc(table));
      expect(out.bodyHtml).toMatch(/<tbody>\{\{#each earnings\}\}/);
      expect(out.bodyHtml).toMatch(/\{\{\/each\}\}<\/tbody>/);
      expect(out.bodyHtml.indexOf('<thead>')).toBeLessThan(out.bodyHtml.indexOf('{{#each'));
    });

    it('renders one row per record with relative money resolution', () => {
      const html = endToEnd(table, {
        currency: 'OMR',
        earnings: [
          { label: 'Basic', amount: 1250 },
          { label: 'Housing', amount: 250 },
        ],
      });
      expect(html).toContain('Basic');
      expect(html).toContain('1,250.000');
      expect(html).toContain('250.000');
    });

    it('rejects nested data-each by name', () => {
      expect(() =>
        compileGrapesDocument(
          doc('<div data-each="a"><div data-each="b">x</div></div>'),
        ),
      ).toThrow(DocumentCompileError);
    });

    it('rejects a data-each value that is not an identifier', () => {
      expect(() => compileGrapesDocument(doc('<div data-each="a; drop">x</div>'))).toThrow(
        /not a list/,
      );
    });
  });

  describe('images', () => {
    it('rewrites the brand-logo block to the companyLogoUrl token', () => {
      const out = compileGrapesDocument(doc('<img data-brand="logo" style="max-height:16mm">'));
      expect(out.bodyHtml).toContain('src="{{companyLogoUrl}}"');
      expect(out.bodyHtml).not.toContain('data-brand');
    });

    it('strips a remote image and SAYS so', () => {
      // The sanitizer would strip the src anyway; stripping here lets the UI
      // name what disappeared instead of shipping a broken image silently.
      const out = compileGrapesDocument(doc('<img src="https://attacker.example/p.png">'));
      expect(out.bodyHtml).not.toContain('attacker');
      expect(out.removed.join(' ')).toContain('attacker.example');
    });

    it('keeps an inlined data: image', () => {
      const out = compileGrapesDocument(doc('<img src="data:image/png;base64,AAAA">'));
      expect(out.bodyHtml).toContain('data:image/png;base64,AAAA');
    });
  });

  describe('style scrubbing — the server twin of the curated StyleManager', () => {
    it.each([
      ['position:absolute;top:0', ''],
      ['position: static; color: red', 'position: static; color: red'],
      ['float:left;margin:4px', 'margin:4px'],
      ['transform:rotate(3deg);color:blue', 'color:blue'],
      ['z-index:99', ''],
      ['display:flex;gap:4px', 'gap:4px'],
      ['display:block;padding:2mm', 'display:block; padding:2mm'],
    ])('scrubStyleValue(%s)', (input, expected) => {
      const out = scrubStyleValue(input);
      expect(out.replace(/\s*;\s*/g, '; ').trim()).toBe(
        expected.replace(/\s*;\s*/g, '; ').trim(),
      );
    });

    it('drops #id CSS rules — the sanitizer strips id attributes, so id-keyed rules orphan', () => {
      const css = scrubCss('#i3kq{color:red}.keep{font-weight:600}#x .y{margin:0}');
      expect(css).not.toContain('#i3kq');
      expect(css).not.toContain('#x .y');
      expect(css).toContain('.keep{font-weight:600}');
    });

    it('scrubs blocked properties out of kept CSS rules', () => {
      expect(scrubCss('.a{position:absolute;color:red}')).toBe('.a{color:red}');
    });
  });

  describe('editor artifacts', () => {
    it('strips id/draggable/contenteditable — keeps contentHash stable across resaves', () => {
      // GrapesJS regenerates ids on every open; leaving them in would make
      // every open-and-save look like a content change in the publish diff.
      const out = compileGrapesDocument(
        doc('<div id="i9x2" draggable="true" contenteditable="false" data-gjs-type="text">x</div>'),
      );
      expect(out.bodyHtml).toBe('<div>x</div>');
    });

    it('produces IDENTICAL output when only editor ids differ', () => {
      const a = compileGrapesDocument(doc('<div id="iaaa"><p id="ibbb">x</p></div>'));
      const b = compileGrapesDocument(doc('<div id="iccc"><p id="iddd">x</p></div>'));
      expect(a.bodyHtml).toBe(b.bodyHtml);
    });
  });

  it('converts data-page-break to the v1 page-break markup', () => {
    const out = compileGrapesDocument(doc('<div data-page-break="true">anything</div>'));
    expect(out.bodyHtml).toContain('break-after:page');
    expect(out.bodyHtml).not.toContain('anything');
  });

  it('runs the footer through the same chip + neutralise pass', () => {
    const out = compileGrapesDocument(
      doc('<p>x</p>', '', {
        footer: { html: '<span data-var="companyName">@ Company</span> {{sneak}}', showPageNumbers: true },
      }),
    );
    expect(out.footerHtml).toContain('{{companyName}}');
    expect(out.footerHtml).not.toMatch(/\{\{sneak\}\}/);
  });

  it('refuses an empty document plainly', () => {
    expect(() =>
      compileGrapesDocument({ ...doc('x'), grapes: undefined as never }),
    ).toThrow(/empty/i);
  });

  it('produces markup the sanitizer leaves intact end to end', () => {
    // The stages must agree: anything this compiler emits that the sanitizer
    // strips is a feature that silently does not work.
    const compiled = compileGrapesDocument(
      doc(
        '<h1 style="text-align:center">SALARY CERTIFICATE</h1>' +
          '<p>Dear <span data-var="employeeName">@ Employee Name</span></p>' +
          '<img data-brand="logo" style="max-height:16mm">',
      ),
    );
    const res = sanitizeTemplateHtml(compiled.bodyHtml);
    expect(res.removed).toEqual([]);
    expect(res.html).toContain('{{employeeName}}');
    expect(res.html).toContain('src="{{companyLogoUrl}}"');
  });
});

describe('compileAnyDocument dispatch', () => {
  it('routes v2 grapes docs to the grapes compiler', () => {
    const out = compileAnyDocument(doc('<p><span data-var="employeeName">@ X</span></p>'));
    expect(out.bodyHtml).toContain('{{employeeName}}');
  });

  it('still routes v1 block docs to the block compiler', () => {
    const out = compileAnyDocument({
      schemaVersion: 1,
      documentType: 'SALARY_CERTIFICATE',
      locale: 'en',
      dir: 'ltr',
      page: { size: 'A4', orientation: 'portrait', margin: { top: 20, right: 18, bottom: 20, left: 18 } },
      theme: { followBrand: true },
      body: [{ id: 'a', type: 'text', props: { html: '<p>{{employeeName}}</p>' } }],
    });
    expect(out.bodyHtml).toContain('{{employeeName}}');
  });

  it('refuses an unknown schema version rather than guessing', () => {
    expect(() => compileAnyDocument({ schemaVersion: 3 } as never)).toThrow(/newer version/i);
  });
});
