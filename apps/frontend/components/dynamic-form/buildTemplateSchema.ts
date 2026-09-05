import { z } from 'zod';
import { TemplateField, TemplateSection } from '@/types/profile-template';
import { PHONE_COUNTRIES } from '@/lib/countries';

/**
 * A zod schema derived from the active template.
 *
 * This replaces two hand-written employee schemas that had already drifted from
 * each other (the create wizard required `branchId` and enforced a phone
 * pattern; the edit form did neither). Deriving both from one template means
 * they cannot disagree again.
 *
 * The server remains the authority: this exists so the user sees a problem
 * before a round-trip, not so the server can trust the client.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s().-]{6,20}$/;

/** Mirrors the backend's rejection of calendar-invalid dates like 2026-02-30. */
function isRealDate(v: string): boolean {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return true;
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3])
  );
}

/**
 * `null` means "not provided", the same as `undefined`.
 *
 * This is the single most common shape a value arrives in: the API returns
 * `null` for every unset column, the form resets from that record, and zod's
 * `.optional()` accepts `undefined` but NOT `null`. Left alone, every optional
 * field that happened to be empty on an existing employee failed with
 * "Invalid input: expected string, received null" — blocking the save on
 * fields the admin had deliberately left blank.
 *
 * The NUMBER branch below used to carry this coercion on its own, which is why
 * numbers worked and text, booleans and multiselects did not. Applied to every
 * type now, so the next field type added cannot reintroduce it.
 *
 * Requiredness is unaffected: `withRequired` treats undefined and null alike.
 */
const nullToUndefined = (schema: z.ZodTypeAny): z.ZodTypeAny =>
  z.preprocess((v) => (v === null ? undefined : v), schema);

function baseSchema(field: TemplateField): z.ZodTypeAny {
  switch (field.fieldType) {
    case 'BOOLEAN':
      return nullToUndefined(z.boolean().optional());
    case 'NUMBER':
    case 'DECIMAL':
    case 'CURRENCY':
      // An empty numeric input yields NaN under valueAsNumber; treat that as
      // "not provided" so requiredness (not a type error) reports it.
      return z.preprocess(
        (v) => (v === '' || v === null || (typeof v === 'number' && Number.isNaN(v)) ? undefined : v),
        z.number({ error: `${field.label} must be a number` }).optional(),
      );
    case 'MULTISELECT':
      return nullToUndefined(z.array(z.string()).optional());
    case 'PHONE_COUNTRY':
      // '' is meaningful — "clear it, inherit the branch default" — so it must
      // stay valid. Anything else has to be a code the picker actually offers,
      // which matters when an older record holds a code since withdrawn.
      return nullToUndefined(
        z
          .string()
          .optional()
          .refine(
            (v) => !v || PHONE_COUNTRIES.some((c) => c.code === v),
            { message: `${field.label} must be a valid country` },
          ),
      );
    default:
      return nullToUndefined(z.string().optional());
  }
}

function withValidation(field: TemplateField, schema: z.ZodTypeAny): z.ZodTypeAny {
  const optional = (check: (v: string) => boolean, message: string) =>
    schema.refine(
      (v: unknown) => v === undefined || v === null || v === '' || check(String(v)),
      { message },
    );

  switch (field.validationType) {
    case 'EMAIL':
      return optional((v) => EMAIL_RE.test(v), 'Invalid email address');
    case 'PHONE':
      return optional((v) => PHONE_RE.test(v), 'Invalid phone number');
    case 'URL':
      return optional((v) => {
        try {
          new URL(v);
          return true;
        } catch {
          return false;
        }
      }, 'Invalid URL');
    case 'DATE':
      return optional(isRealDate, 'Invalid date');
    case 'DATE_PAST':
      return optional(
        (v) => isRealDate(v) && new Date(v).getTime() <= Date.now(),
        'Date must be in the past',
      );
    case 'DATE_FUTURE':
      return optional(
        (v) => isRealDate(v) && new Date(v).getTime() >= Date.now(),
        'Date must be in the future',
      );
    case 'NUMBER':
      return optional((v) => /^\d+$/.test(v), 'Must be digits only');
    case 'REGEX': {
      if (!field.regex) return schema;
      let re: RegExp;
      try {
        re = new RegExp(field.regex);
      } catch {
        // A broken configured pattern never blocks the user — the same choice
        // the server makes, so client and server agree on a bad config.
        return schema;
      }
      return optional((v) => re.test(v), 'Invalid format');
    }
    case 'LENGTH':
      return optional(
        (v) =>
          (field.minLength == null || v.length >= field.minLength) &&
          (field.maxLength == null || v.length <= field.maxLength),
        field.minLength != null && field.maxLength != null
          ? `Must be ${field.minLength}–${field.maxLength} characters`
          : field.minLength != null
            ? `Must be at least ${field.minLength} characters`
            : `Must be at most ${field.maxLength} characters`,
      );
    case 'RANGE':
      return schema.refine(
        (v: unknown) => {
          if (v === undefined || v === null || v === '') return true;
          const n = Number(v);
          if (Number.isNaN(n)) return false;
          return (
            (field.minValue == null || n >= field.minValue) &&
            (field.maxValue == null || n <= field.maxValue)
          );
        },
        {
          message:
            field.minValue != null && field.maxValue != null
              ? `Must be between ${field.minValue} and ${field.maxValue}`
              : field.minValue != null
                ? `Must be at least ${field.minValue}`
                : `Must be at most ${field.maxValue}`,
        },
      );
    default:
      return schema;
  }
}

