import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceSource,
  AttendanceStatus,
  LibraryType,
  Prisma,
  RequestStatus,
  UserRole,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import {
  assertCanAccessRequestOf,
  isInManagerScope,
  managerDepartmentIds,
} from '../common/utils/manager-scope.util';
import { dayKeyToDate } from '../attendances/attendance-calendar.util';
import { LeaveBalancesService } from '../leave-balances/leave-balances.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import type { Principal } from '../auth/auth.service';
import { WorkingDaysService } from './working-days.service';
import { CreateLeaveRequestDto } from './dto/create-leave-request.dto';
import { ListLeaveRequestsDto } from './dto/list-leave-requests.dto';

const LEAVE_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      position: true,
      gender: true,
      branchId: true,
      departmentId: true,
      supervisorId: true,
      department: { select: { id: true, name: true } },
      branch: { select: { id: true, code: true, name: true } },
      supervisor: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  approver: { select: { id: true, email: true } },
  attachments: {
    where: { deletedAt: null },
    orderBy: { uploadedAt: 'desc' as const },
  },
} satisfies Prisma.LeaveRequestInclude;

/**
 * Filing leave, and deciding it.
 *
 * The two things worth knowing before changing anything here:
 *
 *   1. **`totalDays` is priced once, at filing, from the branch calendar.** It
 *      excludes the branch's weekly rest days and any holiday in force there,
 *      and it is stored — so a branch that changes its working week next quarter
 *      does not silently re-price leave somebody has already taken.
 *
 *   2. **Approval deducts BEFORE it writes APPROVED.** Nothing is reserved at
 *      filing, so two pending requests can each pass the filing-time balance
 *      check against the same days. See {@link approve}.
 */
