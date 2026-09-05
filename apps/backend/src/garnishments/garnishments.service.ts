import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type GarnishmentOrder } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertBranchAssignable,
  assertInBranch,
} from '../common/branch/branch-scope.util';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import { roundMoney } from '../common/utils/money.util';
import {
  allocateGarnishments,
  type AllocatableOrder,
  type CarriedShortfall,
  type GarnishmentAllocation,
} from './garnishment-allocator';
import {
  CreateGarnishmentDto,
  UpdateGarnishmentDto,
} from './dto/garnishment.dto';

const dec = (v: Prisma.Decimal | null): number | null =>
  v === null ? null : Number(v);

/** What one payroll run needs to know about one employee's court orders. */
export interface GarnishmentInputs {
  orders: AllocatableOrder[];
  carried: CarriedShortfall[];
}

/**
 * Court-ordered attachments of earnings.
 *
 * The rung the recovery ladder was missing. `PayrollItem.garnishment` and
 * `CycleContext.garnishment` both existed, payroll passed a hard-coded `0`, and
 * there was nowhere to record that an order existed at all — so the documented
 * order (statutory > garnishment > protected net > advance > loan) could not be
 * exercised even in principle.
 *
 * A garnishment outranks every loan by construction: payroll subtracts it from
 * the pool BEFORE the loan allocator sees the money, which is why the ladder is
 * enforced structurally here rather than by sorting.
 */
@Injectable()
export class GarnishmentsService {
  private readonly logger = new Logger(GarnishmentsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * An order has to be followable.
   *
   * Both an amount and a percentage is two conflicting instructions; neither is
   * none. Either way the payroll run would have to guess, and guessing about a
   * court order is not an option.
   */
  private assertCoherent(dto: {
    amount?: number | null;
    percentOfNet?: number | null;
    startDate?: string;
    endDate?: string | null;
  }) {
    const hasAmount = dto.amount != null;
    const hasPercent = dto.percentOfNet != null;
    if (hasAmount && hasPercent) {
      throw new BadRequestException(
        'An order states either a fixed amount or a percentage of net pay, not both.',
      );
    }
    if (!hasAmount && !hasPercent) {
      throw new BadRequestException(
        'An order needs either a fixed amount or a percentage of net pay.',
      );
    }
    if (dto.startDate && dto.endDate) {
      if (new Date(dto.endDate) < new Date(dto.startDate)) {
        throw new BadRequestException('The order ends before it starts.');
      }
    }
  }

  async create(dto: CreateGarnishmentDto) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { id: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    // Creates are not auto-scoped for relation-owned rows, so the target
    // employee's branch is checked explicitly.
    assertInBranch(employee.branchId);

    this.assertCoherent(dto);

    return this.prisma.garnishmentOrder.create({
      data: {
        employeeId: dto.employeeId,
        reference: dto.reference,
        authority: dto.authority ?? null,
        amount: dto.amount ?? null,
        percentOfNet: dto.percentOfNet ?? null,
        totalCap: dto.totalCap ?? null,
        startDate: new Date(`${dto.startDate}T00:00:00.000Z`),
        endDate: dto.endDate ? new Date(`${dto.endDate}T00:00:00.000Z`) : null,
        priority: dto.priority ?? 100,
        isActive: dto.isActive ?? true,
        notes: dto.notes ?? null,
      },
      include: {
        employee: {
          // `branchId` is here for `revoke`, which has to check the order's
          // branch is one this caller may write to.
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            branchId: true,
          },
        },
      },
    });
  }

