import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  buildItemLines,
  describeMismatch,
  reconcileLines,
  type BuildLinesInput,
  type LineBucket,
  type LineSpec,
} from './payroll-item-lines.util';

/** The columns a set of lines is checked against. */
export type ItemTotals = Partial<Record<LineBucket, number>>;

export interface WriteLinesArgs {
  payrollItemId: string;
  input: BuildLinesInput;
  /** Refuse rather than proceed when the lines do not add up. */
  strict: boolean;
  /** For the audit row when a non-strict mismatch is tolerated. */
  context?: {
    payrollId?: string;
    employeeId?: string;
    branchId?: string | null;
  };
}

/**
 * Writes and re-writes the itemised breakdown behind a payslip.
 *
 * Every method that participates in a payroll run takes the caller's
 * `Prisma.TransactionClient` first, so lines are written inside the same
 * transaction as the item they explain — a payslip that exists without its
 * breakdown, or a breakdown that outlives a rolled-back run, would both be
 * worse than no itemisation at all.
 */
@Injectable()
export class PayrollItemLinesService {
  private readonly logger = new Logger(PayrollItemLinesService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * Build the lines for one item and persist them.
   *
   * Returns the specs that were written so a caller can assert on them without
   * a second read.
   */
  async buildAndPersist(
    tx: Prisma.TransactionClient,
    args: WriteLinesArgs,
  ): Promise<LineSpec[]> {
    const lines = buildItemLines(args.input);
    this.assertReconciles(lines, args);
    if (lines.length === 0) return lines;

    await tx.payrollItemLine.createMany({
      data: lines.map((l) => ({
        payrollItemId: args.payrollItemId,
        code: l.code,
        label: l.label,
        category: l.category,
        bucket: l.bucket,
        amount: new Prisma.Decimal(l.amount.toFixed(2)),
        sourceType: l.sourceType,
        sourceId: l.sourceId ?? null,
        displayOrder: l.displayOrder,
      })),
    });
    return lines;
  }

  /**
   * Replace an item's lines wholesale.
   *
   * Used by `updateItem`, where a scalar edit destroys the itemisation behind
   * the column it replaces: `dto.allowances` is one number that stands in for
   * however many components produced the old total, so apportioning it back
   * across them would invent an allocation nobody asked for. Delete and rewrite
   * is the honest answer, and the rewritten line says it was adjusted by hand.
   */
  async rebuildForItem(
    tx: Prisma.TransactionClient,
    args: WriteLinesArgs,
  ): Promise<LineSpec[]> {
    await this.deleteForItem(tx, args.payrollItemId);
    return this.buildAndPersist(tx, args);
  }

  async deleteForItem(
    tx: Prisma.TransactionClient,
    payrollItemId: string,
  ): Promise<void> {
    await tx.payrollItemLine.deleteMany({ where: { payrollItemId } });
  }

  /**
   * Re-check a stored payslip against its stored lines.
   *
   * Read-only, so it can be pointed at a run that was generated months ago —
   * which is the situation in which someone actually asks whether the payslip
   * adds up.
   */
  async reconcileItem(payrollItemId: string) {
    const [item, lines] = await Promise.all([
      this.prisma.payrollItem.findUnique({ where: { id: payrollItemId } }),
      this.prisma.payrollItemLine.findMany({ where: { payrollItemId } }),
    ]);
    if (!item) return null;
    const totals = totalsFromItem(item);
    return reconcileLines(
      totals,
      lines.map((l) => ({
        bucket: l.bucket as LineBucket,
        amount: Number(l.amount),
      })),
    );
  }

  /**
   * The reconciliation gate.
   *
   * Strict refuses, which rolls back the whole run: an itemisation that does not
   * add up is worse than none, because a payslip that shows its working and
   * gets it wrong is harder to argue with than one that shows nothing. The
   * non-strict path exists so a site that hits an edge case in production can
   * keep paying people while it is diagnosed — and it audits, because a
   * mismatch nobody hears about is the same as no check.
   */
  private assertReconciles(lines: LineSpec[], args: WriteLinesArgs) {
    const result = reconcileLines(args.input.totals, lines);
    if (result.ok) return;

    const detail = describeMismatch(result);
    if (args.strict) {
      throw new InternalServerErrorException(
        `Payslip itemisation does not reconcile — ${detail}. ` +
          'The payroll was not saved. Turn off ' +
          'payroll_item_lines_strict_reconciliation to record the mismatch and ' +
          'continue instead of refusing.',
      );
    }

    this.logger.error(`Payslip itemisation does not reconcile — ${detail}`);
    void this.audit.log({
      action: 'PAYROLL_LINES_RECONCILIATION_FAILED',
      resourceType: 'PayrollItem',
      resourceId: args.payrollItemId,
      branchId: args.context?.branchId ?? null,
      newData: {
        payrollId: args.context?.payrollId,
        employeeId: args.context?.employeeId,
        mismatches: result.mismatches,
      },
    });
  }
}

/** Read the authoritative columns off a stored item, in bucket terms. */
export function totalsFromItem(item: {
  baseSalary: unknown;
  allowances: unknown;
  bonus: unknown;
  overtimePay: unknown;
  foodAllowance: unknown;
  siteAllowance: unknown;
  reimbursement: unknown;
  deduction: unknown;
  advanceLoanDeduction: unknown;
  garnishment: unknown;
  insurance: unknown;
  tax: unknown;
}): ItemTotals {
  const n = (v: unknown) => Number(v ?? 0);
  return {
    baseSalary: n(item.baseSalary),
    allowances: n(item.allowances),
    bonus: n(item.bonus),
    overtimePay: n(item.overtimePay),
    foodAllowance: n(item.foodAllowance),
    siteAllowance: n(item.siteAllowance),
    reimbursement: n(item.reimbursement),
    deduction: n(item.deduction),
    advanceLoanDeduction: n(item.advanceLoanDeduction),
    garnishment: n(item.garnishment),
    insurance: n(item.insurance),
    tax: n(item.tax),
  };
}
