/**
 * The letters this platform ships with, seeded on boot the way the library
 * pick lists are.
 *
 * The markup is self-contained — one inline stylesheet, no external font or
 * asset beyond the company logo — so a letter renders and prints identically
 * wherever it is opened. The Arabic variants set `dir="rtl"` and lead with an
 * Arabic font stack; the rest of the document is the same document.
 */
export interface LetterTemplateDefault {
  key: string;
  name: string;
  locale: string;
  requiresApproval: boolean;
  bodyHtml: string;
}

const BASE_STYLE = `
  @page { margin: 18mm; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #111827; font-size: 13pt; line-height: 1.7; margin: 0; padding: 24px; }
  .header { text-align: center; border-bottom: 2px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 28px; }
  .header img { max-height: 60px; }
  .header h2 { margin: 8px 0 0; font-size: 15pt; }
  .meta { display: flex; justify-content: space-between; font-size: 10pt; color: #6b7280; margin-bottom: 24px; }
  h1 { font-size: 16pt; text-align: center; text-decoration: underline; margin: 0 0 28px; }
  table.details { width: 100%; border-collapse: collapse; margin: 18px 0; }
  table.details td { padding: 6px 0; vertical-align: top; }
  table.details td.label { width: 40%; color: #6b7280; }
  .sign { margin-top: 56px; }
  .footer { margin-top: 48px; border-top: 1px solid #e5e7eb; padding-top: 10px; font-size: 9pt; color: #9ca3af; text-align: center; }
`;

const ARABIC_STYLE = `
  ${BASE_STYLE}
  body { font-family: 'Noto Sans Arabic', 'Noto Naskh Arabic', Arial, sans-serif; }
`;

function page(opts: {
  dir: 'ltr' | 'rtl';
  lang: string;
  style: string;
  title: string;
  body: string;
  footer: string;
}): string {
  const ref = opts.dir === 'rtl' ? 'الرقم المرجعي' : 'Ref';
  const date = opts.dir === 'rtl' ? 'التاريخ' : 'Date';
  return `<!doctype html>
<html dir="${opts.dir}" lang="${opts.lang}">
<head><meta charset="utf-8"><title>${opts.title}</title><style>${opts.style}</style></head>
<body>
  <div class="header">
    {{#if companyLogoUrl}}<img src="{{companyLogoUrl}}" alt="{{companyName}}" />{{/if}}
    <h2>{{companyName}}</h2>
  </div>
  <div class="meta">
    <span>${ref}: {{serialNumber}}</span>
    <span>${date}: {{issueDate}}</span>
  </div>
  <h1>${opts.title}</h1>
  ${opts.body}
  <div class="footer">${opts.footer}</div>
</body>
</html>`;
}

const EN_FOOTER =
  'This document was generated electronically and is valid without a physical signature. Verify it with reference {{serialNumber}}.';

