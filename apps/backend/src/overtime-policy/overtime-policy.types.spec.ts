import { OvertimeConfig } from '../system-settings/system-settings.service';
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
  it('buildDefaultRules mirrors global + STANDARD/eligible defaults', () => {
    const r = buildDefaultRules(GLOBAL);
    expect(r.regularRate).toBe(1.5);
    expect(r.eligible).toBe(true);
    expect(r.holidayBehavior).toBe('STANDARD');
    expect(r.dayEndBoundary).toBeNull();
    expect(r.sunday).toEqual(GLOBAL.sunday);
    expect(r.holiday).toEqual(GLOBAL.holiday);
  });

  it('composeRules overlays a partial payload and deep-merges tiers', () => {
    const r = composeRules(
      { regularRate: 1.25, holidayBehavior: 'IGNORE' as any, sunday: { lateRate: 3 } as any },
      GLOBAL,
    );
    expect(r.regularRate).toBe(1.25);
    expect(r.holidayBehavior).toBe('IGNORE');
    // deep-merge: only sunday.lateRate changes, the rest of the tier is preserved
    expect(r.sunday.lateRate).toBe(3);
    expect(r.sunday.regularRate).toBe(GLOBAL.sunday.regularRate);
    // untouched fields inherit the global
    expect(r.lateRate).toBe(GLOBAL.lateRate);
  });

  it('overlayRules edits an existing full blob, preserving tier fields', () => {
    const base = buildDefaultRules(GLOBAL);
    const r = overlayRules(base, { holiday: { regularRate: 2.75 } as any });
    expect(r.holiday.regularRate).toBe(2.75);
    expect(r.holiday.lateThreshold).toBe(base.holiday.lateThreshold);
  });

  it('mergeRulesOverGlobal inherits omitted fields and keeps org-level flags', () => {
    const cfg = mergeRulesOverGlobal({ regularRate: 1.25 }, GLOBAL);
    expect(cfg.regularRate).toBe(1.25);
    expect(cfg.lateRate).toBe(GLOBAL.lateRate);
    // org-flow flags are not per-policy → preserved from global
    expect(cfg.enabled).toBe(true);
    expect(cfg.allowEmployeeSubmit).toBe(true);
    expect(cfg.requireManagerApproval).toBe(true);
    // policy-level additions default sanely
    expect(cfg.eligible).toBe(true);
    expect(cfg.holidayBehavior).toBe('STANDARD');
    expect(cfg.dayEndBoundary).toBeNull();
  });

  it('mergeRulesOverGlobal surfaces IGNORE + eligible:false', () => {
    const cfg = mergeRulesOverGlobal(
      { holidayBehavior: 'IGNORE', eligible: false, dayEndBoundary: '23:00' },
      GLOBAL,
    );
    expect(cfg.holidayBehavior).toBe('IGNORE');
    expect(cfg.eligible).toBe(false);
    expect(cfg.dayEndBoundary).toBe('23:00');
  });

  it('resolvedFromGlobal = global values + defaults + null policy', () => {
    const cfg = resolvedFromGlobal(GLOBAL);
    expect(cfg.policyId).toBeNull();
    expect(cfg.policyName).toBeNull();
    expect(cfg.holidayBehavior).toBe('STANDARD');
    expect(cfg.regularRate).toBe(1.5);
  });
});
