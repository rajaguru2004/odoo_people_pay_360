import { Injectable } from '@nestjs/common';
import { SystemSettingsService } from '../system-settings/system-settings.service';

/**
 * Which payroll extensions are switched on.
 *
 * Deliberately NOT part of `PayrollConfig`. `PayrollConfig` is the *calculation*
 * config, and four spec fixtures build it as an object literal
 * (`payrolls-money-invariants`, `payrolls-daily-wage`, `overtime-cycle`,
 * `payrolls-overtime`). Adding a
 * required field there breaks all four at compile time; adding an optional one
 * gives every existing test a silent default, which is worse — the fixture would
 * stop describing what the engine actually runs with.
 *
 * Keeping the switches in their own object also keeps the honest property that
 * makes this whole phase safe: `calculateSalaryOptimized`'s signature never
 * changes, so the arithmetic that produces today's payslips cannot be altered by
 * anything here.
 */
export interface PayrollFeatureFlags {
  /** Write an itemised breakdown alongside each payslip total. */
  itemLinesEnabled: boolean;
  /**
   * Refuse a run whose lines do not sum to its stored totals.
   *
   * Defaults TRUE, unlike every other flag here, because it is not a feature
   * switch — it is the failure mode of one. The safe state for "the itemisation
   * disagrees with the money" is to refuse, not to publish a payslip that does
   * not add up.
   */
  itemLinesStrictReconciliation: boolean;

  /** Master switch for end-of-service benefits. */
  eosbEnabled: boolean;
  /** Write a monthly gratuity accrual when a payroll locks. */
  eosbAccrualEnabled: boolean;
  /** Allow final-settlement documents to be prepared. */
  eosbSettlementEnabled: boolean;
  /** What to do when an employee's nationality class is unrecorded. */
  eosbUnknownNationalityPolicy: 'BLOCK' | 'SKIP';
  /** Divisor for the fractional years-of-service calculation. */
  eosbServiceYearDays: number;
  /**
   * Pay the benefit through the FINAL_SETTLEMENT run rather than outside payroll.
   *
   * Off, gratuity is a provision and never a payslip line. On, the exit payout
   * reaches the payslip and therefore the wage file — which some jurisdictions
   * require and others do not, so it is the client's call rather than ours.
   */
  eosbPayThroughFinalRun: boolean;

  leaveEncashmentEnabled: boolean;
  /** Whether encashment joins the taxable and statutory base. */
  leaveEncashmentTaxable: boolean;
  leaveCarryForwardEnabled: boolean;

  calendarEnabled: boolean;
  /** WARN leaves a cut-off advisory; BLOCK refuses generation. */
  cutOffEnforcement: 'WARN' | 'BLOCK';

  preflightEnabled: boolean;

  employeeRecoveryEnabled: boolean;
  /** A recovery is bounded by the minimum-take-home floor. */
  recoveryRespectsMinNet: boolean;

  employeeTransferEnabled: boolean;
  /** Which date decides the paying branch. */
  transferPayBasis: 'PERIOD_END' | 'CUT_OFF';

  gradeEnabled: boolean;
  reportsEnabled: boolean;
}

/**
 * Every switch off, and every non-boolean at the value that reproduces today's
 * behaviour.
 *
 * This is also what a test gets when it stubs `PayrollFeaturesService`, so a new
 * flag cannot be added without every existing caller seeing the inert value.
 */
export const DEFAULT_PAYROLL_FEATURES: PayrollFeatureFlags = {
  itemLinesEnabled: false,
  itemLinesStrictReconciliation: true,

  eosbEnabled: false,
  eosbAccrualEnabled: false,
  eosbSettlementEnabled: false,
  eosbUnknownNationalityPolicy: 'BLOCK',
  eosbServiceYearDays: 365,
  eosbPayThroughFinalRun: false,

  leaveEncashmentEnabled: false,
  leaveEncashmentTaxable: true,
  leaveCarryForwardEnabled: false,

  calendarEnabled: false,
  cutOffEnforcement: 'WARN',

  preflightEnabled: false,

  employeeRecoveryEnabled: false,
  recoveryRespectsMinNet: true,

  employeeTransferEnabled: false,
  transferPayBasis: 'PERIOD_END',

  gradeEnabled: false,
  reportsEnabled: false,
};

