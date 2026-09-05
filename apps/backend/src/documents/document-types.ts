/**
 * The document type catalogue.
 *
 * CODE, not a table, and deliberately so. A type an admin could create would
 * list in the UI, accept a template, take a publish — and then fail at
 * generation, because no context resolver exists to populate it. That is the
 * "setting an admin can see but nothing reads" defect CLAUDE.md §4 names,
 * except worse: it fails after the work rather than before it.
 *
 * Templates are rows. Types are not.
 *
 * Shaped as data rather than a switch, matching BRANCH_SCOPE and
 * SETTING_VALUE_RULES: the drift guard in document-types.spec.ts can then
 * check the whole catalogue mechanically.
 */

export type DocumentCategory =
  | 'LETTER'
  | 'PAYROLL'
  | 'FINANCE'
  | 'TIME'
  | 'LEAVE'
  | 'ASSET';

/**
 * How much damage a leaked copy does. Drives the role filter, not just a label.
 *
 * PAY refuses MANAGER outright — the rule already enforced for letters, on the
 * grounds that a manager has no business reading a subordinate's salary
 * certificate. RESTRICTED narrows further, to ADMIN/HR plus the subject.
 */
export type DocumentSensitivity =
  | 'INTERNAL'
  | 'PERSONAL'
  | 'PAY'
  | 'RESTRICTED';

export type DocumentVariableType =
  | 'string'
  | 'number'
  | 'money'
  | 'date'
  | 'boolean'
  | 'table'
  | 'image';

export interface DocumentVariableColumn {
  name: string;
  label: string;
  type: DocumentVariableType;
}

/**
 * One merge field, as the token picker sees it.
 *
 * `sample` is mandatory and the drift guard enforces it: a variable with no
 * sample renders blank in the sample preview, and an admin reasonably
 * concludes the token is broken rather than that the preview has no data.
 */
export interface DocumentVariable {
  name: string;
  label: string;
  type: DocumentVariableType;
  /** Picker section: 'Employee' | 'Company' | 'Document' | 'Pay' | … */
  group: string;
  sample: unknown;
  /** Row shape, when type === 'table'. */
  columns?: DocumentVariableColumn[];
  /** false => the UI offers a fallback value, because it can legitimately be absent. */
  alwaysPresent?: boolean;
}

export interface DocumentTypeDef {
  key: string;
  category: DocumentCategory;
  /** Only 'bulk' types may feed POST /documents/batches. */
  cardinality: 'single' | 'bulk';
  subjectType: 'EMPLOYEE' | 'PAYROLL' | 'SETTLEMENT' | 'PERIOD' | 'NONE';
  /** Human name, shown in the gallery. */
  name: string;
  description: string;
  /** Roles that may generate it, AND-ed with the route's own @Roles. */
  allowedRoles: readonly string[];
  /** May an EMPLOYEE generate it for THEMSELVES only? */
  selfService: boolean;
  sensitivity: DocumentSensitivity;
  /** Serial-numbered and verifiable? */
  serialized: boolean;
  /** EmployeeDocument.documentType to file it under, or null to not file it. */
  vaultDocumentType: string | null;
  defaultLocales: readonly string[];
  variables: readonly DocumentVariable[];
}

// ---------------------------------------------------------------------------
// Shared variable groups. Defined once: a token that means the same thing in
// two documents must not be able to drift into two spellings.
// ---------------------------------------------------------------------------

