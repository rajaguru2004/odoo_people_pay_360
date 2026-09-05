/**
 * What an employee has earned in end-of-service benefit, and why.
 *
 * Pure: no Prisma, no Nest, no settings. Layer 0.
 *
 * The single most important decision here is that the entitlement is computed
 * BAND BY BAND rather than by looking up the band a total service length falls
 * into. Under a law with a lower rate for the first years of service — which is
 * how Oman's pre-2023 law worked, and how several neighbouring jurisdictions
 * still work — an employee with 5 years does not earn 5 x the 5-year rate. They
 * earn 3 x the first-band rate plus 2 x the second. Getting that wrong is not a
 * rounding difference; it is a different number, and correcting it later means
 * recomputing every balance ever accrued.
 */

export type NationalityClass = 'NATIONAL' | 'GCC' | 'EXPAT';
export type GratuityBasis = 'BASIC' | 'GROSS';

export interface GratuityRuleLike {
  id: string;
  country: string;
  /** NATIONAL | GCC | EXPAT | ANY */
  nationalityClass: string;
  fromYears: number;
  /** null = open-ended */
  toYears: number | null;
  daysPerYear: number;
  basis: string;
  monthDays: number;
  /** Fraction the employer bears; the rest sits with a state fund. */
  employerShare: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isActive: boolean;
}

export interface GratuityContext {
  employmentStart: Date;
  /** The date entitlement is measured to — period end, or the last working day. */
  asOf: Date;
  /** Monthly basic, and monthly gross, so a rule can price either. */
  monthlyBasic: number;
  monthlyGross: number;
  nationalityClass: NationalityClass | null;
  country: string;
  /** Days in a service year. 365 unless an installation says otherwise. */
  serviceYearDays: number;
}

export interface GratuityBand {
  ruleId: string;
  fromYears: number;
  toYears: number | null;
  /** Years of THIS employee's service that fall inside the band. */
  yearsInBand: number;
  daysPerYear: number;
  basis: GratuityBasis;
  dayRate: number;
  employerShare: number;
  /** Employer-borne amount earned in this band. */
  amount: number;
}

export interface GratuityResult {
  serviceYears: number;
  bands: GratuityBand[];
  /** Employer-borne total. */
  amount: number;
  /** Total before the employer share is applied — what the employee receives. */
  grossEntitlement: number;
  /** Human-readable working, stored verbatim on the accrual. */
  workingLines: string[];
  /** Set when nothing could be computed, and why. */
  refusal: string | null;
}

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 10000) / 10000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Fractional years of service between two dates.
 *
 * Day-count rather than calendar anniversaries, because the entitlement is
 * proportional and an anniversary rule would make February hires systematically
 * different from March ones. `serviceYearDays` is configurable since the
 * convention is a legal variable, not a constant.
 */
export function serviceYearsBetween(
  start: Date,
  asOf: Date,
  serviceYearDays = 365,
): number {
  if (!(start instanceof Date) || !(asOf instanceof Date)) return 0;
  const days = (asOf.getTime() - start.getTime()) / MS_PER_DAY;
  if (!Number.isFinite(days) || days <= 0) return 0;
  const denom = serviceYearDays > 0 ? serviceYearDays : 365;
  return round4(days / denom);
}

/** Does a rule apply to this country, class and date? */
export function ruleApplies(
  rule: GratuityRuleLike,
  country: string,
  cls: NationalityClass,
  asOf: Date,
): boolean {
  if (!rule.isActive) return false;
  if (rule.country.toUpperCase() !== country.toUpperCase()) return false;
  if (
    rule.nationalityClass !== 'ANY' &&
    rule.nationalityClass.toUpperCase() !== cls
  ) {
    return false;
  }
  if (rule.effectiveFrom > asOf) return false;
  if (rule.effectiveTo && rule.effectiveTo < asOf) return false;
  return true;
}

/**
 * The applicable rules, in a TOTAL order.
 *
 * Sorted by band start, then by effective date, then by id — the last of those
 * only to break a genuine tie, so that two runs over identical data always
 * produce identical bands. A partial sort would let an accrual and the
 * settlement that consumes it disagree.
 */
export function resolveRules(
  rules: GratuityRuleLike[],
  country: string,
  cls: NationalityClass,
  asOf: Date,
): GratuityRuleLike[] {
  return rules
    .filter((r) => ruleApplies(r, country, cls, asOf))
    .sort(
      (a, b) =>
        a.fromYears - b.fromYears ||
        a.effectiveFrom.getTime() - b.effectiveFrom.getTime() ||
        a.id.localeCompare(b.id),
    );
}

/**
 * Total entitlement as at `asOf`.
 *
 * Returns a refusal rather than a zero when the nationality class is unknown:
 * an employee whose class nobody recorded has an entitlement nobody can
 * compute, and reporting that as "0" would hide a missing record behind a
 * plausible number.
 */
