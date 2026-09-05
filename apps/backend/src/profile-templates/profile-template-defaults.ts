/**
 * The Employee Profile Templates every environment ships with, and the seeder
 * that reconciles a live template against them.
 *
 * Deliberately free of Nest and of PrismaService so it can be called from two
 * places that have nothing else in common:
 *
 *   - `ProfileTemplateService.onModuleInit()` — self-heals a running app;
 *   - `prisma/seed.ts` — a bare ts-node script with a raw PrismaClient and no
 *     DI container.
 *
 * `PrismaService extends PrismaClient`, so both callers satisfy the `db` param.
 * Same contract as `src/library-items/library-defaults.ts`.
 *
 * ── How a shipped update avoids clobbering a customer's edits ───────────────
 *
 * Every field row carries `origin`, `systemRevision` and `isCustomized`, and the
 * seeder is create-only plus a narrowly-guarded update:
 *
 *   - the upsert's `update` is EMPTY, so a boot can never overwrite an edit;
 *   - a separate updateMany applies a newer `systemRevision` ONLY where
 *     `isCustomized = false`, which is how a corrected regex or a better help
 *     text reaches customers who never touched that field;
 *   - a field we stop shipping is flagged `systemDeprecated`, never deleted,
 *     because employees already hold values under its key;
 *   - an admin "deleting" a system field sets `isActive=false` AND
 *     `isCustomized=true` — the row survives, so the create-only upsert cannot
 *     resurrect it on the next boot. That last rule is the non-obvious one.
 *
 * Bump `systemRevision` on a field whenever you change what it ships as.
 */
import {
  EMPLOYEE_BOUND_COLUMNS,
  BOUND_BY_KEY,
  BoundColumn,
} from './employee-bound-columns';
import { FieldType } from '../common/dynamic-fields/field-def';

/** Minimal structural subset of PrismaClient this module needs. */
export interface TemplateSeedDb {
  profileTemplate: {
    findFirst(args: any): Promise<any>;
    create(args: any): Promise<any>;
  };
  profileTemplateSection: {
    upsert(args: any): Promise<any>;
    updateMany(args: any): Promise<any>;
    findMany(args: any): Promise<any[]>;
  };
  profileTemplateField: {
    upsert(args: any): Promise<any>;
    updateMany(args: any): Promise<any>;
  };
}

export interface SectionPreset {
  sectionKey: string;
  label: string;
  icon?: string;
  wizardStep: number;
  displayOrder: number;
  columns?: number;
  /** Ships switched off; the admin can enable it. */
  isActive?: boolean;
  visibleToRoles?: string[];
}

export interface FieldPreset {
  fieldKey: string;
  sectionKey: string;
  label: string;
  displayOrder: number;
  /** Required only for CUSTOM (JSONB) fields — bound fields take it from the registry. */
  fieldType?: FieldType;
  validationType?: string;
  regex?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  optionSource?: string;
  placeholder?: string;
  helpText?: string;
  colSpan?: number;
  isSensitive?: boolean;
  isActive?: boolean;
  selfVisible?: boolean;
  selfEditable?: boolean;
  visibleToRoles?: string[];
  editableByRoles?: string[];
  includeInCompletion?: boolean;
  /** Bump when this field's shipped definition changes. */
  systemRevision?: number;
}

export interface TemplateDefinition {
  country: string | null;
  name: string;
  sections: SectionPreset[];
  fields: FieldPreset[];
}

// ── Option sets ─────────────────────────────────────────────────────────────
// Values match what the frontend already persists (types/employee-profile.ts),
// so switching a field to template-driven does not rewrite stored data.
const opt = (...vals: [string, string][]) =>
  vals.map(([value, label]) => ({ value, label }));