const COMPANY_VARS: readonly DocumentVariable[] = [
  { name: 'companyName', label: 'Company name', type: 'string', group: 'Company', sample: 'Acme Trading LLC' },
  { name: 'companyLegalName', label: 'Company legal name', type: 'string', group: 'Company', sample: 'Acme Trading LLC', alwaysPresent: false },
  { name: 'companyLogoUrl', label: 'Company logo', type: 'image', group: 'Company', sample: '' },
  { name: 'companyAddress', label: 'Company address', type: 'string', group: 'Company', sample: 'P.O. Box 1234, Muscat, Oman', alwaysPresent: false },
  { name: 'companyPhone', label: 'Company phone', type: 'string', group: 'Company', sample: '+968 2400 0000', alwaysPresent: false },
  { name: 'companyEmail', label: 'Company email', type: 'string', group: 'Company', sample: 'hr@acme.example', alwaysPresent: false },
  { name: 'companyWebsite', label: 'Company website', type: 'string', group: 'Company', sample: 'www.acme.example', alwaysPresent: false },
  { name: 'companyCrNumber', label: 'CR number', type: 'string', group: 'Company', sample: '1234567', alwaysPresent: false },
  { name: 'companyVatNumber', label: 'VAT number', type: 'string', group: 'Company', sample: 'OM1100000000', alwaysPresent: false },
  { name: 'branchName', label: 'Branch name', type: 'string', group: 'Company', sample: 'Muscat', alwaysPresent: false },
  { name: 'currency', label: 'Currency code', type: 'string', group: 'Company', sample: 'OMR' },
];

const DOCUMENT_VARS: readonly DocumentVariable[] = [
  { name: 'serialNumber', label: 'Reference number', type: 'string', group: 'Document', sample: 'SC-2026-00142', alwaysPresent: false },
  { name: 'issueDate', label: 'Issue date', type: 'date', group: 'Document', sample: '03/09/2026' },
  { name: 'verifyUrl', label: 'Verification link', type: 'string', group: 'Document', sample: 'https://ess.example/letters/verify/SC-2026-00142', alwaysPresent: false },
];

const EMPLOYEE_VARS: readonly DocumentVariable[] = [
  { name: 'employeeName', label: 'Employee name', type: 'string', group: 'Employee', sample: 'Ahmed Al-Balushi' },
  { name: 'employeeCode', label: 'Employee code', type: 'string', group: 'Employee', sample: 'EMP-0142' },
  { name: 'position', label: 'Designation', type: 'string', group: 'Employee', sample: 'Site Supervisor' },
  { name: 'department', label: 'Department', type: 'string', group: 'Employee', sample: 'Operations' },
  { name: 'startDate', label: 'Joining date', type: 'date', group: 'Employee', sample: '12/03/2021' },
  { name: 'endDate', label: 'Last working day', type: 'date', group: 'Employee', sample: '', alwaysPresent: false },
  { name: 'nationality', label: 'Nationality', type: 'string', group: 'Employee', sample: 'Omani', alwaysPresent: false },
  { name: 'passportNumber', label: 'Passport number', type: 'string', group: 'Employee', sample: 'A1234567', alwaysPresent: false },
  { name: 'civilIdNumber', label: 'Civil ID', type: 'string', group: 'Employee', sample: '12345678', alwaysPresent: false },
];

const PAY_VARS: readonly DocumentVariable[] = [
  { name: 'baseSalary', label: 'Basic salary', type: 'money', group: 'Pay', sample: '1,250.000' },
  { name: 'grossSalary', label: 'Gross salary', type: 'money', group: 'Pay', sample: '1,500.000', alwaysPresent: false },
];

const SIGNATORY_VARS: readonly DocumentVariable[] = [
  { name: 'signatory.hr.name', label: 'HR signatory name', type: 'string', group: 'Signature', sample: 'Fatma Al-Habsi', alwaysPresent: false },
  { name: 'signatory.hr.title', label: 'HR signatory title', type: 'string', group: 'Signature', sample: 'HR Manager', alwaysPresent: false },
  { name: 'signatory.hr.image', label: 'HR signature image', type: 'image', group: 'Signature', sample: '', alwaysPresent: false },
];

/**
 * Custom fields from the employee profile template, namespaced so
 * `{{custom.jobGrade}}` can never shadow a whitelisted key above.
 *
 * A single declared entry rather than one per field: the field set is
 * per-branch configuration and changes without a deploy, so the manifest
 * endpoint expands this at request time from the resolved profile template.
 */
const CUSTOM_NAMESPACE: DocumentVariable = {
  name: 'custom',
  label: 'Custom employee fields',
  type: 'string',
  group: 'Custom fields',
  sample: '',
  alwaysPresent: false,
};

