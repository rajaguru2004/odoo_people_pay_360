import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { paginated } from '../common/utils/pagination.util';
import type { Principal } from '../auth/auth.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { AttendanceCalendarService } from '../attendances/attendance-calendar.service';
import { isWeeklyOff, toDayKey } from '../attendances/attendance-calendar.util';
import {
  OvertimePolicyService,
  POLICY_RESOLVABLE_SELECT,
} from '../overtime-policy/overtime-policy.service';
import { ResolvedOvertimeConfig } from '../overtime-policy/overtime-policy.types';
import { overtimeSetting } from '../overtime-policy/overtime-config';
import { splitOvertimeHours } from './overtime-calc.util';
import { CreateOvertimeDto } from './dto/create-overtime.dto';
import { RejectOvertimeDto } from './dto/reject-overtime.dto';
import { ApproveOvertimeDto } from './dto/approve-overtime.dto';

/**
 * Employees are stored as `firstName`/`lastName` here and the screens read one
 * name, so both halves are selected and joined on the way out.
 */
const OVERTIME_EMPLOYEE_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  workEmail: true,
  personalEmail: true,
  departmentId: true,
  branchId: true,
  overtimePolicyId: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

const OVERTIME_INCLUDE = {
  employee: { select: OVERTIME_EMPLOYEE_SELECT },
} satisfies Prisma.OvertimeRequestInclude;

type OvertimeRow = Prisma.OvertimeRequestGetPayload<{
  include: typeof OVERTIME_INCLUDE;
}>;

type EmployeeCard = Prisma.EmployeeGetPayload<{
  select: typeof OVERTIME_EMPLOYEE_SELECT;
}>;

type DayType = 'WEEKDAY' | 'SUNDAY' | 'HOLIDAY';

/** The payable shape both the live preview and the approval write are built on. */
interface OvertimeBreakdown {
  hours: number;
  regularHours: number;
  lateHours: number;
  doubleHours: number;
  doubleLateHours: number;
  dayType: DayType;
  foodAllowance: number;
  otType: string;
}