const GENDER_OPTIONS = opt(
  ['MALE', 'Male'],
  ['FEMALE', 'Female'],
  ['OTHER', 'Other'],
);
const STATUS_OPTIONS = opt(
  ['ACTIVE', 'Active'],
  ['INACTIVE', 'Inactive'],
  ['ON_LEAVE', 'On Leave'],
  ['TERMINATED', 'Terminated'],
);
const SALARY_TYPE_OPTIONS = opt(
  ['MONTHLY', 'Monthly'],
  ['DAILY', 'Daily (per day worked)'],
);
const MARITAL_OPTIONS = opt(
  ['SINGLE', 'Single'],
  ['MARRIED', 'Married'],
  ['DIVORCED', 'Divorced'],
  ['WIDOWED', 'Widowed'],
);
const EDUCATION_OPTIONS = opt(
  ['HIGH_SCHOOL', 'High School'],
  ['ASSOCIATE', 'Associate'],
  ['BACHELOR', 'Bachelor'],
  ['MASTER', 'Master'],
  ['DOCTORATE', 'Doctorate'],
);
const RELATIONSHIP_OPTIONS = opt(
  ['Spouse', 'Spouse'],
  ['Parent', 'Parent'],
  ['Child', 'Child'],
  ['Sibling', 'Sibling'],
  ['Other', 'Other'],
);
const DATE_FORMAT_OPTIONS = opt(
  ['DD/MM/YYYY', 'DD/MM/YYYY'],
  ['MM/DD/YYYY', 'MM/DD/YYYY'],
  ['YYYY-MM-DD', 'YYYY-MM-DD'],
);

// ── The baseline: today's hardcoded employee form, expressed as data ─────────
// Sections mirror the existing create wizard's steps and the SECTION_FIELDS map
// in the profile form, so turning the kill-switch on renders a SUPERSET of the
// form that shipped before this feature — never a different one.

export const BASELINE_SECTIONS: SectionPreset[] = [
  { sectionKey: 'personal', label: 'Personal Information', icon: 'User', wizardStep: 1, displayOrder: 10 },
  { sectionKey: 'personal_extended', label: 'Personal Details', icon: 'IdCard', wizardStep: 1, displayOrder: 20 },
  { sectionKey: 'addresses', label: 'Addresses', icon: 'MapPin', wizardStep: 1, displayOrder: 30 },
  { sectionKey: 'government_ids', label: 'Government IDs', icon: 'FileBadge', wizardStep: 1, displayOrder: 40 },
  { sectionKey: 'emergency_contact', label: 'Emergency Contact', icon: 'Phone', wizardStep: 1, displayOrder: 50 },
  { sectionKey: 'employment', label: 'Employment', icon: 'Briefcase', wizardStep: 2, displayOrder: 10 },
  { sectionKey: 'compensation', label: 'Compensation', icon: 'Banknote', wizardStep: 2, displayOrder: 20 },
  { sectionKey: 'preferences', label: 'Preferences', icon: 'Settings', wizardStep: 2, displayOrder: 30 },
  { sectionKey: 'education', label: 'Education', icon: 'GraduationCap', wizardStep: 3, displayOrder: 10 },
  { sectionKey: 'insurance_tax', label: 'Insurance & Tax', icon: 'ShieldCheck', wizardStep: 3, displayOrder: 20 },
  // Superseded by the versioned, country-aware EmployeeBankDetail + its own
  // payment-information UI. Shipped OFF so the two do not disagree; the columns
  // and any historic values are untouched and an admin can switch it back on.
  { sectionKey: 'bank_legacy', label: 'Bank (legacy)', icon: 'Landmark', wizardStep: 3, displayOrder: 30, isActive: false },
];

