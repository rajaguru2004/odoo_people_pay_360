import { OvertimeConfig } from './overtime-config';
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
  foodAllowanceAmount: 150,
  regularRate: 1.5,
  lateRate: 1.5,
  doubleOtEnabled: true,
  doubleRate: 2,
  sunday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  holiday: { regularRate: 2.5, lateRate: 2.5, lateThreshold: '21:00' },
  shiftEndTime: '17:00',
  doubleFoodAllowanceAnyTime: false,
  doubleOtAllowAnytime: true,
  maxHoursPerDay: 4,
  maxHoursPerDoubleDay: 12,
  maxHoursPerMonth: 30,
  maxHoursPerYear: 200,
  requireManagerApproval: true,
  allowEmployeeSubmit: true,
};

describe('overtime-policy rules helpers', () => {
  it('buildDefaultRules mirrors the company config plus the policy defaults', () => {
    const r = buildDefaultRules(GLOBAL);
    expect(r.regularRate).toBe(1.5);
    expect(r.eligible).toBe(true);
    expect(r.holidayBehavior).toBe('STANDARD');
    expect(r.dayEndBoundary).toBeNull();
    expect(r.sunday).toEqual(GLOBAL.sunday);
    expect(r.holiday).toEqual(GLOBAL.holiday);
  });

  it('composeRules overlays a partial payload and deep-merges the tiers', () => {
    const r = composeRules(
      {
        regularRate: 1.25,
        holidayBehavior: 'IGNORE',
        sunday: { lateRate: 3 } as never,
      },
      GLOBAL,
    );
    expect(r.regularRate).toBe(1.25);
    expect(r.holidayBehavior).toBe('IGNORE');
    // Only sunday.lateRate changes; the rest of the tier survives.
    expect(r.sunday.lateRate).toBe(3);
    expect(r.sunday.regularRate).toBe(GLOBAL.sunday.regularRate);
    expect(r.lateRate).toBe(GLOBAL.lateRate);
  });

  it('overlayRules edits an existing blob without losing tier fields', () => {
    const base = buildDefaultRules(GLOBAL);
    const r = overlayRules(base, { holiday: { regularRate: 2.75 } as never });
    expect(r.holiday.regularRate).toBe(2.75);
    expect(r.holiday.lateThreshold).toBe(base.holiday.lateThreshold);
  });

  it('mergeRulesOverGlobal inherits omitted fields and keeps the org flags', () => {
    const cfg = mergeRulesOverGlobal({ regularRate: 1.25 }, GLOBAL);
    expect(cfg.regularRate).toBe(1.25);
    expect(cfg.lateRate).toBe(GLOBAL.lateRate);
    // The org-flow flags are not per-policy, so they come through untouched.
    expect(cfg.enabled).toBe(true);
    expect(cfg.allowEmployeeSubmit).toBe(true);
    expect(cfg.requireManagerApproval).toBe(true);
    expect(cfg.eligible).toBe(true);
    expect(cfg.holidayBehavior).toBe('STANDARD');
    expect(cfg.dayEndBoundary).toBeNull();
  });

  it('mergeRulesOverGlobal surfaces IGNORE and eligible:false', () => {
    const cfg = mergeRulesOverGlobal(
      { holidayBehavior: 'IGNORE', eligible: false, dayEndBoundary: '23:00' },
      GLOBAL,
    );
    expect(cfg.holidayBehavior).toBe('IGNORE');
    expect(cfg.eligible).toBe(false);
    expect(cfg.dayEndBoundary).toBe('23:00');
  });

  it('mergeRulesOverGlobal ignores a rule field of the wrong type', () => {
    // The blob is JSON: a hand-edited row can hold anything, and a rate that
    // reads as zero is a payslip of zero.
    const cfg = mergeRulesOverGlobal(
      { regularRate: 'fast' as never, sunday: { lateRate: null } as never },
      GLOBAL,
    );
    expect(cfg.regularRate).toBe(GLOBAL.regularRate);
    expect(cfg.sunday.lateRate).toBe(GLOBAL.sunday.lateRate);
  });

  it('resolvedFromGlobal is the company config with a null policy identity', () => {
    const cfg = resolvedFromGlobal(GLOBAL);
    expect(cfg.policyId).toBeNull();
    expect(cfg.policyName).toBeNull();
    expect(cfg.holidayBehavior).toBe('STANDARD');
    expect(cfg.regularRate).toBe(1.5);
  });
});
