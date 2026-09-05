import type { OvertimeConfig } from './overtime-config';
import {
  buildDefaultRules,
  composeRules,
  mergeRulesOverGlobal,
  overlayRules,
  resolvedFromGlobal,
} from './overtime-policy.types';

const GLOBAL: OvertimeConfig = {
  enabled: true,
  lateThreshold: '22:00',
  foodAllowanceEnabled: true,
  foodAllowanceThreshold: '22:00',
  foodAllowanceAmount: 3,
  regularRate: 1.25,
  lateRate: 1.5,
  doubleOtEnabled: true,
  doubleRate: 2,
  sunday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  holiday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  shiftEndTime: '17:00',
  doubleOtAllowAnytime: true,
  doubleFoodAllowanceAnyTime: false,
  maxHoursPerDay: 4,
  maxHoursPerDoubleDay: 12,
  maxHoursPerMonth: 30,
  maxHoursPerYear: 200,
  allowEmployeeSubmit: true,
  requireReason: true,
  approverEditEnabled: true,
  siteAllowanceEnabled: false,
  siteAllowanceMax: 0,
  dayEndBoundary: '23:59',
};

describe('buildDefaultRules', () => {
  it('mirrors the global configuration, so a default policy changes nobody', () => {
    const rules = buildDefaultRules(GLOBAL);
    expect(rules.regularRate).toBe(GLOBAL.regularRate);
    expect(rules.sunday).toEqual(GLOBAL.sunday);
    expect(rules.eligible).toBe(true);
    expect(rules.holidayBehavior).toBe('STANDARD');
    // null means "inherit the global boundary" rather than pinning a copy of it,
    // so changing the company value moves every policy that never overrode it.
    expect(rules.dayEndBoundary).toBeNull();
  });

  it('copies the tiers rather than aliasing them', () => {
    const rules = buildDefaultRules(GLOBAL);
    rules.sunday.regularRate = 99;
    expect(GLOBAL.sunday.regularRate).toBe(2);
  });
});

describe('composeRules', () => {
  it('fills every unnamed field from the global defaults', () => {
    const rules = composeRules({ regularRate: 1.75 }, GLOBAL);
    expect(rules.regularRate).toBe(1.75);
    // The point of composing: a form that named one field must not produce a
    // policy whose other rates are zero.
    expect(rules.lateRate).toBe(GLOBAL.lateRate);
    expect(rules.maxHoursPerYear).toBe(GLOBAL.maxHoursPerYear);
  });

  it('deep-merges a partial tier', () => {
    const rules = composeRules(
      { holiday: { lateThreshold: '20:00' } as never },
      GLOBAL,
    );
    expect(rules.holiday).toEqual({
      regularRate: 2,
      lateRate: 2,
      lateThreshold: '20:00',
    });
  });

  it('an absent payload is the defaults', () => {
    expect(composeRules(undefined, GLOBAL)).toEqual(buildDefaultRules(GLOBAL));
  });
});

describe('overlayRules', () => {
  it('keeps every field the edit did not name', () => {
    const existing = composeRules(
      { regularRate: 1.75, lateRate: 2.25 },
      GLOBAL,
    );
    const next = overlayRules(existing, { regularRate: 1.9 });
    expect(next.regularRate).toBe(1.9);
    // Reverting to the global default here would silently undo an
    // administrator's earlier edit on every unrelated save.
    expect(next.lateRate).toBe(2.25);
  });

  it('deep-merges a tier without dropping its other fields', () => {
    const existing = composeRules(undefined, GLOBAL);
    const next = overlayRules(existing, { sunday: { lateRate: 2.5 } as never });
    expect(next.sunday).toEqual({
      regularRate: 2,
      lateRate: 2.5,
      lateThreshold: '22:00',
    });
  });
});

describe('mergeRulesOverGlobal', () => {
  it('inherits a field a stored blob never had', () => {
    // The older-schema case: a rate the blob predates must fall back to the
    // global, never to zero — a 0× multiplier pays an hour worked at nothing.
    const merged = mergeRulesOverGlobal({ regularRate: 1.75 }, GLOBAL);
    expect(merged.regularRate).toBe(1.75);
    expect(merged.lateRate).toBe(GLOBAL.lateRate);
    expect(merged.holiday).toEqual(GLOBAL.holiday);
  });

  it('ignores a non-numeric rate rather than producing NaN', () => {
    const merged = mergeRulesOverGlobal(
      { regularRate: 'fast' as unknown as number },
      GLOBAL,
    );
    expect(merged.regularRate).toBe(GLOBAL.regularRate);
  });

  it('honours a per-policy day boundary and inherits the global otherwise', () => {
    expect(
      mergeRulesOverGlobal({ dayEndBoundary: '02:00' }, GLOBAL).dayEndBoundary,
    ).toBe('02:00');
    expect(
      mergeRulesOverGlobal({ dayEndBoundary: null }, GLOBAL).dayEndBoundary,
    ).toBe('23:59');
  });

  it('reads any holidayBehavior but IGNORE as STANDARD', () => {
    expect(
      mergeRulesOverGlobal({ holidayBehavior: 'IGNORE' }, GLOBAL)
        .holidayBehavior,
    ).toBe('IGNORE');
    expect(
      mergeRulesOverGlobal({ holidayBehavior: 'SOMETHING' as never }, GLOBAL)
        .holidayBehavior,
    ).toBe('STANDARD');
  });

  it('defaults eligibility to true, so a blob that predates the gate still pays', () => {
    expect(mergeRulesOverGlobal({}, GLOBAL).eligible).toBe(true);
    expect(mergeRulesOverGlobal({ eligible: false }, GLOBAL).eligible).toBe(
      false,
    );
  });
});

describe('resolvedFromGlobal', () => {
  it('is the global config with no policy attached', () => {
    const resolved = resolvedFromGlobal(GLOBAL);
    expect(resolved.policyId).toBeNull();
    expect(resolved.policyName).toBeNull();
    expect(resolved.eligible).toBe(true);
    expect(resolved.regularRate).toBe(GLOBAL.regularRate);
  });
});
