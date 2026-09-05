/**
 * The payroll edge-case lane: which branch and which periods this spec family
 * owns, and the date arithmetic that addresses them.
 *
 * ## Why this is its own module
 *
 * Every function here is pure — no `ApiClient`, no network, no Playwright. That
 * makes it layer-0 testable (`payroll-period.test.ts`, collected by the `unit`
 * vitest project the same way `routes.test.ts` is), and `docs/TESTING.md` is
 * explicit that a rule a pure function can check does not belong in a browser
 * test. `payroll-support.ts` re-exports all of it, so a spec still imports from
 * one place.
 *
 * Keeping it out of `payroll-support.ts` is load-bearing rather than tidy:
 * that module imports `./fixtures`, which imports `@playwright/test`, which has
 * no business being loaded by a millisecond unit suite.
 */

// ───────────────────────────────────────────────────────────────────────────
// The payroll edge-case lane
// ───────────────────────────────────────────────────────────────────────────

/**
 * Where the `payroll-edge-*` specs live, and why it is somewhere nobody else is.
 *
 * A payroll run is generated for a whole BRANCH and covers every employee in
 * it, so two files sharing a branch and a month collide on a 409 — and the
 * second one reads as a product defect rather than as a booking clash.
 *
 * The branches are therefore carved up, and this is the register:
 *
 *   HO         → `payroll.admin-employee`, `payroll-depth`
 *   E2E-PAY    → the `payroll-edge-*` family, periods 2044–2046  ← this constant
 *
 * If you add a phase, take a branch and a year band, and add a line here. The
 * cost of not doing so is a red spec in a file you did not touch.
 */
export const PAYROLL_EDGE_BRANCH_CODE = 'E2E-PAY';
export const PAYROLL_EDGE_BRANCH_NAME = 'Payroll Edge Cases (Oman)';

/**
 * The branch's country.
 *
 * Oman, because that is the market this catalogue is written for and because the
 * statutory presets these cases price against are Omani. A branch left at
 * `country: null` — which is what `POST /branches` produces — inherits the
 * global settings instead, and a case about a branch's own configuration then
 * measures the global value.
 */
export const PAYROLL_EDGE_BRANCH_COUNTRY = 'OM';

/**
 * The year band this family owns — 120 periods, one per spec case that needs a
 * period of its own.
 *
 * Widened twice, both times because `edgePeriod` REFUSED an index rather than
 * wrapping: first at index 40 (`payroll-edge-attendance`), then at 73. Each
 * refusal cost one run and a one-line change. The alternative it prevents is
 * silent wrapping into 2047, 2054 … and eventually onto a month another file
 * already owns — a failure that would appear in a different spec, on a different
 * day, with no connection to the change that caused it. Widen here and record
 * it; never wrap.
 *
 * Allocate a decade per file and leave gaps: the cost of a sparse register is
 * nothing, and the cost of two files sharing a month is a 409 that reads as a
 * product defect.
 *
 * Allocation, so two files cannot pick the same month:
 *
 *   0–9     `payroll-edge-fixtures`
 *   10–19   `payroll-edge-run-guards`
 *   20–29   `payroll-edge-leave`
 *   30–39   `payroll-edge-overtime`
 *   40–49   `payroll-edge-attendance`
 *   50–59   `payroll-edge-recoveries`
 *   60–69   `payroll-edge-salary-change`
 *   80–89   `payroll-edge-audit`
 *   90–99   `payroll-edge-config`
 *   100–109 `payroll-edge-itemization`
 *   110–119 `payroll-edge-concurrency-scale`
 *   120+    unallocated — take the next free decade and add a line here
 *
 * `payroll-edge-settlement` is not listed: every case in it turns on an
 * employment date, so it runs in `PAYROLL_EDGE_PAST_YEARS` instead (G30).
 *
 * Widened a third time, to 2059, for the gap-closure phase: nine new files each
 * need a decade and only three were left. Widening UPWARD is the safe direction,
 * and nothing in `payroll-period.test.ts` hardcodes the last year, because every
 * case derives `span` from these constants. The years the leap-day cases name
 * (2044, 2045, 2046) are date facts, not band facts.
 */