export function entitlementAt(
  ctx: GratuityContext,
  rules: GratuityRuleLike[],
): GratuityResult {
  const empty = (refusal: string | null, working: string[]): GratuityResult => ({
    serviceYears: 0,
    bands: [],
    amount: 0,
    grossEntitlement: 0,
    workingLines: working,
    refusal,
  });

  if (!ctx.nationalityClass) {
    return empty(
      'Nationality class is not recorded for this employee, so no end-of-service ' +
        'entitlement can be calculated. Record it as NATIONAL, GCC or EXPAT.',
      [],
    );
  }

  const serviceYears = serviceYearsBetween(
    ctx.employmentStart,
    ctx.asOf,
    ctx.serviceYearDays,
  );
  if (serviceYears <= 0) {
    return empty(null, ['No completed service in this period.']);
  }

  const applicable = resolveRules(
    rules,
    ctx.country,
    ctx.nationalityClass,
    ctx.asOf,
  );
  if (applicable.length === 0) {
    return {
      ...empty(
        `No end-of-service rule is configured for ${ctx.country} / ` +
          `${ctx.nationalityClass}.`,
        [],
      ),
      serviceYears,
    };
  }

  const workingLines: string[] = [
    `Service: ${serviceYears} year(s) from ` +
      `${iso(ctx.employmentStart)} to ${iso(ctx.asOf)} ` +
      `(${ctx.serviceYearDays} days per service year).`,
  ];

  const bands: GratuityBand[] = [];
  let employerTotal = 0;
  let grossTotal = 0;

  for (const rule of applicable) {
    // How much of THIS employee's service falls inside this band.
    const bandStart = rule.fromYears;
    const bandEnd = rule.toYears ?? Number.POSITIVE_INFINITY;
    const yearsInBand = Math.max(
      0,
      Math.min(serviceYears, bandEnd) - Math.min(serviceYears, bandStart),
    );
    if (yearsInBand <= 0) continue;

    const basis: GratuityBasis = rule.basis === 'GROSS' ? 'GROSS' : 'BASIC';
    const monthly = basis === 'GROSS' ? ctx.monthlyGross : ctx.monthlyBasic;
    const dayRate = rule.monthDays > 0 ? monthly / rule.monthDays : 0;
    const gross = yearsInBand * rule.daysPerYear * dayRate;
    const amount = gross * rule.employerShare;

    employerTotal += amount;
    grossTotal += gross;

    bands.push({
      ruleId: rule.id,
      fromYears: rule.fromYears,
      toYears: rule.toYears,
      yearsInBand: round4(yearsInBand),
      daysPerYear: rule.daysPerYear,
      basis,
      dayRate: round2(dayRate),
      employerShare: rule.employerShare,
      amount: round2(amount),
    });

    workingLines.push(
      `Band ${rule.fromYears}–${rule.toYears ?? '∞'} year(s): ` +
        `${round4(yearsInBand)} year(s) × ${rule.daysPerYear} day(s) × ` +
        `${round2(dayRate)} per day (${basis.toLowerCase()} ÷ ${rule.monthDays}) ` +
        `= ${round2(gross)}` +
        (rule.employerShare < 1
          ? `, employer share ${rule.employerShare} = ${round2(amount)}`
          : ''),
    );
  }

  workingLines.push(`Total employer-borne entitlement: ${round2(employerTotal)}.`);

  return {
    serviceYears,
    bands,
    amount: round2(employerTotal),
    grossEntitlement: round2(grossTotal),
    workingLines,
    refusal: null,
  };
}

/**
 * What one month adds to the provision.
 *
 * Computed as the difference between the entitlement at the end of the period
 * and at the start, rather than as a twelfth of a year. That is what makes it
 * correct across a band boundary: the month an employee crosses from a lower
 * rate to a higher one accrues the blend, automatically, with no special case.
 */
export function accrueForPeriod(
  ctx: GratuityContext & { periodStart: Date },
  rules: GratuityRuleLike[],
): GratuityResult & { openingEntitlement: number } {
  const opening = entitlementAt(
    { ...ctx, asOf: earlier(ctx.periodStart, ctx.asOf) },
    rules,
  );
  const closing = entitlementAt(ctx, rules);

  if (closing.refusal) {
    return { ...closing, openingEntitlement: 0 };
  }

  const accrued = round2(closing.amount - opening.amount);
  return {
    ...closing,
    // Never negative: a rate that falls, or a rule retired mid-service, must not
    // claw back a provision already set aside.
    amount: Math.max(0, accrued),
    openingEntitlement: opening.amount,
    workingLines: [
      ...closing.workingLines,
      `Provision at ${iso(ctx.periodStart)}: ${opening.amount}.`,
      `Accrued this period: ${Math.max(0, accrued)}.`,
    ],
  };
}

const earlier = (a: Date, b: Date): Date => (a.getTime() < b.getTime() ? a : b);

const iso = (d: Date): string => d.toISOString().slice(0, 10);
