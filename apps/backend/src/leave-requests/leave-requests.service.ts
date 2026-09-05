import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceSource,
  AttendanceStatus,
  LibraryType,
  Prisma,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import type { Principal } from '../auth/auth.service';
import { LeaveBalancesService } from '../leave-balances/leave-balances.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { LeaveWorkingDaysService } from './leave-working-days.service';
import { CreateLeaveRequestDto } from './dto/create-leave-request.dto';
import {
  ListLeaveRequestsDto,
  ListMyLeaveRequestsDto,
} from './dto/list-leave-requests.dto';

/** Short codes a client may send instead of a library label, and what they mean. */
const LEAVE_TYPE_ALIASES: Record<string, string> = {
  ANNUAL: 'Annual Leave',
  SICK: 'Sick Leave',
  UNPAID: 'Unpaid Leave',
  MATERNITY: 'Maternity Leave',
  PATERNITY: 'Paternity Leave',
  BEREAVEMENT: 'Bereavement Leave',
};

/** How much notice annual leave needs when the library says nothing. */
const FALLBACK_ANNUAL_NOTICE_DAYS = 3;

/** Roles that may decide a request when no configured chain governs it. */
const DIRECT_DECIDERS: UserRole[] = [
  UserRole.ADMIN,
  UserRole.HR_MANAGER,
  UserRole.MANAGER,
];

const EMPLOYEE_CARD_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  workEmail: true,
  departmentId: true,
  branchId: true,
  department: { select: { id: true, name: true, managerId: true } },
} satisfies Prisma.EmployeeSelect;

const LEAVE_INCLUDE = {
  employee: { select: EMPLOYEE_CARD_SELECT },
  approver: { select: { id: true, email: true, role: true } },
  attachments: { where: { deletedAt: null } },
} satisfies Prisma.LeaveRequestInclude;

type LeaveRow = Prisma.LeaveRequestGetPayload<{
  include: typeof LEAVE_INCLUDE;
}>;

/** `YYYY-MM-DD` → the UTC midnight a `@db.Date` column stores. */
function dateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

/** Today at UTC midnight, for notice-period arithmetic. */
function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