const DAY_TYPES: readonly DayType[] = ['WEEKDAY', 'SUNDAY', 'HOLIDAY'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The joined name and a single contact address the screens can render. */
function withEmployeeName(employee: EmployeeCard) {
  return {
    ...employee,
    fullName: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
    email: employee.workEmail ?? employee.personalEmail ?? null,
  };
}

function decorate<T extends { employee: EmployeeCard }>(row: T) {
  return { ...row, employee: withEmployeeName(row.employee) };
}

@Injectable()
export class OvertimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly approvalEngine: ApprovalEngineService,
    private readonly calendar: AttendanceCalendarService,
    private readonly otPolicy: OvertimePolicyService,
  ) {}

  async create(
    employeeId: string | null,
    dto: CreateOvertimeDto,
    actorRole?: UserRole,
  ) {
    // An administrator's account need not be linked to an employee record, and
    // an undefined id reaching `findUnique` is a 500 that carries the Prisma
    // invocation into the response body.
    if (!employeeId) {
      throw new BadRequestException('Employee ID is required');
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, branchId: true, ...POLICY_RESOLVABLE_SELECT },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const cfg = await this.otPolicy.resolveOvertimeConfig(employee);
    if (!cfg.enabled) {
      throw new BadRequestException('Overtime feature is disabled');
    }
    if (actorRole === UserRole.EMPLOYEE && !cfg.allowEmployeeSubmit) {
      throw new ForbiddenException(
        'Employee submission of overtime is disabled by administrator',
      );
    }
    if (!cfg.eligible) {
      throw new ForbiddenException(
        'This employee is not eligible for overtime under their assigned policy',
      );
    }

    // A reason is mandatory only while an administrator keeps
    // `overtime_require_reason` on. Turned off, a blank reason is accepted and
    // stored as an empty string, because the column is NOT NULL.
    const reason = (dto.reason ?? '').trim();
    const reasonRequired =
      (await this.setting('overtime_require_reason')) !== 'false';
    if (reasonRequired && !reason) {
      throw new BadRequestException('Reason for overtime is required');
    }

    const startTime = new Date(dto.startTime);
    const endTime = this.readEnd(startTime, new Date(dto.endTime));

    const calculatedHours =
      (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);
    // A tenth of an hour of slack: the client rounds what it displays, and
    // refusing a request over six seconds of drift helps nobody.
    if (Math.abs(calculatedHours - dto.hours) > 0.1) {
      throw new BadRequestException(
        `Hours do not match. Calculated: ${calculatedHours.toFixed(2)}h, Entered: ${dto.hours}h`,
      );
    }

    const requestDate = new Date(dto.date);
    const { dayType, isDoubleOtDay } = await this.classifyDay(
      requestDate,
      employee.branchId,
      cfg,
    );

    // A rest day or holiday is a whole extra shift, not the few hours after a
    // normal one, so it carries its own and much larger daily cap.
    const dailyCap = isDoubleOtDay
      ? cfg.maxHoursPerDoubleDay
      : cfg.maxHoursPerDay;
    if (dto.hours > dailyCap) {
      throw new BadRequestException(
        `Daily overtime limit exceeded (${dailyCap}h). Registered: ${dto.hours}h`,
      );
    }

    await this.assertOutsideWorkHours(startTime, cfg, isDoubleOtDay);

    const month = requestDate.getUTCMonth() + 1;
    const year = requestDate.getUTCFullYear();

    const monthlyTotal = await this.getMonthlyOvertimeHours(
      employeeId,
      month,
      year,
    );
    if (monthlyTotal + dto.hours > cfg.maxHoursPerMonth) {
      throw new BadRequestException(
        `Monthly overtime limit exceeded (${cfg.maxHoursPerMonth}h). Current: ${monthlyTotal}h, Registered: ${dto.hours}h`,
      );
    }

    const yearlyTotal = await this.getYearlyOvertimeHours(employeeId, year);
    if (yearlyTotal + dto.hours > cfg.maxHoursPerYear) {
      throw new BadRequestException(
        `Yearly overtime limit exceeded (${cfg.maxHoursPerYear}h). Current: ${yearlyTotal}h, Registered: ${dto.hours}h`,
      );
    }

    const existingRequest = await this.prisma.overtimeRequest.findFirst({
      where: {
        employeeId,
        date: new Date(dto.date),
        status: { in: ['PENDING', 'APPROVED'] },
      },
      select: { id: true },
    });
    if (existingRequest) {
      throw new BadRequestException(
        'An overtime request already exists for this date',
      );
    }

    const breakdown = await this.computeOvertimeBreakdown(
      startTime,
      endTime,
      isDoubleOtDay ? dayType : 'WEEKDAY',
      cfg,
    );

    // `hours` holds the payable total AFTER the boundary clamp; the per-tier
    // buckets are what payroll multiplies by the tier rates.
    const created = await this.prisma.overtimeRequest.create({
      data: {
        employeeId,
        date: new Date(dto.date),
        startTime,
        endTime,
        hours: breakdown.hours,
        ...this.persistedTiers(breakdown),
        dayType: breakdown.dayType,
        foodAllowance: breakdown.foodAllowance,
        otType: breakdown.otType,
        // Snapshot the governing policy so payroll monetizes against the same
        // rules that classified the hours.
        overtimePolicyId: cfg.policyId,
        reason,
        status: 'PENDING',
      },
      include: OVERTIME_INCLUDE,
    });

    // Materialize the configurable approval trail. A deployment with no active
    // OVERTIME workflow gets `engaged: false` and nothing changes; a chain whose
    // every step resolves to nobody finalizes immediately rather than parking
    // the request in a queue no one can see.
    const init = await this.approvalEngine.initiate(
      'OVERTIME',
      created.id,
      employeeId,
    );
    if (init.engaged && init.finalized) {
      return this.finalizeOvertimeApproval(created.id, null);
    }

    return decorate(created);
  }

  async findAll(
    status?: string,
    employeeId?: string,
    month?: number,
    year?: number,
    page: number = 1,
    limit: number = 20,
    user?: Principal,
    search?: string,
    startDate?: string,
    endDate?: string,
    otType?: string,
  ) {
    const where: Prisma.OvertimeRequestWhereInput = {};
    const employeeWhere: Prisma.EmployeeWhereInput = {};

    if (status && status !== 'all') where.status = status;
    if (employeeId) where.employeeId = employeeId;
    if (otType && otType !== 'all') where.otType = otType;

    if (startDate || endDate) {
      where.date = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(`${endDate}T23:59:59.999Z`) } : {}),
      };
    } else if (month && year) {
      where.date = {
        gte: new Date(Date.UTC(year, month - 1, 1)),
        lte: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
      };
    }

    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { reason: { contains: q, mode: 'insensitive' } },
        { employee: { firstName: { contains: q, mode: 'insensitive' } } },
        { employee: { lastName: { contains: q, mode: 'insensitive' } } },
        { employee: { employeeCode: { contains: q, mode: 'insensitive' } } },
        {
          employee: {
            department: { name: { contains: q, mode: 'insensitive' } },
          },
        },
      ];
    }

    // An EMPLOYEE only ever sees their own, whatever they filtered by; a
    // MANAGER sees their department. Both are ANDed onto the requested filter,
    // so naming somebody else narrows the result to nothing rather than
    // widening it to their queue.
    if (user?.role === UserRole.EMPLOYEE) {
      if (!user.employeeId) {
        throw new ForbiddenException(
          'Your account is not linked to an employee record',
        );
      }
      where.AND = [{ employeeId: user.employeeId }];
    } else if (user?.role === UserRole.MANAGER) {
      employeeWhere.departmentId = user.departmentId;
    }
    if (Object.keys(employeeWhere).length) where.employee = employeeWhere;

    const currentPage = Math.max(1, page);
    const take = Math.max(1, limit);
    const skip = (currentPage - 1) * take;

    const [requests, total] = await this.prisma.$transaction([
      this.prisma.overtimeRequest.findMany({
        where,
        include: OVERTIME_INCLUDE,
        orderBy: { date: 'desc' },
        skip,
        take,
      }),
      this.prisma.overtimeRequest.count({ where }),
    ]);

    return paginated(requests.map(decorate), total, currentPage, take);
  }

  findPending(user?: Principal) {
    return this.findAll(
      'PENDING',
      undefined,
      undefined,
      undefined,
      1,
      20,
      user,
    );
  }

  async findByEmployee(
    employeeId: string,
    user?: Principal,
    page?: number,
    limit?: number,
  ) {
    if (user?.role === UserRole.MANAGER) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { departmentId: true },
      });
      if (!emp || emp.departmentId !== user.departmentId) {
        throw new ForbiddenException(
          'You do not have permission to view employees outside your department.',
        );
      }
    }
    return this.findAll(
      undefined,
      employeeId,
      undefined,
      undefined,
      page || 1,
      limit || 50,
      user,
    );
  }

  /**
   * `user` is supplied only by the HTTP by-id door.
   *
   * The internal callers — approve, reject, cancel — omit it deliberately: an
   * approver sitting on a configured chain may hold the EMPLOYEE role and own
   * none of the record, so the ownership rule would refuse a decision the
   * approval engine is about to authorise. Those paths run their own
   * eligibility checks instead.
   */
  async findOne(
    id: string,
    user?: Principal,
    opts?: { withPreview?: boolean },
  ) {
    const overtime = await this.prisma.overtimeRequest.findUnique({
      where: { id },
      include: OVERTIME_INCLUDE,
    });
    if (!overtime) {
      throw new NotFoundException('Overtime request not found');
    }

    if (user) await this.assertMayRead(overtime, user);

    const row = decorate(overtime);
    if (opts?.withPreview) {
      return { ...row, preview: await this.buildLivePreview(overtime) };
    }
    return row;
  }

  /**
   * Dry run: what the request would look like under these corrections. Nothing
   * is written.
   *
   * It exists because the browser cannot answer the question itself. A
   * client-side recompute reads the company settings, and so ignores both the
   * employee's overtime policy and the branch-aware rest-day and holiday
   * classification. An approver about to change the money has to see the figure
   * that will actually be paid.
   */
  async previewApproverEdit(
    id: string,
    dto: ApproveOvertimeDto,
    user: Principal,
  ) {
    const overtime = await this.findOne(id, user);
    if (overtime.status !== 'PENDING') {
      throw new BadRequestException('Can only edit pending requests');
    }
    await this.assertMayEdit(id, overtime.employeeId, user);
    await this.assertApproverEditEnabled();

    const resolved = await this.resolveApproverEdit(overtime, dto);
    const tier = this.tierFor(resolved.cfg, resolved.dayType);

    // Shaped exactly like buildLivePreview's return, so the review screen reads
    // one object whether it is showing the request as filed or as corrected.
    return {
      ...resolved.breakdown,
      foodAllowance: resolved.effectiveFood,
      foodAllowanceOverride: resolved.foodAllowanceOverride ?? null,
      siteAllowance:
        resolved.siteAllowance ?? Number(overtime.siteAllowance ?? 0),
      startTime: resolved.startTime,
      endTime: resolved.endTime,
      isDoubleOtDay: resolved.isDoubleOtDay,
      regularRate: resolved.cfg.regularRate,
      lateRate: resolved.cfg.lateRate,
      doubleRate: tier ? tier.regularRate : resolved.cfg.doubleRate,
      doubleLateRate: tier ? tier.lateRate : resolved.cfg.doubleRate,
      policyId: resolved.cfg.policyId,
      policyName: resolved.cfg.policyName,
    };
  }

  async approve(
    id: string,
    approverId: string,
    user: Principal,
    dto?: ApproveOvertimeDto,
  ) {
    const overtime = await this.findOne(id);
    if (overtime.status !== 'PENDING') {
      throw new BadRequestException('Can only approve pending requests');
    }

    // Corrections are written BEFORE the decision is recorded. In a multi-step
    // chain an intermediate approver returns below with the request still
    // PENDING and never reaches finalizeOvertimeApproval, so an edit deferred to
    // there would be silently dropped on every step but the last.
    if (this.hasApproverEdit(dto)) {
      await this.applyApproverEdit(id, dto, user, overtime);
    }

    const result = await this.approvalEngine.decide(
      'OVERTIME',
      id,
      overtime.employeeId,
      user,
      'APPROVE',
    );

    if (!result.engaged) {
      await this.assertMayDecideWithoutChain(overtime.employeeId, user);
      return this.finalizeOvertimeApproval(id, approverId);
    }
    if (result.finalized) {
      return this.finalizeOvertimeApproval(id, approverId);
    }
    // An intermediate step is recorded and the request stays PENDING for the
    // next approver. Re-read rather than returning the row loaded above, which
    // predates any correction just written.
    return this.findOne(id);
  }

  async reject(
    id: string,
    approverId: string,
    dto: RejectOvertimeDto,
    user: Principal,
  ) {
    const overtime = await this.findOne(id);
    if (overtime.status !== 'PENDING') {
      throw new BadRequestException('Can only reject pending requests');
    }

    const result = await this.approvalEngine.decide(
      'OVERTIME',
      id,
      overtime.employeeId,
      user,
      'REJECT',
      dto?.rejectedReason,
    );
    if (!result.engaged) {
      await this.assertMayDecideWithoutChain(overtime.employeeId, user);
    }

    const updated = await this.prisma.overtimeRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approverId: approverId ?? undefined,
        approvedAt: new Date(),
        rejectedReason: dto.rejectedReason,
      },
      include: OVERTIME_INCLUDE,
    });
    return decorate(updated);
  }

  async cancel(id: string, employeeId: string | null) {
    const overtime = await this.findOne(id);

    if (!employeeId || overtime.employeeId !== employeeId) {
      throw new ForbiddenException(
        'You do not have permission to cancel this request',
      );
    }
    if (overtime.status !== 'PENDING') {
      throw new BadRequestException('Can only cancel pending requests');
    }

    const updated = await this.prisma.overtimeRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: OVERTIME_INCLUDE,
    });

    // Terminate any live approval trail, or an approver could finalize a
    // request the employee has already withdrawn.
    await this.approvalEngine.abandon('OVERTIME', id);

    return decorate(updated);
  }

  /** Approved hours in a month — what payroll reads. */
  async getApprovedOvertimeHours(
    employeeId: string,
    month: number,
    year: number,
  ) {
    const result = await this.prisma.overtimeRequest.aggregate({
      where: {
        employeeId,
        status: 'APPROVED',
        date: {
          gte: new Date(Date.UTC(year, month - 1, 1)),
          lte: new Date(Date.UTC(year, month, 0)),
        },
      },
      _sum: { hours: true },
    });
    return Number(result._sum.hours) || 0;
  }

  /**
   * The month's requests with their totals.
   *
   * The row count is taken first and used as the page size: `findAll` pages at
   * twenty, and summing a page rather than a month reports the wrong money for
   * any month with more than twenty requests in it.
   */
  async getMonthlyReport(month: number, year: number) {
    const total = await this.prisma.overtimeRequest.count({
      where: {
        date: {
          gte: new Date(Date.UTC(year, month - 1, 1)),
          lte: new Date(Date.UTC(year, month, 0)),
        },
      },
    });
    const result = await this.findAll(
      undefined,
      undefined,
      month,
      year,
      1,
      Math.max(total, 1),
    );
    const overtimeRequests = result.data;

    const byEmployee: Record<
      string,
      { employee: unknown; totalHours: number; requests: number }
    > = {};

    for (const request of overtimeRequests) {
      const empId = request.employee.id;
      byEmployee[empId] ??= {
        employee: request.employee,
        totalHours: 0,
        requests: 0,
      };
      if (request.status === 'APPROVED') {
        byEmployee[empId].totalHours += Number(request.hours);
      }
      byEmployee[empId].requests += 1;
    }

    return {
      month,
      year,
      summary: {
        totalRequests: overtimeRequests.length,
        pending: overtimeRequests.filter((r) => r.status === 'PENDING').length,
        approved: overtimeRequests.filter((r) => r.status === 'APPROVED')
          .length,
        rejected: overtimeRequests.filter((r) => r.status === 'REJECTED')
          .length,
        totalHours: overtimeRequests
          .filter((r) => r.status === 'APPROVED')
          .reduce((sum, r) => sum + Number(r.hours), 0),
        byEmployee,
      },
      requests: overtimeRequests,
    };
  }

  // ── Access ───────────────────────────────────────────────────────────────

  /**
   * Ownership on the by-id door, with the exception the approval chain needs.
   *
   * An approver on a configured chain is entitled to open a request they
   * neither own nor manage — that is the whole point of naming them on the
   * chain — so the engine gets the last word before a refusal.
   */
  private async assertMayRead(overtime: OvertimeRow, user: Principal) {
    const owns =
      user.role === UserRole.EMPLOYEE
        ? overtime.employeeId === user.employeeId
        : user.role === UserRole.MANAGER
          ? overtime.employee.departmentId === user.departmentId
          : true;
    if (owns) return;

    if (
      await this.approvalEngine.isChainParticipant(
        'OVERTIME',
        overtime.id,
        user,
      )
    ) {
      return;
    }
    throw new ForbiddenException(
      'You do not have permission to view this overtime request',
    );
  }

  /**
   * The fallback rule when no approval chain is configured.
   *
   * A MANAGER decides only inside their own department; anyone else who reached
   * the route passed the role guard already.
   */
  private async assertMayDecideWithoutChain(
    employeeId: string,
    user: Principal,
  ) {
    if (user.role !== UserRole.MANAGER) return;
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { departmentId: true },
    });
    if (!emp || emp.departmentId !== user.departmentId) {
      throw new ForbiddenException(
        'You do not have permission to decide overtime outside your department.',
      );
    }
  }

  /**
   * May this caller change the numbers on the request right now?
   *
   * With a chain engaged the answer is the trail's own `canAct` — the very test
   * `decide()` will run a moment later, so an edit is offered exactly when the
   * approval it rides on would succeed.
   *
   * With no chain the rule is deliberately STRICTER than the one `approve()`
   * falls back to. That path admits the EMPLOYEE role without an ownership
   * test, which is tolerable for a yes/no decision on a queue the caller had to
   * be shown, but not for rewriting hours and allowances.
   */
  private async assertMayEdit(
    id: string,
    employeeId: string,
    user: Principal,
  ): Promise<void> {
    const trail = await this.approvalEngine.trailFor('OVERTIME', id, user);
    if (trail.engaged) {
      if (!trail.canAct) {
        throw new ForbiddenException(
          'You are not an eligible approver for the current step',
        );
      }
      return;
    }

    if (user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER) {
      return;
    }
    if (user.role === UserRole.MANAGER) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { departmentId: true },
      });
      if (emp && emp.departmentId === user.departmentId) return;
    }
    throw new ForbiddenException(
      'You do not have permission to edit this overtime request',
    );
  }

  // ── Breakdown ────────────────────────────────────────────────────────────

  /**
   * Resolve the effective policy and the branch-aware day type for a request,
   * then run the payable breakdown against them. One source of truth, shared by
   * the detail page's preview and by the approval that freezes the numbers.
   */
  private async resolveLiveBreakdown(overtime: {
    employeeId: string;
    date: Date;
    startTime: Date;
    endTime: Date;
  }) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: overtime.employeeId },
      select: { branchId: true, ...POLICY_RESOLVABLE_SELECT },
    });
    const cfg = await this.otPolicy.resolveOvertimeConfig({
      overtimePolicyId: emp?.overtimePolicyId ?? null,
      employmentType: emp?.employmentType ?? null,
    });
    const { dayType, isDoubleOtDay } = await this.classifyDay(
      new Date(overtime.date),
      emp?.branchId ?? null,
      cfg,
    );
    const breakdown = await this.computeOvertimeBreakdown(
      overtime.startTime,
      overtime.endTime,
      isDoubleOtDay ? dayType : 'WEEKDAY',
      cfg,
    );
    return { cfg, dayType, isDoubleOtDay, breakdown };
  }

  /**
   * The breakdown plus the rates that monetize it, so the client can show the
   * expected pay without re-deriving a single rule from the settings screen.
   *
   * A failure degrades to `null`: the page falls back to its own estimate
   * rather than losing the request detail entirely.
   */
  private async buildLivePreview(overtime: OvertimeRow) {
    try {
      // PENDING shows what approval WILL persist under today's rules. A decided
      // request shows the FROZEN numbers, monetized by the policy snapshot the
      // row carries — recomputing them would show an approver a figure that no
      // longer matches the payslip.
      const decided = overtime.status !== 'PENDING';
      const { cfg, dayType, isDoubleOtDay, breakdown } = decided
        ? await this.frozenBreakdown(overtime)
        : await this.resolveLiveBreakdown(overtime);
      const tier = this.tierFor(cfg, dayType);
      const override = overtime.foodAllowanceOverride;

      return {
        ...breakdown,
        // An approver override outranks the recomputed figure for the same
        // reason it does at approval: the page must show what will be paid.
        foodAllowance:
          !decided && override !== null
            ? Number(override)
            : breakdown.foodAllowance,
        foodAllowanceOverride: override === null ? null : Number(override),
        // Never recomputed, only ever carried — see finalizeOvertimeApproval.
        siteAllowance: Number(overtime.siteAllowance ?? 0),
        isDoubleOtDay,
        regularRate: cfg.regularRate,
        lateRate: cfg.lateRate,
        doubleRate: tier ? tier.regularRate : cfg.doubleRate,
        doubleLateRate: tier ? tier.lateRate : cfg.doubleRate,
        policyId: cfg.policyId,
        policyName: cfg.policyName,
      };
    } catch {
      return null;
    }
  }

  /** The persisted breakdown of a decided request plus its snapshot config. */
  private async frozenBreakdown(overtime: OvertimeRow) {
    const cfg = await this.otPolicy.configForPolicyId(
      overtime.overtimePolicyId,
    );
    const dayType = (
      DAY_TYPES.includes(overtime.dayType as DayType)
        ? overtime.dayType
        : 'WEEKDAY'
    ) as DayType;

    const hours = Number(overtime.hours) || 0;
    let regularHours = Number(overtime.regularHours) || 0;
    let lateHours = Number(overtime.lateHours) || 0;
    let doubleHours = Number(overtime.doubleHours) || 0;
    let doubleLateHours = Number(overtime.doubleLateHours) || 0;

    // A row whose buckets are all zero carries only a total. Rebuild its single
    // bucket from otType so the page shows the hours that get paid rather than
    // a breakdown of nothing.
    if (
      regularHours + lateHours + doubleHours + doubleLateHours === 0 &&
      hours > 0
    ) {
      if (overtime.otType === 'DOUBLE_LATE') {
        doubleLateHours = hours;
      } else if (overtime.otType === 'DOUBLE') {
        doubleHours = hours;
      } else if (overtime.otType === 'LATE') {
        lateHours = hours;
      } else {
        regularHours = hours;
      }
    }

    return {
      cfg,
      dayType,
      isDoubleOtDay: dayType !== 'WEEKDAY',
      breakdown: {
        hours,
        regularHours,
        lateHours,
        doubleHours,
        doubleLateHours,
        dayType,
        foodAllowance: Number(overtime.foodAllowance) || 0,
        otType: overtime.otType,
      } satisfies OvertimeBreakdown,
    };
  }

  /** The rate tier a day type is paid on; null on an ordinary weekday. */
  private tierFor(cfg: ResolvedOvertimeConfig, dayType: DayType) {
    if (dayType === 'HOLIDAY') return cfg.holiday;
    if (dayType === 'SUNDAY') return cfg.sunday;
    return null;
  }

  /**
   * The four tier buckets, one column each.
   *
   * They are kept apart because each is paid at its own multiplier: a rest-day
   * window that runs past the late threshold earns the double-regular rate up
   * to it and the double-late rate after, and folding the two together would
   * pay the whole window at whichever rate was chosen for the pair.
   */
  private persistedTiers(breakdown: OvertimeBreakdown) {
    return {
      regularHours: breakdown.regularHours,
      lateHours: breakdown.lateHours,
      doubleHours: breakdown.doubleHours,
      doubleLateHours: breakdown.doubleLateHours,
    };
  }

  /** Does this body actually ask for a change, or is it a plain approve? */
  private hasApproverEdit(dto?: ApproveOvertimeDto): dto is ApproveOvertimeDto {
    if (!dto) return false;
    return (
      dto.startTime !== undefined ||
      dto.endTime !== undefined ||
      dto.foodAllowance !== undefined ||
      dto.siteAllowance !== undefined ||
      dto.siteAllowanceNote !== undefined
    );
  }

  /**
   * Validate an approver's proposed changes and return what they would produce.
   * Pure: nothing is written, so the same routine backs both the dry run the
   * review screen calls on every keystroke and the real edit.
   */
  private async resolveApproverEdit(
    overtime: {
      id: string;
      employeeId: string;
      date: Date;
      startTime: Date;
      endTime: Date;
    },
    dto: ApproveOvertimeDto,
  ) {
    const startTime = dto.startTime
      ? new Date(dto.startTime)
      : overtime.startTime;
    const endTime = this.readEnd(
      startTime,
      dto.endTime ? new Date(dto.endTime) : overtime.endTime,
    );

    const { cfg, dayType, isDoubleOtDay, breakdown } =
      await this.resolveLiveBreakdown({
        employeeId: overtime.employeeId,
        date: overtime.date,
        startTime,
        endTime,
      });

    if (!cfg.eligible) {
      throw new ForbiddenException(
        'This employee is not eligible for overtime under their assigned policy',
      );
    }

    await this.assertOutsideWorkHours(startTime, cfg, isDoubleOtDay);

    // The window can clamp away to nothing at the day boundary, and an approver
    // who moves a shift past it would otherwise approve a request worth zero.
    if (breakdown.hours <= 0) {
      throw new BadRequestException(
        'The corrected window has no payable overtime hours',
      );
    }

    const dailyCap = isDoubleOtDay
      ? cfg.maxHoursPerDoubleDay
      : cfg.maxHoursPerDay;
    if (breakdown.hours > dailyCap) {
      throw new BadRequestException(
        `Daily overtime limit exceeded (${dailyCap}h). Corrected to: ${breakdown.hours}h`,
      );
    }

    // The row under edit is itself PENDING and so already inside these sums.
    // Counted twice, an edit that LOWERS the hours could still be refused.
    const requestDate = new Date(overtime.date);
    const month = requestDate.getUTCMonth() + 1;
    const year = requestDate.getUTCFullYear();
    const monthlyTotal = await this.getMonthlyOvertimeHours(
      overtime.employeeId,
      month,
      year,
      overtime.id,
    );
    if (monthlyTotal + breakdown.hours > cfg.maxHoursPerMonth) {
      throw new BadRequestException(
        `Monthly overtime limit exceeded (${cfg.maxHoursPerMonth}h). Other requests: ${monthlyTotal}h, Corrected to: ${breakdown.hours}h`,
      );
    }
    const yearlyTotal = await this.getYearlyOvertimeHours(
      overtime.employeeId,
      year,
      overtime.id,
    );
    if (yearlyTotal + breakdown.hours > cfg.maxHoursPerYear) {
      throw new BadRequestException(
        `Yearly overtime limit exceeded (${cfg.maxHoursPerYear}h). Other requests: ${yearlyTotal}h, Corrected to: ${breakdown.hours}h`,
      );
    }

    // Food allowance: absent leaves the policy in charge, and a value — zero
    // included — wins. Overriding it while the policy pays no food allowance at
    // all would be inventing a payment the policy does not have, so that is
    // refused rather than quietly honoured.
    let foodAllowanceOverride: number | undefined;
    if (dto.foodAllowance !== undefined) {
      if (!cfg.foodAllowanceEnabled) {
        throw new BadRequestException(
          'Food allowance is disabled by the overtime policy for this employee',
        );
      }
      foodAllowanceOverride = dto.foodAllowance;
    }

    // The note is grounds for the amount, so writing one engages the same gate
    // and defaults the amount to zero rather than leaving a reason attached to
    // whatever figure happened to be on the row already.
    let siteAllowance: number | undefined;
    if (
      dto.siteAllowance !== undefined ||
      dto.siteAllowanceNote !== undefined
    ) {
      const enabled =
        (await this.setting('overtime_site_allowance_enabled')) === 'true';
      if (!enabled) {
        throw new BadRequestException('Site allowance is disabled');
      }
      siteAllowance = dto.siteAllowance ?? 0;
      const max = Number(await this.setting('overtime_site_allowance_max'));
      // Zero means "no ceiling".
      if (max > 0 && siteAllowance > max) {
        throw new BadRequestException(
          `Site allowance exceeds the maximum of ${max}`,
        );
      }
    }

    const effectiveFood =
      foodAllowanceOverride !== undefined
        ? foodAllowanceOverride
        : breakdown.foodAllowance;

    return {
      cfg,
      dayType,
      isDoubleOtDay,
      breakdown,
      startTime,
      endTime,
      foodAllowanceOverride,
      siteAllowance,
      effectiveFood,
    };
  }

  private async assertApproverEditEnabled(): Promise<void> {
    const enabled =
      (await this.setting('overtime_approver_edit_enabled')) !== 'false';
    if (!enabled) {
      throw new BadRequestException(
        'Editing an overtime request while approving it is disabled',
      );
    }
  }

  /**
   * Persist an approver's corrections.
   *
   * Only the times, the food override, the site allowance and the note are
   * written. The tier buckets are NOT: they are derived, and
   * finalizeOvertimeApproval recomputes them from the stored window, which by
   * then is the corrected one.
   */
  private async applyApproverEdit(
    id: string,
    dto: ApproveOvertimeDto,
    user: Principal,
    overtime: OvertimeRow,
  ) {
    await this.assertApproverEditEnabled();
    await this.assertMayEdit(id, overtime.employeeId, user);

    // Optimistic concurrency. Two approvers can hold the same request open —
    // an HR step and an administrator override, say — and last write wins would
    // let one silently discard the other's correction.
    if (dto.expectedUpdatedAt) {
      const seen = new Date(dto.expectedUpdatedAt).getTime();
      if (seen !== overtime.updatedAt.getTime()) {
        throw new ConflictException(
          'This request was changed by someone else. Reload it and review the current values.',
        );
      }
    }

    const resolved = await this.resolveApproverEdit(overtime, dto);

    const data: Prisma.OvertimeRequestUpdateInput = {
      startTime: resolved.startTime,
      endTime: resolved.endTime,
      editedBy: { connect: { id: user.id } },
      editedAt: new Date(),
    };
    if (resolved.foodAllowanceOverride !== undefined) {
      data.foodAllowanceOverride = resolved.foodAllowanceOverride;
    }
    if (resolved.siteAllowance !== undefined) {
      data.siteAllowance = resolved.siteAllowance;
      data.siteAllowanceNote = dto.siteAllowanceNote?.trim() || null;
    }
    if (dto.approverNote !== undefined) {
      data.approverNote = dto.approverNote?.trim() || null;
    }
    // First edit only: keep what the employee actually filed, so a second
    // approver's correction cannot overwrite the original with an edited value.
    if (!overtime.originalStartTime) {
      data.originalStartTime = overtime.startTime;
      data.originalEndTime = overtime.endTime;
    }

    const updated = await this.prisma.overtimeRequest.update({
      where: { id },
      data,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'OVERTIME_APPROVER_EDIT',
        entityType: 'OvertimeRequest',
        entityId: id,
        metadata: {
          before: {
            startTime: overtime.startTime.toISOString(),
            endTime: overtime.endTime.toISOString(),
            hours: Number(overtime.hours),
            foodAllowance: Number(overtime.foodAllowance),
            foodAllowanceOverride:
              overtime.foodAllowanceOverride === null
                ? null
                : Number(overtime.foodAllowanceOverride),
            siteAllowance: Number(overtime.siteAllowance),
            siteAllowanceNote: overtime.siteAllowanceNote,
          },
          after: {
            startTime: updated.startTime.toISOString(),
            endTime: updated.endTime.toISOString(),
            hours: resolved.breakdown.hours,
            foodAllowance: resolved.effectiveFood,
            foodAllowanceOverride:
              updated.foodAllowanceOverride === null
                ? null
                : Number(updated.foodAllowanceOverride),
            siteAllowance: Number(updated.siteAllowance),
            siteAllowanceNote: updated.siteAllowanceNote,
            approverNote: updated.approverNote,
          },
        },
      },
    });

    return updated;
  }

  /**
   * Freeze the approval: recompute the payable breakdown from the current
   * rules, then persist APPROVED.
   */
  private async finalizeOvertimeApproval(
    id: string,
    approverId: string | null,
  ) {
    const overtime = await this.findOne(id);
    const { cfg, breakdown } = await this.resolveLiveBreakdown(overtime);

    // Eligibility is re-checked here, not just at submission: a policy edit or
    // a reassignment between the two must not let an ineligible employee's
    // hours slip through into payroll.
    if (!cfg.eligible) {
      throw new ForbiddenException(
        'This employee is no longer eligible for overtime under their assigned policy',
      );
    }

    const updated = await this.prisma.overtimeRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approverId: approverId ?? undefined,
        approvedAt: new Date(),
        hours: breakdown.hours,
        ...this.persistedTiers(breakdown),
        dayType: breakdown.dayType,
        // An explicit approver value wins, otherwise the policy recomputes.
        // Null is not "no allowance": it means nobody overrode it, which is
        // exactly why the column is nullable. `siteAllowance` is deliberately
        // ABSENT from this payload — it is approver-granted with nothing to
        // recompute it from, so naming it here would zero it on every approval.
        foodAllowance:
          overtime.foodAllowanceOverride !== null
            ? overtime.foodAllowanceOverride
            : breakdown.foodAllowance,
        otType: breakdown.otType,
        // Re-snapshot the governing policy at approval time.
        overtimePolicyId: cfg.policyId,
      },
      include: OVERTIME_INCLUDE,
    });

    return decorate(updated);
  }

  // ── Sums and rules ───────────────────────────────────────────────────────

  /**
   * `excludeId` exists for the approver edit: the row being edited is itself
   * PENDING and therefore already inside this sum, so counting it would charge
   * the employee for the same hours twice and refuse an edit that lowers them.
   */
  private async getMonthlyOvertimeHours(
    employeeId: string,
    month: number,
    year: number,
    excludeId?: string,
  ): Promise<number> {
    const result = await this.prisma.overtimeRequest.aggregate({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        date: {
          gte: new Date(Date.UTC(year, month - 1, 1)),
          lte: new Date(Date.UTC(year, month, 0)),
        },
      },
      _sum: { hours: true },
    });
    return Number(result._sum.hours) || 0;
  }

  /** See getMonthlyOvertimeHours for why `excludeId` exists. */
  private async getYearlyOvertimeHours(
    employeeId: string,
    year: number,
    excludeId?: string,
  ): Promise<number> {
    const result = await this.prisma.overtimeRequest.aggregate({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        date: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lte: new Date(Date.UTC(year, 11, 31)),
        },
      },
      _sum: { hours: true },
    });
    return Number(result._sum.hours) || 0;
  }

  /**
   * Which premium tier the day earns.
   *
   * Holidays win over a weekly rest day when a date is both, and a policy set
   * to IGNORE holidays falls through to the rest-day or weekday answer — that
   * is what daily-wage terms mean by "a public holiday is an ordinary day".
   * Both the holiday and the rest day come from the branch calendar, so an
   * office observing a national day its sister branch does not is expressed
   * without a second calendar.
   */
  private async classifyDay(
    date: Date,
    branchId: string | null,
    cfg: ResolvedOvertimeConfig,
  ): Promise<{ dayType: DayType; isDoubleOtDay: boolean }> {
    const dayKey = toDayKey(date);
    const [configs, holidays] = await Promise.all([
      this.calendar.branchConfigs(),
      this.calendar.holidayIndex(dayKey, dayKey),
    ]);
    const branchConfig = this.calendar.configFor(configs, branchId);
    const holiday =
      cfg.holidayBehavior === 'IGNORE'
        ? null
        : this.calendar.holidayOn(holidays, dayKey, branchId);
    const restDay = isWeeklyOff(date, branchConfig.weeklyOffDays);

    const dayType: DayType = holiday
      ? 'HOLIDAY'
      : restDay
        ? 'SUNDAY'
        : 'WEEKDAY';
    return {
      dayType,
      isDoubleOtDay: cfg.doubleOtEnabled && dayType !== 'WEEKDAY',
    };
  }

  /**
   * Overtime has to start outside the working day, or ordinary paid hours could
   * be claimed twice — once as salary and once as overtime.
   *
   * The approver edit is held to the same rule the employee was, or correcting
   * a window becomes the way around it. The start is read in UTC wall clock:
   * overtime times are stored zone-naive tagged UTC, so the UTC getters recover
   * the hour that was entered on any server.
   */
  private async assertOutsideWorkHours(
    startTime: Date,
    cfg: ResolvedOvertimeConfig,
    isDoubleOtDay: boolean,
  ): Promise<void> {
    // A rest day has no working hours to overlap, when the policy says so.
    if (isDoubleOtDay && cfg.doubleOtAllowAnytime) return;

    const startMinutes =
      startTime.getUTCHours() * 60 + startTime.getUTCMinutes();

    const startSetting =
      (await this.settings.get('attendance_office_start')) ?? '08:00';
    const endSetting = cfg.shiftEndTime || '17:00';

    const [startHour, startMin] = startSetting.split(':').map(Number);
    const [endHour, endMin] = endSetting.split(':').map(Number);

    const workStart =
      (isNaN(startHour) ? 8 : startHour) * 60 +
      (isNaN(startMin) ? 0 : startMin);
    const workEnd =
      (isNaN(endHour) ? 17 : endHour) * 60 + (isNaN(endMin) ? 0 : endMin);

    if (startMinutes >= workStart && startMinutes < workEnd) {
      throw new BadRequestException(
        `Overtime hours must be outside of regular work hours (${startSetting}-${endSetting})`,
      );
    }
  }

  private async computeOvertimeBreakdown(
    startTime: Date,
    endTime: Date,
    dayType: DayType,
    cfg: ResolvedOvertimeConfig,
  ): Promise<OvertimeBreakdown> {
    const isDoubleOtDay = dayType !== 'WEEKDAY';
    /** "HH:MM" into minutes past midnight, falling back to 22:00 on nonsense. */
    const parseThreshold = (value: string) => {
      const [h, m] = (value || '').split(':').map(Number);
      return (isNaN(h) ? 22 : h) * 60 + (isNaN(m) ? 0 : m);
    };

    // Overtime is only counted up to the close of the attendance day. A policy
    // may set its own boundary; otherwise the company value applies.
    const boundaryRaw =
      cfg.dayEndBoundary ?? (await this.setting('attendance_day_end_time'));
    const dayBoundaryMinutes = parseThreshold(boundaryRaw);

    const lateThresholdMinutes = parseThreshold(cfg.lateThreshold);
    const dblCfg = dayType === 'HOLIDAY' ? cfg.holiday : cfg.sunday;
    const doubleLateThresholdMinutes = parseThreshold(
      dblCfg?.lateThreshold ?? cfg.lateThreshold,
    );
    const split = splitOvertimeHours(
      startTime,
      endTime,
      isDoubleOtDay,
      lateThresholdMinutes,
      dayBoundaryMinutes,
      doubleLateThresholdMinutes,
    );

    // The food allowance has its own threshold time, separate from the pay
    // tier's, and it is judged against the boundary-clamped end — an hour that
    // was never payable cannot earn a meal either.
    const foodThresholdMinutes = parseThreshold(cfg.foodAllowanceThreshold);
    const foodThresholdInstant = new Date(
      Date.UTC(
        startTime.getUTCFullYear(),
        startTime.getUTCMonth(),
        startTime.getUTCDate(),
        Math.floor(foodThresholdMinutes / 60),
        foodThresholdMinutes % 60,
        0,
        0,
      ),
    );
    const isPastFoodThreshold =
      split.effectiveEnd.getTime() > foodThresholdInstant.getTime();

    let foodAllowance = 0;
    if (cfg.foodAllowanceEnabled && split.totalHours > 0) {
      if (isDoubleOtDay) {
        if (isPastFoodThreshold || cfg.doubleFoodAllowanceAnyTime) {
          foodAllowance = cfg.foodAllowanceAmount;
        }
      } else if (isPastFoodThreshold) {
        foodAllowance = cfg.foodAllowanceAmount;
      }
    }

    const otType = isDoubleOtDay
      ? split.isLate
        ? 'DOUBLE_LATE'
        : 'DOUBLE'
      : split.isLate
        ? 'LATE'
        : 'REGULAR';

    return {
      hours: split.totalHours,
      regularHours: split.regularHours,
      lateHours: split.lateHours,
      doubleHours: split.doubleHours,
      doubleLateHours: split.doubleLateHours,
      dayType,
      foodAllowance,
      otType,
    };
  }

  /**
   * An end at or before the start means the shift crossed midnight, not that
   * the request is nonsense — callers routinely send both timestamps on the
   * same calendar date for a 17:00 to 03:00 window. The day-boundary clamp
   * still caps how far it is actually payable.
   */
  private readEnd(startTime: Date, endTime: Date): Date {
    const end =
      endTime <= startTime ? new Date(endTime.getTime() + MS_PER_DAY) : endTime;
    if (end <= startTime) {
      throw new BadRequestException('End time must be after start time');
    }
    return end;
  }

  private setting(key: Parameters<typeof overtimeSetting>[1]) {
    return overtimeSetting(this.prisma, key);
  }
}