function withRequired(field: TemplateField, schema: z.ZodTypeAny): z.ZodTypeAny {
  if (!field.required) return schema;
  return schema.refine(
    (v: unknown) => {
      if (v === undefined || v === null) return false;
      if (typeof v === 'string') return v.trim() !== '';
      if (Array.isArray(v)) return v.length > 0;
      return true;
    },
    { message: `${field.label} is required` },
  );
}

/** One field's schema: type, then validation rule, then requiredness. */
export function schemaForField(field: TemplateField): z.ZodTypeAny {
  return withRequired(field, withValidation(field, baseSchema(field)));
}

/**
 * The whole form. Bound fields sit at the top level; JSONB fields are nested
 * under `customFields`, matching both the request body and the error keys the
 * server returns (`customFields.<key>`) so `setError` paths line up.
 */
export function buildTemplateSchema(
  fields: TemplateField[],
  opts: {
    /**
     * Fields the SYSTEM fills, which the user cannot type into.
     *
     * A field rendered read-only and also marked required is a dead end: the
     * form demands a value the user has no way to supply. That is not
     * hypothetical — `idCard` is required and read-only on wizard step 1, and
     * its only source is `departmentId` on step 2, so step 1 could never be
     * satisfied and the create wizard could not be completed at all.
     *
     * Requiredness is dropped for these on the client only. The server still
     * enforces its own, and the form fills the value before submitting; the
     * field that DOES drive it stays required, so nothing is actually skipped.
     */
    derivedFields?: string[];
  } = {},
): z.ZodTypeAny {
  const top: Record<string, z.ZodTypeAny> = {};
  const custom: Record<string, z.ZodTypeAny> = {};
  const derived = new Set(opts.derivedFields ?? []);

  for (const f of fields) {
    if (!f.isActive) continue;
    // Strip requiredness rather than the whole field: format and length rules
    // still apply to whatever the system puts there.
    const effective = derived.has(f.fieldKey) ? { ...f, required: false } : f;
    if (f.storage === 'JSONB') custom[f.fieldKey] = schemaForField(effective);
    else top[f.fieldKey] = schemaForField(effective);
  }

  if (Object.keys(custom).length) {
    // The bag itself arrives as null on every employee created before the
    // template existed — `custom_fields` is a nullable column with no default.
    // Same coercion as the fields inside it, for the same reason.
    top.customFields = nullToUndefined(
      z.object(custom).partial().optional(),
    );
  }

  // Passthrough: the employee forms carry properties the template does not
  // govern (contract block, salary rows). Stripping them here would silently
  // drop half of what the create wizard submits.
  return z.object(top).passthrough();
}

/**
 * Seed a form model from an API record, with nulls turned into the empty value
 * each control actually wants.
 *
 * The API returns `null` for every unset column. React logs
 * "value prop on input should not be null" for those and treats the input as
 * uncontrolled, so the first keystroke flips it to controlled and React warns
 * again. The forms worked around this with a hand-kept list of
 * `field: employee.field || ''` lines — which covers whatever someone
 * remembered, and silently misses every field the template gains afterwards.
 *
 * Type-aware, because "empty" is not one value: a checkbox wants undefined, a
 * multiselect wants [], a number input wants undefined (an empty string would
 * parse as NaN), and everything else wants ''.
 *
 * Only touches keys the template governs and only when they are null, so the
 * caller's own overrides — date slicing, salary coercion — still win when
 * spread afterwards.
 */
export function toFormDefaults(
  record: Record<string, unknown>,
  fields: TemplateField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };

  const emptyFor = (fieldType: string): unknown => {
    switch (fieldType) {
      case 'BOOLEAN':
      case 'NUMBER':
      case 'DECIMAL':
      case 'CURRENCY':
        return undefined;
      case 'MULTISELECT':
        return [];
      default:
        return '';
    }
  };

  for (const f of fields) {
    if (!f.isActive) continue;
    if (f.storage === 'JSONB') continue; // handled via the bag below
    if (out[f.fieldKey] === null) out[f.fieldKey] = emptyFor(f.fieldType);
  }

  // The bag is nullable with no default, so a pre-template employee has null
  // rather than {}. Its own values get the same treatment.
  const bag = (out.customFields ?? {}) as Record<string, unknown>;
  const nextBag: Record<string, unknown> = { ...bag };
  for (const f of fields) {
    if (!f.isActive || f.storage !== 'JSONB') continue;
    if (nextBag[f.fieldKey] === null) nextBag[f.fieldKey] = emptyFor(f.fieldType);
  }
  out.customFields = nextBag;

  return out;
}

