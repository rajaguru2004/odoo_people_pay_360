import { describe, expect, it } from 'vitest';
import { payrollFeaturesFrom } from './usePayrollFeatures';

/**
 * The read side of the same argument the backend registry spec makes: a payroll
 * extension that is not explicitly on must be off, and must be off for every
 * way "not explicitly on" can happen.
 */
describe('payrollFeaturesFrom', () => {
  it('reads every feature off when the payload is empty', () => {
    expect(payrollFeaturesFrom({})).toEqual({
      itemLines: false,
      loaded: false,
    });
  });

  it('separates "off" from "not read yet"', () => {
    // Every flag defaults false, so without this a screen cannot tell a feature
    // that IS off from one whose settings have not arrived — and the payroll
    // extension screens printed "switched off" as a fact in that window. An
    // admin who had just turned a switch on was told it was off.
    expect(payrollFeaturesFrom({}).loaded).toBe(false);
    expect(payrollFeaturesFrom({}, true).loaded).toBe(true);
    expect(payrollFeaturesFrom(undefined, true).loaded).toBe(true);
  });

  it('reads every feature off when there is no branding at all', () => {
    // The window between app mount and the first /system-settings/public
    // response. A feature must not be briefly on during it.
    expect(payrollFeaturesFrom(undefined).itemLines).toBe(false);
    expect(payrollFeaturesFrom(null).itemLines).toBe(false);
  });

  it('does not treat a missing key as enabled', () => {
    // An older backend that has never heard of these keys returns none of them.
    // `!== false` would read every one of those as ON.
    const partial = { company_name: 'X' } as never;
    const { loaded: _loaded, ...flags } = payrollFeaturesFrom(partial);
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });

  it.each([undefined, null, 'true', 1, {}, []])(
    'treats %p as off, because only a real boolean true is on',
    (junk) => {
      const f = payrollFeaturesFrom({
        payroll_item_lines_enabled: junk,
      } as never);
      expect(f.itemLines).toBe(false);
    },
  );

  it('turns on exactly the feature named', () => {
    const f = payrollFeaturesFrom({
      payroll_item_lines_enabled: true,
    } as never);
    expect(f.itemLines).toBe(true);
  });
});
