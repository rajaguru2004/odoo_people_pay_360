import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { roundMoney } from '../common/utils/money.util';
import { LOAN_TERMINAL_STATUSES } from './loan.types';
import { validateAffordability } from './loan-amortization.util';
import { LoanPolicyService } from './loan-policy.service';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN';

export interface EligibilityCheck {
  code: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  limit?: number | string | null;
  actual?: number | string | null;
}

export interface EligibilityResult {
  eligible: boolean;
  checks: EligibilityCheck[];
  maxEligibleAmount: number | null;
  monthlyNet: number;
  existingEmis: number;
}

/**
 * The ONE place that answers "may this employee borrow this?".
 *
 * Called by create(), approve(), the on-behalf path and (later) the bulk
 * import. One implementation with several callers is deliberate: the moment
 * the import has its own copy, it starts creating loans that could never have
 * been created through the UI.
 *
 * WARN vs FAIL matters. The requirement doc lists "loan equals annual salary"
 * as a case to HANDLE, not to reject — so it warns. Only rules that would
 * produce an unrecoverable or illegal loan fail.
 */
@Injectable()
export class LoanEligibilityService {
  constructor(
    private prisma: PrismaService,
    private settings: SystemSettingsService,
    private policy: LoanPolicyService,
  ) {}

  private async num(key: string, fallback: string): Promise<number> {
    const v = Number(await this.settings.getSetting(key, fallback));
    return Number.isFinite(v) ? v : Number(fallback);
  }

