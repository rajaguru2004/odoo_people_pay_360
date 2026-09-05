import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { PayrollCalendarService } from '../payroll-calendar/payroll-calendar.service';
import { latenessOf } from '../payroll-calendar/calendar-window';
import {
  resolveAttendanceCoverage,
  resolveContracts,
  resolvePopulation,
  resolveSalary,
} from './payroll-preflight.rules';
import type {
  PayrollEmployeeStatus,
  PayrollFinding,
  PayrollPreflightResult,
} from './types/payroll-finding';

/**
 * "Is this run safe to generate?", answered BEFORE the run exists.
 *
 * The WPS pre-flight answers the same shape of question about a wage file, but
 * only once a payroll has been generated and locked — by which point the
 * expensive mistakes have already been made. This runs first.
 *
 * Every check here is derived from the same pure functions `create()` uses, so
 * a "ready" verdict cannot be followed by a refusal. Where a check has no
 * equivalent in `create()` it is a WARNING, never BLOCKING: reporting something
 * as blocking that generation would happily accept is the same failure in the
 * other direction.
 */
@Injectable()
export class PayrollValidationService {
  constructor(
    private prisma: PrismaService,
    private features: PayrollFeaturesService,
    private calendar: PayrollCalendarService,
  ) {}

  async preflight(dto: {
    month: number;
    year: number;
    branchId?: string | null;
    batchId?: string | null;
    employeeIds?: string[] | null;
    runType?: string;
  }): Promise<PayrollPreflightResult> {
    const features = await this.features.resolve();
    // The flag gates the API, not only the screen.
    //
    // Without this the route answered normally with the feature "off", so
    // switching it off hid the menu entry and changed nothing else — and every
    // other feature here 404s when off. A switch that only moves the navigation
    // is not a switch.
    if (!features.preflightEnabled) {
      throw new NotFoundException('Pre-run validation is not enabled');
    }

    const { month, year } = dto;
    const branchId = dto.branchId ?? null;
    const window = await this.calendar.windowForPeriod(branchId, month, year);

    const runFindings: PayrollFinding[] = [];
    const perEmployee = new Map<string, PayrollFinding[]>();
    const addTo = (employeeId: string, finding: PayrollFinding) => {
      const list = perEmployee.get(employeeId) ?? [];
      list.push(finding);
      perEmployee.set(employeeId, list);
    };

    // ── Who would be paid ────────────────────────────────────────────────
    let targetIds: string[] | null = dto.employeeIds ?? null;
    if (dto.batchId) {
      const members = await this.prisma.payrollBatchMember.findMany({
        where: { batchId: dto.batchId },
        select: { employeeId: true },
      });
      targetIds = members.map((m) => m.employeeId);
    }

    const employees = await this.prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
        ...(branchId ? { branchId } : {}),
        ...(targetIds ? { id: { in: targetIds } } : {}),
      },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        baseSalary: true,
        contracts: { where: { status: 'ACTIVE' }, select: { status: true }, take: 1 },
        salaryComponents: {
          where: { isActive: true },
          select: { componentType: true, amount: true },
        },
      },
    });

    const population = resolvePopulation({
      found: employees,
      requestedIds: targetIds,
    });

    if (population.emptyReason === 'ALL_UNMATCHED') {
      runFindings.push({
        code: 'ALL_EMPLOYEES_UNKNOWN',
        severity: 'BLOCKING',
        scope: 'RUN',
        message:
          `None of the ${targetIds?.length ?? 0} employees named could be found ` +
          `in this branch. Generating would produce an empty payroll.`,
      });
    } else if (population.emptyReason === 'NO_EMPLOYEES') {
      runFindings.push({
        code: 'NO_PAYABLE_EMPLOYEES',
        severity: 'BLOCKING',
        scope: 'RUN',
        message: 'There are no active employees to pay in this selection.',
      });
    } else if (population.unmatchedIds.length > 0) {
      runFindings.push({
        code: 'SOME_EMPLOYEES_UNKNOWN',
        severity: 'WARNING',
        scope: 'RUN',
        message:
          `${population.unmatchedIds.length} of the employees named could not be ` +
          `found and will not be paid.`,
      });
    }

    // ── A run already exists for this period ─────────────────────────────
    const existing = await this.prisma.payroll.findFirst({
      where: { month, year, branchId, batchId: dto.batchId ?? null },
      select: { id: true, status: true },
    });
    if (existing) {
      runFindings.push({
        code: existing.status === 'LOCKED' ? 'PERIOD_LOCKED' : 'PERIOD_ALREADY_RUN',
        severity: 'BLOCKING',
        scope: 'RUN',
        message:
          existing.status === 'LOCKED'
            ? `A LOCKED payroll already exists for ${month}/${year}. It must be ` +
              `unlocked before this period can be generated again.`
            : `A payroll already exists for ${month}/${year} (${existing.status}).`,
        fix: { label: 'Open the existing run', href: `/dashboard/payroll/${existing.id}` },
      });
    }

    // ── Attendance ───────────────────────────────────────────────────────
    const employeeIds = employees.map((e) => e.id);
    const counts = employeeIds.length
      ? await this.prisma.attendance.groupBy({
          by: ['employeeId'],
          where: {
            employeeId: { in: employeeIds },
            date: { gte: window.periodStart, lte: window.periodEnd },
            // Copied from the engine's own guard verbatim, including the null
            // arm. `{ not: 'LEAVE' }` alone is SQL `source <> 'LEAVE'`, which is
            // NULL — and therefore false — for every row where source is unset,
            // silently dropping ordinary attendance and reporting a fully
            // captured period as having none.
            OR: [{ source: null }, { source: { notIn: ['LEAVE'] } }],
          },
          _count: { _all: true },
        })
      : [];

    const coverage = resolveAttendanceCoverage({
      counts: counts.map((c) => ({ employeeId: c.employeeId })),
      employeeIds,
    });

    if (employeeIds.length > 0 && coverage.runHasNone) {
      runFindings.push({
        code: 'NO_ATTENDANCE_CAPTURED',
        severity: 'BLOCKING',
        scope: 'RUN',
        message:
          `No attendance has been captured for anybody in ${month}/${year}. ` +
          `Generating now would pay every employee a full month.`,
        fix: { label: 'Review attendance', href: '/dashboard/attendance' },
      });
    } else {
      for (const id of coverage.employeesWithout) {
        addTo(id, {
          code: 'EMPLOYEE_ATTENDANCE_MISSING',
          severity: 'WARNING',
          scope: 'EMPLOYEE',
          employeeId: id,
          field: 'attendance',
          message:
            'No attendance was captured for this employee, so no loss of pay ' +
            'will be applied.',
        });
      }
    }

    // ── Contract and pay ─────────────────────────────────────────────────
    for (const id of resolveContracts(employees).withoutActiveContract) {
      addTo(id, {
        code: 'NO_ACTIVE_CONTRACT',
        severity: 'WARNING',
        scope: 'EMPLOYEE',
        employeeId: id,
        field: 'contract',
        message:
          'This employee has no active contract, so statutory insurance will be ' +
          'waived for them.',
      });
    }
    for (const id of resolveSalary(
      employees.map((e) => ({
        id: e.id,
        baseSalary: e.baseSalary,
        components: e.salaryComponents,
      })),
    ).withoutAnyPay) {
      addTo(id, {
        code: 'NO_PAY_CONFIGURED',
        severity: 'WARNING',
        scope: 'EMPLOYEE',
        employeeId: id,
        field: 'baseSalary',
        message: 'This employee has no salary or components, so they would be paid nothing.',
      });
    }

    // ── Pending approvals inside the period ──────────────────────────────
    if (employeeIds.length > 0) {
      const pendingLeave = await this.prisma.leaveRequest.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: 'PENDING',
          startDate: { lte: window.periodEnd },
          endDate: { gte: window.periodStart },
        },
        select: { employeeId: true },
      });
      for (const id of new Set(pendingLeave.map((l) => l.employeeId))) {
        addTo(id, {
          code: 'UNAPPROVED_LEAVE_IN_PERIOD',
          severity: 'WARNING',
          scope: 'EMPLOYEE',
          employeeId: id,
          field: 'leave',
          message:
            'This employee has leave in the period that is still awaiting ' +
            'approval; it will not be counted.',
          fix: { label: 'Review leave', href: '/dashboard/leaves' },
        });
      }
    }

    // ── Post-cut-off inputs ──────────────────────────────────────────────
    if (features.calendarEnabled && window.cutOffDate && employeeIds.length > 0) {
      const late = await this.prisma.salaryComponent.findMany({
        where: {
          employeeId: { in: employeeIds },
          isActive: true,
          effectiveDate: { gte: window.periodStart, lte: window.periodEnd },
        },
        select: { employeeId: true, createdAt: true, componentType: true },
      });
      for (const c of late) {
        if (latenessOf(c.createdAt, window) !== 'LATE') continue;
        addTo(c.employeeId, {
          // BLOCKING only when the period itself says enforcement is on, which
          // is a per-period column rather than a global switch.
          code: 'POST_CUTOFF_INPUT',
          severity: window.enforceCutOff ? 'BLOCKING' : 'WARNING',
          scope: 'EMPLOYEE',
          employeeId: c.employeeId,
          field: 'salaryComponent',
          message:
            `A ${c.componentType} component was recorded after the ` +
            `${window.cutOffDate.toISOString().slice(0, 10)} cut-off.`,
        });
      }
    }

    // ── Outstanding balances ─────────────────────────────────────────────
    if (employeeIds.length > 0) {
      const carry = await this.prisma.payrollCarryForward.findMany({
        where: { employeeId: { in: employeeIds }, status: 'OUTSTANDING' },
        select: { employeeId: true },
      });
      for (const id of new Set(carry.map((c) => c.employeeId))) {
        addTo(id, {
          code: 'OUTSTANDING_RECOVERY',
          severity: 'WARNING',
          scope: 'EMPLOYEE',
          employeeId: id,
          field: 'carryForward',
          message:
            'This employee has a balance carried from an earlier payslip, which ' +
            'this run will try to collect.',
        });
      }
    }

    // ── Assemble ─────────────────────────────────────────────────────────
    const byEmployee: PayrollEmployeeStatus[] = employees.map((e) => {
      const findings = perEmployee.get(e.id) ?? [];
      const blocked = findings.some((f) => f.severity === 'BLOCKING');
      return {
        employeeId: e.id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        status: blocked ? 'BLOCKED' : findings.length ? 'WARNING' : 'READY',
        findings: findings.map((f) => ({
          ...f,
          employeeCode: e.employeeCode,
          employeeName: e.fullName,
        })),
      };
    });

    const blockedEmployees = byEmployee.filter((e) => e.status === 'BLOCKED').length;
    const warningEmployees = byEmployee.filter((e) => e.status === 'WARNING').length;
    const runBlocking = runFindings.some((f) => f.severity === 'BLOCKING');

    return {
      branchId,
      month,
      year,
      runType: dto.runType ?? 'REGULAR',
      ready: byEmployee.filter((e) => e.status === 'READY').length,
      total: byEmployee.length,
      blockedEmployees,
      warningEmployees,
      // All-or-nothing, exactly as the WPS pre-flight is.
      canGenerate: !runBlocking && blockedEmployees === 0,
      runFindings,
      byEmployee,
      requiresAcknowledgement: [
        ...new Set(
          [...runFindings, ...byEmployee.flatMap((e) => e.findings)]
            .filter((f) => f.severity === 'WARNING')
            .map((f) => f.code),
        ),
      ].sort(),
      window: {
        periodStart: window.periodStart.toISOString().slice(0, 10),
        periodEnd: window.periodEnd.toISOString().slice(0, 10),
        cutOffDate: window.cutOffDate?.toISOString().slice(0, 10) ?? null,
        paymentDate: window.paymentDate?.toISOString().slice(0, 10) ?? null,
        enforceCutOff: window.enforceCutOff,
        fromCalendar: window.fromCalendar,
      },
    };
  }
}