/** Present-and-'true' rather than not-'false': an unset key must read OFF. */
const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : v.trim().toLowerCase() === 'true';

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const oneOf = <T extends string>(
  v: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T => {
  const up = (v ?? '').trim().toUpperCase();
  return (allowed as readonly string[]).includes(up) ? (up as T) : fallback;
};

/**
 * Reads the raw setting map into the typed flag object.
 *
 * Pure and exported so it can be unit-tested as a table without a database —
 * the resolution rules (unset reads OFF, an unrecognised enum falls back rather
 * than throwing) are the part worth pinning.
 */
export function resolvePayrollFeatures(
  raw: Record<string, string>,
): PayrollFeatureFlags {
  const d = DEFAULT_PAYROLL_FEATURES;
  return {
    itemLinesEnabled: bool(raw.payroll_item_lines_enabled, d.itemLinesEnabled),
    itemLinesStrictReconciliation: bool(
      raw.payroll_item_lines_strict_reconciliation,
      d.itemLinesStrictReconciliation,
    ),

    eosbEnabled: bool(raw.payroll_eosb_enabled, d.eosbEnabled),
    eosbAccrualEnabled: bool(
      raw.payroll_eosb_accrual_enabled,
      d.eosbAccrualEnabled,
    ),
    eosbSettlementEnabled: bool(
      raw.payroll_eosb_settlement_enabled,
      d.eosbSettlementEnabled,
    ),
    eosbUnknownNationalityPolicy: oneOf(
      raw.payroll_eosb_unknown_nationality_policy,
      ['BLOCK', 'SKIP'] as const,
      d.eosbUnknownNationalityPolicy,
    ),
    eosbServiceYearDays: num(
      raw.payroll_eosb_service_year_days,
      d.eosbServiceYearDays,
    ),
    eosbPayThroughFinalRun: bool(
      raw.payroll_eosb_pay_through_final_run,
      d.eosbPayThroughFinalRun,
    ),

    leaveEncashmentEnabled: bool(
      raw.leave_encashment_enabled,
      d.leaveEncashmentEnabled,
    ),
    leaveEncashmentTaxable: bool(
      raw.leave_encashment_taxable,
      d.leaveEncashmentTaxable,
    ),
    leaveCarryForwardEnabled: bool(
      raw.leave_carry_forward_enabled,
      d.leaveCarryForwardEnabled,
    ),

    calendarEnabled: bool(raw.payroll_calendar_enabled, d.calendarEnabled),
    cutOffEnforcement: oneOf(
      raw.payroll_cutoff_enforcement,
      ['WARN', 'BLOCK'] as const,
      d.cutOffEnforcement,
    ),

    preflightEnabled: bool(raw.payroll_preflight_enabled, d.preflightEnabled),

    employeeRecoveryEnabled: bool(
      raw.payroll_employee_recovery_enabled,
      d.employeeRecoveryEnabled,
    ),
    recoveryRespectsMinNet: bool(
      raw.payroll_recovery_respects_min_net,
      d.recoveryRespectsMinNet,
    ),

    employeeTransferEnabled: bool(
      raw.employee_transfer_enabled,
      d.employeeTransferEnabled,
    ),
    transferPayBasis: oneOf(
      raw.payroll_transfer_pay_basis,
      ['PERIOD_END', 'CUT_OFF'] as const,
      d.transferPayBasis,
    ),

    gradeEnabled: bool(raw.employee_grade_enabled, d.gradeEnabled),
    reportsEnabled: bool(raw.payroll_reports_enabled, d.reportsEnabled),
  };
}

/**
 * Resolves the payroll feature switches.
 *
 * `SystemSetting` is a flat, key-unique global table with no branch column, and
 * this phase deliberately does not give it one: it is read on nearly every
 * request path, and a scope column there is disproportionate to the problem.
 * Features that genuinely need to vary per branch carry the variation in their
 * own table instead — the payroll calendar's `enforceCutOff` is the worked
 * example.
 *
 * Callers resolve ONCE, before opening any transaction, and pass the object
 * down. That is what makes the flags-off guarantee cheap: with a switch off the
 * caller issues no additional statements at all, rather than issuing a query
 * that returns nothing.
 */
@Injectable()
export class PayrollFeaturesService {
  constructor(private settings: SystemSettingsService) {}

  async resolve(): Promise<PayrollFeatureFlags> {
    const list = await this.settings.getSettingsList();
    const raw: Record<string, string> = {};
    for (const row of list as Array<{ key: string; value: string }>) {
      raw[row.key] = row.value;
    }
    return resolvePayrollFeatures(raw);
  }
}
