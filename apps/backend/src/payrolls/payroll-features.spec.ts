import {
  DEFAULT_PAYROLL_FEATURES,
  resolvePayrollFeatures,
} from './payroll-features.service';

describe('resolvePayrollFeatures', () => {
  describe('an empty setting map', () => {
    it('reproduces the shipped defaults', () => {
      expect(resolvePayrollFeatures({})).toEqual(DEFAULT_PAYROLL_FEATURES);
    });

    it('leaves every feature switch off', () => {
      const f = resolvePayrollFeatures({});
      expect(f.itemLinesEnabled).toBe(false);
      expect(f.leaveCarryForwardEnabled).toBe(false);
    });

    it('keeps strict reconciliation on — the failure mode of a switch, not a switch', () => {
      expect(resolvePayrollFeatures({}).itemLinesStrictReconciliation).toBe(true);
    });
  });

  describe('boolean resolution', () => {
    const keys = [
      'payroll_item_lines_enabled',
      'leave_carry_forward_enabled',
    ] as const;

    it.each(keys)('reads %s as OFF when unrecognised', (key) => {
      for (const junk of ['', ' ', 'yes', '1', 'TRUEISH', 'null']) {
        expect(resolvePayrollFeatures({ [key]: junk })).toEqual(
          DEFAULT_PAYROLL_FEATURES,
        );
      }
    });

    it.each(keys)('reads %s as ON for any casing of "true"', (key) => {
      for (const on of ['true', 'TRUE', ' True ']) {
        const f = resolvePayrollFeatures({ [key]: on }) as unknown as Record<string, unknown>;
        const off = DEFAULT_PAYROLL_FEATURES as unknown as Record<string, unknown>;
        // exactly one flag moved
        const moved = Object.keys(f).filter((k) => f[k] !== off[k]);
        expect(moved).toHaveLength(1);
        expect(f[moved[0]]).toBe(true);
      }
    });

    it('turns strict reconciliation off on anything that is not "true"', () => {
      for (const off of ['false', 'nonsense', '']) {
        expect(
          resolvePayrollFeatures({
            payroll_item_lines_strict_reconciliation: off,
          }).itemLinesStrictReconciliation,
        ).toBe(false);
      }
      // Only an ABSENT key keeps the safe default.
      expect(resolvePayrollFeatures({}).itemLinesStrictReconciliation).toBe(true);
    });
  });

  it('ignores keys it does not know', () => {
    expect(
      resolvePayrollFeatures({ some_other_module_enabled: 'true' }),
    ).toEqual(DEFAULT_PAYROLL_FEATURES);
  });
});
