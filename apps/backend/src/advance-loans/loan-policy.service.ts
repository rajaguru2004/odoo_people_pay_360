import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import type {
  DeferralMode,
  LeaveLoanPolicy,
  PaymentAllocationOrder,
  ShortfallPolicy,
} from './loan.types';

/**
 * The effective loan policy for one branch, after the resolution chain has run.
 *
 * Everything here is a plain number/string so the allocator can stay a pure
 * function and be unit-tested as a table.
 */
export interface ResolvedLoanPolicy {
  /** Master kill-switch. False => legacy installmentAmount recovery. */
  moduleV2Enabled: boolean;

  // Affordability
  minNetPayAmount: number;
  minNetPayPercent: number;
  maxTotalDeductionPercentOfNet: number;
  minPartialRecoveryAmount: number;

  // Behaviour when the pool cannot cover the instalment
  shortfallPolicy: ShortfallPolicy;
  deferralMode: DeferralMode;
  zeroSalaryPolicy: 'DEFER' | 'SKIP';

  // Leave interaction
  unpaidLeavePolicy: LeaveLoanPolicy;
  unpaidLeaveMinDays: number;

  // Ordering
  recoveryPriorityOrder: string[]; // e.g. ['ADVANCE','LOAN']
  priorityTiebreak: 'OLDEST_FIRST' | 'SMALLEST_BALANCE_FIRST';
  paymentAllocationOrder: PaymentAllocationOrder;

  // Run gating
  recoverOnRunTypes: string[];
  recoveryFailurePolicy: 'FAIL' | 'WARN';
  finalSettlementIgnoresMinNet: boolean;

  gracePeriodCycles: number;
  roundingTolerance: number;
  autoCloseOnFullRecovery: boolean;

  // ── Eligibility and authority, per branch ────────────────────────────────
  //
  // These six are `LoanPolicy` columns that existed with NO reader at all: the
  // table could hold a branch's answer and every consumer read the global
  // SystemSetting instead. Resolving them here is what makes a branch policy do
  // anything — the CRUD alone would have shipped a screen that saves values
  // nothing consults.
  maxActivePerEmployee: number;
  minServiceMonths: number;
  maxAmountMultipleOfSalary: number;
  interestDefaultMethod: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';
  /** CSV. Who may write a balance off in this branch. */
  writeOffRoles: string;
  /** CSV. Who may waive one. */
  waiverRoles: string;
}

/**
 * The hardcoded tail of the resolution chain.
 *
 * Also the shape tests provide when they stub LoanPolicyService, so a new
 * policy field cannot be added without every caller seeing a sane value.
 */
export const DEFAULT_LOAN_POLICY: ResolvedLoanPolicy = {
  moduleV2Enabled: false,
  minNetPayAmount: 0,
  minNetPayPercent: 0,
  // 50, matching the seeded `loan_max_total_deduction_percent_of_net`. It read
  // 100 here, so the two documented defaults disagreed and the setting silently
  // won — the hardcoded tail only surfaced on a database whose settings row was
  // missing, i.e. exactly when nobody was watching.
  maxTotalDeductionPercentOfNet: 50,
  minPartialRecoveryAmount: 1,
  shortfallPolicy: 'PARTIAL',
  deferralMode: 'CARRY_FORWARD',
  zeroSalaryPolicy: 'DEFER',
  unpaidLeavePolicy: 'PAUSE',
  unpaidLeaveMinDays: 1,
  recoveryPriorityOrder: ['ADVANCE', 'LOAN'],
  priorityTiebreak: 'OLDEST_FIRST',
  paymentAllocationOrder: 'INTEREST_FIRST',
  recoverOnRunTypes: ['REGULAR', 'FINAL_SETTLEMENT'],
  recoveryFailurePolicy: 'FAIL',
  finalSettlementIgnoresMinNet: true,
  gracePeriodCycles: 0,
  roundingTolerance: 1,
  autoCloseOnFullRecovery: true,
  maxActivePerEmployee: 2,
  minServiceMonths: 0,
  maxAmountMultipleOfSalary: 0,
  interestDefaultMethod: 'NONE',
  writeOffRoles: 'ADMIN',
  waiverRoles: 'ADMIN,HR_MANAGER',
};