export const BASELINE_FIELDS: FieldPreset[] = [
  // personal
  { fieldKey: 'fullName', sectionKey: 'personal', label: 'Full Name', displayOrder: 10, required: true, includeInCompletion: true },
  { fieldKey: 'email', sectionKey: 'personal', label: 'Email', displayOrder: 20, required: true, validationType: 'EMAIL', includeInCompletion: true },
  { fieldKey: 'phone', sectionKey: 'personal', label: 'Phone', displayOrder: 30, validationType: 'PHONE', selfEditable: true, includeInCompletion: true },
  // 35, not a renumber of what follows: the boot seeder pushes shipped revisions
  // onto uncustomised rows, so shifting existing displayOrders would rewrite
  // live installs for cosmetics. selfEditable matches `phone` — a number an
  // employee may change is useless if they cannot correct its country.
  { fieldKey: 'phoneCountryCode', sectionKey: 'personal', label: 'Phone Country', displayOrder: 35, selfEditable: true },
  { fieldKey: 'dateOfBirth', sectionKey: 'personal', label: 'Date of Birth', displayOrder: 40, required: true, validationType: 'DATE_PAST', selfEditable: true, includeInCompletion: true },
  { fieldKey: 'gender', sectionKey: 'personal', label: 'Gender', displayOrder: 50, options: GENDER_OPTIONS, includeInCompletion: true },
  { fieldKey: 'idCard', sectionKey: 'personal', label: 'ID Card Number', displayOrder: 60, required: true, isSensitive: true, includeInCompletion: true },
  { fieldKey: 'address', sectionKey: 'personal', label: 'Address', displayOrder: 70, colSpan: 2, selfEditable: true, includeInCompletion: true },
  { fieldKey: 'avatarUrl', sectionKey: 'personal', label: 'Photo', displayOrder: 80 },

  // personal_extended
  { fieldKey: 'placeOfBirth', sectionKey: 'personal_extended', label: 'Place of Birth', displayOrder: 10, includeInCompletion: true },
  { fieldKey: 'nationality', sectionKey: 'personal_extended', label: 'Nationality', displayOrder: 20, includeInCompletion: true },
  // Sit beside the free-text nationality they qualify. Deliberately NOT counted
  // toward profile completion: an employee whose class nobody has recorded is a
  // gap end-of-service reports on by name, and folding it into a completion
  // percentage would bury it.
  { fieldKey: 'nationalityCode', sectionKey: 'personal_extended', label: 'Nationality (ISO code)', displayOrder: 21, includeInCompletion: false },
  { fieldKey: 'nationalityClass', sectionKey: 'personal_extended', label: 'Nationality class (for end-of-service)', displayOrder: 22, includeInCompletion: false },
  { fieldKey: 'ethnicity', sectionKey: 'personal_extended', label: 'Ethnicity', displayOrder: 30 },
  { fieldKey: 'religion', sectionKey: 'personal_extended', label: 'Religion', displayOrder: 40 },
  { fieldKey: 'maritalStatus', sectionKey: 'personal_extended', label: 'Marital Status', displayOrder: 50, options: MARITAL_OPTIONS, includeInCompletion: true },
  { fieldKey: 'numberOfChildren', sectionKey: 'personal_extended', label: 'Number of Children', displayOrder: 60 },

  // addresses
  { fieldKey: 'permanentAddress', sectionKey: 'addresses', label: 'Permanent Address', displayOrder: 10, colSpan: 2 },
  { fieldKey: 'temporaryAddress', sectionKey: 'addresses', label: 'Current Address', displayOrder: 20, colSpan: 2 },

  // government_ids
  { fieldKey: 'passportNumber', sectionKey: 'government_ids', label: 'Passport Number', displayOrder: 10, isSensitive: true },
  { fieldKey: 'passportExpiry', sectionKey: 'government_ids', label: 'Passport Expiry', displayOrder: 20, validationType: 'DATE' },

  // emergency_contact
  { fieldKey: 'emergencyContactName', sectionKey: 'emergency_contact', label: 'Contact Name', displayOrder: 10, selfEditable: true, includeInCompletion: true },
  { fieldKey: 'emergencyContactRelationship', sectionKey: 'emergency_contact', label: 'Relationship', displayOrder: 20, options: RELATIONSHIP_OPTIONS, selfEditable: true, includeInCompletion: true },
  { fieldKey: 'emergencyContactPhone', sectionKey: 'emergency_contact', label: 'Contact Phone', displayOrder: 30, validationType: 'PHONE', selfEditable: true, includeInCompletion: true },
  { fieldKey: 'emergencyContactAddress', sectionKey: 'emergency_contact', label: 'Contact Address', displayOrder: 40, colSpan: 2, selfEditable: true },

  // employment
  { fieldKey: 'employeeCode', sectionKey: 'employment', label: 'Employee Code', displayOrder: 10, required: true },
  { fieldKey: 'departmentId', sectionKey: 'employment', label: 'Department', displayOrder: 20, required: true },
  { fieldKey: 'branchId', sectionKey: 'employment', label: 'Branch', displayOrder: 30, required: true },
  { fieldKey: 'position', sectionKey: 'employment', label: 'Position', displayOrder: 40, required: true, optionSource: 'POSITION' },
  { fieldKey: 'employmentType', sectionKey: 'employment', label: 'Employment Type', displayOrder: 50, optionSource: 'EMPLOYMENT_TYPE', helpText: 'Determines the pay basis and the overtime policy tier.' },
  { fieldKey: 'startDate', sectionKey: 'employment', label: 'Start Date', displayOrder: 60, required: true, validationType: 'DATE' },
  { fieldKey: 'endDate', sectionKey: 'employment', label: 'End Date', displayOrder: 70, validationType: 'DATE' },
  { fieldKey: 'status', sectionKey: 'employment', label: 'Status', displayOrder: 80, options: STATUS_OPTIONS },
  { fieldKey: 'supervisorId', sectionKey: 'employment', label: 'Supervisor', displayOrder: 90 },

  // compensation — visible to the roles that already see salary in the list API
  // systemRevision 2: the help text used to describe this as the salary, full
  // stop, which is what let people believe there was nowhere to put HRA or DA.
  // Bumped so existing, uncustomized templates pick the correction up on boot.
  { fieldKey: 'baseSalary', sectionKey: 'compensation', label: 'Base Salary', displayOrder: 10, required: true, systemRevision: 2, visibleToRoles: ['ADMIN', 'HR_MANAGER'], editableByRoles: ['ADMIN', 'HR_MANAGER'], selfVisible: false, helpText: 'The BASIC part of the pay — a monthly amount for MONTHLY staff, a per-day rate for DAILY staff. HRA, DA and other allowances are added as salary components in the breakup below.' },
  { fieldKey: 'salaryType', sectionKey: 'compensation', label: 'Pay Basis', displayOrder: 20, options: SALARY_TYPE_OPTIONS, visibleToRoles: ['ADMIN', 'HR_MANAGER'], editableByRoles: ['ADMIN', 'HR_MANAGER'], selfVisible: false },
  { fieldKey: 'overtimePolicyId', sectionKey: 'compensation', label: 'Overtime Policy', displayOrder: 30, visibleToRoles: ['ADMIN', 'HR_MANAGER'], editableByRoles: ['ADMIN', 'HR_MANAGER'], selfVisible: false },

  // preferences
  { fieldKey: 'timezone', sectionKey: 'preferences', label: 'Timezone', displayOrder: 10, selfEditable: true, helpText: 'IANA timezone, e.g. Asia/Muscat. Empty inherits the company setting.' },
  { fieldKey: 'dateFormat', sectionKey: 'preferences', label: 'Date Format', displayOrder: 20, options: DATE_FORMAT_OPTIONS, selfEditable: true },
  { fieldKey: 'attendanceExternalId', sectionKey: 'preferences', label: 'Attendance Device ID', displayOrder: 30, visibleToRoles: ['ADMIN', 'HR_MANAGER'], selfVisible: false, helpText: 'Identity inside the branch attendance provider. Usually auto-matched on employee code.' },

  // education
  { fieldKey: 'highestEducation', sectionKey: 'education', label: 'Highest Education', displayOrder: 10, options: EDUCATION_OPTIONS, selfEditable: true, includeInCompletion: true },
  { fieldKey: 'major', sectionKey: 'education', label: 'Major', displayOrder: 20, selfEditable: true, includeInCompletion: true },
  { fieldKey: 'university', sectionKey: 'education', label: 'University', displayOrder: 30, selfEditable: true, includeInCompletion: true },
  { fieldKey: 'graduationYear', sectionKey: 'education', label: 'Graduation Year', displayOrder: 40, validationType: 'RANGE', selfEditable: true },
  { fieldKey: 'professionalCertificates', sectionKey: 'education', label: 'Professional Certificates', displayOrder: 50, colSpan: 2, selfEditable: true },

  // insurance_tax
  { fieldKey: 'taxCode', sectionKey: 'insurance_tax', label: 'Tax Code', displayOrder: 10, isSensitive: true },
  { fieldKey: 'socialInsuranceNumber', sectionKey: 'insurance_tax', label: 'Social Insurance Number', displayOrder: 20, isSensitive: true },
  { fieldKey: 'healthInsuranceNumber', sectionKey: 'insurance_tax', label: 'Health Insurance Number', displayOrder: 30, isSensitive: true },
  { fieldKey: 'dependents', sectionKey: 'insurance_tax', label: 'Dependents', displayOrder: 40 },

  // bank_legacy (section ships inactive)
  { fieldKey: 'bankName', sectionKey: 'bank_legacy', label: 'Bank Name', displayOrder: 10 },
  { fieldKey: 'bankAccountNumber', sectionKey: 'bank_legacy', label: 'Account Number', displayOrder: 20, isSensitive: true },
  { fieldKey: 'bankAccountHolderName', sectionKey: 'bank_legacy', label: 'Account Holder', displayOrder: 30 },
  { fieldKey: 'bankBranch', sectionKey: 'bank_legacy', label: 'Bank Branch', displayOrder: 40 },
];

