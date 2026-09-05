/**
 * Config-driven validation for any set of dynamic fields.
 *
 * Generalized from `src/bank-details/banking-fields.util.ts`, which shipped this
 * pattern for bank details: the module knows HOW to run each named validation
 * type; WHICH fields exist is data. The banking util now delegates here, so both
 * the employee profile template and the country banking schema run one engine.
 *
 * Two behaviours are preserved verbatim from the banking original because they
 * were deliberate:
 *
 *   - a broken configured regex never blocks the user (a bad pattern is an admin
 *     mistake; refusing every save would be worse than accepting the value);
 *   - IBAN and friends normalize before validating, so a pasted value with
 *     spaces is accepted rather than rejected on formatting.
 *
 * One behaviour deliberately differs, selected by `unknownKeys`:
 *
 *   - banking DROPS keys it does not recognise;
 *   - the employee template REJECTS them, because a typo'd custom field that
 *     silently vanishes after "Saved!" is worse than a 400.
 */
import { isSupportedCountry } from 'libphonenumber-js';
import { validateIban, normalizeIban } from '../../bank-details/iban.util';
import { FieldDef } from './field-def';

/**
 * ISO 3166-1 alpha-2, restricted to countries libphonenumber knows — the same
 * test `normalisePhoneRegion` applies on the bound-column path. Kept here rather
 * than imported from `whatsapp/utils` so this module stays free of feature-module
 * dependencies, which is the whole point of `common/dynamic-fields`.
 */
function isValidCountryCode(v: string): boolean {
  const up = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(up) && isSupportedCountry(up as any);
}

export interface DynamicValidationOptions {
  /** ISO-2, used by IBAN length/prefix rules. */
  country?: string;
  /** Cross-check an IBAN's embedded bank identifier. Banking only. */
  expectedBankCode?: string | null;
  /** What to do with a submitted key no field declares. */
  unknownKeys?: 'drop' | 'reject';
  /**
   * Only validate the keys actually present. Used by PATCH, where an absent key
   * means "leave it alone" rather than "clear it" — without this a partial
   * update would fail on every required field it did not send.
   */
  partial?: boolean;
  /** Prefix for error keys, e.g. 'customFields' -> 'customFields.grade'. */
  errorKeyPrefix?: string;
  /** Live option sets, keyed by `optionSource`. Absent source => not checked. */
  allowedOptions?: Record<string, Set<string>>;
}

export interface DynamicValidationResult {
  valid: boolean;
  /** Keyed by field key (with `errorKeyPrefix` applied when given). */
  errors: Record<string, string>;
  /** Coerced values for declared fields only. */
  normalized: Record<string, unknown>;
}

/**
 * Postgres cannot store U+0000 inside a jsonb string and rejects the whole
 * statement, so an unhandled NUL byte surfaces as a 500 from the driver rather
 * than as a validation error. It arrives from ordinary places — a paste out of
 * a hex editor, a badly-exported CSV, a fixed-width file padded with NULs — so
 * this is malformed user input, not an attack, and deserves a 400 like any
 * other.
 *
 * Written as an escape on purpose: a literal NUL in this source would make the
 * file binary, and grep would stop finding anything in it.
 */
const NUL_RE = /\u0000/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Deliberately permissive: E.164-ish with common separators. Country-accurate
// phone validation belongs in a per-country REGEX field, not here.
const PHONE_RE = /^\+?[\d\s().-]{6,20}$/;

/** Normalize a raw value before validation/storage (per validation type). */
export function normalizeDynamicValue(
  validationType: string,
  raw: string,
): string {
  const v = (raw ?? '').trim();
  switch (validationType) {
    case 'IBAN':
      return normalizeIban(v);
    case 'IFSC':
    case 'SWIFT':
      return v.replace(/\s+/g, '').toUpperCase();
    case 'SORT_CODE':
      return v.replace(/[\s-]/g, '');
    case 'EMAIL':
      return v.toLowerCase();
    default:
      return v;
  }
}