export const PAYROLL_EDGE_YEARS = { first: 2044, last: 2059 } as const;

/**
 * The SECOND band, in the past, for inputs the server refuses to date forward.
 *
 * Most of this family lives in 2044–2046 because a far-future period is how a
 * spec guarantees no other suite's payroll run reaches its employees. Attendance
 * CORRECTIONS cannot live there: `attendance-corrections.service.ts:74` refuses
 * any correction dated after today — *"Cannot adjust attendance for future
 * dates"* — which is correct behaviour and fatal to a 2044 period.
 *
 * The distinction is not arbitrary, and it is worth stating so the next person
 * does not "simplify" the two bands into one: what a payroll run is FOR may be
 * any period at all, but several inputs are records of something that already
 * happened, and the server will not accept them in the future. Corrections are
 * the one this suite hit; treat a new "cannot ... future" refusal as a signal to
 * move that case here rather than to weaken the guard.
 *
 * 2023–2024 is late enough to be after `makeEmployee`'s default `startDate` of
 * `2020-01-01` — an employee cannot be paid for a period before they joined —
 * and early enough to be unambiguously past.
 */
export const PAYROLL_EDGE_PAST_YEARS = { first: 2023, last: 2024 } as const;

export interface Period {
  month: number;
  year: number;
}

/**
 * A period as one comparable integer. Sorting teardown by this is what makes
 * "newest period first" expressible.
 */
export function periodKey(p: Period): number {
  return p.year * 12 + p.month;
}

/** `periodAt({month:1,year:2044}, 13)` → `{month:2,year:2045}`. Handles the wrap. */
export function periodAt(base: Period, offset: number): Period {
  const zeroBased = base.year * 12 + (base.month - 1) + offset;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

/**
 * A period inside this family's band, addressed by index rather than by literal.
 *
 * Specs ask for `edgePeriod(0)`, `edgePeriod(1)` … instead of writing
 * `{ month: 3, year: 2044 }`, so that two files cannot silently pick the same
 * month, and so the band can move in one place if it ever has to.
 *
 * Throws rather than wrapping past the band: silently running in 2047 would
 * reintroduce exactly the collision the band exists to prevent.
 */
export function edgePeriod(index: number): Period {
  const span = (PAYROLL_EDGE_YEARS.last - PAYROLL_EDGE_YEARS.first + 1) * 12;
  if (!Number.isInteger(index) || index < 0 || index >= span) {
    throw new Error(
      `edgePeriod(${index}) is outside the payroll-edge band ` +
        `${PAYROLL_EDGE_YEARS.first}-${PAYROLL_EDGE_YEARS.last} (0..${span - 1}). ` +
        `Widen PAYROLL_EDGE_YEARS and record it in the branch register, rather than ` +
        `running in a year another spec family owns.`,
    );
  }
  return periodAt({ month: 1, year: PAYROLL_EDGE_YEARS.first }, index);
}

/** `2044-03-01`, zero-padded — the shape every date DTO in this app wants. */
export function dateIn(p: Period, day: number): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The last calendar day of a period. Leap years included — this is `Date`'s day-0 trick. */
export function lastDayOf(p: Period): number {
  return new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
}

/**
 * A period inside the PAST band, addressed by index, with the same
 * refuse-rather-than-wrap contract as `edgePeriod`.
 */
export function pastEdgePeriod(index: number): Period {
  const span = (PAYROLL_EDGE_PAST_YEARS.last - PAYROLL_EDGE_PAST_YEARS.first + 1) * 12;
  if (!Number.isInteger(index) || index < 0 || index >= span) {
    throw new Error(
      `pastEdgePeriod(${index}) is outside the payroll-edge PAST band ` +
        `${PAYROLL_EDGE_PAST_YEARS.first}-${PAYROLL_EDGE_PAST_YEARS.last} (0..${span - 1}). ` +
        `Widen PAYROLL_EDGE_PAST_YEARS and record it in the branch register, rather than ` +
        `running in a year another spec family owns.`,
    );
  }
  return periodAt({ month: 1, year: PAYROLL_EDGE_PAST_YEARS.first }, index);
}
