import {
  accrueForPeriod,
  entitlementAt,
  resolveRules,
  ruleApplies,
  serviceYearsBetween,
  type GratuityContext,
  type GratuityRuleLike,
} from './gratuity-calculator';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const rule = (over: Partial<GratuityRuleLike> = {}): GratuityRuleLike => ({
  id: 'r1',
  country: 'OM',
  nationalityClass: 'EXPAT',
  fromYears: 0,
  toYears: null,
  daysPerYear: 30,
  basis: 'BASIC',
  monthDays: 30,
  employerShare: 1,
  effectiveFrom: d('2023-07-26'),
  effectiveTo: null,
  isActive: true,
  ...over,
});

const ctx = (over: Partial<GratuityContext> = {}): GratuityContext => ({
  employmentStart: d('2020-01-01'),
  asOf: d('2025-01-01'),
  monthlyBasic: 900,
  monthlyGross: 1200,
  nationalityClass: 'EXPAT',
  country: 'OM',
  serviceYearDays: 365,
  ...over,
});

describe('gratuity calculator', () => {
  describe('service length', () => {
    it('counts a whole year', () => {
      expect(serviceYearsBetween(d('2024-01-01'), d('2025-01-01'))).toBeCloseTo(1.0027, 3);
    });

    it('is fractional, not whole years', () => {
      // Half a year of service earns half a year of benefit. Rounding to whole
      // years would either rob an employee or overstate a liability.
      expect(serviceYearsBetween(d('2024-01-01'), d('2024-07-01'))).toBeCloseTo(0.4986, 3);
    });

    it('is zero before the employee started', () => {
      expect(serviceYearsBetween(d('2025-01-01'), d('2024-01-01'))).toBe(0);
    });

    it('honours a different day-count convention', () => {
      // The convention is a legal variable, not a constant.
      expect(serviceYearsBetween(d('2024-01-01'), d('2025-01-01'), 360)).toBeCloseTo(1.0167, 3);
    });
  });

  describe('the seeded Oman rule, and the rate it does NOT quite reproduce', () => {
    it('earns one month of basic per year of service', () => {
      // "30 days of basic wages for each year of service", priced the standard
      // Gulf way: a day is a month divided by 30. So a year earns exactly one
      // month's basic — 1/12 of annual, or 0.0833.
      const r = entitlementAt(
        ctx({ employmentStart: d('2024-01-01'), asOf: d('2025-01-01') }),
        [rule()],
      );
      const annualBasic = 900 * 12;
      expect(r.amount / annualBasic).toBeCloseTo(0.0833, 3);
    });

    it('is deliberately NOT the 0.0822 the unused setting displayed', () => {
      // `payroll_gratuity_rate` has shipped as 0.0822, documented in the preset
      // as "30/365". That prices a day as ANNUAL basic ÷ 365 rather than as
      // monthly ÷ 30, which is a different convention and about 1.4% lower.
      //
      // The divergence is safe to take because that setting has never been read
      // by anything — there is no behaviour to preserve, only a number that was
      // displayed. The standard reading is used instead, and the difference is
      // recorded here so nobody later "fixes" one to match the other by
      // accident. Which convention Oman actually requires is on the open-questions
      // list for the legal advisor; `monthDays` is the field that expresses it.
      const r = entitlementAt(
        ctx({ employmentStart: d('2024-01-01'), asOf: d('2025-01-01') }),
        [rule()],
      );
      const ratio = r.amount / (900 * 12);
      expect(ratio).toBeGreaterThan(0.0822);
      expect(ratio - 0.0822).toBeLessThan(0.002);
    });

    it('expresses the 365-day convention as monthDays, with no code change', () => {
      // If the advisor says annual ÷ 365, this is the whole change: one field.
      const r = entitlementAt(
        ctx({ employmentStart: d('2024-01-01'), asOf: d('2025-01-01') }),
        [rule({ monthDays: 365 / 12 })],
      );
      expect(r.amount / (900 * 12)).toBeCloseTo(0.0822, 3);
    });
  });

  describe('banding — the decision that cannot be retrofitted', () => {
    const preAndPost = [
      rule({ id: 'low', fromYears: 0, toYears: 3, daysPerYear: 15 }),
      rule({ id: 'high', fromYears: 3, toYears: null, daysPerYear: 30 }),
    ];

    it('splits five years across two bands, not five at the higher rate', () => {
      // The whole point. A bracket LOOKUP would price all 5 years at 30 days;
      // the law prices the first 3 at 15 and only the rest at 30.
      const r = entitlementAt(
        ctx({ employmentStart: d('2020-01-01'), asOf: d('2025-01-01') }),
        preAndPost,
      );
      expect(r.bands.map((b) => b.ruleId)).toEqual(['low', 'high']);
      expect(r.bands[0].yearsInBand).toBeCloseTo(3, 2);
      expect(r.bands[1].yearsInBand).toBeCloseTo(2.0055, 2);

      const dayRate = 900 / 30;
      const expected = 3 * 15 * dayRate + 2.0055 * 30 * dayRate;
      expect(r.amount).toBeCloseTo(expected, 0);
    });

    it('is materially different from the naive lookup', () => {
      const banded = entitlementAt(
        ctx({ employmentStart: d('2020-01-01'), asOf: d('2025-01-01') }),
        preAndPost,
      );
      const naive = 5.0055 * 30 * (900 / 30);
      // ~40% apart. This is the number that would have to be recomputed for
      // every employee if the shape were fixed later.
      expect(banded.amount).toBeLessThan(naive * 0.75);
    });

    it('uses only the first band when service has not reached the second', () => {
      const r = entitlementAt(
        ctx({ employmentStart: d('2023-01-01'), asOf: d('2025-01-01') }),
        preAndPost,
      );
      expect(r.bands.map((b) => b.ruleId)).toEqual(['low']);
    });

    it('skips a band the employee never entered', () => {
      const r = entitlementAt(
        ctx({ employmentStart: d('2024-06-01'), asOf: d('2025-01-01') }),
        preAndPost,
      );
      expect(r.bands).toHaveLength(1);
      expect(r.bands[0].ruleId).toBe('low');
    });
  });

  describe('nationality', () => {
    it('refuses rather than guessing when the class is unrecorded', () => {
      // Reporting an unknown class as a zero entitlement would hide a missing
      // record behind a plausible number, and the number is a legal one.
      const r = entitlementAt(ctx({ nationalityClass: null }), [rule()]);
      expect(r.amount).toBe(0);
      expect(r.refusal).toMatch(/nationality class is not recorded/i);
    });

    it('applies a class-specific rule over the ANY fallback', () => {
      const rules = [
        rule({ id: 'any', nationalityClass: 'ANY', daysPerYear: 30 }),
        rule({ id: 'nat', nationalityClass: 'NATIONAL', daysPerYear: 10 }),
      ];
      const forNational = resolveRules(rules, 'OM', 'NATIONAL', d('2025-01-01'));
      // Both match a national; the calculator bands across whatever applies, so
      // this asserts the resolver is not silently dropping one.
      expect(forNational.map((r) => r.id).sort()).toEqual(['any', 'nat']);
    });

    it('expresses the Social Protection Fund as employerShare = 0', () => {
      // A national whose benefit is carried by the state fund: the employer
      // provisions nothing, but the employee's entitlement is unchanged. No
      // schema change was needed to say that.
      const r = entitlementAt(ctx({ nationalityClass: 'NATIONAL' }), [
        rule({ nationalityClass: 'NATIONAL', employerShare: 0 }),
      ]);
      expect(r.amount).toBe(0);
      expect(r.grossEntitlement).toBeGreaterThan(0);
    });
  });

  describe('rule selection', () => {
    it('ignores an inactive rule', () => {
      expect(ruleApplies(rule({ isActive: false }), 'OM', 'EXPAT', d('2025-01-01'))).toBe(false);
    });

    it('ignores a rule for another country', () => {
      expect(ruleApplies(rule({ country: 'AE' }), 'OM', 'EXPAT', d('2025-01-01'))).toBe(false);
    });

    it('ignores a rule that had not taken effect yet', () => {
      expect(ruleApplies(rule({ effectiveFrom: d('2026-01-01') }), 'OM', 'EXPAT', d('2025-01-01'))).toBe(false);
    });

    it('ignores a rule that has been superseded', () => {
      expect(ruleApplies(rule({ effectiveTo: d('2024-01-01') }), 'OM', 'EXPAT', d('2025-01-01'))).toBe(false);
    });

    it('orders rules totally, so two runs cannot disagree', () => {
      const rules = [
        rule({ id: 'b', fromYears: 3 }),
        rule({ id: 'a', fromYears: 0 }),
        rule({ id: 'c', fromYears: 3 }),
      ];
      expect(resolveRules(rules, 'OM', 'EXPAT', d('2025-01-01')).map((r) => r.id))
        .toEqual(['a', 'b', 'c']);
    });

    it('says so when nothing is configured', () => {
      const r = entitlementAt(ctx(), []);
      expect(r.refusal).toMatch(/no end-of-service rule is configured/i);
    });
  });

  describe('basis', () => {
    it('prices a day from basic by default', () => {
      const r = entitlementAt(
        ctx({ employmentStart: d('2024-01-01'), asOf: d('2025-01-01') }),
        [rule()],
      );
      expect(r.bands[0].dayRate).toBe(30); // 900 / 30
    });

    it('prices a day from gross when the rule says so', () => {
      const r = entitlementAt(
        ctx({ employmentStart: d('2024-01-01'), asOf: d('2025-01-01') }),
        [rule({ basis: 'GROSS' })],
      );
      expect(r.bands[0].dayRate).toBe(40); // 1200 / 30
    });
  });

  describe('the monthly provision', () => {
    it('accrues the difference between opening and closing entitlement', () => {
      const r = accrueForPeriod(
        {
          ...ctx({ employmentStart: d('2024-01-01'), asOf: d('2025-02-01') }),
          periodStart: d('2025-01-01'),
        },
        [rule()],
      );
      // A year earns one month's basic (900), so a month earns about a twelfth
      // of that — 75, plus a little for the extra days in a 31-day month.
      expect(r.amount).toBeCloseTo(76.5, 0);
      expect(r.openingEntitlement).toBeGreaterThan(0);
    });

    it('blends automatically in the month a band boundary is crossed', () => {
      // The reason accrual is a difference of entitlements rather than a
      // twelfth of a year: no special case is needed for the crossing month.
      const rules = [
        rule({ id: 'low', fromYears: 0, toYears: 3, daysPerYear: 15 }),
        rule({ id: 'high', fromYears: 3, toYears: null, daysPerYear: 30 }),
      ];
      const before = accrueForPeriod(
        { ...ctx({ employmentStart: d('2022-01-01'), asOf: d('2024-06-01') }), periodStart: d('2024-05-01') },
        rules,
      );
      const crossing = accrueForPeriod(
        { ...ctx({ employmentStart: d('2022-01-01'), asOf: d('2025-02-01') }), periodStart: d('2025-01-01') },
        rules,
      );
      expect(crossing.amount).toBeGreaterThan(before.amount);
    });

    it('never claws back a provision already set aside', () => {
      // A rate that falls, or a rule retired mid-service, must not produce a
      // negative accrual that reduces a liability someone has already reported.
      const r = accrueForPeriod(
        {
          ...ctx({ employmentStart: d('2020-01-01'), asOf: d('2025-02-01') }),
          periodStart: d('2025-01-01'),
        },
        [rule({ daysPerYear: 0 })],
      );
      expect(r.amount).toBeGreaterThanOrEqual(0);
    });

    it('accrues nothing before the employee starts', () => {
      const r = accrueForPeriod(
        {
          ...ctx({ employmentStart: d('2026-01-01'), asOf: d('2025-02-01') }),
          periodStart: d('2025-01-01'),
        },
        [rule()],
      );
      expect(r.amount).toBe(0);
    });
  });

  describe('the working', () => {
    it('states the service, every band and the total', () => {
      // Stored verbatim on the accrual, because a settlement disputed five years
      // later cannot be answered with "the system would calculate it differently
      // now".
      const r = entitlementAt(
        ctx({ employmentStart: d('2024-01-01'), asOf: d('2025-01-01') }),
        [rule()],
      );
      expect(r.workingLines[0]).toMatch(/^Service: .* from 2024-01-01 to 2025-01-01/);
      expect(r.workingLines.some((l) => l.includes('Band 0–∞'))).toBe(true);
      expect(r.workingLines[r.workingLines.length - 1]).toMatch(/^Total employer-borne entitlement:/);
    });

    it('names the employer share when it is not the whole amount', () => {
      const r = entitlementAt(ctx({ nationalityClass: 'NATIONAL' }), [
        rule({ nationalityClass: 'NATIONAL', employerShare: 0.5 }),
      ]);
      expect(r.workingLines.some((l) => l.includes('employer share 0.5'))).toBe(true);
    });
  });
});