function asNumber(v: string): number | null {
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function parseDate(v: string): Date | null {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;

  // `new Date('2026-02-30')` does not throw — it rolls over to March 2. Left
  // alone, a typo'd passport expiry would be accepted as a different date and
  // then quietly drive a renewal reminder on the wrong day. Round-trip the
  // components to reject anything the calendar does not actually contain.
  const m = ISO_DATE_RE.exec(v.trim());
  if (m) {
    const [, y, mo, day] = m;
    if (
      d.getUTCFullYear() !== Number(y) ||
      d.getUTCMonth() + 1 !== Number(mo) ||
      d.getUTCDate() !== Number(day)
    ) {
      return null;
    }
  }
  return d;
}

/** Validate one value. Returns an error string, or null when valid. */
export function validateDynamicValue(
  field: FieldDef,
  value: string,
  opts: DynamicValidationOptions = {},
): string | null {
  if (!value) return null; // requiredness is the caller's job

  const country = (opts.country ?? '').toUpperCase();

  switch (field.validationType) {
    case 'IBAN': {
      const res = validateIban(value, country, opts.expectedBankCode);
      return res.valid ? null : (res.message ?? 'Invalid IBAN');
    }
    case 'IFSC':
      return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value)
        ? null
        : 'Invalid IFSC (expected e.g. HDFC0001234)';
    case 'SWIFT':
      return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value)
        ? null
        : 'Invalid SWIFT/BIC';
    case 'SORT_CODE':
      return /^\d{6}$/.test(value) ? null : 'Sort code must be 6 digits';
    case 'ROUTING':
      return /^\d{9}$/.test(value) ? null : 'Routing number must be 9 digits';
    case 'NUMBER':
      return /^\d+$/.test(value) ? null : 'Must be digits only';
    case 'REGEX': {
      if (!field.regex) return null;
      try {
        return new RegExp(field.regex).test(value) ? null : 'Invalid format';
      } catch {
        // A broken configured pattern never blocks the user.
        return null;
      }
    }
    case 'EMAIL':
      return EMAIL_RE.test(value) ? null : 'Invalid email address';
    case 'PHONE':
      return PHONE_RE.test(value) ? null : 'Invalid phone number';
    case 'URL':
      try {
        new URL(value);
        return null;
      } catch {
        return 'Invalid URL';
      }
    case 'DATE':
      return parseDate(value) ? null : 'Invalid date';
    case 'DATE_PAST': {
      const d = parseDate(value);
      if (!d) return 'Invalid date';
      return d.getTime() <= Date.now() ? null : 'Date must be in the past';
    }
    case 'DATE_FUTURE': {
      const d = parseDate(value);
      if (!d) return 'Invalid date';
      return d.getTime() >= Date.now() ? null : 'Date must be in the future';
    }
    case 'RANGE': {
      const n = asNumber(value);
      if (n === null) return 'Must be a number';
      const min = field.minValue == null ? null : Number(field.minValue);
      const max = field.maxValue == null ? null : Number(field.maxValue);
      if (min !== null && n < min) return `Must be at least ${min}`;
      if (max !== null && n > max) return `Must be at most ${max}`;
      return null;
    }
    case 'LENGTH': {
      const min = field.minLength ?? null;
      const max = field.maxLength ?? null;
      if (min !== null && value.length < min)
        return `Must be at least ${min} characters`;
      if (max !== null && value.length > max)
        return `Must be at most ${max} characters`;
      return null;
    }
    case 'ONE_OF':
      return optionValues(field).has(value)
        ? null
        : 'Not one of the allowed values';
    case 'LIBRARY_ITEM': {
      const src = field.optionSource;
      const allowed = src ? opts.allowedOptions?.[src] : undefined;
      // Unknown source => the caller could not supply the set, so do not guess.
      if (!allowed) return null;
      return allowed.has(value) ? null : 'Not an available option';
    }
    case 'NONE':
    default:
      return null;
  }
}

/** Static option values for a field, tolerant of the JSON shapes we accept. */
function optionValues(field: FieldDef): Set<string> {
  const raw = field.options;
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const o of raw) {
    if (typeof o === 'string') out.add(o);
    else if (o && typeof o === 'object' && 'value' in (o as any)) {
      out.add(String((o as any).value));
    }
  }
  return out;
}

/**
 * Coerce a submitted value to what the column or the JSON bag should hold.
 * Returns `undefined` when the value is unusable, which the caller reports as a
 * type error rather than silently storing a NaN.
 */
