/**
 * Employee Profile Template — the single frontend definition.
 *
 * Types in this repo are hand-mirrored from the backend and have drifted before
 * (there were two different employee zod schemas). Everything template-shaped
 * lives here and is imported by the renderer, the builder and the services, so
 * there is exactly one place to keep in step with
 * `apps/backend/src/profile-templates/profile-template.types.ts`.
 */

export const FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DECIMAL',
  'CURRENCY',
  'DATE',
  'DATETIME',
  'SELECT',
  'MULTISELECT',
  'BOOLEAN',
  'EMAIL',
  'PHONE',
  // ISO 3166-1 alpha-2 picker. Its own type, not a SELECT: the ~240 options are
  // a client constant rather than template payload, and it shows the dial code.
  'PHONE_COUNTRY',
  'FILE',
  'LIBRARY_SELECT',
  'DEPARTMENT_SELECT',
  'BRANCH_SELECT',
  'EMPLOYEE_SELECT',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const VALIDATION_TYPES = [
  'NONE',
  'IBAN',
  'IFSC',
  'SWIFT',
  'SORT_CODE',
  'ROUTING',
  'NUMBER',
  'REGEX',
  'EMAIL',
  'PHONE',
  'URL',
  'DATE',
  'DATE_PAST',
  'DATE_FUTURE',
  'RANGE',
  'LENGTH',
  'ONE_OF',
  'LIBRARY_ITEM',
] as const;
export type ValidationType = (typeof VALIDATION_TYPES)[number];

export type TemplateSource = 'BRANCH_OVERRIDE' | 'COMPANY' | 'LEGACY_BASELINE';
export type TemplateMode = 'CREATE' | 'EDIT' | 'SELF';
export type TemplateScope = 'COMPANY' | 'BRANCH' | 'NONE';

export interface FieldOption {
  value: string;
  label: string;
}

export interface TemplateField {
  id: string | null;
  sectionKey: string;
  fieldKey: string;
  label: string;
  fieldType: FieldType | string;
  /** COLUMN => a real employee column; JSONB => lives under `customFields`. */
  storage: 'COLUMN' | 'JSONB';
  boundColumn: string | null;
  validationType: ValidationType | string;
  regex?: string | null;
  options?: FieldOption[] | null;
  /** LibraryType name, or DEPARTMENT | BRANCH | EMPLOYEE. */
  optionSource?: string | null;
  required: boolean;
  displayOrder: number;
  placeholder?: string | null;
  helpText?: string | null;
  defaultValue?: string | null;
  colSpan: number;
  isSensitive: boolean;
  minValue?: number | null;
  maxValue?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  visibleToRoles: string[];
  editableByRoles: string[];
  selfVisible: boolean;
  selfEditable: boolean;
  includeInCompletion: boolean;
  isActive: boolean;
  systemDeprecated: boolean;
  origin: 'SYSTEM' | 'CUSTOM';
  /** From the backend's bound-column registry: cannot be hidden. */
  locked: boolean;
  /** Cannot be made optional — the column is NOT NULL with no default. */
  systemRequired: boolean;
  lockReason?: string | null;
}

export interface TemplateSection {
  id: string | null;
  sectionKey: string;
  label: string;
  icon: string | null;
  /** Groups sections into steps of the create wizard. */
  wizardStep: number;
  columns: number;
  displayOrder: number;
  fields: TemplateField[];
}

export interface ResolvedTemplate {
  templateId: string | null;
  source: TemplateSource;
  scope: TemplateScope;
  branchId: string | null;
  country: string | null;
  name: string;
  fields: TemplateField[];
  sections: TemplateSection[];
  /**
   * The kill switch. False means the caller must keep whatever it did before
   * templates existed — the payload is still a usable baseline for rendering.
   */
  enabled: boolean;
}

/** Admin view: a template row with its (possibly inactive) sections and fields. */
export interface TemplateSummary {
  id: string;
  scope: 'COMPANY' | 'BRANCH';
  branchId: string | null;
  country: string | null;
  name: string;
  isActive: boolean;
  branch?: { id: string; code: string; name: string; country?: string | null } | null;
  _count?: { fields: number; sections: number };
}

export interface TemplateDetail extends TemplateSummary {
  sections: (TemplateSection & {
    isActive: boolean;
    origin: 'SYSTEM' | 'CUSTOM';
    isCustomized: boolean;
    visibleToRoles: string[];
  })[];
}

export interface CountryPreset {
  country: string;
  name: string;
  sectionCount: number;
  fieldCount: number;
  extraFieldCount: number;
}

/** A field's value in the form model. Bound fields sit at the top level. */
export type TemplateFormValues = Record<string, unknown> & {
  customFields?: Record<string, unknown>;
};

/** RHF field name for a template field: JSONB fields are nested. */
export function fieldName(field: Pick<TemplateField, 'fieldKey' | 'storage'>): string {
  return field.storage === 'JSONB'
    ? `customFields.${field.fieldKey}`
    : field.fieldKey;
}
