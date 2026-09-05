import { TemplateField } from '@/types/profile-template';

/**
 * Reading and rendering a template field's value.
 *
 * Shared by the read view and the list table so the same field cannot render
 * two different ways depending on which screen you are looking at. Mirrors the
 * server's `employee-field-values.ts`.
 */

/** Where the value lives — the mirror of the server's storage split. */
export function readFieldValue(
  field: TemplateField,
  employee: Record<string, any> | null | undefined,
  profile?: Record<string, any> | null,
): unknown {
  if (field.storage === 'JSONB') {
    const bag = (employee?.customFields ?? {}) as Record<string, unknown>;
    return bag[field.fieldKey];
  }
  const fromEmployee = employee?.[field.fieldKey];
  if (fromEmployee !== undefined && fromEmployee !== null) return fromEmployee;
  return profile?.[field.fieldKey] ?? employee?.profile?.[field.fieldKey];
}

function optionLabel(field: TemplateField, value: unknown): string {
  return (
    field.options?.find((o) => String(o.value) === String(value))?.label ??
    String(value)
  );
}

/** Human-readable rendering, or null when there is nothing to show. */
export function formatFieldValue(
  field: TemplateField,
  value: unknown,
): string | null {
  if (value === null || value === undefined || value === '') return null;

  switch (field.fieldType) {
    case 'BOOLEAN':
      return value ? 'Yes' : 'No';
    case 'DATE':
    case 'DATETIME': {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return String(value);
      return field.fieldType === 'DATE'
        ? d.toLocaleDateString()
        : d.toLocaleString();
    }
    case 'MULTISELECT':
      return Array.isArray(value)
        ? value.map((v) => optionLabel(field, v)).join(', ')
        : String(value);
    case 'SELECT':
      return optionLabel(field, value);
    default:
      return String(value);
  }
}

/** Sensitive values keep their last four characters and nothing else. */
export function maskValue(value: string): string {
  return value.length > 4 ? `••••${value.slice(-4)}` : '••••';
}

/** Read, format, and mask in one step. */
export function displayFieldValue(
  field: TemplateField,
  employee: Record<string, any> | null | undefined,
  profile?: Record<string, any> | null,
): string | null {
  const formatted = formatFieldValue(
    field,
    readFieldValue(field, employee, profile),
  );
  if (formatted === null) return null;
  return field.isSensitive ? maskValue(formatted) : formatted;
}

/**
 * Fields that can be shown as an extra list column.
 *
 * Restricted to what the list endpoint actually returns: custom (JSONB) fields,
 * plus the `employees` columns already in its `select`. Anything on
 * `employee_profiles` would need a join on every page of the list, which is a
 * cost the column picker should not be able to impose silently.
 */
const LIST_AVAILABLE_BOUND_KEYS = new Set([
  'employeeCode',
  'fullName',
  'email',
  'phone',
  'gender',
  'position',
  'status',
  'baseSalary',
  'salaryType',
  'employmentType',
  'startDate',
]);

/** Columns already rendered by the fixed part of the table. */
const FIXED_COLUMN_KEYS = new Set([
  'employeeCode',
  'fullName',
  'email',
  'position',
  'startDate',
  'status',
]);

export function listColumnCandidates(fields: TemplateField[]): TemplateField[] {
  return fields.filter(
    (f) =>
      f.isActive &&
      !FIXED_COLUMN_KEYS.has(f.fieldKey) &&
      (f.storage === 'JSONB' || LIST_AVAILABLE_BOUND_KEYS.has(f.fieldKey)),
  );
}