export const LETTER_TEMPLATE_DEFAULTS: LetterTemplateDefault[] = [
  {
    key: 'SALARY_CERTIFICATE',
    name: 'Salary Certificate',
    locale: 'en',
    // It states somebody's pay to a bank, so it is never issued instantly.
    requiresApproval: true,
    bodyHtml: page({
      dir: 'ltr',
      lang: 'en',
      style: BASE_STYLE,
      title: 'SALARY CERTIFICATE',
      body: `
  <p>To Whom It May Concern{{#if addressedTo}} ({{addressedTo}}){{/if}},</p>
  <p>This is to certify that the following individual is employed by {{companyName}}:</p>
  <table class="details">
    <tr><td class="label">Name</td><td><strong>{{employeeName}}</strong></td></tr>
    <tr><td class="label">Employee code</td><td>{{employeeCode}}</td></tr>
    <tr><td class="label">Designation</td><td>{{position}}</td></tr>
    <tr><td class="label">Department</td><td>{{department}}</td></tr>
    <tr><td class="label">Date of joining</td><td>{{startDate}}</td></tr>
    <tr><td class="label">Monthly gross salary</td><td><strong>{{currency}} {{baseSalary}}</strong></td></tr>
  </table>
  {{#if purpose}}<p>This certificate is issued at the employee's request for the purpose of {{purpose}}.</p>{{/if}}
  <div class="sign">
    <p>For {{companyName}},</p>
    <p style="margin-top:44px">_______________________<br/>Human Resources</p>
  </div>`,
      footer: EN_FOOTER,
    }),
  },
  {
    key: 'SALARY_CERTIFICATE',
    name: 'شهادة راتب',
    locale: 'ar',
    requiresApproval: true,
    bodyHtml: page({
      dir: 'rtl',
      lang: 'ar',
      style: ARABIC_STYLE,
      title: 'شهادة راتب',
      body: `
  <p>إلى من يهمه الأمر{{#if addressedTo}} ({{addressedTo}}){{/if}}،</p>
  <p>نشهد بأن الموظف المذكور أدناه يعمل لدى {{companyName}}:</p>
  <table class="details">
    <tr><td class="label">الاسم</td><td><strong>{{employeeName}}</strong></td></tr>
    <tr><td class="label">الرقم الوظيفي</td><td>{{employeeCode}}</td></tr>
    <tr><td class="label">المسمى الوظيفي</td><td>{{position}}</td></tr>
    <tr><td class="label">القسم</td><td>{{department}}</td></tr>
    <tr><td class="label">تاريخ الالتحاق</td><td>{{startDate}}</td></tr>
    <tr><td class="label">الراتب الشهري الإجمالي</td><td><strong>{{currency}} {{baseSalary}}</strong></td></tr>
  </table>
  {{#if purpose}}<p>وقد أُصدرت هذه الشهادة بناءً على طلب الموظف لغرض {{purpose}}.</p>{{/if}}
  <div class="sign">
    <p>عن {{companyName}}،</p>
    <p style="margin-top:44px">_______________________<br/>الموارد البشرية</p>
  </div>`,
      footer:
        'صدرت هذه الوثيقة إلكترونياً وهي صالحة دون توقيع. الرقم المرجعي {{serialNumber}}.',
    }),
  },
  {
    key: 'NOC',
    name: 'No Objection Certificate',
    locale: 'en',
    requiresApproval: true,
    bodyHtml: page({
      dir: 'ltr',
      lang: 'en',
      style: BASE_STYLE,
      title: 'NO OBJECTION CERTIFICATE',
      body: `
  <p>To Whom It May Concern{{#if addressedTo}} ({{addressedTo}}){{/if}},</p>
  <p>This is to certify that <strong>{{employeeName}}</strong> ({{employeeCode}}),
     holding the position of {{position}} in our {{department}} department since
     {{startDate}}, is a bona fide employee of {{companyName}}.</p>
  <p>{{companyName}} has <strong>no objection</strong> to the above employee
     {{#if purpose}}{{purpose}}{{else}}proceeding with their stated request{{/if}}.</p>
  <p>This certificate is issued at the employee's request and creates no financial
     obligation on the part of the company.</p>
  <div class="sign">
    <p>For {{companyName}},</p>
    <p style="margin-top:44px">_______________________<br/>Human Resources</p>
  </div>`,
      footer: EN_FOOTER,
    }),
  },
  {
    key: 'EXPERIENCE',
    name: 'Experience Letter',
    locale: 'en',
    // A statement of past employment carries no live financial data, so it can
    // be issued the moment it is asked for.
    requiresApproval: false,
    bodyHtml: page({
      dir: 'ltr',
      lang: 'en',
      style: BASE_STYLE,
      title: 'EXPERIENCE LETTER',
      body: `
  <p>To Whom It May Concern,</p>
  <p>This is to certify that <strong>{{employeeName}}</strong> ({{employeeCode}})
     has been employed with {{companyName}} as <strong>{{position}}</strong> in the
     {{department}} department from {{startDate}}{{#if endDate}} to {{endDate}}{{else}} to date{{/if}}.</p>
  <p>During this period we found them to be sincere, hardworking and professional
     in the discharge of their duties.</p>
  <p>We wish them every success in their future endeavours.</p>
  <div class="sign">
    <p>For {{companyName}},</p>
    <p style="margin-top:44px">_______________________<br/>Human Resources</p>
  </div>`,
      footer: EN_FOOTER,
    }),
  },
  {
    key: 'EMBASSY',
    name: 'Embassy Letter',
    locale: 'en',
    requiresApproval: true,
    bodyHtml: page({
      dir: 'ltr',
      lang: 'en',
      style: BASE_STYLE,
      title: 'EMBASSY LETTER',
      body: `
  <p>The Visa Officer{{#if addressedTo}}<br/>{{addressedTo}}{{/if}},</p>
  <p>This is to confirm that <strong>{{employeeName}}</strong> ({{employeeCode}})
     has been employed with {{companyName}} as {{position}} since {{startDate}},
     drawing a monthly gross salary of {{currency}} {{baseSalary}}.</p>
  <p>{{#if purpose}}The employee intends to travel for {{purpose}}. {{/if}}We confirm
     that their employment will continue on their return, and that all expenses
     related to this travel are the employee's own responsibility unless stated
     otherwise in a separate undertaking.</p>
  <p>We should be grateful for any assistance you can extend in processing their
     visa application.</p>
  <div class="sign">
    <p>For {{companyName}},</p>
    <p style="margin-top:44px">_______________________<br/>Human Resources</p>
  </div>`,
      footer: EN_FOOTER,
    }),
  },
];