// ── Country deltas ──────────────────────────────────────────────────────────
// Each preset is the baseline PLUS these. Every delta field is a CUSTOM (JSONB)
// field: onboarding a country must never require a schema change.

interface CountryDelta {
  name: string;
  sections?: SectionPreset[];
  fields: FieldPreset[];
}

const COUNTRY_DELTAS: Record<string, CountryDelta> = {
  OM: {
    name: 'Oman',
    fields: [
      { fieldKey: 'civilIdNumber', sectionKey: 'government_ids', label: 'Civil ID Number', displayOrder: 100, fieldType: 'TEXT', validationType: 'REGEX', regex: '^\\d{8}$', isSensitive: true, helpText: '8 digits, as printed on the Civil ID card.' },
      { fieldKey: 'civilIdExpiry', sectionKey: 'government_ids', label: 'Civil ID Expiry', displayOrder: 110, fieldType: 'DATE', validationType: 'DATE' },
      { fieldKey: 'gccNational', sectionKey: 'personal_extended', label: 'GCC National', displayOrder: 100, fieldType: 'BOOLEAN', helpText: 'GCC nationals are exempt from work-permit requirements.' },
      { fieldKey: 'pasiNumber', sectionKey: 'insurance_tax', label: 'PASI Number', displayOrder: 100, fieldType: 'TEXT', isSensitive: true, helpText: 'Public Authority for Social Insurance registration number.' },
      { fieldKey: 'labourCardNumber', sectionKey: 'government_ids', label: 'Labour Card Number', displayOrder: 120, fieldType: 'TEXT' },
    ],
  },
  IN: {
    name: 'India',
    fields: [
      { fieldKey: 'panNumber', sectionKey: 'insurance_tax', label: 'PAN', displayOrder: 100, fieldType: 'TEXT', validationType: 'REGEX', regex: '^[A-Z]{5}[0-9]{4}[A-Z]$', isSensitive: true, placeholder: 'ABCDE1234F' },
      { fieldKey: 'aadhaarNumber', sectionKey: 'government_ids', label: 'Aadhaar Number', displayOrder: 100, fieldType: 'TEXT', validationType: 'REGEX', regex: '^\\d{12}$', isSensitive: true, helpText: '12 digits.' },
      { fieldKey: 'uanNumber', sectionKey: 'insurance_tax', label: 'UAN', displayOrder: 110, fieldType: 'TEXT', validationType: 'REGEX', regex: '^\\d{12}$', isSensitive: true, helpText: 'Universal Account Number for EPF.' },
      { fieldKey: 'pfNumber', sectionKey: 'insurance_tax', label: 'PF Number', displayOrder: 120, fieldType: 'TEXT', isSensitive: true },
      { fieldKey: 'esicNumber', sectionKey: 'insurance_tax', label: 'ESIC Number', displayOrder: 130, fieldType: 'TEXT', validationType: 'REGEX', regex: '^\\d{10}$', isSensitive: true },
    ],
  },
  AE: {
    name: 'United Arab Emirates',
    fields: [
      { fieldKey: 'emiratesId', sectionKey: 'government_ids', label: 'Emirates ID', displayOrder: 100, fieldType: 'TEXT', validationType: 'REGEX', regex: '^784-\\d{4}-\\d{7}-\\d$', isSensitive: true, placeholder: '784-1234-1234567-1' },
      { fieldKey: 'emiratesIdExpiry', sectionKey: 'government_ids', label: 'Emirates ID Expiry', displayOrder: 110, fieldType: 'DATE', validationType: 'DATE' },
      { fieldKey: 'labourCardNumber', sectionKey: 'government_ids', label: 'Labour Card Number', displayOrder: 120, fieldType: 'TEXT' },
      { fieldKey: 'gccNational', sectionKey: 'personal_extended', label: 'GCC National', displayOrder: 100, fieldType: 'BOOLEAN' },
      { fieldKey: 'gpssaNumber', sectionKey: 'insurance_tax', label: 'GPSSA Number', displayOrder: 100, fieldType: 'TEXT', isSensitive: true, helpText: 'Applies to UAE/GCC nationals only.' },
    ],
  },
  SA: {
    name: 'Saudi Arabia',
    fields: [
      { fieldKey: 'iqamaNumber', sectionKey: 'government_ids', label: 'Iqama Number', displayOrder: 100, fieldType: 'TEXT', validationType: 'REGEX', regex: '^\\d{10}$', isSensitive: true, helpText: '10 digits.' },
      { fieldKey: 'iqamaExpiry', sectionKey: 'government_ids', label: 'Iqama Expiry', displayOrder: 110, fieldType: 'DATE', validationType: 'DATE' },
      { fieldKey: 'gosiNumber', sectionKey: 'insurance_tax', label: 'GOSI Number', displayOrder: 100, fieldType: 'TEXT', isSensitive: true },
      { fieldKey: 'saudiNational', sectionKey: 'personal_extended', label: 'Saudi National', displayOrder: 100, fieldType: 'BOOLEAN', helpText: 'Drives Saudization (Nitaqat) headcount reporting.' },
    ],
  },
  GB: {
    name: 'United Kingdom',
    fields: [
      { fieldKey: 'nationalInsuranceNumber', sectionKey: 'insurance_tax', label: 'National Insurance Number', displayOrder: 100, fieldType: 'TEXT', validationType: 'REGEX', regex: '^[A-Z]{2}\\d{6}[A-D]$', isSensitive: true, placeholder: 'QQ123456C' },
      { fieldKey: 'rightToWorkChecked', sectionKey: 'government_ids', label: 'Right to Work Verified', displayOrder: 100, fieldType: 'BOOLEAN' },
    ],
  },
  US: {
    name: 'United States',
    fields: [
      { fieldKey: 'ssn', sectionKey: 'insurance_tax', label: 'Social Security Number', displayOrder: 100, fieldType: 'TEXT', validationType: 'REGEX', regex: '^\\d{3}-?\\d{2}-?\\d{4}$', isSensitive: true, placeholder: '123-45-6789' },
      { fieldKey: 'i9Verified', sectionKey: 'government_ids', label: 'I-9 Verified', displayOrder: 100, fieldType: 'BOOLEAN' },
    ],
  },
};

