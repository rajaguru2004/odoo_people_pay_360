/**
 * The shared contract for a config-driven form field.
 *
 * Generalized from `src/bank-details/banking-fields.util.ts`, which proved the
 * pattern for banking: the set of fields, their order, requiredness and
 * validation are DATA (CountryBankingField rows); the code only knows HOW to
 * run each named validation type. The Employee Profile Template reuses that
 * split, so this module is deliberately free of Nest, Prisma and of any
 * knowledge of WHICH fields exist.
 *
 * `BankingFieldDef` is a structural subset of `FieldDef` — a banking row
 * satisfies this interface unchanged, which is what lets the banking util
 * become a thin adapter without touching its green specs.
 */

/** How a value is rendered and coerced. */
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
  // An ISO 3166-1 alpha-2 country, rendered as a picker with its dial code.
  // Distinct from SELECT so the ~240 options stay in the client rather than
  // being shipped on every template resolve, and so the "+968" preview the
  // hand-written form had is not lost.
  'PHONE_COUNTRY',
  'FILE',
  // Option sets sourced from live rows rather than static `options`.
  'LIBRARY_SELECT',
  'DEPARTMENT_SELECT',
  'BRANCH_SELECT',
  'EMPLOYEE_SELECT',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * How a value is checked. The first eight are the banking set, kept verbatim so
 * CountryBankingField rows remain valid without a data migration.
 */
export const VALIDATION_TYPES = [
  'NONE',
  'IBAN',
  'IFSC',
  'SWIFT',
  'SORT_CODE',
  'ROUTING',
  'NUMBER',
  'REGEX',
  // Added for employee profile fields.
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

/** A selectable choice for SELECT/MULTISELECT fields with static options. */
export interface FieldOption {
  value: string;
  label: string;
}

/**
 * One configured field. Every property except `fieldKey` is admin-editable;
 * `fieldKey` is immutable because stored values are keyed by it.
 */
export interface FieldDef {
  fieldKey: string;
  label: string;
  fieldType: FieldType | string;
  validationType: ValidationType | string;
  regex?: string | null;
  /** Static choices; ignored when `optionSource` is set. */
  options?: unknown;
  /** Live option source: a LibraryType name, or DEPARTMENT | BRANCH | EMPLOYEE. */
  optionSource?: string | null;
  required: boolean;
  displayOrder: number;
  placeholder?: string | null;
  helpText?: string | null;
  isSensitive: boolean;
  /** Bounds for RANGE (numeric) — decimal-safe, so strings are accepted. */
  minValue?: number | string | null;
  maxValue?: number | string | null;
  /** Bounds for LENGTH (string). */
  minLength?: number | null;
  maxLength?: number | null;
}
