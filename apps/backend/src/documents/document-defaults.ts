import {
  Block,
  DocumentTemplateDoc,
  defaultPageSetup,
  defaultTheme,
} from './document-doc.model';
import { DOCUMENT_TYPES, DocumentTypeDef } from './document-types';

/**
 * The shipped predefined templates.
 *
 * Built from three archetypes rather than twenty-two hand-drawn layouts, and
 * that is a design decision, not a shortcut: a letter, a payslip and a report
 * are genuinely three shapes, and twenty-two near-copies would drift apart the
 * first time somebody fixed a margin in one of them. Per-type differences are
 * expressed as data (which key/value rows, which table) rather than as
 * separate files.
 *
 * These are STARTING POINTS. An admin duplicates one and edits it; the seeder
 * never overwrites a row once `isCustomized` is set, exactly as the profile
 * template seeder behaves.
 */

let seq = 0;
/**
 * Stable-per-build block ids.
 *
 * Not `crypto.randomUUID()`: the seeder reconciles shipped templates on every
 * boot, and ids that changed each time would make every restart look like an
 * edit — and would break the publish diff, which keys on block id to tell a
 * MOVE from a delete-plus-add.
 */
const id = (prefix: string) => `${prefix}-${(seq++).toString(36)}`;

function heading(text: string): Block {
  return {
    id: id('h'),
    type: 'heading',
    props: { html: text, level: 1, align: 'center', underline: true },
    spacingAfterMm: 6,
    locked: true,
  };
}

/** Ref/date line. Only shown for a type that actually has a serial. */
function metaRow(serialized: boolean): Block {
  return {
    id: id('meta'),
    type: 'keyValue',
    props: {
      rows: serialized
        ? [
            { label: 'Reference', value: '{{serialNumber}}' },
            { label: 'Date', value: '{{issueDate}}' },
          ]
        : [{ label: 'Date', value: '{{issueDate}}' }],
      labelWidthPct: 25,
      hideEmptyRows: true,
    },
    spacingAfterMm: 6,
  };
}

function signature(): Block {
  return {
    id: id('sig'),
    type: 'signature',
    props: { slotKey: 'hr', showImage: true, showStamp: true, align: 'start' },
  };
}

function text(html: string, spacingAfterMm = 4): Block {
  return { id: id('t'), type: 'text', props: { html }, spacingAfterMm };
}

/**
 * A letter: salutation, body paragraph, the facts as a key/value block, a
 * closing line and a signature.
 */