/** ISO-2 codes that ship with a preset. */
export const PRESET_COUNTRIES = Object.keys(COUNTRY_DELTAS);

/** Country presets for the adopt screen: `{ country, name, fieldCount }`. */
export function listPresets() {
  return PRESET_COUNTRIES.map((country) => {
    const def = buildTemplateDefinition(country);
    return {
      country,
      name: def.name,
      sectionCount: def.sections.length,
      fieldCount: def.fields.length,
      extraFieldCount: COUNTRY_DELTAS[country].fields.length,
    };
  });
}

/**
 * The full definition for a country, or the bare baseline when the country is
 * unknown. An unrecognised country is NOT an error: a deployment in a country
 * we have not modelled yet still needs a working employee form.
 */
export function buildTemplateDefinition(
  country?: string | null,
): TemplateDefinition {
  const code = (country ?? '').trim().toUpperCase();
  const delta = COUNTRY_DELTAS[code];

  if (!delta) {
    return {
      country: code || null,
      name: 'Employee Profile',
      sections: BASELINE_SECTIONS,
      fields: BASELINE_FIELDS,
    };
  }

  return {
    country: code,
    name: `Employee Profile — ${delta.name}`,
    sections: [...BASELINE_SECTIONS, ...(delta.sections ?? [])],
    fields: [...BASELINE_FIELDS, ...delta.fields],
  };
}

