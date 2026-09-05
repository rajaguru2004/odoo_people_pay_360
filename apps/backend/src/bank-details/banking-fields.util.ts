/**
 * Config-driven banking-field validation. No banking field is hardcoded — the
 * set of fields, their order, requiredness and validation come entirely from
 * CountryBankingField rows.
 *
 * The engine that runs each named validation type now lives in
 * `src/common/dynamic-fields/`, shared with the Employee Profile Template. This
 * module is the banking-shaped adapter over it and keeps banking's own
 * semantics, which differ from the template's in one deliberate way: an unknown
 * key here is DROPPED (bank payloads have historically carried legacy keys),
 * whereas the employee template rejects it.
 */
import {
  FieldDef,
  FIELD_TYPES as ALL_FIELD_TYPES,
} from '../common/dynamic-fields/field-def';
import {
  normalizeDynamicValue,
  validateDynamicValue,
  validateDynamicData,
} from '../common/dynamic-fields/validate-dynamic-data';

export interface BankingFieldDef {
  fieldKey: string;
  label: string;
  fieldType: string; // TEXT | NUMBER | SELECT
  validationType: string; // NONE|IBAN|IFSC|SWIFT|SORT_CODE|ROUTING|NUMBER|REGEX
  regex?: string | null;
  options?: unknown;
  required: boolean;
  displayOrder: number;
  placeholder?: string | null;
  helpText?: string | null;
  isSensitive: boolean;
}

/**
 * The validation types a banking field may use. Intentionally the banking
 * SUBSET of the shared VALIDATION_TYPES: offering DATE_FUTURE or LIBRARY_ITEM in
 * the bank-config admin UI would be noise.
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
] as const;

export const FIELD_TYPES = ['TEXT', 'NUMBER', 'SELECT'] as const;

// Banking's field types must remain a subset of the shared list, or a banking
// row would describe a control the shared renderer cannot draw.
FIELD_TYPES.forEach((t) => {
  if (!(ALL_FIELD_TYPES as readonly string[]).includes(t)) {
    throw new Error(`Banking fieldType ${t} is not a known FieldType`);
  }
});

/**
 * Normalize a stored branch country to an ISO-2 code, or '' when not a usable
 * code (e.g. legacy free-text "Oman"). Callers treat '' as "country not set".
 */
export function normalizeCountry(raw?: string | null): string {
  const v = (raw ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : '';
}

/**
 * The banking countries allowed for a branch: its configured `bankingCountries`
 * (multi), or a single-element fallback to the branch location `country`, or [].
 */
export function branchAllowedCountries(branch?: {
  country?: string | null;
  bankingCountries?: string[] | null;
} | null): string[] {
  const multi = (branch?.bankingCountries ?? [])
    .map(normalizeCountry)
    .filter(Boolean);
  if (multi.length) return Array.from(new Set(multi));
  const single = normalizeCountry(branch?.country);
  return single ? [single] : [];
}

/** Normalize a raw value before validation/storage (per validation type). */
export function normalizeValue(validationType: string, raw: string): string {
  return normalizeDynamicValue(validationType, raw);
}

export interface BankingValidationResult {
  valid: boolean;
  errors: Record<string, string>;
  /** Normalized values for the configured fields only (unknown keys dropped). */
  normalized: Record<string, string>;
}

/** A banking row is structurally a FieldDef; this only satisfies the compiler. */
function toFieldDef(f: BankingFieldDef): FieldDef {
  return {
    fieldKey: f.fieldKey,
    label: f.label,
    // Banking rows describe storage as text; the shared coercion would turn a
    // NUMBER field into a JS number, but bank identifiers are strings whose
    // leading zeros matter (sort codes, routing numbers). Keep them TEXT.
    fieldType: 'TEXT',
    validationType: f.validationType,
    regex: f.regex,
    options: f.options,
    required: f.required,
    displayOrder: f.displayOrder,
    placeholder: f.placeholder,
    helpText: f.helpText,
    isSensitive: f.isSensitive,
  };
}

/**
 * Validate a submitted key→value map against a country's configured fields.
 * Drops keys not in the config, enforces required, runs each field's validator.
 *
 * `expectedBankCode` is the selected Bank's `bankCode`. When supplied, an IBAN
 * field additionally has its embedded bank identifier cross-checked against it —
 * a mathematically valid IBAN that points at a different (or non-existent) bank
 * still fails the payment, weeks later.
 */
export function validateBankingData(
  country: string,
  data: Record<string, unknown>,
  fields: BankingFieldDef[],
  expectedBankCode?: string | null,
): BankingValidationResult {
  const result = validateDynamicData(data, fields.map(toFieldDef), {
    country,
    expectedBankCode,
    unknownKeys: 'drop',
  });

  // Banking stores strings, and historically returned only the fields that both
  // passed and carried a value — a cleared optional field is absent here, not
  // present as null.
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(result.normalized)) {
    if (v === null || v === undefined || v === '') continue;
    normalized[k] = String(v);
  }

  return { valid: result.valid, errors: result.errors, normalized };
}

/** Mask sensitive field values (last 4 kept) for reads/audit/notifications. */
export function maskBankingData(
  data: Record<string, unknown> | null | undefined,
  fields: BankingFieldDef[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data) return out;
  const sensitive = new Map(fields.map((f) => [f.fieldKey, f.isSensitive]));
  for (const [k, v] of Object.entries(data)) {
    const s = v == null ? '' : String(v);
    if (sensitive.get(k) && s.length > 4) out[k] = '••••' + s.slice(-4);
    else if (sensitive.get(k)) out[k] = '••••';
    else out[k] = s;
  }
  return out;
}

/** Re-exported so bank code can validate one value without the map wrapper. */
export function validateSingleValue(
  field: BankingFieldDef,
  value: string,
  country: string,
  expectedBankCode?: string | null,
): string | null {
  return validateDynamicValue(toFieldDef(field), value, {
    country,
    expectedBankCode,
  });
}
