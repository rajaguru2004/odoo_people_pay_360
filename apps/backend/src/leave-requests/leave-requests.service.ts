import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import {
  managerDeptScope,
  isDeptInManagerScope,
} from '../common/services/manager-scope.util';
import {
  assertCanAccessEmployeeRecord,
  assertCanActOnBehalfOf,
} from '../common/services/record-access.util';
import { CreateLeaveRequestDto } from './dto/create-leave-request.dto';
import { LeaveBalancesService } from '../leave-balances/leave-balances.service';
import { HolidaysService } from '../holidays/holidays.service';
import { MailService } from '../mail/mail.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { NotificationsService } from '../notifications/notifications.service';

const DEPT_SCOPE_ERROR =
  'You do not have permission to perform this action outside your department.';

@Injectable()
export class LeaveRequestsService {
  constructor(
    private prisma: PrismaService,
    private leaveBalancesService: LeaveBalancesService,
    private holidaysService: HolidaysService,
    private mailService: MailService,
    private tzSvc: TimezoneService,
    private approvalEngine: ApprovalEngineService,
    private notifications: NotificationsService,
  ) {}

  private serializeLeaveRequest(request: any) {
    if (!request) return null;
    if (Array.isArray(request)) {
      return request.map((r) => this.serializeLeaveRequest(r));
    }
    if (request.attachments) {
      request.attachments = request.attachments.map((att: any) => ({
        ...att,
        fileSize:
          att.fileSize !== null && att.fileSize !== undefined
            ? Number(att.fileSize)
            : null,
      }));
    }
    return request;
  }

  async create(
    dto: CreateLeaveRequestDto,
    userId: string,
    userEmployeeId?: string,
    user?: any,
  ) {
    const employeeId = dto.employeeId || userEmployeeId;
    if (!employeeId) {
      throw new BadRequestException('Employee ID is required');
    }

    // Filing for somebody else is an HR privilege. Without this, an EMPLOYEE
    // could book leave against a colleague simply by passing their id — and the
    // days came out of the colleague's balance, with LEAVE attendance rows
    // written against them.
    assertCanActOnBehalfOf(
      { ...(user ?? {}), employeeId: userEmployeeId },
      employeeId,
    );

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, gender: true, branchId: true },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Branch guard: a scoped caller cannot create a request for an
    // out-of-branch employee (create is not auto-scoped for relation models).
    assertInBranch(employee.branchId);

    const startParts = dto.startDate.split('-');
    const endParts = dto.endDate.split('-');
    const startDate = new Date(
      Date.UTC(
        Number(startParts[0]),
        Number(startParts[1]) - 1,
        Number(startParts[2]),
        0,
        0,
        0,
        0,
      ),
    );
    const endDate = new Date(
      Date.UTC(
        Number(endParts[0]),
        Number(endParts[1]) - 1,
        Number(endParts[2]),
        0,
        0,
        0,
        0,
      ),
    );

    if (endDate < startDate) {
      throw new BadRequestException('End date must be after start date');
    }

