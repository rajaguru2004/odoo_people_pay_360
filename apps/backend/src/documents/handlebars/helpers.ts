import type * as Handlebars from 'handlebars';
import { DateTime } from 'luxon';

/**
 * Helpers available inside a document template.
 *
 * Every one is PURE. No I/O, no database, no settings read — a helper that
 * touches the database is an N+1 that nobody can see, because it fires once per
 * `{{…}}` per row per document, and in a 500-payslip bulk run that is tens of
 * thousands of queries attributable to nothing in particular.
 *
 * Anything a helper needs is put into the context by the resolver, which builds
 * the whole batch in one pass.
 */

const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const parsed = Number(v.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (v && typeof v === 'object' && 'toNumber' in (v as any)) {
    // Prisma Decimal, which arrives here whenever a resolver forwards a money
    // column without converting it.
    const parsed = Number((v as any).toNumber());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under1000(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const r = n % 10;
    return r ? `${t}-${ONES[r]}` : t;
  }
  const h = Math.floor(n / 100);
  const r = n % 100;
  return r ? `${ONES[h]} hundred ${under1000(r)}` : `${ONES[h]} hundred`;
}

/** Integer to words. Used for cheque-style amounts on settlements and payslips. */
function toWords(n: number): string {
  if (n === 0) return 'zero';
  const scales: [number, string][] = [
    [1_000_000_000, 'billion'],
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ];
  let rest = Math.floor(Math.abs(n));
  const parts: string[] = [];
  for (const [value, name] of scales) {
    if (rest >= value) {
      parts.push(`${under1000(Math.floor(rest / value))} ${name}`);
      rest %= value;
    }
  }
  if (rest > 0) parts.push(under1000(rest));
  return (n < 0 ? 'minus ' : '') + parts.join(' ');
}

export function registerDocumentHelpers(hb: typeof Handlebars): void {
  /**
   * Money, formatted to the currency's own precision.
   *
   * Three decimals for the Gulf currencies (OMR/BHD/KWD are 1000 baisa/fils to
   * the unit) and two elsewhere. Rounding a rial to two decimals loses real
   * money on a payslip, which is why this is not a single global default.
   */
  hb.registerHelper('money', (amount: unknown, currency?: unknown) => {
    const code = typeof currency === 'string' ? currency.toUpperCase() : '';
    const decimals = ['OMR', 'BHD', 'KWD', 'JOD', 'TND', 'LYD'].includes(code) ? 3 : 2;
    return num(amount).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  });

  hb.registerHelper('num', (value: unknown, decimals?: unknown) => {
    const d = typeof decimals === 'number' ? decimals : 0;
    return num(value).toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  });

  /**
   * Date, in the format the template asks for.
   *
   * Parsed as UTC and formatted without a zone shift on purpose: a joining date
   * is a calendar day, not an instant, and rendering it in the server's zone
   * moves it a day either side of midnight for half the world.
   */
  hb.registerHelper('date', (value: unknown, format?: unknown) => {
    if (!value) return '';
    const fmt = typeof format === 'string' ? format : 'dd/MM/yyyy';
    const dt =
      value instanceof Date
        ? DateTime.fromJSDate(value, { zone: 'utc' })
        : DateTime.fromISO(str(value), { zone: 'utc' });
    return dt.isValid ? dt.toFormat(fmt) : str(value);
  });

  /** Amount in words, with the fractional part as a /1000 or /100 remainder. */
  hb.registerHelper('words', (amount: unknown, currency?: unknown) => {
    const code = typeof currency === 'string' ? currency.toUpperCase() : '';
    const decimals = ['OMR', 'BHD', 'KWD', 'JOD'].includes(code) ? 3 : 2;
    const scale = 10 ** decimals;
    const value = num(amount);
    const whole = Math.floor(Math.abs(value));
    const frac = Math.round((Math.abs(value) - whole) * scale);
    const head = toWords(value < 0 ? -whole : whole);
    return frac > 0 ? `${head} and ${frac}/${scale}` : head;
  });

  hb.registerHelper('upper', (v: unknown) => str(v).toUpperCase());
  hb.registerHelper('lower', (v: unknown) => str(v).toLowerCase());
  hb.registerHelper('title', (v: unknown) =>
    str(v).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  );

  hb.registerHelper('pct', (part: unknown, whole: unknown, decimals?: unknown) => {
    const w = num(whole);
    if (w === 0) return '0%';
    const d = typeof decimals === 'number' ? decimals : 1;
    return `${((num(part) / w) * 100).toFixed(d)}%`;
  });

  /** Total a column without the resolver having to precompute every subtotal. */
  hb.registerHelper('sum', (rows: unknown, field: unknown) => {
    if (!Array.isArray(rows)) return 0;
    const key = str(field);
    return rows.reduce((acc: number, row: any) => acc + num(row?.[key]), 0);
  });

  hb.registerHelper('count', (rows: unknown) => (Array.isArray(rows) ? rows.length : 0));

  // Comparison block helpers. A condition builder in the UI emits these, so the
  // set is deliberately small and total — an HR user cannot author a comparison
  // that has no helper behind it.
  const block = (
    name: string,
    test: (a: unknown, b: unknown) => boolean,
  ) =>
    hb.registerHelper(name, function (this: unknown, a: unknown, b: unknown, options: any) {
      return test(a, b) ? options.fn(this) : options.inverse(this);
    });

  block('ifEq', (a, b) => String(a) === String(b));
  block('ifNeq', (a, b) => String(a) !== String(b));
  block('ifGt', (a, b) => num(a) > num(b));
  block('ifGte', (a, b) => num(a) >= num(b));
  block('ifLt', (a, b) => num(a) < num(b));
  block('ifLte', (a, b) => num(a) <= num(b));

  hb.registerHelper('unlessEmpty', function (this: unknown, value: unknown, options: any) {
    const empty =
      value === null ||
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
    return empty ? options.inverse(this) : options.fn(this);
  });

  /**
   * A page break the layout engine honours.
   *
   * `break-after` rather than the legacy `page-break-after`: Chromium's print
   * layout implements the modern property, and the old one is only aliased in
   * some contexts.
   */
  hb.registerHelper('pageBreak', () => new hb.SafeString('<div style="break-after:page"></div>'));

  /**
   * A table whose header repeats when it splits across pages.
   *
   * This is the only reliable repeat mechanism in Chromium's print layout —
   * `position: fixed` does not repeat, and CSS paged-media running elements are
   * unimplemented — so a 60-line payslip or a 2000-row register gets column
   * headings on every page only if it goes through here.
   */
  hb.registerHelper('docTable', function (rows: unknown, options: any) {
    if (!Array.isArray(rows) || rows.length === 0) {
      const empty = options.hash?.empty;
      return new hb.SafeString(
        empty ? `<p class="doc-empty">${hb.escapeExpression(String(empty))}</p>` : '',
      );
    }
    const body = rows.map((row, index) => options.fn(row, { data: { index } })).join('');
    return new hb.SafeString(`<table class="doc-table"><tbody>${body}</tbody></table>`);
  });
}
