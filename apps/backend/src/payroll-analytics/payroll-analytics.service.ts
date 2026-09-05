import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getScopedBranchIds } from '../common/branch/branch-scope.util';
import { PayrollDashboardQueryDto } from './dto/payroll-dashboard-query.dto';
import {
  changePct,
  dateOnly,
  money,
  monthEnd,
  monthKey,
  monthStart,
  monthWindow,
  periodLabel,
  previousMonth,
  safeRate,
} from '../common/analytics/analytics.util';
import {
  ATTENTION_NAME_CAP,
  buildBridge,
  buildFunnel,
  emptyStatusCounts,
  grossOf,
  RUN_STATUS,
  toRunStatus,
} from './payroll-analytics.util';

/**
 * The payroll analytics page's single aggregate.
 *
 * One endpoint, one response. Every visual on the page reads the same payload,
 * so a filter change is one request and every chart moves together; a page that
 * fetched per panel would show the reader six charts partway through agreeing
 * with each other, and no way to tell which two were answering for different
 * periods.
 *
 * ## Mapped onto this repo's payroll, not the one it was designed against
 *
 * The screen was drawn for a schema with `PayrollRun`/`Payslip`/`PayslipLine`.
 * Here the same questions are answered from `Payroll`/`PayrollItem`, and three
 * of the differences are visible in the response rather than hidden:
 *
 * - **`employerCost` is always 0, and `totalCost === gross`.** This payroll
 *   records no employer-side contributions at all — `PayrollItemLine.category`
 *   is EARNING or DEDUCTION and nothing else. That is a structural zero, not an
 *   unanswered question, which is why it is 0 rather than null.
 * - **`late` and `halfDay` are always 0 in the attendance mix.** The status
 *   vocabulary here is PRESENT / ABSENT / LEAVE / HOLIDAY / MISSED_CHECKOUT /
 *   NOT_CHECKED_IN; lateness is simply not recorded, so there is no figure to
 *   report and none is invented.
 * - **`otherCurrencies` is always empty.** One tenant, one payroll currency —
 *   see the note in `utils/formatters.ts`. The field stays in the contract
 *   because the page discloses mixed currencies when they exist.
 */
@Injectable()
export class PayrollAnalyticsService {
  constructor(private prisma: PrismaService) {}