  async evaluate(args: {
    employeeId: string;
    amount: number;
    installments?: number;
    type?: string;
    startDate?: string;
    referenceNo?: string;
    monthlyNet: number;
    /** The product being borrowed under, when one was chosen. */
    loanTypeId?: string | null;
  }): Promise<EligibilityResult> {
    const checks: EligibilityCheck[] = [];
    const push = (c: EligibilityCheck) => checks.push(c);

    const employee = await this.prisma.employee.findUnique({
      where: { id: args.employeeId },
      select: {
        id: true,
        status: true,
        startDate: true,
        endDate: true,
        position: true,
        employmentType: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    // The product, when one was chosen. Its terms are STRICTER-WINS against
    // the system settings below rather than a replacement for them: a company
    // ceiling must not be liftable by defining a generous product.
    // The employee's own branch decides these three ceilings when it has a
    // `LoanPolicy` row. Before this the columns existed and every caller read
    // the company-wide setting, so a branch policy changed nothing.
    const branchPolicy = await this.policy.resolve(
      (
        await this.prisma.employee.findUnique({
          where: { id: args.employeeId },
          select: { branchId: true },
        })
      )?.branchId ?? null,
    );

    const product = args.loanTypeId
      ? await this.prisma.loanType.findFirst({ where: { id: args.loanTypeId } })
      : null;
    if (args.loanTypeId && !product) {
      throw new NotFoundException('Loan product not found');
    }

    const enabled = await this.settings.getSetting('advance_loan_enabled', 'true');
    push({
      code: 'MODULE_ENABLED',
      label: 'Advance & loan module enabled',
      status: enabled === 'false' ? 'FAIL' : 'PASS',
    });

    push({
      code: 'EMPLOYEE_ACTIVE',
      label: 'Employee is active',
      status: employee.status === 'ACTIVE' ? 'PASS' : 'FAIL',
      actual: employee.status,
      detail:
        employee.status === 'ACTIVE'
          ? undefined
          : `An employee with status ${employee.status} cannot take a new advance or loan.`,
    });

    const start = args.startDate ? new Date(args.startDate) : new Date();

    push({
      code: 'NOT_BEFORE_JOINING',
      label: 'Not dated before the joining date',
      status:
        employee.startDate && start < new Date(employee.startDate)
          ? 'FAIL'
          : 'PASS',
      limit: employee.startDate?.toISOString().slice(0, 10) ?? null,
      actual: start.toISOString().slice(0, 10),
    });

    // A loan maturing past a known last working day is allowed, but it needs a
    // settlement plan — so it warns rather than blocking.
    push({
      code: 'NOT_AFTER_RESIGNATION',
      label: 'Not dated after the last working day',
      status: employee.endDate && start > new Date(employee.endDate) ? 'FAIL' : 'PASS',
      limit: employee.endDate?.toISOString().slice(0, 10) ?? null,
    });

    const minService = branchPolicy.minServiceMonths;
    const monthsOfService = employee.startDate
      ? Math.floor(
          (Date.now() - new Date(employee.startDate).getTime()) /
            (30.44 * 86400000),
        )
      : 0;
    push({
      code: 'MIN_SERVICE',
      label: 'Minimum service period met',
      status: monthsOfService >= minService ? 'PASS' : 'FAIL',
      limit: minService,
      actual: monthsOfService,
    });

    const maxActive = branchPolicy.maxActivePerEmployee;
    const activeCount = await this.prisma.advanceLoanRequest.count({
      where: {
        employeeId: args.employeeId,
        status: { notIn: LOAN_TERMINAL_STATUSES as any },
      },
    });
    push({
      code: 'MAX_ACTIVE_LOANS',
      label: 'Within the maximum number of active loans',
      status: activeCount < maxActive ? 'PASS' : 'FAIL',
      limit: maxActive,
      actual: activeCount,
      detail:
        activeCount < maxActive
          ? undefined
          : `This employee already has ${activeCount} active advance/loan record(s).`,
    });

    // Amount ceilings
    const multiple = branchPolicy.maxAmountMultipleOfSalary;
    const ceiling = multiple > 0 ? roundMoney(args.monthlyNet * multiple) : null;
    push({
      code: 'AMOUNT_CEILING',
      label: 'Within the configured amount ceiling',
      status: ceiling !== null && args.amount > ceiling ? 'FAIL' : 'PASS',
      limit: ceiling,
      actual: args.amount,
    });

    push({
      code: 'ANNUAL_SALARY_CAP',
      label: 'Amount relative to annual pay',
      // A loan at or above a year's pay is unusual but legitimate — the doc
      // asks for it to be handled, not blocked.
      status:
        args.monthlyNet > 0 && args.amount >= args.monthlyNet * 12
          ? 'WARN'
          : 'PASS',
      limit: roundMoney(args.monthlyNet * 12),
      actual: args.amount,
      detail:
        args.monthlyNet > 0 && args.amount >= args.monthlyNet * 12
          ? 'This loan is at or above a full year of pay. Confirm the repayment plan.'
          : undefined,
    });

    const maxInstallments = await this.num('advance_loan_max_installments', '12');
    const installments = args.installments ?? 1;
    push({
      code: 'INSTALLMENT_RANGE',
      label: 'Instalment count within range',
      status:
        Number.isInteger(installments) &&
        installments >= 1 &&
        installments <= maxInstallments
          ? 'PASS'
          : 'FAIL',
      limit: maxInstallments,
      actual: installments,
    });

    // Affordability against loans already running.
    const existing = await this.prisma.advanceLoanRequest.findMany({
      where: {
        employeeId: args.employeeId,
        status: { notIn: LOAN_TERMINAL_STATUSES as any },
      },
      select: { installmentAmount: true },
    });
    const existingEmis = roundMoney(
      existing.reduce((a, e) => a + Number(e.installmentAmount ?? 0), 0),
    );
    const newEmi = installments > 0 ? roundMoney(args.amount / installments) : args.amount;
    const maxEmiPct = await this.num('loan_max_emi_percent_of_net', '50');
    const emiCap = roundMoney((args.monthlyNet * maxEmiPct) / 100);

    push({
      code: 'NET_PAY_AFTER_EMI',
      label: 'Take-home after all instalments',
      status:
        args.monthlyNet > 0 && newEmi + existingEmis > emiCap ? 'FAIL' : 'PASS',
      limit: emiCap,
      actual: roundMoney(newEmi + existingEmis),
      detail:
        args.monthlyNet > 0 && newEmi + existingEmis > emiCap
          ? `Instalments would total ${roundMoney(newEmi + existingEmis)}, above ${maxEmiPct}% of monthly pay. Spread the loan over more cycles.`
          : undefined,
    });

    if (args.referenceNo) {
      const dupe = await this.prisma.advanceLoanRequest.findFirst({
        where: { referenceNo: args.referenceNo },
        select: { id: true },
      });
      push({
        code: 'DUPLICATE_REFERENCE',
        label: 'Reference number is unique',
        status: dupe ? 'FAIL' : 'PASS',
        actual: args.referenceNo,
      });
    }

    // ── Product gates ────────────────────────────────────────────────────
    //
    // Every rule here is a `LoanType` column that existed and was read by
    // nothing. They are pushed AFTER the system-level checks so that when both
    // fire, the message the user gets names the product they picked — which is
    // the thing they can change.
    if (product) {
      push({
        code: 'PRODUCT_ACTIVE',
        label: 'Loan product is available',
        status: product.isActive ? 'PASS' : 'FAIL',
        actual: product.name,
        detail: product.isActive
          ? undefined
          : `${product.name} is no longer offered. Choose another product.`,
      });

      if (product.eligiblePositions.length > 0) {
        const ok = product.eligiblePositions.some(
          (p) => p.toLowerCase() === (employee.position ?? '').toLowerCase(),
        );
        push({
          code: 'PRODUCT_POSITION',
          label: 'Position is eligible for this product',
          status: ok ? 'PASS' : 'FAIL',
          limit: product.eligiblePositions.join(', '),
          actual: employee.position,
          detail: ok
            ? undefined
            : `${product.name} is offered to ${product.eligiblePositions.join(', ')} only.`,
        });
      }

      if (product.eligibleEmploymentTypes.length > 0) {
        const ok = product.eligibleEmploymentTypes.some(
          (t) => t.toLowerCase() === (employee.employmentType ?? '').toLowerCase(),
        );
        push({
          code: 'PRODUCT_EMPLOYMENT_TYPE',
          label: 'Employment type is eligible for this product',
          status: ok ? 'PASS' : 'FAIL',
          limit: product.eligibleEmploymentTypes.join(', '),
          actual: employee.employmentType ?? 'not set',
          detail: ok
            ? undefined
            : `${product.name} is offered to ${product.eligibleEmploymentTypes.join(', ')} staff only.`,
        });
      }

      if (product.minServiceMonths > 0) {
        push({
          code: 'PRODUCT_MIN_SERVICE',
          label: 'Minimum service for this product',
          status: monthsOfService >= product.minServiceMonths ? 'PASS' : 'FAIL',
          limit: product.minServiceMonths,
          actual: monthsOfService,
          detail:
            monthsOfService >= product.minServiceMonths
              ? undefined
              : `${product.name} needs ${product.minServiceMonths} months of service; this employee has ${monthsOfService}.`,
        });
      }

      // Counted per product, unlike the company-wide `loan_max_active_per_employee`
      // above: "one vehicle loan at a time" is a different rule from "two loans
      // in total", and a product cap that counted every loan would make the two
      // indistinguishable.
      const activeOfType = await this.prisma.advanceLoanRequest.count({
        where: {
          employeeId: args.employeeId,
          loanTypeId: product.id,
          status: { notIn: LOAN_TERMINAL_STATUSES as any },
        },
      });
      push({
        code: 'PRODUCT_MAX_ACTIVE',
        label: 'Within this product’s active-loan limit',
        status: activeOfType < product.maxActiveLoans ? 'PASS' : 'FAIL',
        limit: product.maxActiveLoans,
        actual: activeOfType,
        detail:
          activeOfType < product.maxActiveLoans
            ? undefined
            : `This employee already has ${activeOfType} active ${product.name} record(s); the product allows ${product.maxActiveLoans}.`,
      });

      if (product.maxAmount != null) {
        const cap = Number(product.maxAmount);
        push({
          code: 'PRODUCT_MAX_AMOUNT',
          label: 'Within this product’s amount ceiling',
          status: args.amount > cap ? 'FAIL' : 'PASS',
          limit: cap,
          actual: args.amount,
          detail:
            args.amount > cap
              ? `${product.name} is capped at ${cap}.`
              : undefined,
        });
      }

      if (product.maxMultipleOfSalary != null && args.monthlyNet > 0) {
        const cap = roundMoney(
          args.monthlyNet * Number(product.maxMultipleOfSalary),
        );
        push({
          code: 'PRODUCT_MAX_MULTIPLE_OF_SALARY',
          label: 'Within this product’s salary multiple',
          status: args.amount > cap ? 'FAIL' : 'PASS',
          limit: cap,
          actual: args.amount,
          detail:
            args.amount > cap
              ? `${product.name} is capped at ${product.maxMultipleOfSalary}x monthly pay (${cap}).`
              : undefined,
        });
      }

      push({
        code: 'PRODUCT_INSTALLMENT_RANGE',
        label: 'Instalment count within this product’s range',
        status: installments <= product.maxInstallments ? 'PASS' : 'FAIL',
        limit: product.maxInstallments,
        actual: installments,
        detail:
          installments <= product.maxInstallments
            ? undefined
            : `${product.name} runs over at most ${product.maxInstallments} instalments.`,
      });
    }

    // ── Affordability, through the engine's own gate ──────────────────────
    //
    // `validateAffordability()` was written, unit-tested and then called by
    // nothing, so its five codes — EMI_BELOW_MIN, EMI_EXCEEDS_NET,
    // EMI_EXCEEDS_CAP, NET_BELOW_FLOOR, TOTAL_EMI_EXCEEDS_NET — could never
    // reach a user. It runs here, with the product's floors when a product was
    // chosen and the system ones otherwise.
    //
    // Guarded on `monthlyNet > 0` for the same reason NET_PAY_AFTER_EMI is:
    // an employee whose salary is not set yet has no meaningful net to gate
    // against, and failing them would block onboarding rather than protect pay.
    if (args.monthlyNet > 0) {
      const minEmi =
        product?.minEmiAmount != null
          ? Number(product.minEmiAmount)
          : await this.num('loan_min_emi_amount', '0');
      const verdict = validateAffordability({
        emi: newEmi,
        otherActiveEmis: existingEmis,
        monthlyNet: args.monthlyNet,
        minEmi: minEmi > 0 ? minEmi : undefined,
        maxEmiPercentOfNet:
          product?.maxEmiPercentOfNet != null
            ? Number(product.maxEmiPercentOfNet)
            : maxEmiPct,
        minNetAfterEmi:
          product?.minNetSalaryAfterEmi != null
            ? Number(product.minNetSalaryAfterEmi)
            : undefined,
      });
      push({
        code: verdict.ok ? 'AFFORDABILITY' : verdict.code,
        label: 'Affordable against monthly pay',
        status: verdict.ok ? 'PASS' : 'FAIL',
        actual: newEmi,
        detail: verdict.ok ? undefined : verdict.message,
      });
    }

    const maxEligibleAmount =
      args.monthlyNet > 0
        ? roundMoney(Math.max(0, (emiCap - existingEmis) * Math.max(1, installments)))
        : null;

    return {
      eligible: !checks.some((c) => c.status === 'FAIL'),
      checks,
      maxEligibleAmount,
      monthlyNet: roundMoney(args.monthlyNet),
      existingEmis,
    };
  }

  /** First failing check, for turning a result into a 400 message. */
  firstFailure(result: EligibilityResult): EligibilityCheck | undefined {
    return result.checks.find((c) => c.status === 'FAIL');
  }
}