function letterDoc(type: DocumentTypeDef, locale: string): DocumentTemplateDoc {
  const rtl = locale === 'ar';
  const facts: { label: string; value: string }[] = [
    { label: rtl ? 'الاسم' : 'Name', value: '{{employeeName}}' },
    { label: rtl ? 'الرقم الوظيفي' : 'Employee code', value: '{{employeeCode}}' },
    { label: rtl ? 'المسمى الوظيفي' : 'Designation', value: '{{position}}' },
    { label: rtl ? 'القسم' : 'Department', value: '{{department}}' },
    { label: rtl ? 'تاريخ الالتحاق' : 'Date of joining', value: '{{startDate}}' },
  ];
  if (type.sensitivity === 'PAY') {
    facts.push({
      label: rtl ? 'الراتب الأساسي' : 'Basic salary',
      value: '{{money baseSalary currency}} {{currency}}',
    });
  }
  if (type.key === 'RELIEVING_LETTER' || type.key === 'EXPERIENCE_CERTIFICATE') {
    facts.push({ label: rtl ? 'آخر يوم عمل' : 'Last working day', value: '{{endDate}}' });
  }

  const opening = rtl
    ? '<p>إلى من يهمه الأمر،</p>'
    : '<p>To whom it may concern,</p>';

  const bodyText: Record<string, string> = {
    SALARY_CERTIFICATE: rtl
      ? '<p>نفيد بأن الموظف المذكور أدناه يعمل لدى {{companyName}}، وأن راتبه كما هو موضح أدناه.</p>'
      : '<p>This is to certify that the person named below is employed by {{companyName}}, and that their salary is as stated.</p>',
    NOC: rtl
      ? '<p>لا مانع لدينا من قيام الموظف المذكور أدناه بإتمام الإجراءات المطلوبة.</p>'
      : '<p>{{companyName}} has no objection to the person named below completing the formalities required.</p>',
    EXPERIENCE_CERTIFICATE: rtl
      ? '<p>نشهد بأن الموظف المذكور أدناه قد عمل لدى {{companyName}} خلال الفترة الموضحة أدناه.</p>'
      : '<p>This is to certify that the person named below served {{companyName}} during the period stated.</p>',
    EMBASSY_LETTER: rtl
      ? '<p>نتقدم بطلب منح التأشيرة للموظف المذكور أدناه، وهو موظف لدينا.</p>'
      : '<p>We request that a visa be granted to the person named below, who is an employee of {{companyName}}.</p>',
    OFFER_LETTER:
      '<p>We are pleased to offer you employment with {{companyName}} on the terms set out below.</p>',
    RELIEVING_LETTER:
      '<p>This is to confirm that the person named below has been relieved of their duties at {{companyName}}.</p>',
    WARNING_LETTER:
      '<p>This letter is a formal warning regarding the matter discussed with you. Please treat it as part of your employment record.</p>',
  };

  const purpose =
    type.key === 'SALARY_CERTIFICATE' || type.key === 'NOC' || type.key === 'EMBASSY_LETTER'
      ? [
          {
            ...text(
              rtl
                ? '<p>صدرت هذه الشهادة بناءً على طلب الموظف لغرض: {{purpose}}</p>'
                : '<p>This letter is issued at the employee’s request for the purpose of: {{purpose}}</p>',
            ),
            // Only printed when a purpose was actually given, rather than
            // leaving a sentence ending in a colon and nothing.
            visibleWhen: { op: 'notEmpty' as const, path: 'purpose' },
          },
        ]
      : [];

  return {
    schemaVersion: 1,
    documentType: type.key,
    locale,
    dir: rtl ? 'rtl' : 'ltr',
    page: defaultPageSetup(),
    theme: defaultTheme(),
    body: [
      heading(rtl ? arabicTitle(type.key) : type.name.toUpperCase()),
      metaRow(type.serialized),
      text(opening, 3),
      text(bodyText[type.key] ?? `<p>${type.description}</p>`),
      {
        id: id('kv'),
        type: 'keyValue',
        props: { rows: facts, labelWidthPct: 38, hideEmptyRows: true },
        spacingAfterMm: 6,
      },
      ...purpose,
      text(
        rtl
          ? '<p>صدرت هذه الشهادة بناءً على طلبه دون أدنى مسؤولية على الشركة.</p>'
          : '<p>This letter is issued without any liability on the part of {{companyName}}.</p>',
        8,
      ),
      signature(),
    ],
    footer: {
      html: type.serialized
        ? '{{companyName}} · {{serialNumber}} · verify at {{verifyUrl}}'
        : '{{companyName}}',
      showPageNumbers: true,
    },
  };
}

function arabicTitle(key: string): string {
  const titles: Record<string, string> = {
    SALARY_CERTIFICATE: 'شهادة راتب',
    NOC: 'شهادة عدم ممانعة',
    EXPERIENCE_CERTIFICATE: 'شهادة خبرة',
    EMBASSY_LETTER: 'خطاب إلى السفارة',
    PAYSLIP: 'قسيمة الراتب',
  };
  return titles[key] ?? key;
}