@Injectable()
export class LeaveRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: LeaveBalancesService,
    private readonly workingDays: WorkingDaysService,
    private readonly settings: SystemSettingsService,
  ) {}

  // ── Filing ─────────────────────────────────────────────────────────────────

  async create(dto: CreateLeaveRequestDto, user: Principal) {
    const employeeId = dto.employeeId ?? user.employeeId;
    if (!employeeId) {
      throw new BadRequestException(
        'This request needs an employee. Your account is not linked to one, so name the employee explicitly.',
      );
    }

    // Filing for somebody else is an HR privilege. Without this check an
    // employee could book leave against a colleague by passing their id — and
    // the days would come out of the colleague's balance with ON_LEAVE
    // attendance written against their name.
    if (
      employeeId !== user.employeeId &&
      user.role !== UserRole.ADMIN &&
      user.role !== UserRole.HR_MANAGER
    ) {
      throw new ForbiddenException(
        'Only HR can file leave on behalf of another employee',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, gender: true, branchId: true, status: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.status === 'TERMINATED') {
      throw new BadRequestException(
        'This employee has left the company and cannot file leave',
      );
    }

    const startDate = dayKeyToDate(dto.startDate);
    const endDate = dayKeyToDate(dto.endDate);
    if (endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException('The end date is before the start date');
    }

    const leaveType = await this.resolveLeaveType(dto.leaveType);

    if (
      leaveType.genderRestriction &&
      (employee.gender ?? '').trim().toUpperCase() !==
        leaveType.genderRestriction.toUpperCase()
    ) {
      throw new BadRequestException(
        `${leaveType.label} is only available to ${leaveType.genderRestriction.toLowerCase()} employees`,
      );
    }

    // Overlap, not containment: a request from the 3rd to the 7th collides with
    // one from the 6th to the 9th, and a containment test would let an employee
    // book the same week twice.
    const overlapping = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: { in: [RequestStatus.PENDING, RequestStatus.APPROVED] },
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      select: { id: true, startDate: true, endDate: true },
    });
    if (overlapping) {
      throw new ConflictException(
        `This overlaps an existing request (${toDayKey(overlapping.startDate)} – ${toDayKey(overlapping.endDate)})`,
      );
    }

    await this.assertNoticeGiven(
      leaveType.requiresNoticeDays,
      startDate,
      leaveType.label,
    );

    const totalDays = await this.workingDays.getWorkDaysBetween(
      startDate,
      endDate,
      employee.branchId,
    );
    if (totalDays === 0) {
      // Every day in the range is already a rest day or a holiday. Approving it
      // would deduct nothing and write no attendance — a request that means
      // nothing, filed in good faith.
      throw new BadRequestException(
        'Every day in that range is already a non-working day at this branch',
      );
    }

    if (leaveType.affectsBalance) {
      const remaining = await this.remainingFor(
        employeeId,
        leaveType.label,
        startDate.getUTCFullYear(),
        leaveType.defaultDays ?? 0,
      );
      if (remaining < totalDays) {
        throw new BadRequestException(
          `Insufficient ${leaveType.label} balance. Available: ${remaining} day(s), requested: ${totalDays}.`,
        );
      }
    }

    return this.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveType: leaveType.label,
        startDate,
        endDate,
        totalDays,
        reason: dto.reason,
        status: RequestStatus.PENDING,
      },
      include: LEAVE_INCLUDE,
    });
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  async findAll(query: ListLeaveRequestsDto, user: Principal) {
    const { page, limit, skip, take } = resolvePagination(query);
    const scope = await managerDepartmentIds(this.prisma, user);
    const insensitive = Prisma.QueryMode.insensitive;

    const where: Prisma.LeaveRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.leaveType ? { leaveType: query.leaveType } : {}),
      // A request straddling the window belongs to it. Filtering on the start
      // date alone would lose every leave that spans a month boundary from the
      // month it actually falls in.
      ...(query.startDate
        ? { endDate: { gte: dayKeyToDate(query.startDate) } }
        : {}),
      ...(query.endDate
        ? { startDate: { lte: dayKeyToDate(query.endDate) } }
        : {}),
      ...this.scopeToCaller(query.employeeId, user, scope),
      ...(query.search
        ? {
            OR: [
              { reason: { contains: query.search, mode: insensitive } },
              {
                employee: {
                  firstName: { contains: query.search, mode: insensitive },
                },
              },
              {
                employee: {
                  lastName: { contains: query.search, mode: insensitive },
                },
              },
              {
                employee: {
                  employeeCode: { contains: query.search, mode: insensitive },
                },
              },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.leaveRequest.findMany({
        where,
        include: LEAVE_INCLUDE,
        skip,
        take,
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);

    return paginated(data.map(serialize), total, page, limit);
  }

  /**
   * Queue health.
   *
   * `avgDecisionHours` is null when nothing has ever been decided — zero would
   * read as "decided instantly", which is the opposite of the truth.
   */
  async stats(user: Principal) {
    const scope = await managerDepartmentIds(this.prisma, user);
    const where = this.scopeToCaller(undefined, user, scope);

    const [byStatus, decided] = await Promise.all([
      this.prisma.leaveRequest.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { totalDays: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: { ...where, approvedAt: { not: null } },
        select: { createdAt: true, approvedAt: true },
      }),
    ]);

    const row = (status: RequestStatus) =>
      byStatus.find((r) => r.status === status);
    const count = (status: RequestStatus) => row(status)?._count._all ?? 0;

    const hours = decided.map(
      (r) =>
        ((r.approvedAt as Date).getTime() - r.createdAt.getTime()) / 3_600_000,
    );

    return {
      pending: count(RequestStatus.PENDING),
      approved: count(RequestStatus.APPROVED),
      rejected: count(RequestStatus.REJECTED),
      cancelled: count(RequestStatus.CANCELLED),
      total: byStatus.reduce((a, r) => a + r._count._all, 0),
      approvedDays: row(RequestStatus.APPROVED)?._sum.totalDays ?? 0,
      avgDecisionHours: hours.length
        ? Math.round((hours.reduce((a, h) => a + h, 0) / hours.length) * 100) /
          100
        : null,
    };
  }

  async findOne(id: string, user: Principal) {
    const request = await this.loadOrThrow(id);
    const scope = await managerDepartmentIds(this.prisma, user);
    assertCanAccessRequestOf(user, request.employee, scope);
    return serialize(request);
  }

  /**
   * The balances of the people a manager is responsible for.
   *
   * The point of the screen is capacity: who can still take leave, and who has
   * nothing left. Restricted to a manager's OWN departments, because it answers
   * by name.
   */
  async getTeamBalances(user: Principal) {
    const scope = await managerDepartmentIds(this.prisma, user);
    if (scope !== null && scope.length === 0) {
      throw new ForbiddenException(
        'You do not manage a department, so there is no team to report on',
      );
    }

    const year = new Date().getUTCFullYear();
    const employees = await this.prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
        ...(scope === null
          ? {}
          : {
              OR: [
                { departmentId: { in: scope } },
                ...(user.employeeId ? [{ supervisorId: user.employeeId }] : []),
              ],
            }),
      },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        position: true,
        avatarUrl: true,
        department: { select: { id: true, name: true } },
        leaveTypeBalances: { where: { year } },
        leaveRequests: {
          where: { status: RequestStatus.PENDING },
          select: { id: true },
        },
      },
      orderBy: { employeeCode: 'asc' },
    });

    const data = employees.map((emp) => {
      const balances = emp.leaveTypeBalances.map((b) => ({
        leaveTypeKey: b.leaveTypeKey,
        allocated: b.allocated,
        used: b.used,
        carriedOver: b.carriedOver,
        remaining: b.allocated + b.carriedOver - b.used,
      }));
      return {
        employeeId: emp.id,
        employeeCode: emp.employeeCode,
        firstName: emp.firstName,
        lastName: emp.lastName,
        position: emp.position,
        avatarUrl: emp.avatarUrl,
        department: emp.department,
        pendingRequests: emp.leaveRequests.length,
        // Null, not an empty array, when the year was never initialised: "not
        // set up" and "entitled to nothing" are different facts.
        balances: balances.length ? balances : null,
        remaining: balances.length
          ? balances.reduce((a, b) => a + b.remaining, 0)
          : null,
      };
    });

    return {
      success: true as const,
      data,
      meta: { year, total: data.length, departmentIds: scope },
    };
  }

  // ── Deciding ───────────────────────────────────────────────────────────────

  /**
   * Approve: spend the balance, mark it approved, write the attendance.
   *
   * **The order is load-bearing.** `deductDays` throws when the balance is
   * short, and nothing is reserved at filing time — so two pending requests can
   * each have passed the filing check against the same days. Writing the status
   * first left the row APPROVED with its attendance written and nothing
   * deducted, while reporting a 400 to the caller: an approved absence nobody
   * paid for, presented as a failure. Deducting first makes the whole approval
   * fail cleanly instead, with the request still PENDING and the approver told
   * why.
   *
   * All three writes are ONE transaction, for the same reason: a balance
   * deducted against a request that never became approved is leave taken from
   * somebody who never got the day off.
   */
  async approve(id: string, user: Principal, comment?: string) {
    const request = await this.loadOrThrow(id);
    await this.assertMayDecide(request, user);
    this.assertPending(request.status, 'approved');

    const year = request.startDate.getUTCFullYear();
    const workingDates = await this.workingDays.getWorkingDatesBetween(
      request.startDate,
      request.endDate,
      request.employee.branchId,
    );

    const { updated, created } = await this.prisma.$transaction(async (tx) => {
      await this.balances.deductDays(
        request.employeeId,
        request.totalDays,
        request.leaveType,
        year,
        tx,
      );

      const row = await tx.leaveRequest.update({
        where: { id },
        data: {
          status: RequestStatus.APPROVED,
          approverId: user.id,
          approvedAt: new Date(),
          rejectedReason: comment?.trim() || null,
        },
        include: LEAVE_INCLUDE,
      });

      // `skipDuplicates` because a day the employee actually clocked keeps its
      // own record: an approval must never overwrite real attendance. The skip
      // COUNT is returned rather than swallowed — silently skipping meant a day
      // of approved leave had no ON_LEAVE row behind it and nobody knew.
      const { count } = await tx.attendance.createMany({
        data: workingDates.map((date) => ({
          employeeId: request.employeeId,
          date,
          // Stamped with the branch. Without it these rows carry a null branch
          // and every branch-filtered view — the attendance list, the reports,
          // the logs — loses them, while payroll still counts them.
          branchId: request.employee.branchId,
          status: AttendanceStatus.ON_LEAVE,
          // SYSTEM, not MANUAL: nobody typed these times, the approval produced
          // them. MANUAL is reserved for a human decision an import must not
          // overwrite, and blurring the two would make the correction flow lie.
          source: AttendanceSource.SYSTEM,
          workHours: 0,
          notes: `Approved ${request.leaveType}`,
        })),
        skipDuplicates: true,
      });

      return { updated: row, created: count };
    });

    const skipped = workingDates.length - created;

    return {
      success: true as const,
      message: skipped
        ? `Leave approved. ${skipped} day(s) already had an attendance record and were left unchanged.`
        : 'Leave approved',
      data: serialize(updated),
      meta: { attendanceCreated: created, attendanceSkipped: skipped },
    };
  }

  async reject(id: string, user: Principal, comment: string) {
    const request = await this.loadOrThrow(id);
    await this.assertMayDecide(request, user);
    this.assertPending(request.status, 'rejected');

    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: {
        status: RequestStatus.REJECTED,
        approverId: user.id,
        approvedAt: new Date(),
        rejectedReason: comment,
      },
      include: LEAVE_INCLUDE,
    });

    return {
      success: true as const,
      message: 'Leave rejected',
      data: serialize(updated),
    };
  }

  /**
   * Withdrawn by the person who filed it, or by an administrator.
   *
   * Only a PENDING request: an approved one has already moved the balance and
   * written attendance, and undoing that is a different act with a different
   * name — it is not the employee's to perform from the list screen.
   */
  async cancel(id: string, user: Principal) {
    const request = await this.loadOrThrow(id);
    const isOwner =
      Boolean(user.employeeId) && request.employeeId === user.employeeId;
    if (!isOwner && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only the employee who filed this request can withdraw it',
      );
    }
    this.assertPending(request.status, 'withdrawn');

    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status: RequestStatus.CANCELLED },
      include: LEAVE_INCLUDE,
    });

    return {
      success: true as const,
      message: 'Leave request withdrawn',
      data: serialize(updated),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Turn whatever the caller sent into a real library row.
   *
   * Matched case-insensitively on the label, so "annual leave" and "Annual
   * Leave" are the same type. An unknown type is refused rather than stored:
   * `LeaveRequest.leaveType` and `LeaveTypeBalance.leaveTypeKey` have to be the
   * same string for a balance to be found at all, and inventing one silently
   * creates leave nobody has an entitlement for.
   */
  private async resolveLeaveType(requested: string) {
    const label = requested.trim();
    const type = await this.prisma.libraryItem.findFirst({
      where: {
        libraryType: LibraryType.LEAVE_TYPE,
        isActive: true,
        label: { equals: label, mode: Prisma.QueryMode.insensitive },
      },
    });
    if (!type) {
      throw new BadRequestException(
        `"${label}" is not an available leave type`,
      );
    }
    return type;
  }

  /**
   * The notice period, measured against TODAY in the company's clock.
   *
   * The company's, not the server's: a request filed at 22:00 in Muscat is filed
   * on that date, and reading the server's UTC clock would call it tomorrow and
   * hand the employee a day of notice they did not give.
   */
  private async assertNoticeGiven(
    requiredDays: number,
    startDate: Date,
    label: string,
  ) {
    if (requiredDays <= 0) return;

    const company = await this.prisma.company.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { timezone: true },
    });
    const zone =
      company?.timezone?.trim() ||
      (await this.settings.get('default_timezone')) ||
      'UTC';
    const today = DateTime.now().setZone(zone);
    const earliest = dayKeyToDate(
      (today.isValid ? today : DateTime.utc())
        .plus({ days: requiredDays })
        .toFormat('yyyy-MM-dd'),
    );

    if (startDate.getTime() < earliest.getTime()) {
      throw new BadRequestException(
        `${label} needs at least ${requiredDays} day(s) notice — the earliest start is ${toDayKey(earliest)}`,
      );
    }
  }

  /** What is left of one type this year, materialising nothing. */
  private async remainingFor(
    employeeId: string,
    leaveTypeKey: string,
    year: number,
    defaultDays: number,
  ): Promise<number> {
    const balance = await this.prisma.leaveTypeBalance.findUnique({
      where: {
        employeeId_year_leaveTypeKey: { employeeId, year, leaveTypeKey },
      },
    });
    // No row yet is not "no entitlement": the year has simply never been
    // initialised, and the library default is what initialising it would give.
    if (!balance) return defaultDays;
    return balance.allocated + balance.carriedOver - balance.used;
  }

  private async loadOrThrow(id: string) {
    const request = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: LEAVE_INCLUDE,
    });
    if (!request) throw new NotFoundException('Leave request not found');
    return request;
  }

  private assertPending(status: RequestStatus, verb: string) {
    if (status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `This request was already ${status.toLowerCase()} and cannot be ${verb}`,
      );
    }
  }

  /**
   * Who may decide.
   *
   * ADMIN and HR always; a MANAGER inside the departments they run; and the
   * SUPERVISOR named on the employee's record, whatever role they hold — that
   * link is documented as "who signs their leave", and a supervisor who cannot
   * approve is a queue that never empties.
   *
   * Nobody approves their own leave, however senior. An approval is a second
   * pair of eyes or it is nothing.
   */
  private async assertMayDecide(
    request: LeaveWithEmployee,
    user: Principal,
  ): Promise<void> {
    if (user.employeeId && request.employeeId === user.employeeId) {
      throw new ForbiddenException('You cannot decide your own leave request');
    }
    if (user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER) {
      return;
    }
    if (user.employeeId && request.employee.supervisorId === user.employeeId) {
      return;
    }
    if (user.role === UserRole.MANAGER) {
      const scope = await managerDepartmentIds(this.prisma, user);
      if (isInManagerScope(scope, request.employee.departmentId)) return;
    }
    throw new ForbiddenException(
      'You are not an approver for this leave request',
    );
  }

  /**
   * An EMPLOYEE only ever sees their own; a MANAGER only their departments'.
   *
   * Built from the PRINCIPAL, never from the query string: a scope that trusts
   * `?employeeId=` is one edited URL away from being no scope at all.
   */
  private scopeToCaller(
    requested: string | undefined,
    user: Principal,
    scope: string[] | null,
  ): Prisma.LeaveRequestWhereInput {
    if (user.role === UserRole.EMPLOYEE) {
      if (!user.employeeId) {
        throw new ForbiddenException(
          'Your account is not linked to an employee record',
        );
      }
      const clauses: Prisma.LeaveRequestWhereInput[] = [
        { employeeId: user.employeeId },
      ];
      if (requested) clauses.push({ employeeId: requested });
      return { AND: clauses };
    }

    if (scope !== null) {
      // A manager also sees the requests they SUPERVISE and their own, both of
      // which can sit outside the departments they run.
      const mine = user.employeeId
        ? [
            { employeeId: user.employeeId },
            { employee: { supervisorId: user.employeeId } },
          ]
        : [];
      return {
        AND: [
          { OR: [{ employee: { departmentId: { in: scope } } }, ...mine] },
          ...(requested ? [{ employeeId: requested }] : []),
        ],
      };
    }

    return requested ? { employeeId: requested } : {};
  }
}

type LeaveWithEmployee = Prisma.LeaveRequestGetPayload<{
  include: typeof LEAVE_INCLUDE;
}>;

/**
 * `LeaveAttachment.fileSize` is a BigInt, which `JSON.stringify` refuses to
 * serialize — an unserialized row takes the whole response down with a
 * TypeError rather than a missing field.
 */
function serialize(request: LeaveWithEmployee) {
  return {
    ...request,
    attachments: request.attachments.map((a) => ({
      ...a,
      fileSize: a.fileSize === null ? null : Number(a.fileSize),
    })),
  };
}

/** A `@db.Date` value as the `YYYY-MM-DD` it means. */
function toDayKey(date: Date): string {
  return new Date(date.getTime() + 12 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