    // Check for overlapping leave requests
    const overlapping = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        OR: [
          {
            AND: [
              { startDate: { lte: endDate } },
              { endDate: { gte: startDate } },
            ],
          },
        ],
      },
    });

    if (overlapping) {
      throw new BadRequestException(
        `Leave request overlaps with existing request (${overlapping.startDate.toLocaleDateString('en-US')} - ${overlapping.endDate.toLocaleDateString('en-US')})`,
      );
    }

    // Look up the active library item matching the key/label
    const libraryItem = await this.prisma.libraryItem.findFirst({
      where: {
        libraryType: 'LEAVE_TYPE',
        isActive: true,
        OR: [
          { label: dto.leaveType },
          { label: { equals: dto.leaveType, mode: 'insensitive' } },
          ...(dto.leaveType === 'ANNUAL' ? [{ label: 'Annual Leave' }] : []),
          ...(dto.leaveType === 'SICK' ? [{ label: 'Sick Leave' }] : []),
          ...(dto.leaveType === 'UNPAID' ? [{ label: 'Unpaid Leave' }] : []),
          ...(dto.leaveType === 'MATERNITY' ? [{ label: 'Maternity Leave' }] : []),
          ...(dto.leaveType === 'PATERNITY' ? [{ label: 'Paternity Leave' }] : []),
          ...(dto.leaveType === 'BEREAVEMENT' ? [{ label: 'Bereavement Leave' }] : []),
        ],
      },
    });

    const leaveTypeLabel = libraryItem ? libraryItem.label : dto.leaveType;

    // Validate gender restriction
    if (libraryItem?.genderRestriction) {
      const empGender = (employee.gender || '').toUpperCase();
      if (empGender !== libraryItem.genderRestriction.toUpperCase()) {
        const genderLabel = libraryItem.genderRestriction === 'FEMALE' ? 'female' : 'male';
        throw new BadRequestException(
          `${leaveTypeLabel} is only available for ${genderLabel} employees`,
        );
      }
    }

    // Check minimum notice period dynamically
    if (libraryItem && libraryItem.requiresNoticeDays > 0) {
      const noticeDays = libraryItem.requiresNoticeDays;
      const companyTZ = await this.tzSvc.getCompanyTZ();
      const today = this.tzSvc.toDateKey(new Date(), companyTZ);
      const minNoticeDate = new Date(today);
      minNoticeDate.setUTCDate(minNoticeDate.getUTCDate() + noticeDays);

      if (startDate < minNoticeDate) {
        throw new BadRequestException(
          `${leaveTypeLabel} requires at least ${noticeDays} days notice`,
        );
      }
    } else if (!libraryItem && dto.leaveType === 'ANNUAL') {
      // Legacy fallback notice check
      const companyTZ = await this.tzSvc.getCompanyTZ();
      const today = this.tzSvc.toDateKey(new Date(), companyTZ);
      const minNoticeDate = new Date(today);
      minNoticeDate.setUTCDate(minNoticeDate.getUTCDate() + 3);

      if (startDate < minNoticeDate) {
        throw new BadRequestException(
          'Annual leave requires at least 3 days notice',
        );
      }
    }

    // Calculate total days (excluding the employee's branch weekly-off days + holidays)
    const totalDays = await this.holidaysService.getWorkDaysBetween(
      startDate,
      endDate,
      employee.branchId ?? undefined,
    );

    // Check leave balance dynamically
    const affectsBalance = libraryItem ? libraryItem.affectsBalance : (dto.leaveType === 'ANNUAL' || dto.leaveType === 'SICK');
    if (affectsBalance) {
      const year = startDate.getUTCFullYear();
      const balanceResult = await this.leaveBalancesService.getBalance(
        employeeId,
        year,
      );

      if (libraryItem) {
        const typeBalances = balanceResult.data.leaveTypeBalances || [];
        const typeBalance = typeBalances.find((tb) => tb.leaveTypeKey === leaveTypeLabel);
        const remainingDays = typeBalance ? typeBalance.remaining : (libraryItem.defaultDays || 0);

        if (remainingDays < totalDays) {
          throw new BadRequestException(
            `Insufficient ${leaveTypeLabel} balance. Available: ${remainingDays} days`,
          );
        }
      } else {
        // Fallback legacy structure
        if (dto.leaveType === 'ANNUAL') {
          const remainingDays = balanceResult.data.remainingAnnual || 0;
          if (remainingDays < totalDays) {
            throw new BadRequestException(
              `Insufficient annual leave balance. Available: ${remainingDays} days`,
            );
          }
        } else if (dto.leaveType === 'SICK') {
          const remainingDays = balanceResult.data.remainingSick || 0;
          if (remainingDays < totalDays) {
            throw new BadRequestException(
              `Insufficient sick leave balance. Available: ${remainingDays} days`,
            );
          }
        }
      }
    }

    const leaveRequest = await this.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveType: leaveTypeLabel,
        startDate,
        endDate,
        totalDays,
        reason: dto.reason,
        status: 'PENDING',
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            // The applicant's own account, so the submission confirmation can
            // reach the channels they use rather than email alone.
            user: { select: { id: true } },
            department: {
              select: {
                id: true,
                name: true,
                manager: {
                  select: {
                    id: true,
                    fullName: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Send notifications to stakeholders in background
    (async () => {
      try {
        const hrUsers = await this.prisma.user.findMany({
          where: {
            role: { in: ['HR_MANAGER', 'ADMIN'] },
            isActive: true,
          },
          select: { email: true },
        });
        const hrEmails = hrUsers.map((u) => u.email);

        // The applicant's own confirmation. The manager and HR copies below
        // stay email-only: they are a work queue, and the approver already
        // gets an APPROVAL_REQUESTED notification of their own.
        if (leaveRequest.employee.user?.id) {
          await this.notifications
            .notifyUser(
              leaveRequest.employee.user.id,
              'Leave request submitted',
              `Your ${leaveRequest.leaveType} leave request has been submitted and is awaiting approval.`,
              'LEAVE_APPLIED',
              '/dashboard/leaves',
            )
            .catch(() => undefined);
        }

        // Send to applicant
        await this.mailService.sendLeaveApplied(leaveRequest.employee.email, {
          employeeName: leaveRequest.employee.fullName,
          leaveType: leaveRequest.leaveType,
          startDate: leaveRequest.startDate.toLocaleDateString('en-US'),
          endDate: leaveRequest.endDate.toLocaleDateString('en-US'),
          days: leaveRequest.totalDays,
          reason: leaveRequest.reason,
          isUserRecipient: true,
        });

        // Send to department manager
        if (leaveRequest.employee.department?.manager?.email) {
          await this.mailService.sendLeaveApplied(
            leaveRequest.employee.department.manager.email,
            {
              employeeName: leaveRequest.employee.fullName,
              leaveType: leaveRequest.leaveType,
              startDate: leaveRequest.startDate.toLocaleDateString('en-US'),
              endDate: leaveRequest.endDate.toLocaleDateString('en-US'),
              days: leaveRequest.totalDays,
              reason: leaveRequest.reason,
              isUserRecipient: false,
            },
          );
        }

        // Send to HR/Admins
        for (const hrEmail of hrEmails) {
          if (
            hrEmail !== leaveRequest.employee.email &&
            hrEmail !== leaveRequest.employee.department?.manager?.email
          ) {
            await this.mailService.sendLeaveApplied(hrEmail, {
              employeeName: leaveRequest.employee.fullName,
              leaveType: leaveRequest.leaveType,
              startDate: leaveRequest.startDate.toLocaleDateString('en-US'),
              endDate: leaveRequest.endDate.toLocaleDateString('en-US'),
              days: leaveRequest.totalDays,
              reason: leaveRequest.reason,
              isUserRecipient: false,
            });
          }
        }
      } catch (err) {
        console.error(
          'Failed to send leave applied email notifications:',
          err.message,
        );
      }
    })().catch((err) => {
      console.error('Background leave application email notification error:', err);
    });

    // Materialize the configurable approval trail (no-op when no active workflow
    // or the master switch is off). If every step auto-skips, finalize now.
    const init = await this.approvalEngine.initiate(
      'LEAVE',
      leaveRequest.id,
      employeeId,
      userId,
    );
    if (init.engaged && init.finalized) {
      await this.finalizeLeaveApproval(
        leaveRequest,
        null,
        'Auto-approved: no applicable approvers in the configured workflow',
      );
    }

    return {
      success: true,
      message: 'Leave request created successfully',
      data: leaveRequest,
    };
  }

  async findAll(
    query: {
      employeeId?: string;
      status?: string;
      leaveType?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
    user?: any,
  ) {
    const {
      employeeId,
      status,
      leaveType,
      startDate,
      endDate,
      search,
      page = 1,
      limit = 10,
    } = query;

    // Convert to numbers and apply max limit
    const pageNum = Number(page) || 1;
    const limitNum = Math.min(Number(limit) || 10, 500); // Max 500
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    if (leaveType) where.leaveType = leaveType;

    if (startDate && startDate.includes('-')) {
      try {
        const parts = startDate.split('-');
        where.startDate = {
          gte: new Date(
            Date.UTC(
              Number(parts[0]),
              Number(parts[1]) - 1,
              Number(parts[2]),
              0,
              0,
              0,
              0,
            ),
          ),
        };
      } catch (e) {}
    }
    if (endDate && endDate.includes('-')) {
      try {
        const parts = endDate.split('-');
        where.endDate = {
          lte: new Date(
            Date.UTC(
              Number(parts[0]),
              Number(parts[1]) - 1,
              Number(parts[2]),
              23,
              59,
              59,
              999,
            ),
          ),
        };
      } catch (e) {}
    }

    // MANAGER: scope to the departments they manage
    if (user?.role === 'MANAGER') {
      where.employee = {
        ...where.employee,
        departmentId: { in: managerDeptScope(user) },
      };
    }

    if (search) {
      where.employee = {
        ...where.employee,
        fullName: {
          contains: search,
          mode: 'insensitive',
        },
      };
    }

    const [requests, total] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where,
        skip,
        take: limitNum,
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
              department: { select: { name: true } },
            },
          },
          approver: {
            select: { id: true, email: true },
          },
          attachments: {
            where: { deletedAt: null },
          },
          approvals: {
            include: {
              approver: {
                select: {
                  id: true,
                  email: true,
                  employee: { select: { fullName: true, avatarUrl: true } },
                },
              },
            },
            orderBy: { tier: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);

    return {
      success: true,
      data: requests.map((r) => this.serializeLeaveRequest(r)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findPending(user?: any) {
    const deptFilter =
      user?.role === 'MANAGER'
        ? { employee: { departmentId: { in: managerDeptScope(user) } } }
        : {};

    const requests = await this.prisma.leaveRequest.findMany({
      where: { status: 'PENDING', ...deptFilter },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
          },
        },
        attachments: {
          where: { deletedAt: null },
        },
        approvals: {
          include: {
            approver: {
              select: {
                id: true,
                email: true,
                employee: { select: { fullName: true, avatarUrl: true } },
              },
            },
          },
          orderBy: { tier: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      success: true,
      data: requests.map((r) => this.serializeLeaveRequest(r)),
      meta: { total: requests.length },
    };
  }

  async findOne(id: string, user?: any) {
    const request = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            branchId: true,
            departmentId: true,
            department: { select: { id: true, name: true, managerId: true } },
          },
        },
        approver: {
          select: { id: true, email: true },
        },
        attachments: {
          where: { deletedAt: null },
          include: {
            uploader: {
              select: {
                id: true,
                email: true,
                employee: { select: { fullName: true, avatarUrl: true } },
              },
            },
          },
        },
        approvals: {
          include: {
            approver: {
              select: {
                id: true,
                email: true,
                employee: { select: { fullName: true, avatarUrl: true } },
              },
            },
          },
          orderBy: { tier: 'asc' },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Leave request not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping) PLUS the
    // ownership/department rule — without the second half, any authenticated
    // employee could read a colleague's leave reason, approver and attachment
    // list by walking ids.
    if (user) {
      // The branch envelope is absolute; the ownership rule is not. An approver
      // named by the request's own chain may read it even though they own none
      // of the requester's records — without that, a configured chain strands
      // at step one, because the person asked to decide cannot open it.
      assertInBranch(request.employee.branchId);
      try {
        assertCanAccessEmployeeRecord(user, request.employee as any);
      } catch (err) {
        if (!(await this.approvalEngine.isChainParticipant('LEAVE', id, user))) {
          throw err;
        }
      }
    } else {
      assertInBranch(request.employee.branchId);
    }

    return { success: true, data: this.serializeLeaveRequest(request) };
  }

  async findByEmployee(
    employeeId: string,
    query?: {
      status?: string;
      leaveType?: string;
      startDate?: string;
      endDate?: string;
    },
    user?: any,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true, branchId: true },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // The overtime module's equivalent door has always checked this; the leave
    // one did not, so a MANAGER read across departments and a scoped caller got
    // a 200-with-an-empty-list existence oracle for another branch.
    if (user) {
      assertCanAccessEmployeeRecord(user, employee);
    }

    const where: any = { employeeId };
    if (query?.status) where.status = query.status;
    if (query?.leaveType) where.leaveType = query.leaveType;
    if (query?.startDate && query.startDate.includes('-')) {
      try {
        const parts = query.startDate.split('-');
        where.startDate = {
          gte: new Date(
            Date.UTC(
              Number(parts[0]),
              Number(parts[1]) - 1,
              Number(parts[2]),
              0,
              0,
              0,
              0,
            ),
          ),
        };
      } catch (e) {}
    }
    if (query?.endDate && query.endDate.includes('-')) {
      try {
        const parts = query.endDate.split('-');
        where.endDate = {
          lte: new Date(
            Date.UTC(
              Number(parts[0]),
              Number(parts[1]) - 1,
              Number(parts[2]),
              23,
              59,
              59,
              999,
            ),
          ),
        };
      } catch (e) {}
    }

    const requests = await this.prisma.leaveRequest.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
          },
        },
        approver: {
          select: { id: true, email: true },
        },
        attachments: {
          where: { deletedAt: null },
        },
        approvals: {
          include: {
            approver: {
              select: {
                id: true,
                email: true,
                employee: { select: { fullName: true, avatarUrl: true } },
              },
            },
          },
          orderBy: { tier: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, data: requests.map((r) => this.serializeLeaveRequest(r)) };
  }

  async approve(id: string, approverId: string, comment?: string, user?: any) {
    const request = await this.loadRequestForDecision(id);
    if (!request) {
      throw new NotFoundException('Leave request not found');
    }
    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(request.employee.branchId);

    if (request.status === 'APPROVED') {
      return {
        success: true,
        message: 'Leave request already approved',
        data: this.serializeLeaveRequest(request),
      };
    }
    if (request.status === 'REJECTED') {
      throw new BadRequestException('Cannot approve a rejected request');
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot approve a ${request.status.toLowerCase()} request`,
      );
    }

    // Configurable hierarchy first; engine returns engaged=false when no active
    // workflow governs this request (legacy single-approver path then applies).
    const result = await this.approvalEngine.decide(
      'LEAVE',
      id,
      request.employeeId,
      user,
      'APPROVE',
      comment,
    );

    if (!result.engaged) {
      // The route admits EMPLOYEE so a SUPERVISOR — who typically holds no
      // elevated role — can act on a step of a CONFIGURED chain. With no chain
      // engaged there is no step to be eligible for, and the legacy guard only
      // ever covered MANAGER, so any colleague could finalize anyone's leave.
      if (!['ADMIN', 'HR_MANAGER', 'MANAGER'].includes(user?.role)) {
        throw new ForbiddenException(
          'You do not have permission to decide this request.',
        );
      }
      if (
        user?.role === 'MANAGER' &&
        !isDeptInManagerScope(user, request.employee.departmentId)
      ) {
        throw new ForbiddenException(DEPT_SCOPE_ERROR);
      }
      return this.finalizeLeaveApproval(request, approverId, comment);
    }
    if (result.finalized) {
      return this.finalizeLeaveApproval(request, approverId, comment);
    }
    return {
      success: true,
      message: 'Approval recorded. Awaiting the next approval step.',
      data: this.serializeLeaveRequest(request),
    };
  }

  /** Final approval side-effects (attendance, balance, notifications, status). */
  private async finalizeLeaveApproval(
    request: any,
    approverId: string | null,
    comment?: string,
  ) {
    const approver = approverId
      ? await this.prisma.user.findUnique({
          where: { id: approverId },
          select: { employee: { select: { fullName: true } } },
        })
      : null;

    // ORDER IS LOAD-BEARING. `deductDays` throws when the balance is short, and
    // nothing is reserved at create time — so two PENDING requests can each
    // pass the create-time check against the same days. Writing the status
    // first meant the second approval returned 400 to the caller while leaving
    // the row APPROVED, its attendance written and nothing deducted: an
    // approved leave nobody paid for, reported as a failure.
    //
    // Deducting first makes the whole finalize fail cleanly instead: the
    // request stays PENDING and the approver is told why.
    await this.leaveBalancesService.deductDays(
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
        rejectedReason: comment || null,
      },
      include: {
        employee: {
          select: { id: true, employeeCode: true, fullName: true, email: true },
        },
      },
    });

    const attendance = await this.createLeaveAttendances(
      request.employeeId,
      request.startDate,
      request.endDate,
    );

    if (request.employee?.user?.id) {
      this.notifications
        .notifyUser(
          request.employee.user.id,
          'Leave approved',
          `Your ${request.leaveType} leave request was approved.`,
          'LEAVE_APPROVED',
          '/dashboard/leaves',
        )
        .catch(() => undefined);
    }

    (async () => {
      try {
        const employee = await this.prisma.employee.findUnique({
          where: { id: request.employeeId },
          include: {
            department: { select: { manager: { select: { email: true } } } },
          },
        });
        const hrUsers = await this.prisma.user.findMany({
          where: { role: { in: ['HR_MANAGER', 'ADMIN'] }, isActive: true },
          select: { email: true },
        });
        const recipients = new Set<string>();
        recipients.add(request.employee.email);
        if (employee?.department?.manager?.email) {
          recipients.add(employee.department.manager.email);
        }
        hrUsers.forEach((u) => recipients.add(u.email));
        for (const email of recipients) {
          await this.mailService.sendLeaveApproved(email, {
            employeeName: request.employee.fullName,
            leaveType: request.leaveType,
            startDate: request.startDate.toLocaleDateString('en-US'),
            endDate: request.endDate.toLocaleDateString('en-US'),
            days: request.totalDays,
            approverName: approver?.employee?.fullName || 'HR Manager',
            comment: comment || '',
          });
        }
      } catch (err) {
        console.error(
          'Failed to send leave approved email notifications:',
          err.message,
        );
      }
    })().catch((err) => {
      console.error('Background leave approved email notification error:', err);
    });

    return {
      success: true,
      message: attendance.skipped
        ? `Leave request approved. ${attendance.skipped} day(s) already had an attendance record and were left unchanged.`
        : 'Leave request approved',
      data: this.serializeLeaveRequest(updated),
      meta: {
        attendanceCreated: attendance.created,
        attendanceSkipped: attendance.skipped,
      },
    };
  }

  async reject(id: string, approverId: string, reason?: string, user?: any) {
    const request = await this.loadRequestForDecision(id);
    if (!request) {
      throw new NotFoundException('Leave request not found');
    }
    assertInBranch(request.employee.branchId);
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Can only reject pending requests');
    }

    const result = await this.approvalEngine.decide(
      'LEAVE',
      id,
      request.employeeId,
      user,
      'REJECT',
      reason,
    );
    if (!result.engaged) {
      if (!['ADMIN', 'HR_MANAGER', 'MANAGER'].includes(user?.role)) {
        throw new ForbiddenException(
          'You do not have permission to decide this request.',
        );
      }
      if (
        user?.role === 'MANAGER' &&
        !isDeptInManagerScope(user, request.employee.departmentId)
      ) {
        throw new ForbiddenException(DEPT_SCOPE_ERROR);
      }
    }
    return this.finalizeLeaveRejection(request, approverId, reason);
  }

  private async finalizeLeaveRejection(
    request: any,
    approverId: string | null,
    reason?: string,
  ) {
    const approver = approverId
      ? await this.prisma.user.findUnique({
          where: { id: approverId },
          select: { employee: { select: { fullName: true } } },
        })
      : null;

    const updated = await this.prisma.leaveRequest.update({
      where: { id: request.id },
      data: {
        status: 'REJECTED',
        approverId: approverId ?? undefined,
        approvedAt: new Date(),
        rejectedReason: reason,
      },
    });

    if (request.employee?.user?.id) {
      this.notifications
        .notifyUser(
          request.employee.user.id,
          'Leave rejected',
          `Your ${request.leaveType} leave request was rejected.`,
          'LEAVE_REJECTED',
          '/dashboard/leaves',
        )
        .catch(() => undefined);
    }

    (async () => {
      try {
        const employee = await this.prisma.employee.findUnique({
          where: { id: request.employeeId },
          include: {
            department: { select: { manager: { select: { email: true } } } },
          },
        });
        const hrUsers = await this.prisma.user.findMany({
          where: { role: { in: ['HR_MANAGER', 'ADMIN'] }, isActive: true },
          select: { email: true },
        });
        const recipients = new Set<string>();
        recipients.add(request.employee.email);
        if (employee?.department?.manager?.email) {
          recipients.add(employee.department.manager.email);
        }
        hrUsers.forEach((u) => recipients.add(u.email));
        for (const email of recipients) {
          await this.mailService.sendLeaveRejected(email, {
            employeeName: request.employee.fullName,
            leaveType: request.leaveType,
            startDate: request.startDate.toLocaleDateString('en-US'),
            endDate: request.endDate.toLocaleDateString('en-US'),
            days: request.totalDays,
            approverName: approver?.employee?.fullName || 'HR Manager',
            reason: reason || 'No specific reason',
          });
        }
      } catch (err) {
        console.error(
          'Failed to send leave rejected email notifications:',
          err.message,
        );
      }
    })().catch((err) => {
      console.error('Background leave rejected email notification error:', err);
    });

    return {
      success: true,
      message: 'Leave request rejected',
      data: this.serializeLeaveRequest(updated),
    };
  }

  private async loadRequestForDecision(id: string) {
    return this.prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            departmentId: true,
            branchId: true,
            department: { select: { id: true, name: true, managerId: true } },
            user: { select: { id: true } },
          },
        },
      },
    });
  }

  async cancel(id: string, userId: string, userEmployeeId?: string) {
    const request = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: { employee: { select: { branchId: true } } },
    });

    if (!request) {
      throw new NotFoundException('Leave request not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(request.employee.branchId);

    // Only owner or HR can cancel
    if (request.employeeId !== userEmployeeId) {
      throw new ForbiddenException('You can only cancel your own requests');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('Can only cancel pending requests');
    }

    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    // Terminate any live approval trail so no approver can finalize it later.
    await this.approvalEngine.abandon('LEAVE', id);

    return {
      success: true,
      message: 'Leave request cancelled',
      data: updated,
    };
  }

  async getTeamBalances(user: any) {
    const deptIds = managerDeptScope(user);
    if (user?.role !== 'MANAGER' || deptIds.length === 0) {
      throw new ForbiddenException(
        'Only managers can view team leave balances.',
      );
    }

    const companyTZ = await this.tzSvc.getCompanyTZ();
    const year = this.tzSvc.toDateKey(new Date(), companyTZ).getUTCFullYear();
    const employees = await this.prisma.employee.findMany({
      where: { departmentId: { in: deptIds }, status: 'ACTIVE' },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
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
    });

    const data = employees.map((emp) => {
      const balance = emp.leaveBalances[0];
      return {
        employeeId: emp.id,
        employeeCode: emp.employeeCode,
        fullName: emp.fullName,
        position: emp.position,
        balances: balance
          ? {
              annual: {
                total: Number(balance.annualLeave),
                used: Number(balance.usedAnnual),
                remaining:
                  Number(balance.annualLeave) -
                  Number(balance.usedAnnual) +
                  Number(balance.carriedOver),
              },
              sick: {
                total: Number(balance.sickLeave),
                used: Number(balance.usedSick),
                remaining: Number(balance.sickLeave) - Number(balance.usedSick),
              },
              carriedOver: Number(balance.carriedOver),
            }
          : null,
      };
    });

    return {
      success: true,
      data,
      meta: { year, departmentIds: deptIds, total: data.length },
    };
  }

  private async createLeaveAttendances(
    employeeId: string,
    startDate: Date,
    endDate: Date,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { branchId: true },
    });

    // Only the employee's actual working dates (branch weekly-off days AND
    // holidays excluded) — keeps LEAVE attendance rows consistent with the
    // work-day count used for leave duration.
    const workingDates = await this.holidaysService.getWorkingDatesBetween(
      startDate,
      endDate,
      employee?.branchId ?? undefined,
    );

    if (workingDates.length === 0) return { created: 0, skipped: 0 };

    const { count } = await this.prisma.attendance.createMany({
      data: workingDates.map((date) => ({
        employeeId,
        date,
        status: 'LEAVE',
        workHours: 0,
        // Stamp the branch. Without it these rows carried `branchId: null`, and
        // `Attendance` is a `direct`-rule model where `branchId IN (…)` never
        // matches NULL — so an approved leave was invisible to every
        // branch-scoped caller: absent from the attendance list, the monthly
        // report and the logs grid, while payroll still counted it.
        branchId: employee?.branchId ?? null,
        // Provenance: an external attendance sync must never overwrite a day
        // that an approved leave already claimed.
        source: 'LEAVE',
      })),
      // A day the employee already clocked keeps its own record — an approval
      // must never overwrite real attendance. But the approver has to be TOLD:
      // silently skipping meant a day of approved leave had no LEAVE record
      // behind it and nobody knew.
      skipDuplicates: true,
    });

    return { created: count, skipped: workingDates.length - count };
  }
}
