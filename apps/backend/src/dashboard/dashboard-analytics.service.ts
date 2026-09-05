import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getScopedBranchIds } from '../common/branch/branch-scope.util';
import { managerDeptScope } from '../common/services/manager-scope.util';
import { TimezoneService } from '../common/timezone/timezone.service';
import { PayrollAnalyticsService } from '../payroll-analytics/payroll-analytics.service';
import {
  changePct,
  dateOnly,
  daysBetween,
  money,
  monthEnd,
  monthKey,
  monthStart,
  monthWindow,
  periodLabel,
  previousMonth,
  safeRate,
} from '../common/analytics/analytics.util';
import { grossOf, toRunStatus } from '../payroll-analytics/payroll-analytics.util';

type Section = 'workforce' | 'attendance' | 'payroll' | 'approvals' | 'compliance';

/** How many rows a capped expiry sample carries before `count` speaks for it. */
const EXPIRY_SAMPLE_CAP = 5;
/** The window the compliance panel gathers over. */
const EXPIRY_HORIZON_DAYS = 60;

/**
 * `/dashboard/analytics-overview` — the one aggregate behind the main dashboard.
 *
 * ## Why this is not `/dashboard/overview`
 *
 * That route already exists, serves eight counters, and is read by the older
 * dashboard widgets. This is a different contract for a different screen. One
 * URL answering both would mean the server guessing which caller it had, and
 * the day the guess is wrong a reader gets a page of plausible, wrong numbers.
 *
 * ## Entitlement, not truthiness
 *
 * `/dashboard` is the one route every role can open. So a block the caller may
 * not see is **absent** from the response, never zeroed, and `sections` states
 * what arrived. A payroll block of zeroes sent to an employee would tell them
 * the company paid nothing that month; omitting it tells the page not to draw
 * the panel at all. The decision is taken once, here, for the whole payload —
 * fanning out to five endpoints would put it in five places and leave the
 * reader with panels that half-loaded and half-403'd.
 *
 * `me` is the exception: it answers about the caller and nobody else, so it is
 * present for every role and carries no entitlement check.
 */
@Injectable()
export class DashboardAnalyticsService {
  constructor(
    private prisma: PrismaService,
    private tzSvc: TimezoneService,
    private payrollAnalytics: PayrollAnalyticsService,
  ) {}

  async overview(user: any, months: 6 | 12 = 6) {
    const role: string = user?.role ?? 'EMPLOYEE';
    const employeeId: string | null = user?.employeeId ?? user?.employee?.id ?? null;
    const branchIds = getScopedBranchIds();

    const companyTZ = await this.tzSvc.getCompanyTZ();
    const today = this.tzSvc.toDateKey(new Date(), companyTZ);
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth() + 1;

    // A manager sees their own departments and nothing wider. Everyone else who
    // reaches a company-wide section sees all of it.
    const deptIds = role === 'MANAGER' ? managerDeptScope(user) : undefined;

    const sections = this.entitlements(role);
    const currency = await this.currency();

    const [workforce, attendance, payroll, approvals, compliance, me] = await Promise.all([
      sections.includes('workforce') ? this.workforce(year, month, months, deptIds, branchIds) : undefined,
      sections.includes('attendance') ? this.attendance(today, deptIds, branchIds) : undefined,
      sections.includes('payroll') ? this.payroll(months, branchIds) : undefined,
      sections.includes('approvals') ? this.approvals(deptIds) : undefined,
      sections.includes('compliance') ? this.compliance(today, deptIds) : undefined,
      this.me(employeeId, today, currency),
    ]);

    return {
      sections,
      viewer: { role, employeeId },
      today: dateOnly(today),
      periodLabel: periodLabel(year, month),
      currency,
      ...(workforce ? { workforce } : {}),
      ...(attendance ? { attendance } : {}),
      ...(payroll ? { payroll } : {}),
      ...(approvals ? { approvals } : {}),
      ...(compliance ? { compliance } : {}),
      me,
    };
  }