const LETTER_VARS: readonly DocumentVariable[] = [
  ...COMPANY_VARS,
  ...DOCUMENT_VARS,
  ...EMPLOYEE_VARS,
  ...SIGNATORY_VARS,
  { name: 'purpose', label: 'Purpose', type: 'string', group: 'Request', sample: 'Bank account opening', alwaysPresent: false },
  { name: 'addressedTo', label: 'Addressed to', type: 'string', group: 'Request', sample: 'Bank Muscat', alwaysPresent: false },
  CUSTOM_NAMESPACE,
];

const PAY_LETTER_VARS: readonly DocumentVariable[] = [...LETTER_VARS, ...PAY_VARS];

const PAYSLIP_TABLE: DocumentVariable[] = [
  {
    name: 'earnings',
    label: 'Earnings lines',
    type: 'table',
    group: 'Payslip',
    columns: [
      { name: 'label', label: 'Component', type: 'string' },
      { name: 'amount', label: 'Amount', type: 'money' },
    ],
    sample: [
      { label: 'Basic salary', amount: '1,250.000' },
      { label: 'Housing allowance', amount: '250.000' },
    ],
  },
  {
    name: 'deductions',
    label: 'Deduction lines',
    type: 'table',
    group: 'Payslip',
    columns: [
      { name: 'label', label: 'Component', type: 'string' },
      { name: 'amount', label: 'Amount', type: 'money' },
    ],
    sample: [{ label: 'Social insurance', amount: '87.500' }],
  },
];

const PAYSLIP_VARS: readonly DocumentVariable[] = [
  ...COMPANY_VARS,
  ...DOCUMENT_VARS,
  ...EMPLOYEE_VARS,
  ...PAY_VARS,
  ...SIGNATORY_VARS,
  ...PAYSLIP_TABLE,
  { name: 'periodLabel', label: 'Pay period', type: 'string', group: 'Payslip', sample: 'August 2026' },
  { name: 'month', label: 'Month', type: 'number', group: 'Payslip', sample: 8 },
  { name: 'year', label: 'Year', type: 'number', group: 'Payslip', sample: 2026 },
  { name: 'totalEarnings', label: 'Total earnings', type: 'money', group: 'Payslip', sample: '1,500.000' },
  { name: 'totalDeductions', label: 'Total deductions', type: 'money', group: 'Payslip', sample: '87.500' },
  { name: 'netPay', label: 'Net pay', type: 'money', group: 'Payslip', sample: '1,412.500' },
  { name: 'netPayInWords', label: 'Net pay in words', type: 'string', group: 'Payslip', sample: 'One thousand four hundred twelve and 500/1000 Omani Rials' },
  { name: 'paymentMethod', label: 'Payment method', type: 'string', group: 'Payslip', sample: 'Bank transfer', alwaysPresent: false },
  { name: 'bankName', label: 'Bank', type: 'string', group: 'Payslip', sample: 'Bank Muscat', alwaysPresent: false },
  { name: 'accountNumber', label: 'Account number', type: 'string', group: 'Payslip', sample: '****4321', alwaysPresent: false },
  { name: 'workedDays', label: 'Days worked', type: 'number', group: 'Payslip', sample: 22, alwaysPresent: false },
  { name: 'lopDays', label: 'Unpaid days', type: 'number', group: 'Payslip', sample: 0, alwaysPresent: false },
  CUSTOM_NAMESPACE,
];

/** A report is a period plus one table. The columns differ; the shape does not. */
function reportVars(
  tableName: string,
  tableLabel: string,
  columns: DocumentVariableColumn[],
  sampleRow: Record<string, unknown>,
  extra: DocumentVariable[] = [],
): readonly DocumentVariable[] {
  return [
    ...COMPANY_VARS,
    ...DOCUMENT_VARS,
    ...SIGNATORY_VARS,
    {
      name: tableName,
      label: tableLabel,
      type: 'table',
      group: 'Report',
      columns,
      sample: [sampleRow],
    },
    { name: 'periodLabel', label: 'Period', type: 'string', group: 'Report', sample: 'August 2026' },
    { name: 'rowCount', label: 'Number of rows', type: 'number', group: 'Report', sample: 1 },
    {
      name: 'truncatedAt',
      label: 'Truncated at N rows',
      type: 'number',
      group: 'Report',
      sample: 0,
      alwaysPresent: false,
    },
    ...extra,
  ];
}

