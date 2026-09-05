import { Injectable } from '@nestjs/common';
import { SystemSettingsService } from '../system-settings/system-settings.service';

/**
 * Which payroll extensions are switched on.
 *
 * Deliberately NOT part of `PayrollConfig`. `PayrollConfig` is the *calculation*
 * config, and the spec fixtures build it as an object literal. Adding a required
 * field there breaks all of them at compile time; adding an optional one gives
 * every existing test a silent default, which is worse — the fixture would stop
 * describing what the engine actually runs with.
 *
 * Keeping the switches in their own object also keeps the honest property that
 * makes this safe: `calculateSalaryOptimized`'s signature never changes, so the
 * arithmetic that produces today's payslips cannot be altered by anything here.
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

  leaveCarryForwardEnabled: boolean;
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

  leaveCarryForwardEnabled: false,
};

/** Present-and-'true' rather than not-'false': an unset key must read OFF. */
const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : v.trim().toLowerCase() === 'true';

/**
 * Reads the raw setting map into the typed flag object.
 *
 * Pure and exported so it can be unit-tested as a table without a database —
 * the resolution rule (unset reads OFF) is the part worth pinning.
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

    leaveCarryForwardEnabled: bool(
      raw.leave_carry_forward_enabled,
      d.leaveCarryForwardEnabled,
    ),
  };
}

/**
 * Resolves the payroll feature switches.
 *
 * `SystemSetting` is a flat, key-unique global table with no branch column, and
 * this deliberately does not give it one: it is read on nearly every request
 * path, and a scope column there is disproportionate to the problem.
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
