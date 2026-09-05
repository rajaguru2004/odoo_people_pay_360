/**
 * Reading a template field's value off an employee row, and rendering it.
 *
 * Export, letters and the read-only profile view all need the same two answers
 * ("where does this field's value live" and "how does a human see it"), and
 * three separate implementations would drift the moment a field type is added.
 *
 * Storage routing is the mirror image of `splitByStorage`: bound fields sit on
 * `employees` or `employee_profiles`, everything else in the JSONB bag.
 */
import { BOUND_BY_KEY } from './employee-bound-columns';

export interface ValueSource {
  /** An `employees` row, ideally with `profile` and `department` included. */
  employee: Record<string, any>;
  /** The `employee_profiles` row, when not already nested under `employee`. */
  profile?: Record<string, any> | null;
}

export interface ReadableField {
  fieldKey: string;
  storage: string;
  fieldType?: string | null;
  options?: unknown;
}

/** The raw stored value, or undefined when the field has never been set. */
export function readFieldValue(
  src: ValueSource,
  field: ReadableField,
): unknown {
  const { employee } = src;

  if (field.storage === 'JSONB') {
    const bag = (employee.customFields ?? {}) as Record<string, unknown>;
    return bag[field.fieldKey];
  }

  const bound = BOUND_BY_KEY.get(field.fieldKey);
  if (!bound) return undefined;

  if (bound.table === 'employee') return employee[bound.column];

  const profile = src.profile ?? employee.profile ?? null;
  return profile ? profile[bound.column] : undefined;
}

/** Label for a SELECT value, so an export shows "Male" rather than "MALE". */
function optionLabel(field: ReadableField, value: unknown): string | null {
  if (!Array.isArray(field.options)) return null;
  for (const o of field.options) {
    if (o && typeof o === 'object' && 'value' in (o as any)) {
      if (String((o as any).value) === String(value)) {
        return String((o as any).label ?? value);
      }
    }
  }
  return null;
}

export interface FormatOptions {
  /** Locale for date rendering. Matches the existing export's en-US default. */
  locale?: string;
  /** Render nothing rather than 'N/A' for an unset value. */
  blank?: string;
}

/** A human-readable rendering, safe to drop into a spreadsheet cell or a letter. */
export function formatFieldValue(
  field: ReadableField,
  value: unknown,
  opts: FormatOptions = {},
): string {
  const blank = opts.blank ?? '';
  if (value === null || value === undefined || value === '') return blank;

  switch (field.fieldType) {
    case 'BOOLEAN':
      return value ? 'Yes' : 'No';

    case 'DATE':
    case 'DATETIME': {
      const d = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(d.getTime())) return String(value);
      return field.fieldType === 'DATE'
        ? d.toLocaleDateString(opts.locale ?? 'en-US')
        : d.toLocaleString(opts.locale ?? 'en-US');
    }

    case 'MULTISELECT':
      if (!Array.isArray(value)) return String(value);
      return value
        .map((v) => optionLabel(field, v) ?? String(v))
        .join(', ');

    case 'SELECT':
      return optionLabel(field, value) ?? String(value);

    default: {
      // Prisma Decimal and other wrapper objects stringify usefully; plain
      // objects do not, and "[object Object]" in a payslip is worse than JSON.
      if (typeof value === 'object' && !(value instanceof Date)) {
        const asString = String(value);
        return asString === '[object Object]' ? JSON.stringify(value) : asString;
      }
      return String(value);
    }
  }
}

/** Convenience: read then format in one step. */
export function readFormatted(
  src: ValueSource,
  field: ReadableField,
  opts: FormatOptions = {},
): string {
  return formatFieldValue(field, readFieldValue(src, field), opts);
}