const money = (name: string, label: string): DocumentVariableColumn => ({ name, label, type: 'money' });
const text = (name: string, label: string): DocumentVariableColumn => ({ name, label, type: 'string' });

export const DOCUMENT_TYPES: readonly DocumentTypeDef[] = [
  // ── Letters ──────────────────────────────────────────────────────────────
  {
    key: 'SALARY_CERTIFICATE',
    category: 'LETTER',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'Salary certificate',
    description: 'States an employee’s pay to a bank, landlord or embassy.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PAY',
    serialized: true,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en', 'ar'],
    variables: PAY_LETTER_VARS,
  },
  {
    key: 'NOC',
    category: 'LETTER',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'No-objection certificate',
    description: 'Confirms the employer raises no objection, typically for travel or a visa.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PERSONAL',
    serialized: true,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en', 'ar'],
    variables: LETTER_VARS,
  },
  {
    key: 'EXPERIENCE_CERTIFICATE',
    category: 'LETTER',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'Experience certificate',
    description: 'Confirms role and dates of service.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PERSONAL',
    serialized: true,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en', 'ar'],
    variables: LETTER_VARS,
  },
  {
    key: 'EMBASSY_LETTER',
    category: 'LETTER',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'Embassy letter',
    description: 'Addressed to a consulate in support of a visa application.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PERSONAL',
    serialized: true,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en', 'ar'],
    variables: LETTER_VARS,
  },
  {
    key: 'OFFER_LETTER',
    category: 'LETTER',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'Offer letter',
    description: 'Offer of employment, stating role and pay.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PAY',
    serialized: true,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en'],
    variables: PAY_LETTER_VARS,
  },
  {
    key: 'RELIEVING_LETTER',
    category: 'LETTER',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'Relieving letter',
    description: 'Confirms an employee has been released, and on what date.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PERSONAL',
    serialized: true,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en'],
    variables: LETTER_VARS,
  },
  {
    key: 'WARNING_LETTER',
    category: 'LETTER',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'Warning letter',
    description: 'Formal disciplinary warning. Restricted: HR and the subject only.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'RESTRICTED',
    serialized: true,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en'],
    variables: LETTER_VARS,
  },

  // ── Payroll ──────────────────────────────────────────────────────────────
  {
    key: 'PAYSLIP',
    category: 'PAYROLL',
    // The one type most worth generating in bulk: "print August for everyone".
    cardinality: 'bulk',
    subjectType: 'EMPLOYEE',
    name: 'Payslip',
    description: 'One employee’s pay for one period, with earnings and deductions.',
    allowedRoles: ['ADMIN', 'HR_MANAGER', 'EMPLOYEE'],
    selfService: true,
    sensitivity: 'PAY',
    serialized: false,
    vaultDocumentType: 'Payslip',
    defaultLocales: ['en', 'ar'],
    variables: PAYSLIP_VARS,
  },
  {
    key: 'PAYROLL_REGISTER',
    category: 'PAYROLL',
    cardinality: 'single',
    subjectType: 'PAYROLL',
    name: 'Payroll register',
    description: 'Every line of one payroll run, for filing and approval.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PAY',
    serialized: false,
    vaultDocumentType: null,
    defaultLocales: ['en'],
    variables: reportVars('rows', 'Register rows', [
      text('employeeCode', 'Code'),
      text('employeeName', 'Employee'),
      money('gross', 'Gross'),
      money('deductions', 'Deductions'),
      money('net', 'Net'),
    ], { employeeCode: 'EMP-0142', employeeName: 'Ahmed Al-Balushi', gross: '1,500.000', deductions: '87.500', net: '1,412.500' },
      [{ name: 'totalNet', label: 'Total net', type: 'money', group: 'Report', sample: '1,412.500' }]),
  },
  {
    key: 'PAYROLL_COST_REPORT',
    category: 'PAYROLL',
    cardinality: 'single',
    subjectType: 'PERIOD',
    name: 'Payroll cost report',
    description: 'Cost by department or branch for a period. Wide — prints landscape.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PAY',
    serialized: false,
    vaultDocumentType: null,
    defaultLocales: ['en'],
    variables: reportVars('rows', 'Cost rows', [
      text('group', 'Group'),
      money('gross', 'Gross'),
      money('employerCost', 'Employer cost'),
    ], { group: 'Operations', gross: '18,000.000', employerCost: '19,260.000' }),
  },
  {
    key: 'STATUTORY_SUMMARY',
    category: 'PAYROLL',
    cardinality: 'single',
    subjectType: 'PERIOD',
    name: 'Statutory summary',
    description: 'Statutory contributions for a period, for filing.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PAY',
    serialized: false,
    vaultDocumentType: null,
    defaultLocales: ['en'],
    variables: reportVars('rows', 'Contribution rows', [
      text('label', 'Contribution'),
      money('employee', 'Employee'),
      money('employer', 'Employer'),
    ], { label: 'Social insurance', employee: '87.500', employer: '150.000' }),
  },
  {
    key: 'YTD_STATEMENT',
    category: 'PAYROLL',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'Year-to-date statement',
    description: 'An employee’s cumulative pay for the year.',
    allowedRoles: ['ADMIN', 'HR_MANAGER', 'EMPLOYEE'],
    selfService: true,
    sensitivity: 'PAY',
    serialized: false,
    vaultDocumentType: 'Payslip',
    defaultLocales: ['en'],
    variables: [
      ...COMPANY_VARS,
      ...DOCUMENT_VARS,
      ...EMPLOYEE_VARS,
      ...SIGNATORY_VARS,
      {
        name: 'rows', label: 'Monthly rows', type: 'table', group: 'Report',
        columns: [text('periodLabel', 'Period'), money('gross', 'Gross'), money('net', 'Net')],
        sample: [{ periodLabel: 'January 2026', gross: '1,500.000', net: '1,412.500' }],
      },
      { name: 'year', label: 'Year', type: 'number', group: 'Report', sample: 2026 },
      { name: 'totalGross', label: 'Total gross', type: 'money', group: 'Report', sample: '18,000.000' },
      { name: 'totalNet', label: 'Total net', type: 'money', group: 'Report', sample: '16,950.000' },
    ],
  },
  {
    key: 'PAYROLL_VARIANCE',
    category: 'PAYROLL',
    cardinality: 'single',
    subjectType: 'PERIOD',
    name: 'Payroll variance',
    description: 'Period-on-period movement. Wide — prints landscape.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PAY',
    serialized: false,
    vaultDocumentType: null,
    defaultLocales: ['en'],
    variables: reportVars('rows', 'Variance rows', [
      text('employeeName', 'Employee'),
      money('previous', 'Previous'),
      money('current', 'Current'),
      money('delta', 'Change'),
    ], { employeeName: 'Ahmed Al-Balushi', previous: '1,412.500', current: '1,512.500', delta: '100.000' }),
  },

  // ── Finance ──────────────────────────────────────────────────────────────
  {
    key: 'FINAL_SETTLEMENT',
    category: 'FINANCE',
    cardinality: 'single',
    subjectType: 'SETTLEMENT',
    name: 'Final settlement',
    description: 'End-of-service statement. A legal payment document.',
    allowedRoles: ['ADMIN', 'HR_MANAGER', 'EMPLOYEE'],
    selfService: true,
    sensitivity: 'RESTRICTED',
    serialized: true,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en'],
    variables: [
      ...COMPANY_VARS,
      ...DOCUMENT_VARS,
      ...EMPLOYEE_VARS,
      ...SIGNATORY_VARS,
      {
        name: 'lines', label: 'Settlement lines', type: 'table', group: 'Settlement',
        columns: [text('label', 'Item'), money('amount', 'Amount')],
        sample: [
          { label: 'Gratuity', amount: '2,400.000' },
          { label: 'Leave encashment', amount: '380.000' },
        ],
      },
      { name: 'totalPayable', label: 'Total payable', type: 'money', group: 'Settlement', sample: '2,780.000' },
      { name: 'totalPayableInWords', label: 'Total in words', type: 'string', group: 'Settlement', sample: 'Two thousand seven hundred eighty Omani Rials' },
      { name: 'lastWorkingDay', label: 'Last working day', type: 'date', group: 'Settlement', sample: '31/08/2026' },
      { name: 'yearsOfService', label: 'Years of service', type: 'number', group: 'Settlement', sample: 5.4 },
    ],
  },
  {
    key: 'EOSB_STATEMENT',
    category: 'FINANCE',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'End-of-service benefit statement',
    description: 'Gratuity accrued to date for one employee.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PAY',
    serialized: false,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en'],
    variables: [
      ...COMPANY_VARS, ...DOCUMENT_VARS, ...EMPLOYEE_VARS, ...PAY_VARS, ...SIGNATORY_VARS,
      { name: 'accruedAmount', label: 'Accrued gratuity', type: 'money', group: 'Gratuity', sample: '2,400.000' },
      { name: 'yearsOfService', label: 'Years of service', type: 'number', group: 'Gratuity', sample: 5.4 },
    ],
  },
  {
    key: 'GRATUITY_LIABILITY',
    category: 'FINANCE',
    cardinality: 'single',
    subjectType: 'PERIOD',
    name: 'Gratuity liability report',
    description: 'Total accrued end-of-service liability across the workforce.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'PAY',
    serialized: false,
    vaultDocumentType: null,
    defaultLocales: ['en'],
    variables: reportVars('rows', 'Liability rows', [
      text('employeeName', 'Employee'),
      { name: 'yearsOfService', label: 'Years', type: 'number' },
      money('accrued', 'Accrued'),
    ], { employeeName: 'Ahmed Al-Balushi', yearsOfService: 5.4, accrued: '2,400.000' },
      [{ name: 'totalLiability', label: 'Total liability', type: 'money', group: 'Report', sample: '48,200.000' }]),
  },

  // ── Time and leave ───────────────────────────────────────────────────────
  {
    key: 'ATTENDANCE_REPORT',
    category: 'TIME',
    cardinality: 'single',
    subjectType: 'PERIOD',
    name: 'Attendance report',
    description: 'Presence, lateness and absence for a period.',
    allowedRoles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
    selfService: false,
    sensitivity: 'INTERNAL',
    serialized: false,
    vaultDocumentType: null,
    defaultLocales: ['en'],
    variables: reportVars('rows', 'Attendance rows', [
      text('employeeName', 'Employee'),
      { name: 'present', label: 'Present', type: 'number' },
      { name: 'absent', label: 'Absent', type: 'number' },
      { name: 'late', label: 'Late', type: 'number' },
    ], { employeeName: 'Ahmed Al-Balushi', present: 21, absent: 1, late: 2 }),
  },
  {
    key: 'OVERTIME_REPORT',
    category: 'TIME',
    cardinality: 'single',
    subjectType: 'PERIOD',
    name: 'Overtime report',
    description: 'Approved overtime hours and value for a period.',
    allowedRoles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
    selfService: false,
    sensitivity: 'PAY',
    serialized: false,
    vaultDocumentType: null,
    defaultLocales: ['en'],
    variables: reportVars('rows', 'Overtime rows', [
      text('employeeName', 'Employee'),
      { name: 'hours', label: 'Hours', type: 'number' },
      money('amount', 'Amount'),
    ], { employeeName: 'Ahmed Al-Balushi', hours: 12.5, amount: '78.125' }),
  },
  {
    key: 'LEAVE_BALANCE_STATEMENT',
    category: 'LEAVE',
    cardinality: 'bulk',
    subjectType: 'EMPLOYEE',
    name: 'Leave balance statement',
    description: 'Entitlement, taken and remaining, per leave type.',
    allowedRoles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
    selfService: true,
    sensitivity: 'PERSONAL',
    serialized: false,
    vaultDocumentType: null,
    defaultLocales: ['en'],
    variables: [
      ...COMPANY_VARS, ...DOCUMENT_VARS, ...EMPLOYEE_VARS, ...SIGNATORY_VARS,
      {
        name: 'rows', label: 'Balance rows', type: 'table', group: 'Leave',
        columns: [
          text('leaveType', 'Leave type'),
          { name: 'entitled', label: 'Entitled', type: 'number' },
          { name: 'taken', label: 'Taken', type: 'number' },
          { name: 'remaining', label: 'Remaining', type: 'number' },
        ],
        sample: [{ leaveType: 'Annual', entitled: 30, taken: 12, remaining: 18 }],
      },
      { name: 'asOfDate', label: 'As of date', type: 'date', group: 'Leave', sample: '03/09/2026' },
    ],
  },

  // ── Assets ───────────────────────────────────────────────────────────────
  {
    key: 'ASSET_CLEARANCE',
    category: 'ASSET',
    cardinality: 'single',
    subjectType: 'EMPLOYEE',
    name: 'Asset clearance',
    description: 'Company property still held by a leaver, for sign-off.',
    allowedRoles: ['ADMIN', 'HR_MANAGER'],
    selfService: false,
    sensitivity: 'INTERNAL',
    serialized: false,
    vaultDocumentType: 'Letter',
    defaultLocales: ['en'],
    variables: [
      ...COMPANY_VARS, ...DOCUMENT_VARS, ...EMPLOYEE_VARS, ...SIGNATORY_VARS,
      {
        name: 'rows', label: 'Asset rows', type: 'table', group: 'Assets',
        columns: [text('assetTag', 'Tag'), text('name', 'Asset'), text('status', 'Status')],
        sample: [{ assetTag: 'LAP-0042', name: 'Dell Latitude 5540', status: 'Outstanding' }],
      },
      { name: 'outstandingCount', label: 'Items outstanding', type: 'number', group: 'Assets', sample: 1 },
    ],
  },
];

