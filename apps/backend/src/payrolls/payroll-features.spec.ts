import {
  DEFAULT_PAYROLL_FEATURES,
  resolvePayrollFeatures,
} from './payroll-features.service';

/**
 * The resolver is the single point where a settings row becomes a decision the
 * payroll engine acts on, so the rules it applies to a missing or malformed
 * value are the whole safety argument for the phase these flags introduce.
 *
 * Layer 0: no Nest, no Prisma, no database. The function takes a plain map.
 */
describe('payroll feature resolution', () => {
  describe('an empty settings map is the inert state', () => {
    it('matches DEFAULT_PAYROLL_FEATURES exactly', () => {
      // A fresh install, and equally an install that has never heard of these
      // keys, must behave identically to the payroll that shipped before them.
      expect(resolvePayrollFeatures({})).toEqual(DEFAULT_PAYROLL_FEATURES);
    });

    it('leaves every feature switch off', () => {
      const f = resolvePayrollFeatures({});
      expect(f.itemLinesEnabled).toBe(false);
      expect(f.eosbEnabled).toBe(false);
      expect(f.eosbAccrualEnabled).toBe(false);
      expect(f.eosbSettlementEnabled).toBe(false);
      expect(f.leaveEncashmentEnabled).toBe(false);
      expect(f.leaveCarryForwardEnabled).toBe(false);
      expect(f.calendarEnabled).toBe(false);
      expect(f.preflightEnabled).toBe(false);
      expect(f.employeeRecoveryEnabled).toBe(false);
      expect(f.employeeTransferEnabled).toBe(false);
      expect(f.gradeEnabled).toBe(false);
      expect(f.reportsEnabled).toBe(false);
    });

    it('still turns strict reconciliation ON', () => {
      // The one default that is true, because it is the failure mode of a
      // feature rather than a feature. "The lines disagree with the money"
      // must refuse, not publish.
      expect(resolvePayrollFeatures({}).itemLinesStrictReconciliation).toBe(
        true,
      );
    });
  });

  describe('a missing key reads OFF, never ON', () => {
    it.each([
      'payroll_item_lines_enabled',
      'payroll_eosb_enabled',
      'leave_encashment_enabled',
      'payroll_calendar_enabled',
      'payroll_employee_recovery_enabled',
      'employee_transfer_enabled',
    ])('%s absent is the same as false', (key) => {
      const absent = resolvePayrollFeatures({});
      const explicit = resolvePayrollFeatures({ [key]: 'false' });
      expect(explicit).toEqual(absent);
    });

    it('does not treat a value of anything-but-false as true', () => {
      // The codebase has both idioms — `=== 'true'` and `!== 'false'`. The
      // second one turns a typo, an empty string, or a stray 'off' into an
      // enabled feature. These use the first.
      for (const junk of ['', 'off', 'no', '0', 'TRU', 'yes', 'enabled']) {
        expect(
          resolvePayrollFeatures({ payroll_eosb_enabled: junk }).eosbEnabled,
        ).toBe(false);
      }
    });
  });

  describe('turning a switch on', () => {
    it('accepts true regardless of case or padding', () => {
      for (const on of ['true', 'TRUE', 'True', '  true  ']) {
        expect(
          resolvePayrollFeatures({ payroll_eosb_enabled: on }).eosbEnabled,
        ).toBe(true);
      }
    });

    it('turns on only the switch it names', () => {
      const f = resolvePayrollFeatures({ payroll_eosb_enabled: 'true' });
      expect(f.eosbEnabled).toBe(true);
      // The master switch does not imply its dependents. Accrual and settlement
      // are separately staged so an installation can adopt one at a time.
      expect(f.eosbAccrualEnabled).toBe(false);
      expect(f.eosbSettlementEnabled).toBe(false);
      expect(f.itemLinesEnabled).toBe(false);
    });
  });

  describe('enumerations fall back rather than throw', () => {
    it.each([
      ['payroll_cutoff_enforcement', 'cutOffEnforcement', 'WARN'],
      [
        'payroll_recovery_ladder_position',
        'recoveryLadderPosition',
        'AFTER_LOAN',
      ],
      ['payroll_transfer_pay_basis', 'transferPayBasis', 'PERIOD_END'],
      [
        'payroll_eosb_unknown_nationality_policy',
        'eosbUnknownNationalityPolicy',
        'BLOCK',
      ],
    ] as const)(
      '%s falls back to %s on an unrecognised value',
      (key, field, fallback) => {
        // A payroll run must not fail to generate because a settings row holds a
        // word nobody recognises; it must behave the safe way and carry on.
        const f = resolvePayrollFeatures({ [key]: 'SOMETHING_ELSE' });
        expect(f[field]).toBe(fallback);
      },
    );

    it('accepts a recognised value case-insensitively', () => {
      expect(
        resolvePayrollFeatures({ payroll_cutoff_enforcement: 'block' })
          .cutOffEnforcement,
      ).toBe('BLOCK');
      expect(
        resolvePayrollFeatures({ payroll_transfer_pay_basis: 'cut_off' })
          .transferPayBasis,
      ).toBe('CUT_OFF');
    });
  });

  describe('the service-year divisor', () => {
    it('defaults to 365', () => {
      expect(resolvePayrollFeatures({}).eosbServiceYearDays).toBe(365);
    });

    it('accepts a positive override', () => {
      expect(
        resolvePayrollFeatures({ payroll_eosb_service_year_days: '360' })
          .eosbServiceYearDays,
      ).toBe(360);
    });

    it.each(['0', '-1', 'abc', ''])(
      'refuses %s and keeps 365, because it is a divisor',
      (bad) => {
        // Zero or negative would produce Infinity or a negative entitlement.
        expect(
          resolvePayrollFeatures({ payroll_eosb_service_year_days: bad })
            .eosbServiceYearDays,
        ).toBe(365);
      },
    );
  });

  describe('the two defaults that reproduce current behaviour', () => {
    it('pays the whole month in the branch holding the employee at period end', () => {
      // PERIOD_END is not a new mode — it is what the engine does today, because
      // employee lookup is branch-scoped at generation time and runs are
      // generated after the period closes. It therefore needs no new code.
      expect(resolvePayrollFeatures({}).transferPayBasis).toBe('PERIOD_END');
    });

    it('leaves a cut-off advisory', () => {
      // Enforcing by default would change what an existing client's run pays.
      expect(resolvePayrollFeatures({}).cutOffEnforcement).toBe('WARN');
    });
  });
});