/** Resolve a preset's storage + type from the bound-column registry. */
function resolveStorage(preset: FieldPreset): {
  storage: 'COLUMN' | 'JSONB';
  boundColumn: string | null;
  fieldType: string;
  optionSource: string | null;
  bound?: BoundColumn;
} {
  const bound = BOUND_BY_KEY.get(preset.fieldKey);
  if (bound) {
    return {
      storage: 'COLUMN',
      // The registry holds the Prisma field name; the split routes on it.
      boundColumn: `${bound.table}.${bound.column}`,
      // Inherent to the column — a preset may not override it.
      fieldType: bound.type,
      optionSource: preset.optionSource ?? bound.optionSource ?? null,
      bound,
    };
  }
  return {
    storage: 'JSONB',
    boundColumn: null,
    fieldType: preset.fieldType ?? 'TEXT',
    optionSource: preset.optionSource ?? null,
  };
}

/** The props a newer systemRevision is allowed to push onto an untouched row. */
function mergeableProps(preset: FieldPreset, sectionId: string) {
  const s = resolveStorage(preset);
  return {
    sectionId,
    label: preset.label,
    fieldType: s.fieldType,
    storage: s.storage,
    boundColumn: s.boundColumn,
    validationType: preset.validationType ?? 'NONE',
    regex: preset.regex ?? null,
    required: presetRequired(preset, s.bound),
    options: (preset.options ?? null) as any,
    optionSource: s.optionSource,
    placeholder: preset.placeholder ?? null,
    helpText: preset.helpText ?? null,
    colSpan: preset.colSpan ?? 1,
    displayOrder: preset.displayOrder,
    isSensitive: preset.isSensitive ?? false,
    selfVisible: preset.selfVisible ?? true,
    selfEditable: preset.selfEditable ?? false,
    visibleToRoles: preset.visibleToRoles ?? [],
    editableByRoles: preset.editableByRoles ?? [],
    includeInCompletion: preset.includeInCompletion ?? false,
  };
}