  /**
   * Which blocks this caller is entitled to.
   *
   * Mirrors the `@Roles` on the endpoints each panel would otherwise have
   * called, so the rail, the page and the server cannot disagree about who sees
   * a company-wide figure. An EMPLOYEE gets `me` and nothing else — their whole
   * dashboard is the self block.
   */
  private entitlements(role: string): Section[] {
    switch (role) {
      case 'ADMIN':
      case 'HR_MANAGER':
        return ['workforce', 'attendance', 'payroll', 'approvals', 'compliance'];
      case 'PAYROLL_OFFICER':
        return ['payroll', 'attendance'];
      case 'MANAGER':
        return ['workforce', 'attendance', 'approvals'];
      default:
        return [];
    }
  }

  // ── workforce ────────────────────────────────────────────────────────────

  private async workforce(
    year: number,
    month: number,
    months: 6 | 12,
    deptIds: string[] | null | undefined,
    branchIds: string[] | null | undefined,
  ) {
    const scope = {
      ...(deptIds ? { departmentId: { in: deptIds } } : {}),
      ...(branchIds ? { branchId: { in: branchIds } } : {}),
    };
    const start = monthStart(year, month);
    const end = monthEnd(year, month);

    const [active, joiners, leavers, onProbation, byDeptRaw, all] = await Promise.all([
      this.prisma.employee.count({ where: { ...scope, status: 'ACTIVE' } }),
      this.prisma.employee.count({ where: { ...scope, startDate: { gte: start, lte: end } } }),
      this.prisma.employee.count({ where: { ...scope, endDate: { gte: start, lte: end } } }),
      // No probation column here; a contract of type PROBATION still running is
      // the closest true answer this schema can give.
      this.prisma.contract.count({
        where: {
          status: 'ACTIVE',
          contractType: 'PROBATION',
          ...(deptIds ? { employee: { departmentId: { in: deptIds } } } : {}),
        },
      }),
      this.prisma.employee.groupBy({
        by: ['departmentId'],
        where: { ...scope, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      // The backwards walk needs a hire and leave date per person, nothing else.
      this.prisma.employee.findMany({
        where: scope,
        select: { startDate: true, endDate: true },
      }),
    ]);

    const deptNames = await this.prisma.department.findMany({
      where: { id: { in: byDeptRaw.map((d) => d.departmentId).filter(Boolean) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(deptNames.map((d) => [d.id, d.name]));

    const byDepartment = byDeptRaw
      .map((d) => ({
        id: d.departmentId ?? null,
        name: d.departmentId ? (nameOf.get(d.departmentId) ?? 'Unknown') : 'Unassigned',
        headcount: d._count._all,
      }))
      .sort((a, b) => b.headcount - a.headcount);

    const window = monthWindow(year, month, months);
    const trend = window.map((m) => {
      const mStart = monthStart(m.year, m.month);
      const mEnd = monthEnd(m.year, m.month);
      return {
        key: m.key,
        label: m.label,
        joiners: all.filter((e) => e.startDate >= mStart && e.startDate <= mEnd).length,
        leavers: all.filter((e) => e.endDate && e.endDate >= mStart && e.endDate <= mEnd).length,
        // Active at the close of that month: hired on or before it ended, and
        // not yet left. Reconstructible for every bucket here, so never null —
        // the field stays nullable because the contract allows a window that
        // reaches back past the earliest record.
        headcountEnd: all.filter(
          (e) => e.startDate <= mEnd && (!e.endDate || e.endDate > mEnd),
        ).length as number | null,
      };
    });

    const opened = trend[0]?.headcountEnd ?? null;
    const closed = trend[trend.length - 1]?.headcountEnd ?? null;

    return {
      headcount: active,
      joinersThisMonth: joiners,
      leaversThisMonth: leavers,
      onProbation,
      byDepartment,
      trend,
      growthPct: opened && closed !== null ? changePct(closed, opened) : null,
    };
  }

  // ── attendance ───────────────────────────────────────────────────────────

  /**
   * Today's mix.
   *
   * `settled` is false until the office end has passed, and it matters: before
   * then "absent" is a PREDICTION — somebody who has not arrived at 09:30 may
   * still arrive — so the panel says so rather than printing a number that will
   * be wrong by the afternoon.
   */
  private async attendance(
    today: Date,
    deptIds: string[] | null | undefined,
    branchIds: string[] | null | undefined,
  ) {
    const rows = await this.prisma.attendance.findMany({
      where: {
        date: today,
        ...(deptIds || branchIds
          ? {
              employee: {
                ...(deptIds ? { departmentId: { in: deptIds } } : {}),
                ...(branchIds ? { branchId: { in: branchIds } } : {}),
              },
            }
          : {}),
      },
      select: { status: true },
    });

    let present = 0;
    let absent = 0;
    let onLeave = 0;
    let notCheckedIn = 0;
    for (const r of rows) {
      if (r.status === 'PRESENT' || r.status === 'MISSED_CHECKOUT') present += 1;
      else if (r.status === 'ABSENT') absent += 1;
      else if (r.status === 'LEAVE') onLeave += 1;
      else if (r.status === 'NOT_CHECKED_IN') notCheckedIn += 1;
    }

    // Expected is the working calendar minus approved leave — never headcount.
    // HOLIDAY rows never enter the sum, so a closed day expects nobody.
    const expected = present + absent + notCheckedIn;

    return {
      present,
      // Lateness is not recorded by this schema; 0 is structural, not measured.
      late: 0,
      absent,
      onLeave,
      notCheckedIn,
      expected,
      attendanceRate: safeRate(present, expected),
      settled: await this.officeClosed(),
    };
  }

  /** True once the company's office end time has passed in the company clock. */
  private async officeClosed(): Promise<boolean> {
    const branch = await this.prisma.branch.findFirst({
      where: { officeEndTime: { not: null } },
      select: { officeEndTime: true, timezone: true },
    });
    if (!branch?.officeEndTime) return false;

    const tz = branch.timezone || (await this.tzSvc.getCompanyTZ());
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    }).format(new Date());
    return nowParts >= branch.officeEndTime;
  }

  // ── payroll ──────────────────────────────────────────────────────────────

  /**
   * The payroll block.
   *
   * `trend` and `byDepartment` are deliberately the SAME shapes the analytics
   * page uses, so `NetSalaryTrendChart` and `DepartmentCostChart` mount here
   * with no adapter between them. Two shapes for one series is how the same
   * month starts reading differently on two screens.
   */
  private async payroll(months: 6 | 12, branchIds: string[] | null | undefined) {
    const summary = await this.payrollAnalytics.summary({ months });

    const lastRunRow = await this.prisma.payroll.findFirst({
      where: branchIds ? { branchId: { in: branchIds } } : {},
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      select: { id: true, month: true, year: true, status: true },
    });

    const anchorKey = summary.filters.applied.period;
    const [anchorYear, anchorMonth] = anchorKey.split('-').map(Number);
    const prev = previousMonth(anchorYear, anchorMonth);
    const prevBucket = summary.trend.find((t) => t.key === monthKey(prev.year, prev.month));

    const net = summary.money.net;
    const previousNet = prevBucket?.net ?? null;

    return {
      lastRun: lastRunRow
        ? {
            id: lastRunRow.id,
            label: periodLabel(lastRunRow.year, lastRunRow.month),
            status: toRunStatus(lastRunRow.status),
            net,
            periodStart: dateOnly(monthStart(lastRunRow.year, lastRunRow.month)),
          }
        : null,
      // Null rather than zero when no run is locked: "not yet run" and "ran and
      // paid nothing" are different claims about the same month.
      netThisPeriod: summary.payslips.total ? net : null,
      previousNet,
      changePct: previousNet === null ? null : changePct(net, previousNet),
      employeesPaid: summary.payslips.employeesPaid,
      trend: summary.trend,
      byDepartment: summary.departments,
    };
  }

  // ── approvals ────────────────────────────────────────────────────────────

  /**
   * What is waiting on a decision.
   *
   * Each count is counted in the database, not taken from the length of a page:
   * a queue longer than one page would otherwise be under-reported by the one
   * card whose whole job is to say how much work is waiting.
   */
  private async approvals(deptIds: string[] | undefined) {
    const scope = deptIds ? { employee: { departmentId: { in: deptIds } } } : {};

    const [leave, overtime, oldestLeave, oldestOvertime] = await Promise.all([
      this.prisma.leaveRequest.count({ where: { status: 'PENDING', ...scope } }),
      this.prisma.overtimeRequest.count({ where: { status: 'PENDING', ...scope } }),
      this.prisma.leaveRequest.findFirst({
        where: { status: 'PENDING', ...scope },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.overtimeRequest.findFirst({
        where: { status: 'PENDING', ...scope },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const now = new Date();
    const ageOf = (row: { createdAt: Date } | null) =>
      row ? daysBetween(row.createdAt, now) : null;

    const items = [
      {
        key: 'leave',
        label: 'Leave requests',
        count: leave,
        href: '/dashboard/leaves/pending',
        severity: (leave > 10 ? 'CRITICAL' : leave > 0 ? 'WARNING' : 'INFO') as
          | 'CRITICAL'
          | 'WARNING'
          | 'INFO',
        oldestDays: ageOf(oldestLeave),
      },
      {
        key: 'overtime',
        label: 'Overtime requests',
        count: overtime,
        href: '/dashboard/overtime',
        severity: (overtime > 10 ? 'CRITICAL' : overtime > 0 ? 'WARNING' : 'INFO') as
          | 'CRITICAL'
          | 'WARNING'
          | 'INFO',
        oldestDays: ageOf(oldestOvertime),
      },
    ];

    return { total: leave + overtime, items };
  }

  // ── compliance ───────────────────────────────────────────────────────────

  private async compliance(today: Date, deptIds: string[] | undefined) {
    const horizon = new Date(today);
    horizon.setUTCDate(horizon.getUTCDate() + EXPIRY_HORIZON_DAYS);
    const empScope = deptIds ? { departmentId: { in: deptIds } } : {};

    const [docCount, docs, contractCount, contracts, probationCount, probation] =
      await Promise.all([
        this.prisma.employeeLegalDocument.count({
          where: { isCurrent: true, expiryDate: { lte: horizon }, employee: empScope },
        }),
        this.prisma.employeeLegalDocument.findMany({
          where: { isCurrent: true, expiryDate: { lte: horizon }, employee: empScope },
          orderBy: { expiryDate: 'asc' },
          take: EXPIRY_SAMPLE_CAP,
          select: {
            id: true,
            expiryDate: true,
            documentType: true,
            employee: { select: { id: true, fullName: true } },
          },
        }),
        this.prisma.contract.count({
          where: { status: 'ACTIVE', endDate: { not: null, lte: horizon }, employee: empScope },
        }),
        this.prisma.contract.findMany({
          where: { status: 'ACTIVE', endDate: { not: null, lte: horizon }, employee: empScope },
          orderBy: { endDate: 'asc' },
          take: EXPIRY_SAMPLE_CAP,
          select: {
            id: true,
            endDate: true,
            contractType: true,
            employee: { select: { id: true, fullName: true } },
          },
        }),
        this.prisma.contract.count({
          where: {
            status: 'ACTIVE',
            contractType: 'PROBATION',
            endDate: { not: null, lte: horizon },
            employee: empScope,
          },
        }),
        this.prisma.contract.findMany({
          where: {
            status: 'ACTIVE',
            contractType: 'PROBATION',
            endDate: { not: null, lte: horizon },
            employee: empScope,
          },
          orderBy: { endDate: 'asc' },
          take: EXPIRY_SAMPLE_CAP,
          select: {
            id: true,
            endDate: true,
            employee: { select: { id: true, fullName: true } },
          },
        }),
      ]);

    return {
      documents: {
        count: docCount,
        items: docs.map((d) => ({
          id: d.id,
          employeeName: d.employee.fullName,
          kind: d.documentType,
          expiryDate: dateOnly(d.expiryDate),
          daysLeft: daysBetween(today, d.expiryDate),
          href: `/dashboard/employees/${d.employee.id}`,
        })),
      },
      contracts: {
        count: contractCount,
        items: contracts.map((c) => ({
          id: c.id,
          employeeName: c.employee.fullName,
          kind: c.contractType,
          expiryDate: dateOnly(c.endDate as Date),
          daysLeft: daysBetween(today, c.endDate as Date),
          href: `/dashboard/contracts/${c.id}`,
        })),
      },
      probation: {
        count: probationCount,
        items: probation.map((c) => ({
          id: c.id,
          employeeName: c.employee.fullName,
          kind: 'Probation',
          expiryDate: dateOnly(c.endDate as Date),
          daysLeft: daysBetween(today, c.endDate as Date),
          href: `/dashboard/contracts/${c.id}`,
        })),
      },
      horizonDays: EXPIRY_HORIZON_DAYS,
    };
  }

  // ── me ───────────────────────────────────────────────────────────────────

  /** The self block — present for every role, entitlement-free by design. */
  private async me(employeeId: string | null, today: Date, currency: string) {
    if (!employeeId) {
      return {
        employeeId: null,
        todayStatus: null,
        leaveBalanceDays: null,
        pendingOwnRequests: 0,
        latestPayslip: null,
      };
    }

    const [attendance, balances, pendingLeave, pendingOt, payslip] = await Promise.all([
      this.prisma.attendance.findFirst({
        where: { employeeId, date: today },
        select: { status: true },
      }),
      this.prisma.leaveBalance.findMany({
        where: { employeeId },
        select: {
          annualLeave: true,
          sickLeave: true,
          usedAnnual: true,
          usedSick: true,
          carriedOver: true,
        },
      }),
      this.prisma.leaveRequest.count({ where: { employeeId, status: 'PENDING' } }),
      this.prisma.overtimeRequest.count({ where: { employeeId, status: 'PENDING' } }),
      this.prisma.payrollItem.findFirst({
        where: { employeeId },
        orderBy: [{ payroll: { year: 'desc' } }, { payroll: { month: 'desc' } }],
        select: {
          id: true,
          netSalary: true,
          payroll: { select: { month: true, year: true } },
        },
      }),
    ]);

    return {
      employeeId,
      todayStatus: attendance?.status ?? null,
      // Null when no balance row exists at all: "no entitlement recorded" is not
      // "nothing left".
      // Remaining across every type this schema tracks. Carry-over belongs to
      // the annual bucket — it is last year's unused annual leave, so counting
      // it as its own entitlement would report it twice.
      leaveBalanceDays: balances.length
        ? Number(
            balances
              .reduce(
                (sum, b) =>
                  sum +
                  (b.annualLeave + b.carriedOver - b.usedAnnual) +
                  (b.sickLeave - b.usedSick),
                0,
              )
              .toFixed(1),
          )
        : null,
      pendingOwnRequests: pendingLeave + pendingOt,
      latestPayslip: payslip
        ? {
            id: payslip.id,
            label: periodLabel(payslip.payroll.year, payslip.payroll.month),
            net: money(payslip.netSalary),
            currency,
          }
        : null,
    };
  }

  private async currency(): Promise<string> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: 'payroll_currency' },
      select: { value: true },
    });
    return row?.value || 'INR';
  }
}