  async findAll(query: { employeeId?: string; activeOnly?: boolean } = {}) {
    return this.prisma.garnishmentOrder.findMany({
      where: {
        ...(query.employeeId ? { employeeId: query.employeeId } : {}),
        ...(query.activeOnly ? { isActive: true } : {}),
      },
      orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
      include: {
        employee: {
          // `branchId` is here for `revoke`, which has to check the order's
          // branch is one this caller may write to.
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            branchId: true,
          },
        },
      },
    });
  }

  async findOne(id: string) {
    // `findFirst`, so the branch predicate applies: an order on somebody else's
    // branch reads as absent rather than as forbidden.
    const row = await this.prisma.garnishmentOrder.findFirst({
      where: { id },
      include: {
        employee: {
          // `branchId` is here for `revoke`, which has to check the order's
          // branch is one this caller may write to.
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            branchId: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Garnishment order not found');
    return row;
  }

  async update(id: string, dto: UpdateGarnishmentDto) {
    const existing = await this.findOne(id);

    this.assertCoherent({
      amount: dto.amount !== undefined ? dto.amount : Number(existing.amount ?? NaN) || null,
      percentOfNet:
        dto.percentOfNet !== undefined
          ? dto.percentOfNet
          : Number(existing.percentOfNet ?? NaN) || null,
      startDate: dto.startDate ?? existing.startDate.toISOString().slice(0, 10),
      endDate:
        dto.endDate !== undefined
          ? dto.endDate
          : (existing.endDate?.toISOString().slice(0, 10) ?? null),
    });

    const data: Record<string, unknown> = {};
    if (dto.reference !== undefined) data.reference = dto.reference;
    if (dto.authority !== undefined) data.authority = dto.authority ?? null;
    if (dto.amount !== undefined) data.amount = dto.amount ?? null;
    if (dto.percentOfNet !== undefined) data.percentOfNet = dto.percentOfNet ?? null;
    if (dto.totalCap !== undefined) data.totalCap = dto.totalCap ?? null;
    if (dto.startDate !== undefined) {
      data.startDate = new Date(`${dto.startDate}T00:00:00.000Z`);
    }
    if (dto.endDate !== undefined) {
      data.endDate = dto.endDate ? new Date(`${dto.endDate}T00:00:00.000Z`) : null;
    }
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.notes !== undefined) data.notes = dto.notes ?? null;

    return this.prisma.garnishmentOrder.update({
      where: { id },
      data,
      include: {
        employee: {
          // `branchId` is here for `revoke`, which has to check the order's
          // branch is one this caller may write to.
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            branchId: true,
          },
        },
      },
    });
  }

  /**
   * Orders are closed, not deleted, once anything has been collected: the
   * record of what was taken from somebody's pay under a court order is not
   * ours to remove.
   */
  async remove(id: string) {
    const row = await this.findOne(id);
    if (Number(row.collected) > 0) {
      throw new BadRequestException(
        `${roundMoney(Number(row.collected))} has already been collected under this order, so it cannot be deleted. Deactivate it instead.`,
      );
    }
    await this.prisma.garnishmentOrder.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Every order in force for these employees in this cycle.
   *
   * Loaded ONCE before the payroll loop, the way loan candidates are: a
   * per-employee query inside a 300-person run is the N+1 this module has
   * already been bitten by. The arithmetic is separate (`takeFor`) because a
   * percentage order needs the employee's net, which is only known after the
   * first pass.
   */
  async loadActiveOrders(
    employeeIds: string[],
    cycle: { month: number; year: number },
  ): Promise<Map<string, GarnishmentOrder[]>> {
    const out = new Map<string, GarnishmentOrder[]>();
    if (employeeIds.length === 0) return out;

    // An order that starts mid-month applies to that month's pay, which is run
    // at its end; one that ended before the month began does not.
    const cycleStart = new Date(Date.UTC(cycle.year, cycle.month - 1, 1));
    const cycleEnd = new Date(Date.UTC(cycle.year, cycle.month, 0));

    const orders = await this.prisma.garnishmentOrder.findMany({
      where: {
        employeeId: { in: employeeIds },
        isActive: true,
        startDate: { lte: cycleEnd },
        OR: [{ endDate: null }, { endDate: { gte: cycleStart } }],
      },
      orderBy: { startDate: 'asc' },
    });

    for (const order of orders) {
      const list = out.get(order.employeeId) ?? [];
      list.push(order);
      out.set(order.employeeId, list);
    }
    return out;
  }

  /**
   * What these orders take out of one employee's net pay this cycle.
   *
   * Pure, so it is a table in the unit spec rather than a database fixture.
   *
   * Two bounds matter. `totalCap` stops an order that has already collected
   * what it was for, and the running total is capped at the net itself: an
   * order cannot create a negative payslip, and what it could not take this
   * cycle it takes in the next one.
   */
  static takeFor(
    orders: Array<Pick<GarnishmentOrder, 'id' | 'amount' | 'percentOfNet' | 'totalCap' | 'collected'>>,
    net: number,
  ): { total: number; orders: Array<{ id: string; take: number }> } {
    let remainingNet = Math.max(0, net);
    const taken: Array<{ id: string; take: number }> = [];

    for (const order of orders) {
      if (remainingNet <= 0) break;

      let take =
        order.amount != null
          ? Number(order.amount)
          : roundMoney((net * Number(order.percentOfNet ?? 0)) / 100);

      if (order.totalCap != null) {
        const left = roundMoney(Number(order.totalCap) - Number(order.collected));
        if (left <= 0) continue;
        take = Math.min(take, left);
      }

      take = roundMoney(Math.max(0, Math.min(take, remainingNet)));
      if (take <= 0) continue;

      taken.push({ id: order.id, take });
      remainingNet = roundMoney(remainingNet - take);
    }

    return {
      total: roundMoney(taken.reduce((a, t) => a + t.take, 0)),
      orders: taken,
    };
  }

  /**
   * Record what a LOCKED payroll actually took.
   *
   * Called at lock rather than at generation, because a draft run can be
   * deleted and money that never moved must not count against a cap.
   *
   * The unique `(orderId, month, year)` is the idempotency: an unlock followed
   * by a re-lock tries to write the same cycle again, loses on the index, and
   * the counter is left alone. Without it a corrected payroll would collect
   * twice against the same order — the mirror of the double-recovery bug the
   * loan ledger already guards against.
   */
  async recordCollected(
    taken: Array<{ id: string; take: number; payrollItemId?: string | null }>,
    cycle: { month: number; year: number },
  ) {
    for (const row of taken) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.garnishmentDeduction.create({
            data: {
              orderId: row.id,
              payrollItemId: row.payrollItemId ?? null,
              amount: row.take,
              month: cycle.month,
              year: cycle.year,
            },
          });
          await tx.garnishmentOrder.update({
            where: { id: row.id },
            data: { collected: { increment: row.take } },
          });
        });
      } catch (err) {
        // P2002 — this cycle has already been recorded against this order.
        // Anything else is logged by the caller; neither is fatal to the lock,
        // because the money has already moved on the payslip.
        if ((err as { code?: string })?.code !== 'P2002') throw err;
      }
    }
  }

  /** What was taken under one order, newest first. */
  async collectionHistory(orderId: string) {
    return this.prisma.garnishmentDeduction.findMany({
      where: { orderId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
  }

  // ------------------------------------------------- carry-forward ledger
  //
  // `takeFor` above says of a shortfall that "what it could not take this cycle
  // it takes in the next one". Nothing implemented that: the missed amount
  // simply vanished and the order collected one instalment short, permanently.
  // These methods are what makes the sentence true.

  /** Deactivate an order without deleting the record of what it took. */
  async revoke(id: string) {
    const existing = await this.findOne(id);
    assertBranchAssignable(existing.employee.branchId!);
    return this.prisma.garnishmentOrder.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async carryForwardsFor(employeeId: string, user: any) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, 'view carried balances for');

    return this.prisma.payrollCarryForward.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Write off an outstanding balance, with a reason. The only way a carried
   * amount ever disappears — nothing writes it off implicitly, which is the
   * whole point of the ledger.
   */
  async waive(id: string, reason: string, user: any) {
    const row = await this.prisma.payrollCarryForward.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, departmentId: true, branchId: true } },
      },
    });
    if (!row) throw new NotFoundException('Carry-forward record not found');
    assertCanAccessEmployeeRecord(user, row.employee, 'waive a balance for');
    assertBranchAssignable(row.employee.branchId!);
    if (row.status === 'RECOVERED') {
      throw new BadRequestException(
        'This balance was already recovered in full and cannot be waived.',
      );
    }
    if (row.status === 'WAIVED') {
      throw new BadRequestException('This balance was already waived.');
    }
    return this.prisma.payrollCarryForward.update({
      where: { id },
      data: {
        status: 'WAIVED',
        reason: `${row.reason ?? ''} Waived: ${reason}`.trim(),
        clearedAt: new Date(),
      },
    });
  }

  /**
   * An employee leaving does NOT clear what they owe.
   *
   * An unrecovered balance survives the exit as a RECEIVABLE — a debt on
   * record, the way the loan module already treats an unpaid loan — instead of
   * being written off silently. `waive()` remains the only path that erases
   * one, and it demands a reason.
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

  // ------------------------------------------------------- payroll seam

  /**
   * Everything the engine needs for a population, in two queries.
   *
   * The richer sibling of `loadActiveOrders`: same orders, plus the arrears
   * each one is owed from periods whose pay could not cover it. RECEIVABLE rows
   * are loaded alongside OUTSTANDING ones on purpose — a rehired employee walks
   * back in owing what they left owing, and a final-settlement run should reach
   * the balance it is settling.
   */
  async loadForPayroll(
    employeeIds: string[],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Map<string, GarnishmentInputs>> {
    const map = new Map<string, GarnishmentInputs>();
    if (employeeIds.length === 0) return map;

    const [orders, carried] = await Promise.all([
      this.prisma.garnishmentOrder.findMany({
        where: {
          employeeId: { in: employeeIds },
          isActive: true,
          startDate: { lte: periodEnd },
          OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
        },
      }),
      this.prisma.payrollCarryForward.findMany({
        where: {
          employeeId: { in: employeeIds },
          kind: 'GARNISHMENT',
          status: { in: ['OUTSTANDING', 'RECEIVABLE'] },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    for (const id of employeeIds) map.set(id, { orders: [], carried: [] });

    for (const o of orders) {
      map.get(o.employeeId)?.orders.push({
        id: o.id,
        amount: dec(o.amount),
        percentOfNet: dec(o.percentOfNet),
        reference: o.reference,
        priority: o.priority,
        startDate: o.startDate,
        endDate: o.endDate,
        totalCap: dec(o.totalCap),
        collected: Number(o.collected),
      });
    }
    for (const c of carried) {
      map.get(c.employeeId)?.carried.push({
        id: c.id,
        sourceId: c.sourceId,
        amount: Number(c.amount),
        amountRecovered: Number(c.amountRecovered),
      });
    }
    return map;
  }

  /**
   * Deduction balances a previous run could not take, per employee.
   *
   * Separate from `loadForPayroll` because these are not tied to a court order:
   * they come from an ad-hoc `deduction` on a payslip that exceeded the pay it
   * was charged against. `updateItem` clamps the INPUT rather than the answer —
   * it stores what the pay could bear and opens one of these for the rest — so
   * this is where the rest is finally collected.
   */
  async loadDeductionCarryForwards(
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
   * Take as much of a carried DEDUCTION balance as `available` allows, oldest
   * first. Returns what to subtract from net and how each row was settled;
   * writing is `persistDeductionRecovery`'s job, inside the run's transaction.
   */
  static allocateCarriedDeductions(
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

  private async settleCarryForward(
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

  async persistDeductionRecovery(
    tx: Prisma.TransactionClient,
    payrollId: string,
    settled: Array<{ id: string; amount: number }>,
  ): Promise<void> {
    for (const s of settled) {
      await this.settleCarryForward(tx, payrollId, s.id, s.amount);
    }
  }

  /**
   * Persist one employee's allocation inside the RUN'S OWN transaction.
   *
   * `recordCollected` above opens a transaction of its own, which means a lock
   * that rolls back after it runs leaves the collection recorded against money
   * that never moved. This takes the caller's `tx` instead, so the ledger and
   * the payslip commit or fail together.
   *
   * Four writes, in this order:
   *   1. a `GarnishmentDeduction` row — the per-cycle ledger, whose unique
   *      `(orderId, month, year)` is what makes a re-lock idempotent;
   *   2. advance each order's `collected`, so a capped debt closes;
   *   3. settle the carry-forward rows this run cleared;
   *   4. open a new carry-forward row for whatever pay could not cover.
   */
  async persistAllocation(
    tx: Prisma.TransactionClient,
    params: {
      employeeId: string;
      branchId: string;
      payrollId: string;
      payrollItemId?: string | null;
      month: number;
      year: number;
      allocation: GarnishmentAllocation;
    },
  ): Promise<void> {
    const {
      employeeId,
      branchId,
      payrollId,
      payrollItemId,
      month,
      year,
      allocation,
    } = params;

    for (const line of allocation.lines) {
      if (line.taken > 0) {
        // Idempotent by the unique index: a re-lock of the same cycle loses
        // here and neither the row nor the counter is written twice.
        const existing = await tx.garnishmentDeduction.findUnique({
          where: { orderId_month_year: { orderId: line.orderId, month, year } },
          select: { id: true },
        });
        if (!existing) {
          await tx.garnishmentDeduction.create({
            data: {
              orderId: line.orderId,
              payrollItemId: payrollItemId ?? null,
              amount: new Prisma.Decimal(line.taken),
              month,
              year,
            },
          });
          await tx.garnishmentOrder.update({
            where: { id: line.orderId },
            data: { collected: { increment: new Prisma.Decimal(line.taken) } },
          });
        }
      }

      for (const s of line.settled) {
        await this.settleCarryForward(
          tx,
          payrollId,
          s.carryForwardId,
          s.amount,
        );
      }

      if (line.shortfall > 0) {
        await tx.payrollCarryForward.create({
          data: {
            employeeId,
            branchId,
            kind: 'GARNISHMENT',
            sourceId: line.orderId,
            amount: new Prisma.Decimal(line.shortfall),
            status: 'OUTSTANDING',
            originPayrollId: payrollId,
            reason:
              `Court order ${line.reference}: pay available in this period ` +
              `covered ${line.taken} of ${line.due}.`,
          },
        });
      }
    }
  }

  /**
   * Undo everything a run wrote, so deleting a DRAFT payroll or unlocking one
   * does not leave a court order believing it collected twice.
   *
   * The `garnishment_deductions` ledger is what makes this exact. Relying on
   * the unique index alone — write once, no-op on re-lock — is only correct
   * while the corrected run takes the SAME amount; an unlock, an edit and a
   * re-lock would otherwise leave the order crediting the old figure while the
   * payslip shows the new one. Reversing means the re-lock writes the truth.
   */
  async reverseForPayroll(
    tx: Prisma.TransactionClient,
    payrollId: string,
  ): Promise<void> {
    // Shortfalls this run opened simply cease to exist.
    await tx.payrollCarryForward.deleteMany({
      where: { originPayrollId: payrollId },
    });

    // Balances this run took ANYTHING off go back to what they were.
    //
    // Keyed on `lastRecoveryPayrollId`, not on `clearedPayrollId`: a run that
    // took 40 off a 100 balance never set `clearedPayrollId` at all, so keying
    // on the clear would have restored the fully-settled balances and silently
    // left every partial one under-stated.
    const touched = await tx.payrollCarryForward.findMany({
      where: { lastRecoveryPayrollId: payrollId },
      select: { id: true, lastRecoveryAmount: true, clearedPayrollId: true },
    });
    for (const c of touched) {
      const back = Number(c.lastRecoveryAmount ?? 0);
      await tx.payrollCarryForward.update({
        where: { id: c.id },
        data: {
          ...(back > 0
            ? { amountRecovered: { decrement: new Prisma.Decimal(back) } }
            : {}),
          status: 'OUTSTANDING',
          lastRecoveryPayrollId: null,
          lastRecoveryAmount: null,
          ...(c.clearedPayrollId === payrollId
            ? { clearedPayrollId: null, clearedAt: null }
            : {}),
        },
      });
    }

    // Roll each order's `collected` back by exactly what it took, read from the
    // ledger rather than reconstructed from `payroll_items.garnishment` — the
    // item column is one summed figure across every order, so splitting it back
    // out would be a guess whenever an employee is under two orders at once.
    const items = await tx.payrollItem.findMany({
      where: { payrollId },
      select: { id: true },
    });
    if (items.length === 0) return;

    const rows = await tx.garnishmentDeduction.findMany({
      where: { payrollItemId: { in: items.map((i) => i.id) } },
      select: { id: true, orderId: true, amount: true },
    });
    for (const r of rows) {
      await tx.garnishmentOrder.update({
        where: { id: r.orderId },
        data: { collected: { decrement: r.amount } },
      });
    }
    await tx.garnishmentDeduction.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
  }

  /** Convenience for the engine — allocate without touching the database. */
  static allocate = allocateGarnishments;
}
