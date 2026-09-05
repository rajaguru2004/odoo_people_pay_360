import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';

/**
 * Payroll reporting.
 *
 * Three rules:
 *
 *  1. Money-moved figures read **LOCKED** payrolls only. A figure sitting in a
 *     DRAFT run has not been paid to anybody, and reporting it as cost makes
 *     every month look overspent until somebody locks it.
 *  2. Unlocked amounts are reported separately as `draft`, never folded into the
 *     headline. The delta is then explicit rather than mysterious.
 *  3. Every response carries `meta.openPayrolls`, so a reader can see exactly
 *     which runs would move the numbers.
 *
 * A fourth, specific to payroll: `netSalary` is the only figure that means "what
 * the employee received". Gross is derived, and deriving it two different ways in
 * two different reports is how two reports come to disagree — so it is derived
 * once, here.
 */
@Injectable()
export class PayrollReportsService {
  constructor(
    private prisma: PrismaService,
    private features: PayrollFeaturesService,
  ) {}

  /**
   * The flag gates the API, not only the screen.
   *
   * `payroll_reports_enabled` was parsed into `PayrollFeatures.reportsEnabled`
   * and read by nothing: switching it off hid the menu entry in `navConfig` and
   * changed no behaviour at all, so the routes stayed open and the module hub
   * happily read them. Every other payroll extension 404s when its switch is
   * off — a switch that only moves the navigation is not a switch.
   *
   * All five `PE-RPT` e2e cases already wrap themselves in `REPORTS_ON`, so
   * this is the gate they were written against.
   */
  private async assertEnabled(): Promise<void> {
    const features = await this.features.resolve();
    if (!features.reportsEnabled) {
      throw new NotFoundException('Payroll reports are not enabled');
    }
  }

