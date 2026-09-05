import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** One unrecovered balance held against an employee. */
export interface CarriedShortfall {
  id: string;
  sourceId: string | null;
  amount: number;
  amountRecovered: number;
}

/**
 * Deduction balances a previous run could not take.
 *
 * `updateItem` clamps the INPUT rather than the answer — it stores what the pay
 * could bear and opens a `PayrollCarryForward` row for the rest — so this is
 * where the rest is finally collected. A shortfall under-recovers for ONE
 * period instead of being silently written off.
 */
@Injectable()
export class DeductionCarryForwardService {
  constructor(private prisma: PrismaService) {}

  private readonly logger = new Logger(DeductionCarryForwardService.name);

  /**
   * A balance does NOT die with the employment.
   *
   * On exit an unrecovered row becomes `RECEIVABLE` — a debt on record — rather
   * than being written off silently. Waiving one is a deliberate act somebody
   * has to perform; leaving is not.
   */
  async markOutstandingAsReceivable(
    employeeId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? this.prisma;
    const { count } = await client.payrollCarryForward.updateMany({
      where: { employeeId, status: 'OUTSTANDING' },
      data: { status: 'RECEIVABLE' },
    });
    if (count > 0) {
      this.logger.log(
        `Employee ${employeeId} left with ${count} unrecovered carry-forward ` +
          `balance(s); recorded as RECEIVABLE rather than written off.`,
      );
    }
    return count;
  }

  async loadForEmployees(
    employeeIds: string[],
  ): Promise<Map<string, CarriedShortfall[]>> {
    const map = new Map<string, CarriedShortfall[]>();
    if (employeeIds.length === 0) return map;
    for (const id of employeeIds) map.set(id, []);

    const rows = await this.prisma.payrollCarryForward.findMany({
      where: {
        employeeId: { in: employeeIds },
        kind: 'DEDUCTION',
        status: { in: ['OUTSTANDING', 'RECEIVABLE'] },
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const r of rows) {
      map.get(r.employeeId)?.push({
        id: r.id,
        sourceId: r.sourceId,
        amount: Number(r.amount),
        amountRecovered: Number(r.amountRecovered),
      });
    }
    return map;
  }

  /**
   * Take as much of a carried balance as `available` allows, oldest first.
   * Returns what to subtract from net and how each row was settled; writing is
   * `persistRecovery`'s job, inside the run's transaction.
   */
  static allocate(
    carried: CarriedShortfall[],
    available: number,
  ): { taken: number; settled: Array<{ id: string; amount: number }> } {
    const settled: Array<{ id: string; amount: number }> = [];
    let pool = Math.max(0, available);
    let taken = 0;
    for (const c of carried) {
      if (pool <= 0) break;
      const owing = Math.round((c.amount - c.amountRecovered) * 100) / 100;
      if (owing <= 0) continue;
      const applied = Math.round(Math.min(owing, pool) * 100) / 100;
      settled.push({ id: c.id, amount: applied });
      pool = Math.round((pool - applied) * 100) / 100;
      taken = Math.round((taken + applied) * 100) / 100;
    }
    return { taken, settled };
  }

  async persistRecovery(
    tx: Prisma.TransactionClient,
    payrollId: string,
    settled: Array<{ id: string; amount: number }>,
  ): Promise<void> {
    for (const s of settled) {
      await this.settle(tx, payrollId, s.id, s.amount);
    }
  }

  private async settle(
    tx: Prisma.TransactionClient,
    payrollId: string,
    id: string,
    amount: number,
  ): Promise<void> {
    const row = await tx.payrollCarryForward.findUnique({
      where: { id },
      select: { amount: true, amountRecovered: true },
    });
    if (!row) return;
    const nowRecovered = Number(row.amountRecovered) + amount;
    const fullyCleared = nowRecovered >= Number(row.amount) - 0.005;
    await tx.payrollCarryForward.update({
      where: { id },
      data: {
        amountRecovered: { increment: new Prisma.Decimal(amount) },
        lastRecoveryPayrollId: payrollId,
        lastRecoveryAmount: new Prisma.Decimal(amount),
        ...(fullyCleared
          ? {
              status: 'RECOVERED',
              clearedPayrollId: payrollId,
              clearedAt: new Date(),
            }
          : {}),
      },
    });
  }

  /**
   * Undo what a run collected, so generate → delete → regenerate cannot
   * double-count against a finite balance.
   */
  async reverseForPayroll(
    tx: Prisma.TransactionClient,
    payrollId: string,
  ): Promise<void> {
    const cleared = await tx.payrollCarryForward.findMany({
      where: { kind: 'DEDUCTION', lastRecoveryPayrollId: payrollId },
      select: { id: true, lastRecoveryAmount: true, status: true },
    });
    for (const row of cleared) {
      const back = Number(row.lastRecoveryAmount ?? 0);
      await tx.payrollCarryForward.update({
        where: { id: row.id },
        data: {
          amountRecovered: { decrement: new Prisma.Decimal(back) },
          lastRecoveryPayrollId: null,
          lastRecoveryAmount: null,
          ...(row.status === 'RECOVERED'
            ? { status: 'OUTSTANDING', clearedPayrollId: null, clearedAt: null }
            : {}),
        },
      });
    }

    // Shortfalls this run itself opened die with it.
    await tx.payrollCarryForward.deleteMany({
      where: { kind: 'DEDUCTION', originPayrollId: payrollId },
    });
  }
}