  async summary(query: PayrollDashboardQueryDto, user?: any) {
    const months = query.months ?? 6;
    const currency = await this.currency();
    const branchIds = getScopedBranchIds();

    const anchor = await this.resolveAnchor(query.period, branchIds);
    const window = monthWindow(anchor.year, anchor.month, months);
    const prev = previousMonth(anchor.year, anchor.month);

    // One read for the whole window. Every panel below slices this in memory
    // rather than going back to the database, which is what keeps the charts
    // agreeing with each other: they cannot observe different snapshots.
    const runs = await this.prisma.payroll.findMany({
      where: {
        OR: window.map((m) => ({ month: m.month, year: m.year })),
        ...(branchIds ? { branchId: { in: branchIds } } : {}),
      },
      select: {
        id: true,
        month: true,
        year: true,
        status: true,
        submittedAt: true,
        approvedAt: true,
        lockedAt: true,
        rejectedAt: true,
        createdAt: true,
        items: {
          select: {
            id: true,
            baseSalary: true,
            allowances: true,
            bonus: true,
            deduction: true,
            overtimePay: true,
            foodAllowance: true,
            siteAllowance: true,
            insurance: true,
            tax: true,
            netSalary: true,
            employee: {
              select: {
                id: true,
                fullName: true,
                employmentType: true,
                departmentId: true,
                department: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    // Slicers apply to the ITEMS, never to the runs: filtering a run out
    // entirely would drop the month from the trend line and leave a gap that
    // reads as "nothing was paid" rather than "nothing matched your filter".
    const keep = (item: (typeof runs)[number]['items'][number]) =>
      (!query.departmentId || item.employee.departmentId === query.departmentId) &&
      (!query.employmentType || item.employee.employmentType === query.employmentType);

    const byMonth = new Map<string, (typeof runs)[number]['items']>();
    for (const run of runs) {
      const key = monthKey(run.year, run.month);
      const kept = run.items.filter(keep);
      byMonth.set(key, [...(byMonth.get(key) ?? []), ...kept]);
    }

    const periodItems = byMonth.get(monthKey(anchor.year, anchor.month)) ?? [];
    const previousItems = byMonth.get(monthKey(prev.year, prev.month)) ?? [];

    const totals = this.totals(periodItems);
    const previousTotals = this.totals(previousItems);

    let cumulativeNet = 0;
    const trend = window.map((m) => {
      const items = byMonth.get(m.key) ?? [];
      const t = this.totals(items);
      cumulativeNet += t.net;
      return {
        key: m.key,
        label: m.label,
        gross: t.gross,
        net: t.net,
        deductions: t.deductions,
        employeeCount: items.length,
        cumulativeNet: Number(cumulativeNet.toFixed(2)),
      };
    });

    const [filters, timeOff, overtime, coverage, attendance, activeEmployees] =
      await Promise.all([
        this.filterOptions(query, anchor, branchIds),
        this.timeOff(anchor, query.departmentId),
        this.overtime(anchor, query.departmentId),
        this.attendanceTotals(anchor, query.departmentId, branchIds),
        this.attendanceByDepartment(anchor, query.departmentId, branchIds),
        this.activeEmployeeCount(query, branchIds),
      ]);

    const employeesPaid = new Set(periodItems.map((i) => i.employee.id)).size;

    return {
      filters: {
        applied: {
          months,
          period: monthKey(anchor.year, anchor.month),
          departmentId: query.departmentId ?? null,
          employmentType: query.employmentType ?? null,
        },
        departments: filters.departments,
        employmentTypes: filters.employmentTypes,
      },
      period: {
        label: periodLabel(anchor.year, anchor.month),
        periodStart: dateOnly(monthStart(anchor.year, anchor.month)),
        periodEnd: dateOnly(monthEnd(anchor.year, anchor.month)),
      },
      previousPeriod: {
        label: periodLabel(prev.year, prev.month),
        periodStart: dateOnly(monthStart(prev.year, prev.month)),
        periodEnd: dateOnly(monthEnd(prev.year, prev.month)),
      },
      money: {
        currency,
        otherCurrencies: [],
        gross: totals.gross,
        net: totals.net,
        deductions: totals.deductions,
        employerCost: 0,
        previousNet: previousTotals.net,
        changePct: changePct(totals.net, previousTotals.net),
        // An average of nobody is not zero — there is no divisor.
        averageNet: employeesPaid
          ? Number((totals.net / employeesPaid).toFixed(2))
          : null,
      },
      payslips: { total: periodItems.length, employeesPaid },
      timeOff,
      overtime,
      coverage: {
        ...coverage,
        payrollCompletion: safeRate(employeesPaid, activeEmployees),
        activeEmployees,
      },
      runs: {
        byStatus: this.statusCounts(runs),
        inWindow: runs.length,
        funnel: buildFunnel(runs),
      },
      trend,
      departments: this.departments(periodItems),
      components: this.components(periodItems),
      bridge: buildBridge(totals),
      attendance,
      attention: this.attention(periodItems, runs, anchor, activeEmployees, employeesPaid),
    };
  }

  // ── money ────────────────────────────────────────────────────────────────

  /**
   * Gross, deductions and net over a set of payslips.
   *
   * `net` is the STORED column rather than `gross - deductions`, because each
   * payslip floors its own net at zero. Recomputing it here would quietly
   * un-floor a payslip whose deductions exceeded its pay, and the bridge would
   * then disagree with every payslip it is summarising. The gap the floor added
   * back is reported explicitly instead — see `buildBridge`.
   */
  private totals(items: Array<Record<string, unknown>>) {
    let gross = 0;
    let deductions = 0;
    let net = 0;
    for (const item of items) {
      gross += grossOf(item);
      deductions += money(item.insurance) + money(item.tax);
      net += money(item.netSalary);
    }
    return {
      gross: Number(gross.toFixed(2)),
      deductions: Number(deductions.toFixed(2)),
      net: Number(net.toFixed(2)),
    };
  }

  private departments(items: Array<any>) {
    const rows = new Map<
      string,
      { id: string | null; name: string; employees: Set<string>; gross: number; deductions: number; net: number }
    >();

    for (const item of items) {
      const id = item.employee.department?.id ?? null;
      const name = item.employee.department?.name ?? 'Unassigned';
      const key = id ?? '__unassigned__';
      const row =
        rows.get(key) ??
        { id, name, employees: new Set<string>(), gross: 0, deductions: 0, net: 0 };
      row.employees.add(item.employee.id);
      row.gross += grossOf(item);
      row.deductions += money(item.insurance) + money(item.tax);
      row.net += money(item.netSalary);
      rows.set(key, row);
    }

    const totalCost = [...rows.values()].reduce((sum, r) => sum + r.gross, 0);

    return [...rows.values()]
      .map((r) => ({
        id: r.id,
        name: r.name,
        headcount: r.employees.size,
        gross: Number(r.gross.toFixed(2)),
        deductions: Number(r.deductions.toFixed(2)),
        net: Number(r.net.toFixed(2)),
        // Structurally zero here — see the class note on employer contributions.
        employerCost: 0,
        totalCost: Number(r.gross.toFixed(2)),
        share: safeRate(r.gross, totalCost),
        avgNet: r.employees.size
          ? Number((r.net / r.employees.size).toFixed(2))
          : null,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);
  }

  /**
   * The earnings mix, built from the payslip's own buckets.
   *
   * Deliberately NOT from `PayrollItemLine`: those rows exist only when
   * `payroll_item_lines_enabled` is on, so a mix derived from them would be
   * empty on a tenant that has the flag off and would silently stop summing to
   * gross on one that turned it on midway through a window. The buckets are
   * columns on every payslip ever written, and they reconcile to `gross` by
   * construction.
   */
  private components(items: Array<any>) {
    const buckets = [
      { key: 'BASIC', label: 'Basic', pick: (i: any) => money(i.baseSalary) },
      { key: 'ALLOWANCES', label: 'Allowances', pick: (i: any) => money(i.allowances) },
      { key: 'BONUS', label: 'Bonus', pick: (i: any) => money(i.bonus) },
      { key: 'OVERTIME', label: 'Overtime', pick: (i: any) => money(i.overtimePay) },
      { key: 'FOOD', label: 'Food allowance', pick: (i: any) => money(i.foodAllowance) },
      { key: 'SITE', label: 'Site allowance', pick: (i: any) => money(i.siteAllowance) },
    ];

    return buckets
      .map((b) => ({
        key: b.key,
        label: b.label,
        amount: Number(items.reduce((sum, i) => sum + b.pick(i), 0).toFixed(2)),
      }))
      .filter((b) => b.amount !== 0);
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  private statusCounts(runs: Array<{ status: string }>) {
    const counts = emptyStatusCounts();
    for (const run of runs) counts[toRunStatus(run.status)] += 1;
    return counts;
  }

  // ── the surrounding record ───────────────────────────────────────────────

  private async timeOff(anchor: { year: number; month: number }, departmentId?: string) {
    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        status: 'APPROVED',
        startDate: { lte: monthEnd(anchor.year, anchor.month) },
        endDate: { gte: monthStart(anchor.year, anchor.month) },
        ...(departmentId ? { employee: { departmentId } } : {}),
      },
      select: { totalDays: true },
    });
    return {
      approvedDays: rows.reduce((sum, r) => sum + (r.totalDays ?? 0), 0),
      approvedRequests: rows.length,
    };
  }

  private async overtime(anchor: { year: number; month: number }, departmentId?: string) {
    const rows = await this.prisma.overtimeRequest.findMany({
      where: {
        status: 'APPROVED',
        date: {
          gte: monthStart(anchor.year, anchor.month),
          lte: monthEnd(anchor.year, anchor.month),
        },
        ...(departmentId ? { employee: { departmentId } } : {}),
      },
      select: { hours: true },
    });
    return {
      approvedHours: Number(
        rows.reduce((sum, r) => sum + Number(r.hours ?? 0), 0).toFixed(2),
      ),
    };
  }

  private async attendanceRows(
    anchor: { year: number; month: number },
    departmentId: string | undefined,
    branchIds: string[] | null | undefined,
  ) {
    return this.prisma.attendance.findMany({
      where: {
        date: {
          gte: monthStart(anchor.year, anchor.month),
          lte: monthEnd(anchor.year, anchor.month),
        },
        ...(departmentId || branchIds
          ? {
              employee: {
                ...(departmentId ? { departmentId } : {}),
                ...(branchIds ? { branchId: { in: branchIds } } : {}),
              },
            }
          : {}),
      },
      select: {
        status: true,
        employee: {
          select: { departmentId: true, department: { select: { id: true, name: true } } },
        },
      },
    });
  }

  /**
   * The attendance mix, company-wide for the period.
   *
   * `HOLIDAY` is excluded from `total` on purpose: a closed office is not an
   * attendance event, and counting it would dilute every rate on the panel by
   * however many public holidays the month happened to contain.
   */
  private async attendanceTotals(
    anchor: { year: number; month: number },
    departmentId: string | undefined,
    branchIds: string[] | null | undefined,
  ) {
    const rows = await this.attendanceRows(anchor, departmentId, branchIds);
    const mix = this.mix(rows.map((r) => r.status));
    return {
      ...mix,
      expected: mix.total,
      attendanceRate: safeRate(mix.present, mix.total),
    };
  }

  private async attendanceByDepartment(
    anchor: { year: number; month: number },
    departmentId: string | undefined,
    branchIds: string[] | null | undefined,
  ) {
    const rows = await this.attendanceRows(anchor, departmentId, branchIds);
    const grouped = new Map<string, { id: string | null; name: string; statuses: string[] }>();

    for (const row of rows) {
      const id = row.employee.department?.id ?? null;
      const name = row.employee.department?.name ?? 'Unassigned';
      const key = id ?? '__unassigned__';
      const entry = grouped.get(key) ?? { id, name, statuses: [] };
      entry.statuses.push(row.status);
      grouped.set(key, entry);
    }

    return [...grouped.values()]
      .map((g) => {
        const mix = this.mix(g.statuses);
        return {
          departmentId: g.id,
          name: g.name,
          ...mix,
          healthPct: safeRate(mix.present, mix.total),
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  /**
   * Attendance statuses folded into the mix the panel draws.
   *
   * `MISSED_CHECKOUT` counts as present — the person was at work; they forgot
   * to clock out, which is a data-quality problem and not an absence.
   * `NOT_CHECKED_IN` counts as absent. `late` and `halfDay` are structurally 0:
   * this schema records neither.
   */
  private mix(statuses: string[]) {
    let present = 0;
    let absent = 0;
    let onLeave = 0;
    for (const status of statuses) {
      if (status === 'PRESENT' || status === 'MISSED_CHECKOUT') present += 1;
      else if (status === 'ABSENT' || status === 'NOT_CHECKED_IN') absent += 1;
      else if (status === 'LEAVE') onLeave += 1;
      // HOLIDAY falls through: not an attendance event.
    }
    return { present, late: 0, absent, halfDay: 0, onLeave, total: present + absent + onLeave };
  }

  private async activeEmployeeCount(
    query: PayrollDashboardQueryDto,
    branchIds: string[] | null | undefined,
  ) {
    return this.prisma.employee.count({
      where: {
        status: 'ACTIVE',
        ...(query.departmentId ? { departmentId: query.departmentId } : {}),
        ...(query.employmentType ? { employmentType: query.employmentType } : {}),
        ...(branchIds ? { branchId: { in: branchIds } } : {}),
      },
    });
  }

  // ── attention ────────────────────────────────────────────────────────────

  /**
   * What a payroll officer should look at before signing the period off.
   *
   * `count` is the true total and `names` is a capped sample — a queue longer
   * than the cap would otherwise be under-reported by the one panel whose job
   * is to say how much work is waiting.
   */
  private attention(
    items: Array<any>,
    runs: Array<{ month: number; year: number; status: string }>,
    anchor: { year: number; month: number },
    activeEmployees: number,
    employeesPaid: number,
  ) {
    const out: Array<{
      code: string;
      severity: 'CRITICAL' | 'WARNING' | 'INFO';
      count: number;
      names: string[];
      message: string;
    }> = [];

    const zeroNet = items.filter((i) => money(i.netSalary) <= 0);
    if (zeroNet.length) {
      out.push({
        code: 'ZERO_NET',
        severity: 'CRITICAL',
        count: zeroNet.length,
        names: zeroNet.slice(0, ATTENTION_NAME_CAP).map((i) => i.employee.fullName),
        message: 'Payslips that resolve to nothing payable. Deductions met or exceeded the pay.',
      });
    }

    const unpaid = activeEmployees - employeesPaid;
    if (unpaid > 0) {
      out.push({
        code: 'NOT_PAID',
        severity: 'WARNING',
        count: unpaid,
        names: [],
        message: 'Active employees with no payslip in this period.',
      });
    }

    const open = runs.filter(
      (r) =>
        r.month === anchor.month &&
        r.year === anchor.year &&
        r.status !== 'LOCKED' &&
        r.status !== 'REJECTED',
    );
    if (open.length) {
      out.push({
        code: 'RUN_NOT_LOCKED',
        severity: 'INFO',
        count: open.length,
        names: [],
        message: 'Runs for this period are still open. These figures can still move.',
      });
    }

    return out;
  }

  // ── resolution ───────────────────────────────────────────────────────────

  /**
   * The period the page opens on.
   *
   * The latest LOCKED run, not today. A dashboard that opened on the current
   * month would greet most readers with an empty chart for three weeks out of
   * four, and the first figure they saw would be one still being edited.
   */
  private async resolveAnchor(period: string | undefined, branchIds: string[] | null | undefined) {
    if (period) {
      const [year, month] = period.split('-').map(Number);
      return { year, month };
    }

    const locked = await this.prisma.payroll.findFirst({
      where: {
        status: 'LOCKED',
        ...(branchIds ? { branchId: { in: branchIds } } : {}),
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      select: { year: true, month: true },
    });
    if (locked) return { year: locked.year, month: locked.month };

    const latest = await this.prisma.payroll.findFirst({
      where: branchIds ? { branchId: { in: branchIds } } : {},
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      select: { year: true, month: true },
    });
    if (latest) return { year: latest.year, month: latest.month };

    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  }

  private async filterOptions(
    query: PayrollDashboardQueryDto,
    anchor: { year: number; month: number },
    branchIds: string[] | null | undefined,
  ) {
    const [departments, types] = await Promise.all([
      this.prisma.department.findMany({
        where: branchIds ? { employees: { some: { branchId: { in: branchIds } } } } : {},
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.employee.findMany({
        where: { employmentType: { not: null }, status: 'ACTIVE' },
        select: { employmentType: true },
        distinct: ['employmentType'],
      }),
    ]);

    return {
      departments: departments.map((d) => ({ value: d.id, label: d.name })),
      employmentTypes: types
        .map((t) => t.employmentType)
        .filter((t): t is string => Boolean(t))
        .sort()
        .map((t) => ({ value: t, label: t })),
    };
  }

  /** One tenant, one payroll currency — the global system setting. */
  private async currency(): Promise<string> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: 'payroll_currency' },
      select: { value: true },
    });
    return row?.value || 'INR';
  }
}

export { RUN_STATUS };