const num = (v: string | null | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const csv = (v: string | null | undefined, fallback: string[]): string[] => {
  if (!v) return fallback;
  const parts = v
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return parts.length ? parts : fallback;
};

const oneOf = <T extends string>(
  v: string | null | undefined,
  allowed: readonly T[],
  fallback: T,
): T => {
  const up = (v ?? '').trim().toUpperCase();
  return (allowed as readonly string[]).includes(up) ? (up as T) : fallback;
};

/**
 * Resolves the loan policy that applies to a branch.
 *
 * Chain, most specific first:
 *   LoanPolicy(branchId) -> LoanPolicy(null) -> SystemSetting -> hardcoded
 *
 * `SystemSetting` is key-unique with no branch column and deliberately does not
 * gain one — the established per-branch precedent in this codebase is a
 * dedicated table/column (see SystemSettingsService.getGeofencingPolicy reading
 * Branch). `loan_policies` is that table.
 *
 * Per-loan-product overrides live on `LoanType` and are applied by the caller
 * that knows which product a request uses; they are not part of this branch
 * level.
 */
/**
 * The five products the requirement doc names. Seeded on demand so a fresh
 * install has a usable catalogue without a migration writing business data.
 */
export const DEFAULT_LOAN_TYPES = [
  { code: 'PERSONAL', name: 'Personal Loan', category: 'LOAN', defaultInstallments: 12, maxInstallments: 36, sortOrder: 1 },
  { code: 'SALARY_ADVANCE', name: 'Salary Advance', category: 'ADVANCE', defaultInstallments: 1, maxInstallments: 1, sortOrder: 2 },
  { code: 'VEHICLE', name: 'Vehicle Loan', category: 'LOAN', defaultInstallments: 24, maxInstallments: 60, sortOrder: 3 },
  { code: 'EDUCATION', name: 'Education Loan', category: 'LOAN', defaultInstallments: 24, maxInstallments: 60, sortOrder: 4 },
  { code: 'EMERGENCY', name: 'Emergency Loan', category: 'LOAN', defaultInstallments: 6, maxInstallments: 12, sortOrder: 5 },
] as const;

@Injectable()
export class LoanPolicyService implements OnModuleInit {
  private readonly logger = new Logger(LoanPolicyService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SystemSettingsService,
  ) {}

  /**
   * Guarantee the product catalogue exists on every boot.
   *
   * `seedDefaultTypes()` existed from the start and was called from exactly one
   * place — `prisma/seed-loans-demo.ts` — so a real installation had an empty
   * `loan_types` table and every per-product term on it (interest, processing
   * fee, security deposit, employer subsidy, per-grade ceilings) was
   * unreachable: nothing could carry a `loanTypeId` because there was no row to
   * point at. Seeding here is the same decision the overtime module already
   * makes for its Company Default policy.
   *
   * Idempotent, and failures are logged rather than fatal so a boot can still
   * complete on a database where the table has not been migrated yet.
   */
  async onModuleInit(): Promise<void> {
    try {
      const created = await this.seedDefaultTypes();
      if (created > 0) {
        this.logger.log(`Seeded ${created} default loan product(s).`);
      }
    } catch (err) {
      this.logger.warn(
        `Could not seed the default loan products: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Create any missing default loan product. Idempotent (skipDuplicates on the
   * unique code), so it is safe to call on every boot and safe to re-run after
   * an admin has edited or deactivated a product.
   */
  async seedDefaultTypes(): Promise<number> {
    const res = await this.prisma.loanType.createMany({
      data: DEFAULT_LOAN_TYPES.map((t) => ({ ...t })),
      skipDuplicates: true,
    });
    return res.count;
  }

  async resolve(branchId?: string | null): Promise<ResolvedLoanPolicy> {
    // One query covers both rows of the chain; `branchId` NULL is the global
    // fallback row rather than a separate table.
    const rows = await this.prisma.loanPolicy.findMany({
      where: {
        isActive: true,
        OR: [{ branchId: branchId ?? undefined }, { branchId: null }],
      },
    });
    const branchRow = branchId
      ? (rows.find((r) => r.branchId === branchId) ?? null)
      : null;
    const globalRow = rows.find((r) => r.branchId === null) ?? null;

    /** First non-null of: branch policy, global policy, then the setting. */
    const pick = async <T>(
      column: (
        r: (typeof rows)[number],
      ) => T | null | undefined,
      settingKey: string,
      settingDefault: string,
      parse: (raw: string | null | undefined) => T,
    ): Promise<T> => {
      for (const row of [branchRow, globalRow]) {
        if (!row) continue;
        const v = column(row);
        if (v !== null && v !== undefined) return v;
      }
      return parse(await this.settings.getSetting(settingKey, settingDefault));
    };

    const dec = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);

    const [
      moduleV2Enabled,
      minNetPayAmount,
      minNetPayPercent,
      maxTotalDeductionPercentOfNet,
      minPartialRecoveryAmount,
      shortfallPolicy,
      deferralMode,
      zeroSalaryPolicy,
      unpaidLeavePolicy,
      unpaidLeaveMinDays,
      recoveryPriorityOrder,
      priorityTiebreak,
      paymentAllocationOrder,
      recoverOnRunTypes,
      recoveryFailurePolicy,
      finalSettlementIgnoresMinNet,
      gracePeriodCycles,
      roundingTolerance,
      autoCloseOnFullRecovery,
      maxActivePerEmployee,
      minServiceMonths,
      maxAmountMultipleOfSalary,
      interestDefaultMethod,
      writeOffRoles,
      waiverRoles,
    ] = await Promise.all([
      this.settings
        .getSetting('loan_module_v2_enabled', 'false')
        .then((v) => v === 'true'),
      pick(
        (r) => dec(r.minNetPayAmount),
        'loan_min_net_pay_amount',
        '0',
        (v) => num(v, 0),
      ),
      pick(
        (r) => dec(r.minNetPayPercent),
        'loan_min_net_pay_percent',
        '0',
        (v) => num(v, 0),
      ),
      pick(
        (r) => dec(r.maxTotalDeductionPercentOfNet),
        'loan_max_total_deduction_percent_of_net',
        '50',
        (v) => num(v, 50),
      ),
      this.settings
        .getSetting('loan_min_partial_recovery_amount', '1')
        .then((v) => num(v, 1)),
      pick(
        (r) => r.shortfallPolicy as ShortfallPolicy | null,
        'loan_shortfall_policy',
        'PARTIAL',
        (v) => oneOf(v, ['PARTIAL', 'DEFER', 'SKIP'] as const, 'PARTIAL'),
      ),
      pick(
        (r) => r.deferralMode as DeferralMode | null,
        'loan_deferral_mode',
        'CARRY_FORWARD',
        (v) =>
          oneOf(v, ['CARRY_FORWARD', 'EXTEND_TENURE'] as const, 'CARRY_FORWARD'),
      ),
      this.settings
        .getSetting('loan_zero_salary_policy', 'DEFER')
        .then((v) => oneOf(v, ['DEFER', 'SKIP'] as const, 'DEFER')),
      pick(
        (r) => r.unpaidLeavePolicy as LeaveLoanPolicy | null,
        'loan_unpaid_leave_policy',
        'PAUSE',
        (v) => oneOf(v, ['CONTINUE', 'PAUSE', 'EXTEND'] as const, 'PAUSE'),
      ),
      this.settings
        .getSetting('loan_unpaid_leave_min_days', '1')
        .then((v) => num(v, 1)),
      this.settings
        .getSetting('loan_recovery_priority_order', 'ADVANCE,LOAN')
        .then((v) => csv(v, ['ADVANCE', 'LOAN'])),
      this.settings
        .getSetting('loan_priority_tiebreak', 'OLDEST_FIRST')
        .then((v) =>
          oneOf(
            v,
            ['OLDEST_FIRST', 'SMALLEST_BALANCE_FIRST'] as const,
            'OLDEST_FIRST',
          ),
        ),
      this.settings
        .getSetting('loan_payment_allocation_order', 'INTEREST_FIRST')
        .then((v) =>
          oneOf(
            v,
            ['INTEREST_FIRST', 'PRINCIPAL_FIRST'] as const,
            'INTEREST_FIRST',
          ),
        ),
      this.settings
        .getSetting('loan_recover_on_run_types', 'REGULAR,FINAL_SETTLEMENT')
        .then((v) => csv(v, ['REGULAR', 'FINAL_SETTLEMENT'])),
      this.settings
        .getSetting('loan_recovery_failure_policy', 'FAIL')
        .then((v) => oneOf(v, ['FAIL', 'WARN'] as const, 'FAIL')),
      this.settings
        .getSetting('loan_final_settlement_ignores_min_net', 'true')
        .then((v) => v === 'true'),
      pick(
        (r) => r.gracePeriodCycles,
        'loan_grace_period_cycles',
        '0',
        (v) => num(v, 0),
      ),
      pick(
        (r) => dec(r.roundingTolerance),
        'loan_rounding_tolerance',
        '1.00',
        (v) => num(v, 1),
      ),
      this.settings
        .getSetting('loan_auto_close_on_full_recovery', 'true')
        .then((v) => v === 'true'),

      // The six that had no reader. All go through `pick()`, so a branch row
      // answers first and the SystemSetting is the fallback — which is what
      // "per-branch policy" was supposed to mean all along.
      pick(
        (r) => r.maxActivePerEmployee,
        'loan_max_active_per_employee',
        '2',
        (v) => num(v, 2),
      ),
      pick(
        (r) => r.minServiceMonths,
        'loan_min_service_months',
        '0',
        (v) => num(v, 0),
      ),
      pick(
        (r) => dec(r.maxAmountMultipleOfSalary),
        'loan_max_amount_multiple_of_salary',
        '0',
        (v) => num(v, 0),
      ),
      pick(
        (r) => r.interestDefaultMethod,
        'loan_default_interest_method',
        'NONE',
        (v) => oneOf(v, ['NONE', 'FLAT', 'REDUCING_BALANCE'], 'NONE'),
      ),
      pick(
        (r) => r.writeOffRoles,
        'advance_loan_writeoff_roles',
        'ADMIN',
        (v) => (v ?? 'ADMIN').trim() || 'ADMIN',
      ),
      // Read with an inline fallback by `loan-lifecycle.service.ts` and absent
      // from the seed block entirely, so it existed only as a literal.
      pick(
        (r) => r.waiverRoles,
        'loan_waiver_roles',
        'ADMIN,HR_MANAGER',
        (v) => (v ?? 'ADMIN,HR_MANAGER').trim() || 'ADMIN,HR_MANAGER',
      ),
    ]);

    return {
      moduleV2Enabled,
      minNetPayAmount,
      minNetPayPercent,
      maxTotalDeductionPercentOfNet,
      minPartialRecoveryAmount,
      shortfallPolicy,
      deferralMode,
      zeroSalaryPolicy,
      unpaidLeavePolicy,
      unpaidLeaveMinDays,
      recoveryPriorityOrder,
      priorityTiebreak,
      paymentAllocationOrder,
      recoverOnRunTypes,
      recoveryFailurePolicy,
      finalSettlementIgnoresMinNet,
      gracePeriodCycles,
      roundingTolerance,
      autoCloseOnFullRecovery,
      maxActivePerEmployee,
      minServiceMonths,
      maxAmountMultipleOfSalary,
      interestDefaultMethod,
      writeOffRoles,
      waiverRoles,
    };
  }
}