/** RHF field names for one wizard step, for per-step `trigger()`. */
export function fieldNamesForStep(
  sections: TemplateSection[],
  step: number,
): string[] {
  return sections
    .filter((s) => s.wizardStep === step)
    .flatMap((s) => s.fields)
    .filter((f) => f.isActive)
    .map((f) => (f.storage === 'JSONB' ? `customFields.${f.fieldKey}` : f.fieldKey));
}

/** Distinct wizard steps present in a template, in order. */
export function wizardSteps(sections: TemplateSection[]): number[] {
  return [...new Set(sections.map((s) => s.wizardStep))].sort((a, b) => a - b);
}

/** The two request bodies a template-driven employee form has to produce. */
export interface EmployeePayloads {
  /** Body for POST /employees and PATCH /employees/:id. */
  employee: Record<string, unknown>;
  /** Body for PATCH /employees/:id/profile. Empty when nothing changed. */
  profile: Record<string, unknown>;
}

/** `boundColumn` is always "<table>.<column>", e.g. "employee.avatarUrl". */
const boundTable = (field: TemplateField): string | null =>
  field.boundColumn ? field.boundColumn.split('.')[0] : null;

/**
 * Split a submitted form model into the request bodies the employee endpoints
 * expect.
 *
 * Two rules, both learned the hard way:
 *
 *  - Only GOVERNED keys are sent. The form model carries whatever `reset()` put
 *    in it, which for an edit is the entire API response — `id`, `createdAt`,
 *    the nested `department`, `_count`. The employee endpoints run under
 *    `forbidNonWhitelisted`, so shipping the whole model means a 400 listing
 *    every one of them, and the save never lands.
 *  - Employee columns and EmployeeProfile columns go to DIFFERENT endpoints.
 *    They were previously sent as one body, which the employee DTO also
 *    rejects — a template that shows Place of Birth next to Full Name has to
 *    route them apart, because the API does.
 */
export function toEmployeePayloads(
  values: Record<string, unknown>,
  fields: TemplateField[],
  opts: {
    /**
     * What an empty string means for an OPTIONAL column.
     *
     * A blank text input yields `''`, and class-validator's `@IsOptional()`
     * skips `undefined` and `null` but NOT `''` — so an untouched optional
     * field arrived as an empty string and failed its own validator:
     * "supervisorId must be a UUID", "status must be one of...",
     * "endDate must be a valid ISO 8601 date string". Five at once, none of
     * them filled in by anyone.
     *
     *   'omit'  — CREATE. There is nothing to clear on a record that does not
     *             exist yet, so the key simply should not be sent.
     *   'null'  — EDIT. Here `''` is the user clearing a field, and null is
     *             what the DTOs accept for that: supervisorId is documented
     *             "null clears the assignment" and carries
     *             `@ValidateIf((_o, v) => v !== null)` to allow it.
     *
     * REQUIRED fields are left exactly as submitted either way: blanking one is
     * a real error, and the server's own message says so better than silence.
     */
    emptyValues?: 'omit' | 'null';
  } = {},
): EmployeePayloads {
  const byKey = new Map(fields.map((f) => [f.fieldKey, f]));
  const employee: Record<string, unknown> = {};
  const profile: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  const emptyValues = opts.emptyValues ?? 'omit';

  for (const [key, value] of Object.entries(values)) {
    if (key === 'customFields') continue;
    const field = byKey.get(key);
    if (!field || field.storage !== 'COLUMN') continue;

    let next = value;
    if (value === '' && !field.required) {
      if (emptyValues === 'omit') continue;
      next = null;
    }

    if (boundTable(field) === 'employeeProfile') profile[key] = next;
    else employee[key] = next;
  }

  const submittedCustom = (values.customFields ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(submittedCustom)) {
    // Only send keys the active template still declares — a stale form model
    // holding a since-removed field would otherwise be rejected as unknown.
    if (!byKey.has(key)) continue;
    if (value === undefined || value === '') continue;
    custom[key] = value;
  }

  // The bag rides on the employee body; the server routes it to JSONB.
  if (Object.keys(custom).length) employee.customFields = custom;
  return { employee, profile };
}

/**
 * One flat body of every governed field, both tables merged.
 *
 * Still correct for `PATCH /employees/:id/profile`, whose DTO accepts the
 * profile columns and the custom-field bag. Anything hitting the employee
 * endpoints wants `toEmployeePayloads` instead — they reject profile columns.
 */
export function toEmployeePayload(
  values: Record<string, unknown>,
  fields: TemplateField[],
): Record<string, unknown> {
  const { employee, profile } = toEmployeePayloads(values, fields);
  return { ...employee, ...profile };
}