const BY_KEY = new Map(DOCUMENT_TYPES.map((t) => [t.key, t]));

export function getDocumentType(key: string): DocumentTypeDef | undefined {
  return BY_KEY.get(key);
}

/**
 * The catalogue as one role may see it.
 *
 * Filtered rather than merely disabled: a MANAGER should not learn that
 * PAYROLL_REGISTER exists. Self-service types stay visible to EMPLOYEE even
 * though `allowedRoles` gates who may generate for OTHERS.
 */
export function documentTypesForRole(role: string): DocumentTypeDef[] {
  return DOCUMENT_TYPES.filter((t) => {
    if (t.allowedRoles.includes(role)) return true;
    return t.selfService && role === 'EMPLOYEE';
  });
}

/**
 * Whether this role may read a document of this sensitivity for SOMEBODY ELSE.
 *
 * The MANAGER refusal on PAY is the rule letters already enforce: a manager
 * has no business reading a subordinate's salary certificate, and a document
 * engine must not become the way around that.
 */
export function roleMaySeeSensitivity(
  role: string,
  sensitivity: DocumentSensitivity,
): boolean {
  if (role === 'ADMIN' || role === 'HR_MANAGER') return true;
  if (role === 'MANAGER') return sensitivity === 'INTERNAL' || sensitivity === 'PERSONAL';
  return false;
}

/** A sample context for a type, used by preview-with-sample-data. */
export function sampleContext(type: DocumentTypeDef): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const v of type.variables) {
    // Dotted names describe nested objects ('signatory.hr.name'), so they have
    // to be built as such — Handlebars resolves {{a.b}} by walking, not by
    // looking up a key that literally contains a dot.
    const parts = v.name.split('.');
    let cursor = ctx;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor[parts[i]] ??= {};
      cursor = cursor[parts[i]] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = v.sample;
  }
  return ctx;
}