/** A payslip: identity, then earnings and deductions, then the net. */
function payslipDoc(locale: string): DocumentTemplateDoc {
  const rtl = locale === 'ar';
  return {
    schemaVersion: 1,
    documentType: 'PAYSLIP',
    locale,
    dir: rtl ? 'rtl' : 'ltr',
    page: defaultPageSetup(),
    theme: defaultTheme(),
    body: [
      heading(rtl ? arabicTitle('PAYSLIP') : 'PAYSLIP'),
      {
        id: id('kv'),
        type: 'keyValue',
        props: {
          rows: [
            { label: rtl ? 'الاسم' : 'Employee', value: '{{employeeName}} ({{employeeCode}})' },
            { label: rtl ? 'المسمى الوظيفي' : 'Designation', value: '{{position}}' },
            { label: rtl ? 'القسم' : 'Department', value: '{{department}}' },
            { label: rtl ? 'الفترة' : 'Pay period', value: '{{periodLabel}}' },
            { label: rtl ? 'أيام العمل' : 'Days worked', value: '{{workedDays}}' },
          ],
          labelWidthPct: 35,
          hideEmptyRows: true,
        },
        spacingAfterMm: 6,
      },
      { id: id('h2'), type: 'heading', props: { html: rtl ? 'المستحقات' : 'Earnings', level: 2 }, spacingAfterMm: 2 },
      {
        id: id('earn'),
        type: 'dataTable',
        props: {
          bind: 'earnings',
          columns: [
            { key: 'label', header: rtl ? 'البند' : 'Component', align: 'start' },
            { key: 'amount', header: rtl ? 'المبلغ' : 'Amount', align: 'end', format: 'money' },
          ],
          showHeader: true,
          totalsRow: { label: rtl ? 'إجمالي المستحقات' : 'Total earnings', column: 'amount' },
          emptyText: rtl ? 'لا توجد مستحقات' : 'No earnings this period',
        },
        spacingAfterMm: 5,
      },
      { id: id('h3'), type: 'heading', props: { html: rtl ? 'الاستقطاعات' : 'Deductions', level: 2 }, spacingAfterMm: 2 },
      {
        id: id('ded'),
        type: 'dataTable',
        props: {
          bind: 'deductions',
          columns: [
            { key: 'label', header: rtl ? 'البند' : 'Component', align: 'start' },
            { key: 'amount', header: rtl ? 'المبلغ' : 'Amount', align: 'end', format: 'money' },
          ],
          showHeader: true,
          totalsRow: { label: rtl ? 'إجمالي الاستقطاعات' : 'Total deductions', column: 'amount' },
          emptyText: rtl ? 'لا توجد استقطاعات' : 'No deductions this period',
        },
        spacingAfterMm: 5,
      },
      {
        id: id('net'),
        type: 'keyValue',
        props: {
          rows: [
            { label: rtl ? 'صافي الراتب' : 'Net pay', value: '{{netPay}} {{currency}}' },
            { label: rtl ? 'بالحروف' : 'In words', value: '{{netPayInWords}}' },
            { label: rtl ? 'طريقة الدفع' : 'Paid by', value: '{{paymentMethod}}' },
            { label: rtl ? 'البنك' : 'Bank', value: '{{bankName}}' },
          ],
          labelWidthPct: 35,
          hideEmptyRows: true,
        },
        spacingAfterMm: 8,
      },
      // A payslip is generated, not signed by hand. Saying so is better than an
      // empty signature rule that invites somebody to sign it.
      text(
        rtl
          ? '<p style="font-size:0.85em">هذه وثيقة صادرة إلكترونياً ولا تحتاج إلى توقيع.</p>'
          : '<p style="font-size:0.85em">This is a computer-generated payslip and does not require a signature.</p>',
      ),
    ],
    footer: { html: '{{companyName}} · {{periodLabel}}', showPageNumbers: true },
  };
}

