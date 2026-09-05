import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Actual spend, keyed `${departmentId ?? 'COMPANY'}::${category}`. */
export type ActualsMap = Map<string, number>;

export function actualsKey(departmentId: string | null, category: string): string {
  return `${departmentId ?? 'COMPANY'}::${category}`;
}

/**
 * Actual spend, computed on read.
 *
 * Nothing is materialised. `Payroll` and `PayrollItem` are already the source
 * of truth, they are already branch-scoped, and a second copy
 * could only drift — it would need backfilling on every payroll unlock and
 * relock, and any divergence would be invisible until someone reconciled by
 * hand. The variance report is a handful of grouped queries over indexed
 * columns, run interactively by HR, not per-request in a hot path.
 *
 * `LOCKED` is the only payroll status that counts: that is what "actually paid"
 * means in this system.
 */
@Injectable()
export class BudgetActualsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Spend for a fiscal window, grouped by (department, category).
   *
   * Every query goes through Prisma so the branch `$use` middleware applies —
   * `groupBy` is in BRANCH_READ_ACTIONS. Moving any of this to `$queryRaw` would
   * silently bypass scoping and need `rawBranchFilter` instead.
   */
  async forWindow(
    branchId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<ActualsMap> {
    const actuals: ActualsMap = new Map();
    const add = (departmentId: string | null, category: string, amount: number) => {
      if (!amount) return;
      const key = actualsKey(departmentId, category);
      actuals.set(key, (actuals.get(key) ?? 0) + amount);
    };

    // Fiscal windows are date ranges; payroll is keyed by (month, year). Take
    // every run whose month falls inside the window.
    const months = monthsBetween(startDate, endDate);
    if (months.length === 0) return actuals;

    const payrolls = await this.prisma.payroll.findMany({
      where: {
        branchId,
        status: 'LOCKED', // only money that actually went out
        OR: months.map((m) => ({ month: m.month, year: m.year })),
      },
      select: { id: true },
    });
    const payrollIds = payrolls.map((p) => p.id);

    if (payrollIds.length > 0) {
      const items = await this.prisma.payrollItem.findMany({
        where: { payrollId: { in: payrollIds } },
        select: {
          netSalary: true,
          overtimePay: true,
          employee: { select: { departmentId: true } },
        },
      });

      for (const item of items) {
        const dept = item.employee?.departmentId ?? null;
        const overtime = Number(item.overtimePay ?? 0);
        // Payroll = the cash cost MINUS the parts attributed to their own
        // categories, so the same money is not counted under two headings.
        const payrollOnly = Number(item.netSalary ?? 0) - overtime;
        add(dept, 'Payroll', payrollOnly);
        add(dept, 'Overtime', overtime);
      }
    }

    return actuals;
  }
}

/** Every (month, year) touched by the window, inclusive. */
function monthsBetween(
  start: Date,
  end: Date,
): Array<{ month: number; year: number }> {
  const out: Array<{ month: number; year: number }> = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
  );
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  // A guard against an absurd range producing an unbounded loop.
  let guard = 0;
  while (cursor <= last && guard++ < 240) {
    out.push({ month: cursor.getUTCMonth() + 1, year: cursor.getUTCFullYear() });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}
