import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import {
  managerDeptScope,
  isDeptInManagerScope,
} from '../common/services/manager-scope.util';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import { CreateOvertimeDto } from './dto/create-overtime.dto';
import { RejectOvertimeDto } from './dto/reject-overtime.dto';
import { ApproveOvertimeDto } from './dto/approve-overtime.dto';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { splitOvertimeHours } from './overtime-calc.util';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HolidaysService } from '../holidays/holidays.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import { ResolvedOvertimeConfig } from '../overtime-policy/overtime-policy.types';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class OvertimeService {
  // Indian labor law limits
  private readonly MAX_MONTHLY_OVERTIME = 30; // 30 hours per month
  private readonly MAX_YEARLY_OVERTIME = 200; // 200 hours per year

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private settingsService: SystemSettingsService,
    private approvalEngine: ApprovalEngineService,
    private notifications: NotificationsService,
    private holidays: HolidaysService,
    private otPolicy: OvertimePolicyService,
    private audit: AuditService,
  ) {}

  async create(employeeId: string, dto: CreateOvertimeDto, actorRole?: string) {
    // An ADMIN account need not be linked to an employee record, and an
    // undefined id reached `findUnique({ where: { id: undefined } })` — a 500
    // that shipped the Prisma invocation and the absolute source path to the
    // caller.
    if (!employeeId) {
      throw new BadRequestException('Employee ID is required');
    }

    // Load the employee first so overtime rules resolve from their effective
    // Overtime Policy (Employee Override → Employment Type → Company Default →
    // legacy globals when the policy engine is disabled).
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Branch guard: a scoped caller cannot create a request for an
    // out-of-branch employee (create is not auto-scoped for relation models).
    assertInBranch(employee.branchId);

    const cfg = await this.otPolicy.resolveOvertimeConfig(employee);
    if (!cfg.enabled) {
      throw new BadRequestException('Overtime feature is disabled');
    }

    if (actorRole === 'EMPLOYEE' && !cfg.allowEmployeeSubmit) {
      throw new ForbiddenException('Employee submission of overtime is disabled by administrator');
    }

    // Per-policy eligibility gate.
    if (!cfg.eligible) {
      throw new ForbiddenException(
        'This employee is not eligible for overtime under their assigned policy',
      );
    }

    // Reason is mandatory only while the admin keeps `overtime_require_reason`
    // on. When off, a blank reason is accepted and stored as an empty string
    // (the column is NOT NULL).
    const reason = (dto.reason ?? '').trim();
    const reasonRequired =
      (await this.settingsService.getSetting('overtime_require_reason', 'true')) !==
      'false';
    if (reasonRequired && !reason) {
      throw new BadRequestException('Reason for overtime is required');
    }

    // Validate time
    const startTime = new Date(dto.startTime);
    let endTime = new Date(dto.endTime);

    // Overnight overtime (e.g. 17:00 -> 03:00): callers may send both
    // timestamps on the same calendar date. Treat an end time at/before the
    // start time as crossing midnight rather than rejecting the request; the
    // day-boundary clamp below (attendance_day_end_time) still caps how far
    // the shift is actually payable.
    if (endTime <= startTime) {
      endTime = new Date(endTime.getTime() + 24 * 60 * 60 * 1000);
    }

    if (endTime <= startTime) {
      throw new BadRequestException('End time must be after start time');
    }

    // Calculate overtime hours
    const calculatedHours =
      (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

    // Check if hours match (allow 0.1h discrepancy)
    if (Math.abs(calculatedHours - dto.hours) > 0.1) {
      throw new BadRequestException(
        `Hours do not match. Calculated: ${calculatedHours.toFixed(2)}h, Entered: ${dto.hours}h`,
      );
    }

    // Classify the day up-front. Rest-day (weekly-off) / Holiday overtime is
    // "double OT" — a full rest-day shift — so it gets a higher daily cap than
    // the few after-shift hours allowed on a normal weekday.
    //
    // Holiday detection is branch-aware (company-wide + branch-specific rows) and
    // the rest day comes from the branch's Branch.weeklyOffDays. When the
    // resolved policy's holidayBehavior is IGNORE (e.g. daily-wage staff), a
    // National Holiday is treated as an ordinary working day — it falls through
    // to the weekly-off / weekday classification with no holiday premium.
    const requestDate = new Date(dto.date);
    const isHoliday =
      cfg.holidayBehavior === 'IGNORE'
        ? false
        : await this.holidays.isHoliday(
            requestDate,
            employee.branchId ?? undefined,
          );
    const isRestDay = await this.holidays.isWeeklyOff(
      requestDate,
      employee.branchId ?? undefined,
    );
    // Holiday takes precedence over a weekly-off day when a date is both.
    const dayType: 'WEEKDAY' | 'SUNDAY' | 'HOLIDAY' = isHoliday
      ? 'HOLIDAY'
      : isRestDay
        ? 'SUNDAY'
        : 'WEEKDAY';
    const isDoubleOtDay = cfg.doubleOtEnabled && dayType !== 'WEEKDAY';

    // Validate daily overtime limit (rest days allow a full-shift cap)
    const dailyCap = isDoubleOtDay
      ? cfg.maxHoursPerDoubleDay
      : cfg.maxHoursPerDay;
    if (dto.hours > dailyCap) {
      throw new BadRequestException(
        `Daily overtime limit exceeded (${dailyCap}h). Registered: ${dto.hours}h`,
      );
    }

    await this.assertOutsideWorkHours(startTime, cfg, isDoubleOtDay);

    // Check monthly overtime limit
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

    // Check yearly overtime limit
    const yearlyTotal = await this.getYearlyOvertimeHours(employeeId, year);
    if (yearlyTotal + dto.hours > cfg.maxHoursPerYear) {
      throw new BadRequestException(
        `Yearly overtime limit exceeded (${cfg.maxHoursPerYear}h). Current: ${yearlyTotal}h, Registered: ${dto.hours}h`,
      );
    }

    // Check if an overtime request already exists for this date
    const existingRequest = await this.prisma.overtimeRequest.findFirst({
      where: {
        employeeId,
        date: new Date(dto.date),
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });

    if (existingRequest) {
      throw new BadRequestException(
        'An overtime request already exists for this date',
      );
    }

    // Tier split + food allowance, computed from current settings.
    const breakdown = await this.computeOvertimeBreakdown(
      startTime,
      endTime,
      isDoubleOtDay ? dayType : 'WEEKDAY',
      cfg,
    );

    // Create overtime request. `hours` stores the payable total AFTER boundary
    // clamping; the per-tier buckets drive payroll rate application.
    const created = await this.prisma.overtimeRequest.create({
      data: {
        employeeId,
        date: new Date(dto.date),
        startTime,
        endTime,
        hours: breakdown.hours,
        regularHours: breakdown.regularHours,
        lateHours: breakdown.lateHours,
        doubleHours: breakdown.doubleHours,
        doubleLateHours: breakdown.doubleLateHours,
        dayType: breakdown.dayType,
        foodAllowance: breakdown.foodAllowance,
        otType: breakdown.otType,
        // Snapshot the governing policy (null when the engine is disabled) so
        // payroll monetizes against the same rules that classified the hours.
        overtimePolicyId: cfg.policyId,
        reason,
        status: 'PENDING',
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            department: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    // Materialize the configurable approval trail (no-op without an active
    // OVERTIME workflow / master switch off). Auto-finalize if all steps skip.
    const init = await this.approvalEngine.initiate(
      'OVERTIME',
      created.id,
      employeeId,
    );
    if (init.engaged && init.finalized) {
      await this.finalizeOvertimeApproval(created.id, null);
    }

    return created;
  }

  async findAll(
    status?: string,
    employeeId?: string,
    month?: number,
    year?: number,
    page: number = 1,
    limit: number = 20,
    user?: any,
    search?: string,
    startDate?: string,
    endDate?: string,
    otType?: string,
  ) {
    const where: any = {};

    if (status && status !== 'all') {
      where.status = status;
    }

    if (employeeId) {
      where.employeeId = employeeId;
    }

    if (otType && otType !== 'all') {
      where.otType = otType;
    }

    if (startDate || endDate) {
      where.date = {
        ...(where.date || {}),
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(`${endDate}T23:59:59.999Z`) } : {}),
      };
    } else if (month && year) {
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
      where.date = {
        gte: start,
        lte: end,
      };
    }

    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { reason: { contains: q, mode: 'insensitive' } },
        { employee: { fullName: { contains: q, mode: 'insensitive' } } },
        { employee: { employeeCode: { contains: q, mode: 'insensitive' } } },
        { employee: { department: { name: { contains: q, mode: 'insensitive' } } } },
      ];
    }

    // MANAGER: scope to the departments they manage
    if (user?.role === 'MANAGER') {
      where.employee = {
        ...(where.employee || {}),
        departmentId: { in: managerDeptScope(user) },
      };
    }

    const skip = (page - 1) * limit;

    const [requests, total] = await Promise.all([
      this.prisma.overtimeRequest.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
              email: true,
              department: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
        orderBy: {
          date: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.overtimeRequest.count({ where }),
    ]);

    return {
      success: true,
      data: requests,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findPending(user?: any) {
    const requests = await this.findAll(
      'PENDING',
      undefined,
      undefined,
      undefined,
      1,
      20,
      user,
    );
    return requests;
  }

  async findByEmployee(
    employeeId: string,
    user?: any,
    page?: number,
    limit?: number,
  ) {
    // MANAGER: can only view employees in their dept
    if (user?.role === 'MANAGER') {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { departmentId: true },
      });
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to view employees outside your department.',
        );
      }
    }
    const requests = await this.findAll(
      undefined,
      employeeId,
      undefined,
      undefined,
      page || 1,
      limit || 50,
      user,
    );
    return requests;
  }

  /**
   * `user` is passed ONLY by the HTTP by-id door. The internal callers
   * (approve/reject/cancel) deliberately omit it: a SUPERVISOR acting on a
   * configured chain holds role EMPLOYEE and owns none of the record, so the
   * ownership rule would refuse a decision the approval engine is about to
   * authorise. Those paths run their own eligibility checks instead.
   */
  async findOne(
    id: string,
    user?: any,
    opts?: { withPreview?: boolean },
  ) {
    const overtime = await this.prisma.overtimeRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            departmentId: true,
            email: true,
            baseSalary: true,
            // The live preview must resolve the SAME Overtime Policy the
            // server used, so the effective policy inputs travel with the row.
            employmentType: true,
            overtimePolicyId: true,
            // The approver's hourly-rate preview must know whether baseSalary is
            // a monthly amount or a per-day rate; without it the preview is off
            // by a factor of the month's work days for daily-wage staff.
            salaryType: true,
            branchId: true,
            department: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!overtime) {
      throw new NotFoundException('Overtime request not found');
    }

    // Branch guard PLUS ownership/department. The payload carries
    // `employee.baseSalary` and `salaryType`, so an unguarded by-id read made
    // walking overtime ids a salary disclosure.
    if (user) {
      // Branch first and absolute; then ownership, with the same chain-approver
      // exception leave makes — see LeaveRequestsService.findOne.
      assertInBranch(overtime.employee.branchId);
      try {
        assertCanAccessEmployeeRecord(user, {
          id: overtime.employee.id,
          departmentId: (overtime.employee as any).departmentId,
          branchId: overtime.employee.branchId,
        });
      } catch (err) {
        if (!(await this.approvalEngine.isChainParticipant('OVERTIME', id, user))) {
          throw err;
        }
      }
    } else {
      assertInBranch(overtime.employee.branchId);
    }

    // The detail screen shows a live "what approve() will persist" breakdown.
    // It used to be recomputed in the browser from the GLOBAL branding
    // settings, which ignores the employee's Overtime Policy and the
    // branch-aware rest-day/holiday classification — so a request classified
    // LATE with a food allowance by the server rendered as REGULAR with a
    // blank allowance on this page. Compute it here, with the engine.
    if (opts?.withPreview) {
      return { ...overtime, preview: await this.buildLivePreview(overtime) };
    }

    return overtime;
  }

  /**
   * Resolve the effective policy + branch-aware day type for a request and run
   * the payable breakdown against them. Single source of truth shared by the
   * detail-page preview and the approval that freezes the numbers.
   */
  private async resolveLiveBreakdown(overtime: {
    employeeId: string;
    date: Date;
    startTime: Date;
    endTime: Date;
  }) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: overtime.employeeId },
      select: {
        branchId: true,
        employmentType: true,
        overtimePolicyId: true,
      },
    });
    const cfg = await this.otPolicy.resolveOvertimeConfig(
      emp ?? { employmentType: null, overtimePolicyId: null },
    );
    const requestDate = new Date(overtime.date);
    const isHoliday =
      cfg.holidayBehavior === 'IGNORE'
        ? false
        : await this.holidays.isHoliday(requestDate, emp?.branchId ?? undefined);
    const isRestDay = await this.holidays.isWeeklyOff(
      requestDate,
      emp?.branchId ?? undefined,
    );
    const dayType: 'WEEKDAY' | 'SUNDAY' | 'HOLIDAY' = isHoliday
      ? 'HOLIDAY'
      : isRestDay
        ? 'SUNDAY'
        : 'WEEKDAY';
    const isDoubleOtDay = cfg.doubleOtEnabled && dayType !== 'WEEKDAY';
    const breakdown = await this.computeOvertimeBreakdown(
      overtime.startTime,
      overtime.endTime,
      isDoubleOtDay ? dayType : 'WEEKDAY',
      cfg,
    );
    return { cfg, dayType, isDoubleOtDay, breakdown };
  }

  /**
   * The breakdown plus the tier rates that monetize it, so the client can show
   * the expected pay without re-deriving any rule from global settings.
   * Failures degrade to `null` — the page falls back to its local estimate
   * rather than losing the request detail entirely.
   */
  private async buildLivePreview(overtime: {
    employeeId: string;
    date: Date;
    startTime: Date;
    endTime: Date;
    status: string;
    hours: any;
    regularHours: any;
    lateHours: any;
    doubleHours: any;
    doubleLateHours: any;
    dayType: string;
    foodAllowance: any;
    otType: string;
    overtimePolicyId: string | null;
    siteAllowance?: any;
    foodAllowanceOverride?: any;
  }) {
    try {
      // PENDING: what approval WILL persist, under today's rules.
      // Decided (approved/rejected/cancelled): the FROZEN numbers, monetized by
      // the policy snapshot the row carries — recomputing them would show an
      // approver a figure that no longer matches the payslip.
      const decided = overtime.status !== 'PENDING';
      const { cfg, dayType, isDoubleOtDay, breakdown } = decided
        ? await this.frozenBreakdown(overtime)
        : await this.resolveLiveBreakdown(overtime);
      const tier =
        dayType === 'HOLIDAY' ? cfg.holiday : dayType === 'SUNDAY' ? cfg.sunday : null;
      // One multiplier per persisted bucket, chosen exactly as
      // payrolls.overtimeRowTier() chooses them (Sunday/Holiday tier on a
      // double day, flat doubleRate otherwise) — so the page's expected pay and
      // the payslip cannot drift apart.
      return {
        ...breakdown,
        // An approver override outranks the recomputed figure here for the same
        // reason it does at approval: the page must show what will be paid.
        foodAllowance:
          !decided &&
          overtime.foodAllowanceOverride !== null &&
          overtime.foodAllowanceOverride !== undefined
            ? Number(overtime.foodAllowanceOverride)
            : breakdown.foodAllowance,
        foodAllowanceOverride:
          overtime.foodAllowanceOverride === null ||
          overtime.foodAllowanceOverride === undefined
            ? null
            : Number(overtime.foodAllowanceOverride),
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

  /** The persisted breakdown of a decided request + its snapshot policy config. */
  private async frozenBreakdown(overtime: {
    hours: any;
    regularHours: any;
    lateHours: any;
    doubleHours: any;
    doubleLateHours: any;
    dayType: string;
    foodAllowance: any;
    otType: string;
    overtimePolicyId: string | null;
  }) {
    const cfg = await this.otPolicy.configForPolicyId(overtime.overtimePolicyId);
    const dayType = (
      ['WEEKDAY', 'SUNDAY', 'HOLIDAY'].includes(overtime.dayType)
        ? overtime.dayType
        : 'WEEKDAY'
    ) as 'WEEKDAY' | 'SUNDAY' | 'HOLIDAY';
    const hours = Number(overtime.hours) || 0;
    let regularHours = Number(overtime.regularHours) || 0;
    let lateHours = Number(overtime.lateHours) || 0;
    let doubleHours = Number(overtime.doubleHours) || 0;
    let doubleLateHours = Number(overtime.doubleLateHours) || 0;
    // Pre-split-columns row: rebuild the single bucket from otType, exactly as
    // payrolls.overtimeRowTier() does, so the page shows the hours that get paid.
    if (regularHours + lateHours + doubleHours + doubleLateHours === 0 && hours > 0) {
      if (overtime.otType === 'DOUBLE_LATE') doubleLateHours = hours;
      else if (overtime.otType === 'DOUBLE') doubleHours = hours;
      else if (overtime.otType === 'LATE') lateHours = hours;
      else regularHours = hours;
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
      },
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
   * May `user` change the numbers on this request right now?
   *
   * With a chain engaged this is `trailFor().canAct` — the very same
   * `isEligible` test `decide()` will run a moment later, so an edit is offered
   * exactly when the approval it rides on would succeed. trailFor also applies
   * the branch envelope and the participant rule, so an out-of-branch caller is
   * refused there before anything is written.
   *
   * With no chain, the legacy rule is deliberately STRICTER than the one
   * `approve()` falls back to. That path admits role EMPLOYEE without any
   * ownership test, which is tolerable for a yes/no decision on a queue the
   * caller had to be shown, but not for rewriting hours and allowances. Only
   * ADMIN/HR_MANAGER, or a MANAGER inside their own departments, may edit.
   */
  private async assertMayEdit(
    id: string,
    employeeId: string,
    user: any,
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

    if (user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') return;
    if (user?.role === 'MANAGER') {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { departmentId: true },
      });
      if (emp && isDeptInManagerScope(user, emp.departmentId)) return;
    }
    throw new ForbiddenException(
      'You do not have permission to edit this overtime request',
    );
  }

  /**
   * Validate an approver's proposed changes and return what they would produce.
   * Pure: nothing is written, so the same routine backs both the dry-run
   * preview the review screen calls on every keystroke and the real edit.
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
    const startTime = dto.startTime ? new Date(dto.startTime) : overtime.startTime;
    let endTime = dto.endTime ? new Date(dto.endTime) : overtime.endTime;

    // Same overnight reading as submission: an end at or before the start means
    // the shift crossed midnight, not that the request is nonsense.
    if (endTime <= startTime) {
      endTime = new Date(endTime.getTime() + 24 * 60 * 60 * 1000);
    }
    if (endTime <= startTime) {
      throw new BadRequestException('End time must be after start time');
    }

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

    // The window can clamp to nothing at the day boundary — an approver who
    // moves a shift past it would otherwise approve a request worth zero hours.
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

    // The row under edit is itself PENDING and so already inside these sums —
    // excluded, or an edit that LOWERS the hours could still be refused.
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

    // Food allowance: absent leaves the policy in charge; a value, 0 included,
    // wins. Overriding it while the policy pays no food allowance at all would
    // be inventing a payment the policy does not have, so that is refused
    // rather than quietly honoured.
    let foodAllowanceOverride: number | null | undefined;
    if (dto.foodAllowance !== undefined) {
      if (!cfg.foodAllowanceEnabled) {
        throw new BadRequestException(
          'Food allowance is disabled by the overtime policy for this employee',
        );
      }
      foodAllowanceOverride = dto.foodAllowance;
    }

    let siteAllowance: number | undefined;
    if (dto.siteAllowance !== undefined || dto.siteAllowanceNote !== undefined) {
      const enabled =
        (await this.settingsService.getSetting(
          'overtime_site_allowance_enabled',
          'false',
        )) === 'true';
      if (!enabled) {
        throw new BadRequestException('Site allowance is disabled');
      }
      siteAllowance = dto.siteAllowance ?? 0;
      const max = Number(
        await this.settingsService.getSetting('overtime_site_allowance_max', '0'),
      );
      // 0 means "no ceiling", the same convention the loan maxima use.
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

  /**
   * Dry run: what the request WOULD look like under these corrections. Nothing
   * is written.
   *
   * It exists because the browser cannot answer this itself. A client-side
   * recompute reads the GLOBAL settings and so ignores both the employee's
   * Overtime Policy and the branch-aware rest-day/holiday classification — the
   * same reason findOne() grew a server-side preview. An approver who is about
   * to change the money has to see the real figure.
   */
  async previewApproverEdit(id: string, dto: ApproveOvertimeDto, user: any) {
    const overtime = await this.findOne(id, user);
    if (overtime.status !== 'PENDING') {
      throw new BadRequestException('Can only edit pending requests');
    }
    await this.assertMayEdit(id, overtime.employeeId, user);
    await this.assertApproverEditEnabled();

    const resolved = await this.resolveApproverEdit(overtime, dto);
    const tier =
      resolved.dayType === 'HOLIDAY'
        ? resolved.cfg.holiday
        : resolved.dayType === 'SUNDAY'
          ? resolved.cfg.sunday
          : null;

    // Shaped exactly like buildLivePreview's return, so the review screen reads
    // one object whether it is showing the request as filed or as corrected.
    return {
      ...resolved.breakdown,
      foodAllowance: resolved.effectiveFood,
      foodAllowanceOverride: resolved.foodAllowanceOverride ?? null,
      siteAllowance:
        resolved.siteAllowance ?? Number((overtime as any).siteAllowance) ?? 0,
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

  private async assertApproverEditEnabled(): Promise<void> {
    const enabled =
      (await this.settingsService.getSetting(
        'overtime_approver_edit_enabled',
        'true',
      )) !== 'false';
    if (!enabled) {
      throw new BadRequestException(
        'Editing an overtime request while approving it is disabled',
      );
    }
  }

  /**
   * Persist an approver's corrections.
   *
   * Called from approve() BEFORE approvalEngine.decide(). That ordering is the
   * whole design: in a multi-step chain an intermediate approver's decide()
   * records their step and returns with the request still PENDING, never
   * reaching finalizeOvertimeApproval() — so an edit written there would be
   * silently dropped on every step but the last.
   *
   * Only the times, the food override, the site allowance and the notes are
   * written. The tier buckets are NOT: they are derived, and
   * finalizeOvertimeApproval() recomputes them from the stored window, which is
   * now the corrected one.
   */
  private async applyApproverEdit(
    id: string,
    dto: ApproveOvertimeDto,
    user: any,
    overtime: any,
  ) {
    await this.assertApproverEditEnabled();
    await this.assertMayEdit(id, overtime.employeeId, user);

    // Optimistic concurrency. Two approvers can hold the same request open —
    // an HR_MANAGER step and an ADMIN override, say — and last-write-wins would
    // let one silently discard the other's correction.
    if (dto.expectedUpdatedAt) {
      const seen = new Date(dto.expectedUpdatedAt).getTime();
      const current = new Date(overtime.updatedAt).getTime();
      if (seen !== current) {
        throw new ConflictException(
          'This request was changed by someone else. Reload it and review the current values.',
        );
      }
    }

    const resolved = await this.resolveApproverEdit(overtime, dto);

    const data: any = {
      startTime: resolved.startTime,
      endTime: resolved.endTime,
      editedById: user?.id ?? null,
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

    await this.audit.log({
      userId: user?.id,
      action: 'OVERTIME_APPROVER_EDIT',
      resourceType: 'OvertimeRequest',
      resourceId: id,
      oldData: {
        startTime: overtime.startTime,
        endTime: overtime.endTime,
        hours: overtime.hours,
        foodAllowance: overtime.foodAllowance,
        foodAllowanceOverride: overtime.foodAllowanceOverride,
        siteAllowance: overtime.siteAllowance,
        siteAllowanceNote: overtime.siteAllowanceNote,
      },
      newData: {
        startTime: updated.startTime,
        endTime: updated.endTime,
        hours: resolved.breakdown.hours,
        foodAllowance: resolved.effectiveFood,
        foodAllowanceOverride: updated.foodAllowanceOverride,
        siteAllowance: updated.siteAllowance,
        siteAllowanceNote: updated.siteAllowanceNote,
        approverNote: updated.approverNote,
      },
      branchId: overtime.employee?.branchId ?? null,
    });

    return updated;
  }

  async approve(
    id: string,
    approverId: string,
    user?: any,
    dto?: ApproveOvertimeDto,
  ) {
    const overtime = await this.findOne(id);
    if (overtime.status !== 'PENDING') {
      throw new BadRequestException('Can only approve pending requests');
    }

    // Corrections are persisted BEFORE the decision is recorded. An
    // intermediate approver in a chain returns below with the request still
    // PENDING and never reaches finalizeOvertimeApproval(), so an edit deferred
    // to there would be lost on every step but the last.
    if (this.hasApproverEdit(dto)) {
      await this.applyApproverEdit(id, dto, user, overtime);
    }

    // Configurable hierarchy first; engaged=false => legacy single-approver path.
    const result = await this.approvalEngine.decide(
      'OVERTIME',
      id,
      overtime.employeeId,
      user,
      'APPROVE',
    );

    if (!result.engaged) {
      if (user?.role === 'MANAGER') {
        const emp = await this.prisma.employee.findUnique({
          where: { id: overtime.employeeId },
          select: { departmentId: true },
        });
        if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
          throw new ForbiddenException(
            'You do not have permission to approve overtime outside your department.',
          );
        }
      }
      return this.finalizeOvertimeApproval(id, approverId);
    }
    if (result.finalized) {
      return this.finalizeOvertimeApproval(id, approverId);
    }
    // Recorded an intermediate step; request stays PENDING for the next
    // approver. Re-read rather than returning the row loaded above, which
    // predates any correction just written.
    return this.findOne(id);
  }

  /**
   * Final overtime approval: recompute the payable breakdown from CURRENT
   * settings, persist APPROVED, and notify the employee.
   */
  private async finalizeOvertimeApproval(id: string, approverId: string | null) {
    const overtime = await this.findOne(id);
    const approver = approverId
      ? await this.prisma.user.findUnique({
          where: { id: approverId },
          select: { employee: { select: { fullName: true } } },
        })
      : null;

    // Re-resolve the effective policy from the employee so an approved request
    // reflects the live rules + correct branch-aware day classification. Same
    // helper the detail page's preview uses, so what the approver saw is what
    // gets frozen here.
    const { cfg, breakdown } = await this.resolveLiveBreakdown(overtime);
    // Re-check eligibility at approval: a policy change (or a reassignment)
    // between submission and approval must not let an ineligible employee's
    // request slip through into payroll.
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
        regularHours: breakdown.regularHours,
        lateHours: breakdown.lateHours,
        doubleHours: breakdown.doubleHours,
        doubleLateHours: breakdown.doubleLateHours,
        dayType: breakdown.dayType,
        // An explicit approver value wins, otherwise the policy recomputes —
        // the same shape the HR payroll-item override uses. Null is not "no
        // allowance", it means nobody overrode it, which is why the column is
        // nullable. `siteAllowance` is deliberately ABSENT from this payload:
        // it is approver-granted with nothing to recompute it from, so naming
        // it here would zero it on every approval.
        foodAllowance:
          overtime.foodAllowanceOverride !== null &&
          overtime.foodAllowanceOverride !== undefined
            ? overtime.foodAllowanceOverride
            : breakdown.foodAllowance,
        otType: breakdown.otType,
        // Re-snapshot the governing policy at approval time.
        overtimePolicyId: cfg.policyId,
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            user: { select: { id: true } },
          },
        },
      },
    });

    if (updated.employee?.user?.id) {
      this.notifications
        .notifyUser(
          updated.employee.user.id,
          'Overtime approved',
          'Your overtime request was approved.',
          'OVERTIME_APPROVED',
          '/dashboard/overtime',
          // OVERTIME_APPROVED already selects the WhatsApp template; waData
          // only enriches the body.
          {
            waData: { date: updated.date?.toISOString(), hours: updated.hours },
            waDedupeKey: `overtime:${updated.id}:approved`,
          },
        )
        .catch(() => undefined);
    }

    await this.mailService.sendOvertimeApproved(overtime.employee.email, {
      employeeName: overtime.employee.fullName,
      date: overtime.date.toLocaleDateString('en-US'),
      hours: Number(updated.hours),
      approverName: approver?.employee?.fullName || 'HR Manager',
    });

    return updated;
  }

  async reject(
    id: string,
    approverId: string,
    dto: RejectOvertimeDto,
    user?: any,
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
    if (!result.engaged && user?.role === 'MANAGER') {
      const emp = await this.prisma.employee.findUnique({
        where: { id: overtime.employeeId },
        select: { departmentId: true },
      });
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to reject overtime outside your department.',
        );
      }
    }
    return this.finalizeOvertimeRejection(id, approverId, dto);
  }

  private async finalizeOvertimeRejection(
    id: string,
    approverId: string | null,
    dto: RejectOvertimeDto,
  ) {
    const overtime = await this.findOne(id);
    const approver = approverId
      ? await this.prisma.user.findUnique({
          where: { id: approverId },
          select: { employee: { select: { fullName: true } } },
        })
      : null;

    const updated = await this.prisma.overtimeRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approverId: approverId ?? undefined,
        approvedAt: new Date(),
        rejectedReason: dto.rejectedReason,
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            user: { select: { id: true } },
          },
        },
      },
    });

    if (updated.employee?.user?.id) {
      this.notifications
        .notifyUser(
          updated.employee.user.id,
          'Overtime rejected',
          'Your overtime request was rejected.',
          'OVERTIME_REJECTED',
          '/dashboard/overtime',
          {
            waData: {
              date: updated.date?.toISOString(),
              hours: updated.hours,
              rejectionReason: (updated as any).rejectedReason ?? undefined,
            },
            waDedupeKey: `overtime:${updated.id}:rejected`,
          },
        )
        .catch(() => undefined);
    }

    await this.mailService.sendOvertimeRejected(overtime.employee.email, {
      employeeName: overtime.employee.fullName,
      date: overtime.date.toLocaleDateString('en-US'),
      hours: Number(overtime.hours),
      approverName: approver?.employee?.fullName || 'HR Manager',
      reason: dto.rejectedReason,
    });

    return updated;
  }

  async cancel(id: string, employeeId: string) {
    const overtime = await this.findOne(id);

    // Only the employee who created the request can cancel it
    if (overtime.employeeId !== employeeId) {
      throw new ForbiddenException(
        'You do not have permission to cancel this request',
      );
    }

    if (overtime.status !== 'PENDING') {
      throw new BadRequestException('Can only cancel pending requests');
    }

    const updated = await this.prisma.overtimeRequest.update({
      where: { id },
      data: {
        status: 'CANCELLED',
      },
    });

    // Terminate any live approval trail so no approver can finalize it later.
    await this.approvalEngine.abandon('OVERTIME', id);

    return updated;
  }

  // Calculate total approved overtime hours in month
  async getApprovedOvertimeHours(
    employeeId: string,
    month: number,
    year: number,
  ) {
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    const result = await this.prisma.overtimeRequest.aggregate({
      where: {
        employeeId,
        status: 'APPROVED',
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      _sum: {
        hours: true,
      },
    });

    return result._sum.hours || 0;
  }

  // Calculate total overtime hours in month (including PENDING and APPROVED)
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
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    const result = await this.prisma.overtimeRequest.aggregate({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      _sum: {
        hours: true,
      },
    });

    return Number(result._sum.hours) || 0;
  }

  // Calculate total overtime hours in year (including PENDING and APPROVED)
  /** See getMonthlyOvertimeHours for why `excludeId` exists. */
  private async getYearlyOvertimeHours(
    employeeId: string,
    year: number,
    excludeId?: string,
  ): Promise<number> {
    const startDate = new Date(Date.UTC(year, 0, 1));
    const endDate = new Date(Date.UTC(year, 11, 31));

    const result = await this.prisma.overtimeRequest.aggregate({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      _sum: {
        hours: true,
      },
    });

    return Number(result._sum.hours) || 0;
  }

  // Monthly overtime report
  async getMonthlyReport(month: number, year: number) {
    // `findAll` defaults to 20 rows per page. Calling it without a limit meant
    // every summary total — totalRequests, totalHours, byEmployee — was
    // computed from the FIRST PAGE, so any month with more than twenty requests
    // reported the wrong money.
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
    const overtimeRequests = result.data; // Extract array from response

    const summary = {
      totalRequests: overtimeRequests.length,
      pending: overtimeRequests.filter((r) => r.status === 'PENDING').length,
      approved: overtimeRequests.filter((r) => r.status === 'APPROVED').length,
      rejected: overtimeRequests.filter((r) => r.status === 'REJECTED').length,
      totalHours: overtimeRequests
        .filter((r) => r.status === 'APPROVED')
        .reduce((sum, r) => sum + Number(r.hours), 0),
      byEmployee: {} as Record<string, any>,
    };

    // Group by employee
    overtimeRequests.forEach((request) => {
      const empId = request.employee.id;
      if (!summary.byEmployee[empId]) {
        summary.byEmployee[empId] = {
          employee: request.employee,
          totalHours: 0,
          requests: 0,
        };
      }
      if (request.status === 'APPROVED') {
        summary.byEmployee[empId].totalHours += Number(request.hours);
      }
      summary.byEmployee[empId].requests += 1;
    });

    return {
      month,
      year,
      summary,
      requests: overtimeRequests,
    };
  }

  // KNOWN LIMITATION (deferred): this lookup is not branch-scoped (it matches a
  // holiday for ANY branch). The day is derived in UTC to align with the
  // @db.Date (UTC-midnight) holiday rows on any server timezone. Future fix:
  // delegate to the branch-aware holidaysService.isHoliday(date, branchId).
  /**
   * Compute the payable tier split + food allowance + otType for a worked
   * window using the CURRENT overtime settings. Shared by create() (at request
   * time) and approve() (recomputed so an approved request always reflects the
   * live rules, correcting any request created under stale settings/logic).
   */
  /**
   * Overtime must start outside the working day — otherwise ordinary paid hours
   * could be claimed twice, once as salary and once as overtime.
   *
   * Shared by submission and by the approver edit: an approver correcting the
   * window is held to the same rule the employee was, or the edit becomes a way
   * around it.
   *
   * Start is read in UTC wall-clock — OT times are stored tz-naive tagged UTC,
   * so getUTCHours recovers the entered hour on any server timezone.
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

    const startSetting = await this.settingsService.getSetting(
      'office_start_time',
      '08:30',
    );
    const endSetting = cfg.shiftEndTime || '17:00';

    const [startHour, startMin] = startSetting.split(':').map(Number);
    const [endHour, endMin] = endSetting.split(':').map(Number);

    const workStart =
      (isNaN(startHour) ? 8 : startHour) * 60 +
      (isNaN(startMin) ? 30 : startMin);
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
    dayType: 'WEEKDAY' | 'SUNDAY' | 'HOLIDAY',
    cfg: ResolvedOvertimeConfig,
  ): Promise<{
    hours: number;
    regularHours: number;
    lateHours: number;
    doubleHours: number;
    doubleLateHours: number;
    dayType: 'WEEKDAY' | 'SUNDAY' | 'HOLIDAY';
    foodAllowance: number;
    otType: string;
  }> {
    const isDoubleOtDay = dayType !== 'WEEKDAY';
    // Parse an "HH:MM" threshold into minutes-since-midnight, defaulting to 22:00 on bad input
    const parseThreshold = (value: string) => {
      const [h, m] = (value || '').split(':').map(Number);
      return (isNaN(h) ? 22 : h) * 60 + (isNaN(m) ? 0 : m);
    };

    // Attendance day boundary (same setting the attendance module uses). Overtime
    // is only counted up to the boundary of that attendance day, never beyond it.
    // A policy may override it via dayEndBoundary; else inherit the global.
    const boundaryRaw =
      cfg.dayEndBoundary ??
      (await this.settingsService.getSetting('attendance_day_end_time', '23:59'));
    const dayBoundaryMinutes = parseThreshold(boundaryRaw);

    // Split the worked window at the late threshold, clamped to the day boundary,
    // so each portion is paid at its own tier (no single-rate-for-whole-duration).
    // Double days use the per-day-type (Sunday vs Holiday) late threshold.
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
    const isLate = split.isLate;

    // Food allowance eligibility is driven by its OWN admin-configured threshold
    // time, evaluated against the boundary-clamped effective end time.
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

    let otType = 'REGULAR';
    if (isDoubleOtDay) {
      otType = isLate ? 'DOUBLE_LATE' : 'DOUBLE';
    } else {
      otType = isLate ? 'LATE' : 'REGULAR';
    }

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
}