  /** Runs whose money has NOT moved yet. */
  private async openPayrolls(branchId?: string) {
    return this.prisma.payroll.findMany({
      where: {
        status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] },
        ...(branchId ? { branchId } : {}),
      },
      select: { id: true, month: true, year: true, status: true },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 20,
    });
  }

  private assertPeriod(month?: number, year?: number) {
    if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
      throw new BadRequestException('year must be between 2000 and 2100.');
    }
    if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
      throw new BadRequestException('month must be between 1 and 12.');
    }
  }

  private grossOf(i: Record<string, unknown>): number {
    const n = (v: unknown) => Number(v ?? 0);
    return (
      n(i.baseSalary) +
      n(i.allowances) +
      n(i.bonus) +
      n(i.overtimePay) +
      n(i.foodAllowance)
    );
  }

  /** Every item in one period, with its breakdown when itemisation is on. */
  async register(month: number, year: number, branchId?: string) {
    await this.assertEnabled();
    this.assertPeriod(month, year);
    const payrolls = await this.prisma.payroll.findMany({
      where: { month, year, status: 'LOCKED', ...(branchId ? { branchId } : {}) },
      include: {
        items: {
          include: {
            employee: {
              select: {
                employeeCode: true,
                fullName: true,
                department: { select: { name: true } },
              },
            },
            lines: { orderBy: { displayOrder: 'asc' } },
          },
        },
      },
    });

    const rows = payrolls.flatMap((p) =>
      p.items.map((i) => ({
        payrollId: p.id,
        employeeCode: i.employee.employeeCode,
        fullName: i.employee.fullName,
        department: i.employee.department?.name ?? null,
        gross: this.grossOf(i as never),
        deductions:
          Number(i.deduction) +
          Number(i.insurance) +
          Number(i.tax) +
          Number(i.garnishment) +
          Number(i.otherRecovery),
        netSalary: Number(i.netSalary),
        lines: i.lines.map((l) => ({
          code: l.code,
          label: l.label,
          category: l.category,
          bucket: l.bucket,
          amount: Number(l.amount),
        })),
      })),
    );

    return {
      success: true,
      data: {
        rows,
        totals: {
          employees: rows.length,
          gross: round2(rows.reduce((a, r) => a + r.gross, 0)),
          deductions: round2(rows.reduce((a, r) => a + r.deductions, 0)),
          net: round2(rows.reduce((a, r) => a + r.netSalary, 0)),
        },
        meta: { openPayrolls: await this.openPayrolls(branchId) },
      },
    };
  }

  /** Where the payroll cost sits. */
  async cost(
    year: number,
    groupBy: 'department' | 'branch',
    month?: number,
    branchId?: string,
  ) {
    await this.assertEnabled();
    this.assertPeriod(month, year);
    const items = await this.prisma.payrollItem.findMany({
      where: {
        payroll: {
          year,
          ...(month ? { month } : {}),
          status: 'LOCKED',
          ...(branchId ? { branchId } : {}),
        },
      },
      include: {
        employee: {
          select: {
            branchId: true,
            department: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } },
          },
        },
      },
    });

    const buckets = new Map<string, { key: string; label: string; gross: number; net: number; employees: Set<string> }>();
    for (const i of items) {
      const key =
        groupBy === 'department'
          ? (i.employee.department?.id ?? 'none')
          : (i.employee.branch?.id ?? 'none');
      const label =
        groupBy === 'department'
          ? (i.employee.department?.name ?? 'No department')
          : (i.employee.branch?.name ?? 'No branch');
      const entry =
        buckets.get(key) ?? { key, label, gross: 0, net: 0, employees: new Set<string>() };
      entry.gross += this.grossOf(i as never);
      entry.net += Number(i.netSalary);
      entry.employees.add(i.employeeId);
      buckets.set(key, entry);
    }

    const rows = [...buckets.values()]
      .map((b) => ({
        key: b.key,
        label: b.label,
        employees: b.employees.size,
        gross: round2(b.gross),
        net: round2(b.net),
      }))
      .sort((a, b) => b.gross - a.gross);

    return {
      success: true,
      data: {
        rows,
        totals: {
          gross: round2(rows.reduce((a, r) => a + r.gross, 0)),
          net: round2(rows.reduce((a, r) => a + r.net, 0)),
        },
        meta: { openPayrolls: await this.openPayrolls(branchId) },
      },
    };
  }

  /** What was withheld, and under which heading. */
  async statutorySummary(month: number, year: number, branchId?: string) {
    await this.assertEnabled();
    this.assertPeriod(month, year);
    const items = await this.prisma.payrollItem.findMany({
      where: {
        payroll: { month, year, status: 'LOCKED', ...(branchId ? { branchId } : {}) },
      },
      select: {
        insurance: true,
        tax: true,
        garnishment: true,
        otherRecovery: true,
        lines: { where: { bucket: { in: ['insurance', 'tax'] } } },
      },
    });

    // Prefer the itemised split when it exists: `insurance` is PF + ESI and
    // `tax` is income tax + professional tax, and the columns cannot say which
    // is which. Falls back to the combined columns when itemisation is off.
    const byCode = new Map<string, number>();
    for (const i of items) {
      for (const l of i.lines) {
        byCode.set(l.code, (byCode.get(l.code) ?? 0) + Number(l.amount));
      }
    }

    return {
      success: true,
      data: {
        combined: {
          insurance: round2(items.reduce((a, i) => a + Number(i.insurance), 0)),
          tax: round2(items.reduce((a, i) => a + Number(i.tax), 0)),
          garnishment: round2(items.reduce((a, i) => a + Number(i.garnishment), 0)),
          otherRecovery: round2(items.reduce((a, i) => a + Number(i.otherRecovery), 0)),
        },
        /** Empty when itemisation has never been switched on. */
        itemised: [...byCode.entries()]
          .map(([code, amount]) => ({ code, amount: round2(amount) }))
          .sort((a, b) => b.amount - a.amount),
        meta: { openPayrolls: await this.openPayrolls(branchId) },
      },
    };
  }

  /** What one employee has been paid this year. */
  async ytd(employeeId: string, year: number) {
    await this.assertEnabled();
    this.assertPeriod(undefined, year);
    const items = await this.prisma.payrollItem.findMany({
      where: { employeeId, payroll: { year, status: 'LOCKED' } },
      include: { payroll: { select: { month: true } } },
      orderBy: { payroll: { month: 'asc' } },
    });

    const months = items.map((i) => ({
      month: i.payroll.month,
      gross: round2(this.grossOf(i as never)),
      insurance: Number(i.insurance),
      tax: Number(i.tax),
      net: Number(i.netSalary),
    }));

    return {
      success: true,
      data: {
        employeeId,
        year,
        months,
        totals: {
          gross: round2(months.reduce((a, m) => a + m.gross, 0)),
          insurance: round2(months.reduce((a, m) => a + m.insurance, 0)),
          tax: round2(months.reduce((a, m) => a + m.tax, 0)),
          net: round2(months.reduce((a, m) => a + m.net, 0)),
        },
        meta: { openPayrolls: await this.openPayrolls() },
      },
    };
  }

  /**
   * "What we would owe if everyone left today."
   *
   * Reports the provision and the entitlement as two DIFFERENT numbers, because
   * they are: the provision is what has been set aside month by month, the
   * entitlement is what would actually be payable. A single figure would let a
   * reader take whichever meaning suited them.
   */
  async gratuityLiability(branchId?: string) {
    await this.assertEnabled();
    const rows = await this.prisma.gratuityAccrual.groupBy({
      by: ['branchId'],
      where: { status: 'ACCRUED', ...(branchId ? { branchId } : {}) },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const settled = await this.prisma.gratuityAccrual.aggregate({
      where: { status: 'SETTLED', ...(branchId ? { branchId } : {}) },
      _sum: { amount: true },
    });

    return {
      success: true,
      data: {
        rows: rows.map((r) => ({
          branchId: r.branchId,
          provisioned: Number(r._sum.amount ?? 0),
          accruals: r._count._all,
        })),
        totals: {
          provisioned: round2(rows.reduce((a, r) => a + Number(r._sum.amount ?? 0), 0)),
          settled: Number(settled._sum.amount ?? 0),
        },
        meta: { openPayrolls: await this.openPayrolls(branchId) },
      },
    };
  }

  /**
   * Month-on-month movement.
   *
   * Splits joiners and leavers out of the delta, because a headcount change read
   * as a pay change is the single most common way a variance report misleads.
   */
  async variance(month: number, year: number, branchId?: string) {
    await this.assertEnabled();
    this.assertPeriod(month, year);
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    const load = async (m: number, y: number) =>
      this.prisma.payrollItem.findMany({
        where: {
          payroll: { month: m, year: y, status: 'LOCKED', ...(branchId ? { branchId } : {}) },
        },
        include: { employee: { select: { employeeCode: true, fullName: true } } },
      });

    const [current, previous] = await Promise.all([
      load(month, year),
      load(prevMonth, prevYear),
    ]);

    const prevBy = new Map(previous.map((i) => [i.employeeId, i]));
    const currBy = new Map(current.map((i) => [i.employeeId, i]));

    const changed: unknown[] = [];
    const joiners: unknown[] = [];
    for (const i of current) {
      const before = prevBy.get(i.employeeId);
      if (!before) {
        joiners.push({
          employeeCode: i.employee.employeeCode,
          fullName: i.employee.fullName,
          net: Number(i.netSalary),
        });
        continue;
      }
      const delta = round2(Number(i.netSalary) - Number(before.netSalary));
      if (delta !== 0) {
        changed.push({
          employeeCode: i.employee.employeeCode,
          fullName: i.employee.fullName,
          previous: Number(before.netSalary),
          current: Number(i.netSalary),
          delta,
        });
      }
    }
    const leavers = previous
      .filter((i) => !currBy.has(i.employeeId))
      .map((i) => ({
        employeeCode: i.employee.employeeCode,
        fullName: i.employee.fullName,
        net: Number(i.netSalary),
      }));

    const sum = (rows: Array<{ net?: number; delta?: number }>, key: 'net' | 'delta') =>
      round2(rows.reduce((a, r) => a + (Number(r[key]) || 0), 0));

    return {
      success: true,
      data: {
        period: { month, year },
        comparedTo: { month: prevMonth, year: prevYear },
        changed,
        joiners,
        leavers,
        totals: {
          currentNet: round2(current.reduce((a, i) => a + Number(i.netSalary), 0)),
          previousNet: round2(previous.reduce((a, i) => a + Number(i.netSalary), 0)),
          // The three parts of the movement, kept apart so a headcount change is
          // never read as a pay change.
          fromPayChanges: sum(changed as never, 'delta'),
          fromJoiners: sum(joiners as never, 'net'),
          fromLeavers: -sum(leavers as never, 'net'),
        },
        meta: { openPayrolls: await this.openPayrolls(branchId) },
      },
    };
  }
}

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;