@Injectable()
export class LeaveRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: LeaveBalancesService,
    private readonly workingDays: LeaveWorkingDaysService,
    private readonly approvals: ApprovalEngineService,
  ) {}

  /**
   * Attachment sizes are `BigInt` in the database and JSON cannot carry one, so
   * they are narrowed to numbers on the way out. A file large enough to lose
   * precision here would have been refused by the upload long before.
   */
  private serialize<T extends { attachments?: { fileSize: bigint | null }[] }>(
    row: T,
  ) {
    if (!row.attachments) return row;
    return {
      ...row,
      attachments: row.attachments.map((attachment) => ({
        ...attachment,
        fileSize:
          attachment.fileSize === null ? null : Number(attachment.fileSize),
      })),
    };
  }

  private withFullName<
    T extends { employee?: { firstName: string; lastName: string } | null },
  >(row: T) {
    if (!row.employee) return row;
    return {
      ...row,
      employee: {
        ...row.employee,
        fullName: [row.employee.firstName, row.employee.lastName]
          .filter(Boolean)
          .join(' '),
      },
    };
  }

  private present(row: LeaveRow) {
    return this.withFullName(this.serialize(row));
  }

  /** The library entry a leave type names, by label or by short code. */
  private leaveTypeItem(leaveType: string) {
    const alias = LEAVE_TYPE_ALIASES[leaveType.toUpperCase()];
    return this.prisma.libraryItem.findFirst({
      where: {
        libraryType: LibraryType.LEAVE_TYPE,
        isActive: true,
        OR: [
          { label: leaveType },
          { label: { equals: leaveType, mode: Prisma.QueryMode.insensitive } },
          ...(alias ? [{ label: alias }] : []),
        ],
      },
    });
  }

  /**
   * Filing for somebody else is an HR privilege.
   *
   * Without it an employee could book leave against a colleague by passing
   * their id: the days would come out of the colleague's balance, with LEAVE
   * attendance written against them.
   */
  private assertCanFileFor(user: Principal, employeeId: string) {
    if (user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER) {
      return;
    }
    if (user.employeeId === employeeId) return;
    throw new ForbiddenException(
      'You may only raise a leave request for yourself',
    );
  }

  /**
   * Who may read one request.
   *
   * A participant in the request's own approval chain is admitted even though
   * they own none of the requester's records: a supervisor holds role EMPLOYEE
   * and would otherwise be asked to decide a request they cannot open.
   */
  private async assertCanRead(user: Principal, row: LeaveRow, id: string) {
    if (user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER) {
      return;
    }
    if (user.employeeId === row.employeeId) return;
    if (
      user.role === UserRole.MANAGER &&
      row.employee.departmentId &&
      row.employee.departmentId === user.departmentId
    ) {
      return;
    }
    if (await this.approvals.isChainParticipant('LEAVE', id, user)) return;
    throw new ForbiddenException('This request belongs to another employee');
  }

  /**
   * Raise a leave request.
   *
   * Everything that can refuse the request is checked BEFORE the row is
   * written: an overlap, a gender restriction, the notice period and the
   * balance. Writing first and validating after would leave a rejected request
   * sitting in the queue with nothing having deducted for it.
   */
  async create(dto: CreateLeaveRequestDto, user: Principal) {
    const employeeId = dto.employeeId || user.employeeId;
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record, so it cannot raise leave',
      );
    }
    this.assertCanFileFor(user, employeeId);

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, gender: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const startDate = dateOnly(dto.startDate);
    const endDate = dateOnly(dto.endDate);
    if (endDate < startDate) {
      throw new BadRequestException('End date must be on or after start date');
    }

    const overlapping = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      select: { startDate: true, endDate: true },
    });
    if (overlapping) {
      throw new BadRequestException(
        `Leave already requested for ${overlapping.startDate.toISOString().slice(0, 10)} to ${overlapping.endDate.toISOString().slice(0, 10)}`,
      );
    }

    const libraryItem = await this.leaveTypeItem(dto.leaveType);
    // The LABEL is stored, not a reference. Renaming a library entry must not
    // rewrite the history of what was taken.
    const leaveTypeLabel = libraryItem?.label ?? dto.leaveType;

    if (libraryItem?.genderRestriction) {
      const employeeGender = (employee.gender || '').toUpperCase();
      if (employeeGender !== libraryItem.genderRestriction.toUpperCase()) {
        throw new BadRequestException(
          `${leaveTypeLabel} is only available to ${libraryItem.genderRestriction.toLowerCase()} employees`,
        );
      }
    }

    const noticeDays = libraryItem
      ? libraryItem.requiresNoticeDays
      : dto.leaveType.toUpperCase() === 'ANNUAL'
        ? FALLBACK_ANNUAL_NOTICE_DAYS
        : 0;
    if (noticeDays > 0) {
      const earliest = todayUtc();
      earliest.setUTCDate(earliest.getUTCDate() + noticeDays);
      if (startDate < earliest) {
        throw new BadRequestException(
          `${leaveTypeLabel} requires at least ${noticeDays} days notice`,
        );
      }
    }

    const totalDays = await this.workingDays.workDaysBetween(
      startDate,
      endDate,
      employee.branchId,
    );
    if (totalDays === 0) {
      throw new BadRequestException(
        'That range contains no working days for this employee',
      );
    }

    const affectsBalance = libraryItem
      ? libraryItem.affectsBalance
      : ['ANNUAL', 'SICK'].includes(dto.leaveType.toUpperCase());
    if (affectsBalance) {
      const year = startDate.getUTCFullYear();
      const balance = await this.balances.getBalance(employeeId, year);
      const bucket = balance.leaveTypeBalances.find(
        (row) => row.leaveTypeKey === leaveTypeLabel,
      );
      const remaining = bucket
        ? bucket.remaining
        : leaveTypeLabel === 'Sick Leave'
          ? balance.remainingSick
          : balance.remainingAnnual;
      if (remaining < totalDays) {
        throw new BadRequestException(
          `Insufficient ${leaveTypeLabel} balance. Available: ${remaining} days`,
        );
      }
    }

    const created = await this.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveType: leaveTypeLabel,
        startDate,
        endDate,
        totalDays,
        reason: dto.reason,
        status: 'PENDING',
      },
      include: LEAVE_INCLUDE,
    });

    // Materialise the configured trail. `engaged: false` when no workflow
    // governs leave, in which case the direct single-approver rule applies. A
    // chain whose every step auto-skipped is already finished, so it finalises
    // here rather than sitting PENDING with nobody able to act on it.
    const init = await this.approvals.initiate(
      'LEAVE',
      created.id,
      employeeId,
      user.id,
    );
    if (init.engaged && init.finalized) {
      return this.finalizeApproval(
        created,
        null,
        'Auto-approved: the configured workflow had no applicable approver',
      );
    }

    return {
      success: true as const,
      data: this.present(created),
      message: 'Leave request created',
    };
  }

  /** The administrative list, paged. */
  async findAll(query: ListLeaveRequestsDto, user: Principal) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.LeaveRequestWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.leaveType ? { leaveType: query.leaveType } : {}),
      ...(query.startDate
        ? { startDate: { gte: dateOnly(query.startDate) } }
        : {}),
      ...(query.endDate ? { endDate: { lte: dateOnly(query.endDate) } } : {}),
      ...this.scopeToCaller(user),
      ...(query.search
        ? {
            employee: {
              OR: [
                {
                  firstName: {
                    contains: query.search,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
                {
                  lastName: {
                    contains: query.search,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
                {
                  employeeCode: {
                    contains: query.search,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
              ],
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.leaveRequest.findMany({
        where,
        include: LEAVE_INCLUDE,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);

    return paginated(
      rows.map((row) => this.present(row)),
      total,
      page,
      limit,
    );
  }

  /**
   * A department head sees their own department and nothing else. Everyone more
   * senior sees the company; an employee never reaches this list.
   */
  private scopeToCaller(user: Principal): Prisma.LeaveRequestWhereInput {
    if (user.role !== UserRole.MANAGER) return {};
    return { employee: { departmentId: user.departmentId ?? '' } };
  }

  /** The approval queue. */
  async findPending(user: Principal) {
    const rows = await this.prisma.leaveRequest.findMany({
      where: { status: 'PENDING', ...this.scopeToCaller(user) },
      include: LEAVE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return {
      success: true as const,
      data: rows.map((row) => this.present(row)),
      meta: { total: rows.length },
    };
  }

  async findOne(id: string, user: Principal) {
    const row = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        ...LEAVE_INCLUDE,
        attachments: {
          where: { deletedAt: null },
          include: {
            uploader: {
              select: {
                id: true,
                email: true,
                employee: {
                  select: { firstName: true, lastName: true, avatarUrl: true },
                },
              },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Leave request not found');
    await this.assertCanRead(user, row, id);
    return this.present(row);
  }

  /** One employee's own history. */
  async findByEmployee(
    employeeId: string,
    query: ListMyLeaveRequestsDto | undefined,
    user: Principal,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    // The same rule the by-id door applies. Without it a manager read across
    // departments and an employee got a 200-with-an-empty-list oracle telling
    // them a colleague's record exists.
    if (
      user.role !== UserRole.ADMIN &&
      user.role !== UserRole.HR_MANAGER &&
      user.employeeId !== employeeId &&
      !(
        user.role === UserRole.MANAGER &&
        employee.departmentId &&
        employee.departmentId === user.departmentId
      )
    ) {
      throw new ForbiddenException('This record belongs to another employee');
    }

    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        employeeId,
        ...(query?.status ? { status: query.status } : {}),
        ...(query?.leaveType ? { leaveType: query.leaveType } : {}),
        ...(query?.startDate
          ? { startDate: { gte: dateOnly(query.startDate) } }
          : {}),
        ...(query?.endDate
          ? { endDate: { lte: dateOnly(query.endDate) } }
          : {}),
      },
      include: LEAVE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => this.present(row));
  }

  /**
   * Approve, either through the configured chain or by the direct rule.
   *
   * `engaged: false` from the engine means no chain governs leave, and the
   * route admits EMPLOYEE precisely so a supervisor holding no elevated role
   * can act on a step of one. With no chain there is no step to be eligible
   * for, so the role check below is the only thing standing between a colleague
   * and finalising somebody else's leave.
   */
  async approve(id: string, comment: string | undefined, user: Principal) {
    const request = await this.loadForDecision(id);
    if (request.status === 'APPROVED') {
      return {
        success: true as const,
        data: this.present(request),
        message: 'Leave request already approved',
      };
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot approve a ${request.status.toLowerCase()} request`,
      );
    }

    const result = await this.approvals.decide(
      'LEAVE',
      id,
      request.employeeId,
      user,
      'APPROVE',
      comment,
    );

    if (!result.engaged) {
      this.assertDirectDecider(user, request);
      return this.finalizeApproval(request, user.id, comment);
    }
    if (result.finalized) {
      return this.finalizeApproval(request, user.id, comment);
    }
    return {
      success: true as const,
      data: this.present(request),
      message: 'Approval recorded. Awaiting the next approval step.',
      meta: { nextStepOrder: result.nextStepOrder },
    };
  }

  async reject(id: string, reason: string | undefined, user: Principal) {
    const request = await this.loadForDecision(id);
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Only a pending request can be rejected');
    }

    const result = await this.approvals.decide(
      'LEAVE',
      id,
      request.employeeId,
      user,
      'REJECT',
      reason,
    );
    if (!result.engaged) this.assertDirectDecider(user, request);

    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approverId: user.id,
        approvedAt: new Date(),
        rejectedReason: reason ?? null,
      },
      include: LEAVE_INCLUDE,
    });
    return {
      success: true as const,
      data: this.present(updated),
      message: 'Leave request rejected',
    };
  }

  private assertDirectDecider(user: Principal, request: LeaveRow) {
    if (!DIRECT_DECIDERS.includes(user.role)) {
      throw new ForbiddenException(
        'You do not have permission to decide this request',
      );
    }
    if (
      user.role === UserRole.MANAGER &&
      request.employee.departmentId !== user.departmentId
    ) {
      throw new ForbiddenException(
        'You may only decide requests from your own department',
      );
    }
  }

  /**
   * The side-effects of a final approval: the balance, the status, and the
   * LEAVE attendance rows.
   *
   * ORDER IS LOAD-BEARING. `deductDays` throws when the balance is short, and
   * nothing is reserved when the request is raised — so two pending requests
   * can each pass the create-time check against the same days. Writing the
   * status first would leave the row APPROVED and its attendance written while
   * the caller got a 400: an approved leave nobody paid for, reported as a
   * failure. Deducting first fails the whole thing cleanly, and the request
   * stays PENDING with the approver told why.
   */
  private async finalizeApproval(
    request: LeaveRow,
    approverId: string | null,
    comment?: string,
  ) {
    await this.balances.deductDays(
      request.employeeId,
      request.totalDays,
      request.leaveType,
      request.startDate.getUTCFullYear(),
    );

    const updated = await this.prisma.leaveRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        approverId: approverId ?? undefined,
        approvedAt: new Date(),
        rejectedReason: comment ?? null,
      },
      include: LEAVE_INCLUDE,
    });

    const attendance = await this.writeLeaveAttendance(request);

    return {
      success: true as const,
      data: this.present(updated),
      message: attendance.skipped
        ? `Leave request approved. ${attendance.skipped} day(s) already had an attendance record and were left as they were.`
        : 'Leave request approved',
      meta: {
        attendanceCreated: attendance.created,
        attendanceSkipped: attendance.skipped,
      },
    };
  }

  /**
   * Write an ON_LEAVE attendance row for every working day the leave covers.
   *
   * A day the employee already clocked keeps its own record — an approval must
   * never overwrite real attendance — but the approver is told how many were
   * left alone, because silently skipping meant a day of approved leave had no
   * record behind it and nobody knew.
   */
  private async writeLeaveAttendance(request: LeaveRow) {
    const dates = await this.workingDays.workingDatesBetween(
      request.startDate,
      request.endDate,
      request.employee.branchId,
    );
    if (dates.length === 0) return { created: 0, skipped: 0 };

    const { count } = await this.prisma.attendance.createMany({
      data: dates.map((date) => ({
        employeeId: request.employeeId,
        date,
        status: AttendanceStatus.ON_LEAVE,
        // Stamped rather than left null: `Attendance` is filtered by branch on
        // every reporting screen, and a null branch matches no `IN` clause — so
        // an approved leave would be invisible to a branch-scoped reader while
        // payroll still counted it.
        branchId: request.employee.branchId,
        // Provenance, so a later biometric import cannot silently claim a day
        // an approved leave already owns.
        source: AttendanceSource.SYSTEM,
        workHours: 0,
      })),
      skipDuplicates: true,
    });

    return { created: count, skipped: dates.length - count };
  }

  private async loadForDecision(id: string): Promise<LeaveRow> {
    const row = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: LEAVE_INCLUDE,
    });
    if (!row) throw new NotFoundException('Leave request not found');
    return row;
  }

  /** Withdraw a pending request. The owner, or an administrator. */
  async cancel(id: string, user: Principal) {
    const request = await this.prisma.leaveRequest.findUnique({
      where: { id },
      select: { id: true, employeeId: true, status: true },
    });
    if (!request) throw new NotFoundException('Leave request not found');

    const isOwner = !!user.employeeId && request.employeeId === user.employeeId;
    if (!isOwner && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('You may only cancel your own requests');
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Only a pending request can be cancelled');
    }

    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: LEAVE_INCLUDE,
    });

    // Close the live trail so no approver can finalise a withdrawn request.
    await this.approvals.abandon('LEAVE', id);

    return {
      success: true as const,
      data: this.present(updated),
      message: 'Leave request cancelled',
    };
  }

  /** Remaining balances for the caller's own department. */
  async getTeamBalances(user: Principal) {
    if (user.role !== UserRole.MANAGER || !user.departmentId) {
      throw new ForbiddenException(
        'Only a department head can read team leave balances',
      );
    }
    const year = new Date().getUTCFullYear();

    const employees = await this.prisma.employee.findMany({
      where: { departmentId: user.departmentId, status: 'ACTIVE' },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        position: true,
        leaveBalances: {
          where: { year },
          select: {
            year: true,
            annualLeave: true,
            usedAnnual: true,
            sickLeave: true,
            usedSick: true,
            carriedOver: true,
          },
        },
      },
      orderBy: { employeeCode: 'asc' },
    });

    const data = employees.map((employee) => {
      const balance = employee.leaveBalances[0];
      return {
        employeeId: employee.id,
        employeeCode: employee.employeeCode,
        fullName: [employee.firstName, employee.lastName]
          .filter(Boolean)
          .join(' '),
        position: employee.position,
        balances: balance
          ? {
              annual: {
                total: balance.annualLeave,
                used: balance.usedAnnual,
                remaining:
                  balance.annualLeave +
                  balance.carriedOver -
                  balance.usedAnnual,
              },
              sick: {
                total: balance.sickLeave,
                used: balance.usedSick,
                remaining: balance.sickLeave - balance.usedSick,
              },
              carriedOver: balance.carriedOver,
            }
          : null,
      };
    });

    return {
      success: true as const,
      data,
      meta: { year, departmentId: user.departmentId, total: data.length },
    };
  }
}