/**
 * A preset may ask for a field to be optional, but a NOT-NULL column with no DB
 * default cannot be — so the registry's floor always wins.
 */
function presetRequired(preset: FieldPreset, bound?: BoundColumn): boolean {
  if (bound?.systemRequired) return true;
  return preset.required ?? false;
}

export interface SeedResult {
  templateId: string;
  sectionsSeeded: number;
  fieldsSeeded: number;
  deprecated: number;
}

/**
 * Reconcile one live template against its country preset. Idempotent, and safe
 * to run on every boot — see the contract at the top of this file.
 */
export async function seedProfileTemplate(
  db: TemplateSeedDb,
  template: { id: string; country: string | null },
): Promise<SeedResult> {
  const def = buildTemplateDefinition(template.country);

  // ── Sections ──────────────────────────────────────────────────────────────
  for (const s of def.sections) {
    await db.profileTemplateSection.upsert({
      where: {
        templateId_sectionKey: {
          templateId: template.id,
          sectionKey: s.sectionKey,
        },
      },
      // Empty on purpose: this runs on every boot, so writing `label` here would
      // undo an admin's rename every time the app restarts.
      update: {},
      create: {
        templateId: template.id,
        sectionKey: s.sectionKey,
        label: s.label,
        icon: s.icon ?? null,
        wizardStep: s.wizardStep,
        columns: s.columns ?? 2,
        displayOrder: s.displayOrder,
        isActive: s.isActive ?? true,
        visibleToRoles: s.visibleToRoles ?? [],
        origin: 'SYSTEM',
      },
    });
  }

  const sections: { id: string; sectionKey: string }[] =
    await db.profileTemplateSection.findMany({
      where: { templateId: template.id },
      select: { id: true, sectionKey: true },
    });
  const sectionIdByKey = new Map(sections.map((s) => [s.sectionKey, s.id]));

  // ── Fields ────────────────────────────────────────────────────────────────
  let fieldsSeeded = 0;
  for (const f of def.fields) {
    const sectionId = sectionIdByKey.get(f.sectionKey);
    // A preset field pointing at a section that does not exist would violate the
    // NOT NULL FK. The defaults spec catches this before it ever ships.
    if (!sectionId) continue;

    const revision = f.systemRevision ?? 1;
    const merged = mergeableProps(f, sectionId);

    await db.profileTemplateField.upsert({
      where: {
        templateId_fieldKey: { templateId: template.id, fieldKey: f.fieldKey },
      },
      update: {},
      create: {
        templateId: template.id,
        fieldKey: f.fieldKey,
        ...merged,
        isActive: f.isActive ?? true,
        origin: 'SYSTEM',
        systemRevision: revision,
        isCustomized: false,
        systemDeprecated: false,
      },
    });

    // The one place a boot may overwrite: a field the admin never touched, when
    // we have shipped a newer definition of it. This is how a corrected regex
    // reaches customers without a support ticket.
    await db.profileTemplateField.updateMany({
      where: {
        templateId: template.id,
        fieldKey: f.fieldKey,
        origin: 'SYSTEM',
        isCustomized: false,
        systemRevision: { lt: revision },
      },
      data: { ...merged, systemRevision: revision, systemDeprecated: false },
    });

    fieldsSeeded += 1;
  }

  // ── Fields we no longer ship ──────────────────────────────────────────────
  // Flagged, never deleted: employees already hold values under these keys, and
  // the admin may still want the field on the form.
  const shippedKeys = def.fields.map((f) => f.fieldKey);
  const deprecated = await db.profileTemplateField.updateMany({
    where: {
      templateId: template.id,
      origin: 'SYSTEM',
      fieldKey: { notIn: shippedKeys },
      systemDeprecated: false,
    },
    data: { systemDeprecated: true },
  });

  return {
    templateId: template.id,
    sectionsSeeded: def.sections.length,
    fieldsSeeded,
    deprecated: deprecated?.count ?? 0,
  };
}

