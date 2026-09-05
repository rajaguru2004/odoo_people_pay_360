/**
 * Which window a payroll period covers, and whether an input arrived in time.
 *
 * Pure: no Prisma, no Nest. Layer 0.
 *
 * The load-bearing property is what happens with NO calendar configured, which
 * is every branch until somebody sets one up: the window must be exactly the
 * calendar month the engine already uses, so that turning the feature on for one
 * branch changes nothing for any other.
 */

export interface CalendarPeriodLike {
  month: number;
  periodStart: Date;
  periodEnd: Date;
  cutOffDate: Date;
  paymentDate: Date;
  enforceCutOff: boolean;
}

export interface PayrollWindow {
  periodStart: Date;
  periodEnd: Date;
  cutOffDate: Date | null;
  paymentDate: Date | null;
  enforceCutOff: boolean;
  /** True when a configured calendar supplied this, rather than the fallback. */
  fromCalendar: boolean;
}

/** The calendar month, which is what the engine computes today. */
export function defaultWindow(month: number, year: number): PayrollWindow {
  return {
    periodStart: new Date(Date.UTC(year, month - 1, 1)),
    // Day 0 of the next month is the last day of this one, leap years included.
    periodEnd: new Date(Date.UTC(year, month, 0)),
    cutOffDate: null,
    paymentDate: null,
    enforceCutOff: false,
    fromCalendar: false,
  };
}

/**
 * The window for one period.
 *
 * Falls back to the calendar month when no period is configured — and that
 * fallback is byte-identical to `Date.UTC(year, month - 1, 1)` …
 * `Date.UTC(year, month, 0)`, which is what `payrolls.service.ts` computes
 * inline in six places. If those two ever disagree, money moves.
 */
export function windowFor(
  month: number,
  year: number,
  period: CalendarPeriodLike | null | undefined,
): PayrollWindow {
  if (!period) return defaultWindow(month, year);
  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    cutOffDate: period.cutOffDate,
    paymentDate: period.paymentDate,
    enforceCutOff: period.enforceCutOff,
    fromCalendar: true,
  };
}

export type LatenessVerdict = 'ON_TIME' | 'LATE' | 'NO_CUTOFF';

/**
 * Did this input arrive before the cut-off?
 *
 * `NO_CUTOFF` rather than `ON_TIME` when no calendar is configured, so a caller
 * cannot mistake "we do not track this" for "we checked and it was fine".
 */
export function latenessOf(
  recordedAt: Date | null | undefined,
  window: PayrollWindow,
): LatenessVerdict {
  if (!window.cutOffDate) return 'NO_CUTOFF';
  if (!recordedAt) return 'NO_CUTOFF';
  // The cut-off DAY is inclusive: an input recorded during the cut-off date is
  // on time. Anything else would make the date mean "the day before the
  // deadline", which nobody reads it as.
  const endOfCutOff = new Date(window.cutOffDate);
  endOfCutOff.setUTCHours(23, 59, 59, 999);
  return recordedAt.getTime() <= endOfCutOff.getTime() ? 'ON_TIME' : 'LATE';
}

/** Is a date inside the period at all? */
export function isWithinPeriod(date: Date, window: PayrollWindow): boolean {
  return (
    date.getTime() >= window.periodStart.getTime() &&
    date.getTime() <= endOfDay(window.periodEnd).getTime()
  );
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(23, 59, 59, 999);
  return out;
}

/**
 * Build a whole year of periods from a simple rule.
 *
 * Day-of-month based, because that is how a payroll calendar is actually
 * described by the people who own it ("we cut off on the 25th and pay on the
 * 30th"), and clamped to the length of each month so February does not produce
 * an invalid date.
 */
export function generateYear(
  year: number,
  opts: {
    periodStartDay?: number;
    cutOffDay: number;
    paymentDay: number;
    enforceCutOff?: boolean;
  },
): CalendarPeriodLike[] {
  const out: CalendarPeriodLike[] = [];
  for (let month = 1; month <= 12; month++) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const clamp = (d: number) => Math.min(Math.max(1, d), lastDay);

    const periodStart = new Date(
      Date.UTC(year, month - 1, clamp(opts.periodStartDay ?? 1)),
    );
    const periodEnd = new Date(Date.UTC(year, month, 0));
    // Both are clamped INTO the period, because the constraints require
    // cutOff >= periodStart and paymentDate >= periodEnd; a calendar that
    // cannot be saved is worse than one that is approximate.
    const cutOffDate = new Date(Date.UTC(year, month - 1, clamp(opts.cutOffDay)));
    const paymentBase = new Date(Date.UTC(year, month - 1, clamp(opts.paymentDay)));
    const paymentDate =
      paymentBase.getTime() < periodEnd.getTime() ? periodEnd : paymentBase;

    out.push({
      month,
      periodStart,
      periodEnd,
      cutOffDate:
        cutOffDate.getTime() < periodStart.getTime() ? periodStart : cutOffDate,
      paymentDate,
      enforceCutOff: opts.enforceCutOff ?? false,
    });
  }
  return out;
}
