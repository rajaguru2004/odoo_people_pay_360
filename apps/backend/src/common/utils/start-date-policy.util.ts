/**
 * Employment start-date policy — the single source of truth for how far a start
 * date may sit in the past or the future.
 *
 * Every bound is expressed in whole UTC days. The columns this guards are all
 * `@db.Date` (Employee.startDate, Employee.dateOfBirth, Contract.startDate), so
 * comparing anything in local time re-introduces the off-by-one this replaces.
 * Days rather than calendar months also avoids `new Date(y, m + 6, d)` rolling
 * Aug 31 over into March 3.
 */

export const MIN_EMPLOYMENT_AGE_YEARS = 18;

export interface StartDatePolicy {
  /** Max days a start date may be backdated. `null` or `0` = unrestricted. */
  maxPastDays: number | null;
  /** Max days a start date may be future-dated. `0` = today at the latest. */
  maxFutureDays: number;
  /** Absolute floor, UTC midnight. Catches typos like `0202-05-01`. */
  floor: Date;
  minAgeYears: number;
}

/**
 * Backdating is unrestricted by default: onboarding a hire whose paperwork
 * arrived late is the common case, and the admin panel can tighten it without a
 * deploy. The future cap stays, because a future-dated employee is created
 * ACTIVE and is picked up by payroll immediately — nothing downstream waits for
 * their start date to arrive.
 */
export const DEFAULT_START_DATE_POLICY: StartDatePolicy = {
  maxPastDays: null,
  maxFutureDays: 180,
  floor: new Date(Date.UTC(1970, 0, 1)),
  minAgeYears: MIN_EMPLOYMENT_AGE_YEARS,
};

export type StartDateErrorCode =
  | 'START_DATE_INVALID'
  | 'START_DATE_BELOW_FLOOR'
  | 'START_DATE_TOO_FAR_PAST'
  | 'START_DATE_TOO_FAR_FUTURE'
  | 'START_DATE_BEFORE_BIRTH'
  | 'START_DATE_BEFORE_MIN_AGE';

export type StartDateCheckResult =
  | { ok: true; date: Date }
  | { ok: false; date: null; code: StartDateErrorCode; message: string };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Normalise any date-ish input to UTC midnight. Returns null for anything
 * unparseable — never throws, since this runs over user-supplied Excel cells.
 */
export function parseDateOnlyUTC(
  value: string | Date | null | undefined,
): Date | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return new Date(
      Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
      ),
    );
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // Fast path for the YYYY-MM-DD the API and the import template both use.
  // Parsing it by hand keeps `2026-13-45` an error rather than letting Date
  // roll it forward into a valid-looking day.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(raw);
  if (iso) {
    const [, y, m, d] = iso;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const utc = new Date(Date.UTC(year, month - 1, day));
    // Rejects 2025-02-30 and friends: Date would have rolled them over.
    if (
      utc.getUTCFullYear() !== year ||
      utc.getUTCMonth() !== month - 1 ||
      utc.getUTCDate() !== day
    ) {
      return null;
    }
    return utc;
  }

  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return null;
  return new Date(
    Date.UTC(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth(),
      parsed.getUTCDate(),
    ),
  );
}

/** Whole days between two UTC-midnight dates (b - a). */
function diffInDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** Date-only anniversary, so age boundaries land on the birthday itself. */
function addYearsUTC(date: Date, years: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear() + years,
      date.getUTCMonth(),
      date.getUTCDate(),
    ),
  );
}

function fail(
  code: StartDateErrorCode,
  message: string,
): StartDateCheckResult {
  return { ok: false, date: null, code, message };
}

/**
 * Validate an employment start date against the configured policy.
 *
 * `dateOfBirth` is optional: the contract path has no DOB to check against, and
 * omitting it skips the birth/minimum-age rules rather than failing them.
 * `now` is injectable so tests are deterministic.
 */
export function checkEmploymentStartDate(input: {
  startDate: string | Date | null | undefined;
  dateOfBirth?: string | Date | null;
  policy: StartDatePolicy;
  now?: Date;
}): StartDateCheckResult {
  const { startDate, dateOfBirth, policy } = input;

  const date = parseDateOnlyUTC(startDate);
  if (!date) {
    return fail('START_DATE_INVALID', 'Start date must be a valid date (YYYY-MM-DD)');
  }

  const floor = parseDateOnlyUTC(policy.floor) ?? DEFAULT_START_DATE_POLICY.floor;
  if (date < floor) {
    return fail(
      'START_DATE_BELOW_FLOOR',
      `Start date cannot be earlier than ${formatDate(floor)}`,
    );
  }

  const today = parseDateOnlyUTC(input.now ?? new Date())!;

  // null / 0 both mean "no backdating limit".
  if (policy.maxPastDays) {
    const daysPast = diffInDays(date, today);
    if (daysPast > policy.maxPastDays) {
      return fail(
        'START_DATE_TOO_FAR_PAST',
        `Start date cannot be more than ${policy.maxPastDays} days in the past`,
      );
    }
  }

  const daysFuture = diffInDays(today, date);
  if (daysFuture > policy.maxFutureDays) {
    return fail(
      'START_DATE_TOO_FAR_FUTURE',
      `Start date cannot be more than ${policy.maxFutureDays} days in the future`,
    );
  }

  const birth = parseDateOnlyUTC(dateOfBirth);
  if (birth) {
    if (date < birth) {
      return fail(
        'START_DATE_BEFORE_BIRTH',
        'Start date cannot be before the date of birth',
      );
    }

    const minStart = addYearsUTC(birth, policy.minAgeYears);
    if (date < minStart) {
      return fail(
        'START_DATE_BEFORE_MIN_AGE',
        `Start date cannot be before the employee turns ${policy.minAgeYears} (${formatDate(minStart)})`,
      );
    }
  }

  return { ok: true, date };
}