function coerce(field: FieldDef, raw: unknown): unknown {
  const type = field.fieldType;

  if (type === 'BOOLEAN') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toLowerCase();
    if (['true', '1', 'yes'].includes(s)) return true;
    if (['false', '0', 'no'].includes(s)) return false;
    return undefined;
  }

  if (['NUMBER', 'DECIMAL', 'CURRENCY'].includes(type as string)) {
    const n = typeof raw === 'number' ? raw : asNumber(String(raw).trim());
    return n === null ? undefined : n;
  }

  if (type === 'MULTISELECT') {
    if (!Array.isArray(raw)) return undefined;
    return raw.map((v) => String(v));
  }

  if (['DATE', 'DATETIME'].includes(type as string)) {
    const d = parseDate(String(raw));
    return d ? String(raw) : undefined;
  }

  if (type === 'PHONE_COUNTRY') {
    // Upper-cased here so 'om' and 'OM' are the same stored value, matching what
    // the bound-column path does via normalisePhoneRegion. Validity is checked
    // below, not here — coerce() reporting `undefined` would surface as a type
    // error rather than the specific "not a valid ISO country code" message.
    return String(raw).trim().toUpperCase();
  }

  return normalizeDynamicValue(field.validationType as string, String(raw));
}

/** A value that counts as "not provided" for requiredness. */
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Validate a submitted key -> value map against a set of configured fields.
 */
export function validateDynamicData(
  data: Record<string, unknown>,
  fields: readonly FieldDef[],
  opts: DynamicValidationOptions = {},
): DynamicValidationResult {
  const errors: Record<string, string> = {};
  const normalized: Record<string, unknown> = {};
  const prefix = opts.errorKeyPrefix ? `${opts.errorKeyPrefix}.` : '';
  const declared = new Set(fields.map((f) => f.fieldKey));
  const payload = data ?? {};

  if (opts.unknownKeys === 'reject') {
    for (const key of Object.keys(payload)) {
      if (!declared.has(key)) {
        errors[`${prefix}${key}`] =
          'Unknown field. It is not part of the current employee profile template.';
      }
    }
  }

  for (const f of fields) {
    const present = Object.prototype.hasOwnProperty.call(payload, f.fieldKey);
    // PATCH semantics: an absent key means "leave it alone", so it can neither
    // fail requiredness nor be written as undefined.
    if (opts.partial && !present) continue;

    const raw = present ? payload[f.fieldKey] : undefined;

    if (isBlank(raw)) {
      if (f.required) errors[`${prefix}${f.fieldKey}`] = `${f.label} is required`;
      // An explicit null is a deliberate clear; absent is a no-op.
      else if (present) normalized[f.fieldKey] = raw === undefined ? null : raw;
      continue;
    }

    const value = coerce(f, raw);
    if (value === undefined) {
      errors[`${prefix}${f.fieldKey}`] =
        `${f.label} must be a valid ${String(f.fieldType).toLowerCase()}`;
      continue;
    }

    // Checked before anything else touches the value: this one cannot reach
    // the database at all, so it has to fail here or fail as a 500.
    if (typeof value === 'string' && NUL_RE.test(value)) {
      errors[`${prefix}${f.fieldKey}`] =
        `${f.label} contains a NUL character, which cannot be stored. Remove it and try again.`;
      continue;
    }

    // A country picker means a real country, whatever validationType says. Same
    // predicate the bound-column path applies, so an admin who moves this field
    // between a real column and the JSON bag gets identical rejections, and the
    // message matches the one the Excel importer already produces.
    if (f.fieldType === 'PHONE_COUNTRY' && !isValidCountryCode(String(value))) {
      errors[`${prefix}${f.fieldKey}`] =
        `${f.label} "${String(raw)}" is not a valid ISO country code (e.g. OM, IN, SG)`;
      continue;
    }

    // Static option sets are enforced regardless of validationType — a SELECT
    // with choices means those choices, not "any string plus a hint".
    if (
      (f.fieldType === 'SELECT' || f.fieldType === 'MULTISELECT') &&
      optionValues(f).size > 0
    ) {
      const vals = Array.isArray(value) ? value : [value];
      const bad = vals.filter((v) => !optionValues(f).has(String(v)));
      if (bad.length) {
        errors[`${prefix}${f.fieldKey}`] =
          `${f.label}: ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not an allowed option`;
        continue;
      }
    }

    const err = validateDynamicValue(f, String(value), opts);
    if (err) errors[`${prefix}${f.fieldKey}`] = err;
    else normalized[f.fieldKey] = value;
  }

  return { valid: Object.keys(errors).length === 0, errors, normalized };
}

/** Mask sensitive values (last 4 kept) for reads, audit and notifications. */
export function maskDynamicData(
  data: Record<string, unknown> | null | undefined,
  fields: readonly FieldDef[],
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
