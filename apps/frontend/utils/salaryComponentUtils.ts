/**
 * Salary component TYPE codes.
 *
 * A component type is an admin-configurable thing: the `SALARY_COMPONENT_TYPE`
 * library is what an HR admin edits when their country's payslip needs HRA, DA,
 * a Special Allowance or anything else. The code stored on
 * `salary_components.component_type` is derived from that label.
 *
 * This used to funnel every label through a fixed nine-value enum, so an admin
 * who added "HRA" and "DA" got TWO rows both stored — and both displayed — as
 * `OTHER`. Configuring a real salary breakup was therefore impossible. Codes are
 * now slugs derived from the label, with the historical labels pinned to their
 * original codes so existing rows keep rendering exactly as before.
 *
 * Only two codes carry meaning in the payroll engine:
 *   - `BASIC`          — the basic part of the contracted rate;
 *   - `PAYROLL_CONFIG` — internal deduction-override bookkeeping, never money.
 * Every other code is an allowance, whatever it is called.
 */

/** Codes that predate admin-defined types. Kept for display and migration. */
export type LegacyComponentType =
  | 'BASIC'
  | 'ALLOWANCE'
  | 'HOUSING'
  | 'TRANSPORT'
  | 'LUNCH'
  | 'PHONE'
  | 'POSITION'
  | 'BONUS'
  | 'OTHER'
  | 'PAYROLL_CONFIG';

/** Any component code — a legacy one, or a slug an admin's label produced. */
export type ComponentTypeCode = string;

/** @deprecated Kept so existing imports still type-check. Use ComponentTypeCode. */
export type ComponentTypeEnum = ComponentTypeCode;

export interface SalaryComponentTypeOption {
  value: ComponentTypeCode;
  label: string;
}

/** Used only when the library is empty or unreachable. */
export const SALARY_COMPONENT_OPTIONS: SalaryComponentTypeOption[] = [
  { value: 'BASIC', label: 'Basic Salary' },
  { value: 'ALLOWANCE', label: 'Allowance' },
  { value: 'HOUSING', label: 'Housing Allowance' },
  { value: 'TRANSPORT', label: 'Transport Allowance' },
  { value: 'LUNCH', label: 'Lunch Allowance' },
  { value: 'PHONE', label: 'Telephone Allowance' },
  { value: 'POSITION', label: 'Position Allowance' },
  { value: 'BONUS', label: 'Bonus' },
  { value: 'OTHER', label: 'Other' },
];

const LEGACY_LABELS: Record<string, string> = {
  BASIC: 'Basic Salary',
  ALLOWANCE: 'Allowance',
  HOUSING: 'Housing Allowance',
  TRANSPORT: 'Transport Allowance',
  LUNCH: 'Lunch Allowance',
  PHONE: 'Telephone Allowance',
  POSITION: 'Position Allowance',
  BONUS: 'Bonus',
  OTHER: 'Other',
  PAYROLL_CONFIG: 'Deduction Overrides',
};

/**
 * The shipped library labels, pinned to the code they have always produced, so
 * a database seeded before this change keeps one code per concept instead of
 * growing a second slug for the same thing.
 */
const PINNED_SLUGS: Record<string, string> = {
  BASIC_SALARY: 'BASIC',
  BASIC_PAY: 'BASIC',
  ALLOWANCES: 'ALLOWANCE',
  LUNCH_ALLOWANCE: 'LUNCH',
  MEAL_ALLOWANCE: 'LUNCH',
  GASOLINE_ALLOWANCE: 'TRANSPORT',
  FUEL_ALLOWANCE: 'TRANSPORT',
  TRANSPORT_ALLOWANCE: 'TRANSPORT',
  TELEPHONE_ALLOWANCE: 'PHONE',
  PHONE_ALLOWANCE: 'PHONE',
  HOUSING_ALLOWANCE: 'HOUSING',
  POSITION_ALLOWANCE: 'POSITION',
  POSITION_ALLOWANCES: 'POSITION',
};

/** Mirrors the backend's `@Matches` rule — VarChar(50), uppercase slug. */
export const COMPONENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,49}$/;

const slugify = (input: string): string =>
  input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
    .replace(/_+$/g, '');

/**
 * Turn a library label (or an already-stored code) into the code to persist.
 *
 * An unrecognised label now keeps its own identity — "HRA" stores as `HRA`, not
 * as `OTHER` — which is the whole point of letting an admin define types.
 */
export const toComponentCode = (input: string): ComponentTypeCode => {
  const slug = slugify(input ?? '');
  if (!slug) return 'OTHER';
  if (PINNED_SLUGS[slug]) return PINNED_SLUGS[slug];
  // A leading digit cannot start a code; prefix rather than reject, so an admin
  // label like "13th Month Pay" still saves.
  return COMPONENT_CODE_PATTERN.test(slug) ? slug : `C_${slug}`.slice(0, 50);
};

/** @deprecated Renamed — component codes are no longer a closed enum. */
export const mapToComponentTypeEnum = toComponentCode;

/** Words that stay upper-cased when a slug is prettified (HRA, DA, PF, LTA…). */
const isAcronym = (word: string) => word.length <= 3;

/**
 * Human label for a stored code.
 *
 * Prefer `componentLabel()` with the live library options — this is the fallback
 * for a code whose library item was renamed or deleted.
 */
export const formatComponentTypeLabel = (code: string): string => {
  if (!code) return '';
  const upper = code.trim().toUpperCase();
  if (LEGACY_LABELS[upper]) return LEGACY_LABELS[upper];
  return upper
    .split('_')
    .filter(Boolean)
    .map((w) => (isAcronym(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
};

/** Label for a code, preferring what the admin actually typed in the library. */
export const componentLabel = (
  code: string,
  options: SalaryComponentTypeOption[] = [],
): string =>
  options.find((o) => o.value === code)?.label ?? formatComponentTypeLabel(code);

/**
 * Build the option list from raw `SALARY_COMPONENT_TYPE` library items.
 *
 * Shared by every screen that edits a salary structure so they cannot offer
 * different type lists — which is how the onboarding wizard ended up with a
 * hardcoded list the library could not influence.
 */
export const optionsFromLibrary = (
  items: { label?: string }[] | undefined | null,
): SalaryComponentTypeOption[] => {
  const mapped = (items ?? [])
    .map((item) => {
      const label = (item?.label ?? '').trim();
      if (!label) return null;
      return { value: toComponentCode(label), label };
    })
    .filter(Boolean) as SalaryComponentTypeOption[];

  const unique = mapped.filter(
    (item, idx, self) => self.findIndex((s) => s.value === item.value) === idx,
  );
  return unique.length ? unique : SALARY_COMPONENT_OPTIONS;
};