/** A report: title, period, one table, a total. */
function reportDoc(type: DocumentTypeDef): DocumentTemplateDoc {
  const table = type.variables.find((v) => v.type === 'table');
  const totalVar = type.variables.find((v) => /^total/.test(v.name) && v.type === 'money');
  const wide = (table?.columns?.length ?? 0) >= 4;

  const page = defaultPageSetup();
  if (wide) {
    // A four-column table on A4 portrait wraps into unreadable stacks. This is
    // the "wide reports print landscape" rule made concrete rather than left to
    // whoever notices.
    page.orientation = 'landscape';
  }
  // Reports are internal working documents; letterhead artwork on a 40-page
  // register wastes ink and adds nothing.
  page.letterhead = { source: 'none', firstPageOnly: true };

  const body: Block[] = [
    { id: id('logo'), type: 'logo', props: { source: 'brand', maxHeightMm: 14, align: 'start' }, spacingAfterMm: 3 },
    heading(type.name.toUpperCase()),
    {
      id: id('meta'),
      type: 'keyValue',
      props: {
        rows: [
          { label: 'Period', value: '{{periodLabel}}' },
          { label: 'Branch', value: '{{branchName}}' },
          { label: 'Generated', value: '{{issueDate}}' },
        ],
        labelWidthPct: 20,
        hideEmptyRows: true,
      },
      spacingAfterMm: 5,
    },
  ];

  if (table) {
    body.push({
      id: id('tbl'),
      type: 'dataTable',
      props: {
        bind: table.name,
        columns: (table.columns ?? []).map((c) => ({
          key: c.name,
          header: c.label,
          align: c.type === 'money' || c.type === 'number' ? ('end' as const) : ('start' as const),
          format: c.type === 'money' ? ('money' as const) : c.type === 'date' ? ('date' as const) : ('none' as const),
        })),
        showHeader: true,
        zebra: true,
        emptyText: 'No rows for this period.',
        ...(totalVar
          ? {}
          : {}),
      },
      spacingAfterMm: 5,
    });
  }

  if (totalVar) {
    body.push({
      id: id('total'),
      type: 'keyValue',
      props: { rows: [{ label: totalVar.label, value: `{{${totalVar.name}}} {{currency}}` }], labelWidthPct: 70 },
      spacingAfterMm: 4,
    });
  }

  body.push({
    ...text('<p style="font-size:0.85em">Truncated at {{truncatedAt}} rows — narrow the filter to see the rest.</p>'),
    // Only printed when the resolver actually capped the result. A report that
    // silently cut rows reads as complete, which is the failure being designed
    // against.
    visibleWhen: { op: 'truthy', path: 'truncatedAt' },
  });

  return {
    schemaVersion: 1,
    documentType: type.key,
    locale: 'en',
    dir: 'ltr',
    page,
    theme: defaultTheme(),
    body,
    footer: { html: '{{companyName}} · ' + type.name, showPageNumbers: true },
  };
}

/** The archetype a type is built from. */
function archetypeFor(type: DocumentTypeDef, locale: string): DocumentTemplateDoc {
  if (type.key === 'PAYSLIP') return payslipDoc(locale);
  if (type.category === 'LETTER') return letterDoc(type, locale);
  if (type.subjectType === 'EMPLOYEE' || type.subjectType === 'SETTLEMENT') {
    // An employee-subject non-letter (settlement, leave balance, EOSB, asset
    // clearance) is a letter with a table in the middle.
    const base = letterDoc(type, locale);
    const table = type.variables.find((v) => v.type === 'table');
    if (table) {
      base.body.splice(base.body.length - 2, 0, {
        id: id('tbl'),
        type: 'dataTable',
        props: {
          bind: table.name,
          columns: (table.columns ?? []).map((c) => ({
            key: c.name,
            header: c.label,
            align: c.type === 'money' || c.type === 'number' ? ('end' as const) : ('start' as const),
            format: c.type === 'money' ? ('money' as const) : c.type === 'date' ? ('date' as const) : ('none' as const),
          })),
          showHeader: true,
          emptyText: 'Nothing to show.',
        },
        spacingAfterMm: 5,
      });
    }
    return base;
  }
  return reportDoc(type);
}

export interface ShippedTemplate {
  typeKey: string;
  locale: string;
  name: string;
  description: string;
  doc: DocumentTemplateDoc;
}

/** Every shipped template, one per (type, locale). */
export function shippedTemplates(): ShippedTemplate[] {
  seq = 0; // deterministic ids across calls
  const out: ShippedTemplate[] = [];
  for (const type of DOCUMENT_TYPES) {
    for (const locale of type.defaultLocales) {
      out.push({
        typeKey: type.key,
        locale,
        name: locale === 'en' ? type.name : `${type.name} (${locale.toUpperCase()})`,
        description: type.description,
        doc: archetypeFor(type, locale),
      });
    }
  }
  return out;
}