/**
 * Ensure the single COMPANY template exists, then reconcile it. `country` is
 * only consulted when creating — an existing template keeps the country it was
 * adopted with, so changing the payroll country never silently reshapes a
 * customized form.
 */
export async function ensureCompanyTemplate(
  db: TemplateSeedDb,
  country?: string | null,
): Promise<SeedResult> {
  let template = await db.profileTemplate.findFirst({
    where: { scope: 'COMPANY', isActive: true },
    select: { id: true, country: true },
  });

  if (!template) {
    const def = buildTemplateDefinition(country);
    template = await db.profileTemplate.create({
      data: {
        scope: 'COMPANY',
        branchId: null,
        country: def.country,
        name: def.name,
        isActive: true,
      },
      select: { id: true, country: true },
    });
  }

  return seedProfileTemplate(db, template);
}

/** Every field key the baseline ships, for tests and the builder's "add" list. */
export const BASELINE_FIELD_KEYS = BASELINE_FIELDS.map((f) => f.fieldKey);

/** Bound registry entries the baseline does not place in any section. */
export function unplacedBoundKeys(): string[] {
  const placed = new Set(BASELINE_FIELD_KEYS);
  return EMPLOYEE_BOUND_COLUMNS.filter((c) => !placed.has(c.fieldKey)).map(
    (c) => c.fieldKey,
  );
}
