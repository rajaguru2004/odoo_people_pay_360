import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { CreateAttendanceCorrectionDto } from './dto/create-attendance-correction.dto';
import { ApproveAttendanceCorrectionDto } from './dto/approve-correction.dto';
import { RejectAttendanceCorrectionDto } from './dto/reject-correction.dto';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DateTime } from 'luxon';

@Injectable()
export class AttendanceCorrectionsService {
  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private settingsService: SystemSettingsService,
    private tzSvc: TimezoneService,
    private notifications: NotificationsService,
  ) {}

  async create(
    employeeId: string,
    dto: CreateAttendanceCorrectionDto,
    skipLimit = false,
  ) {
    // Check if employee exists
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Branch guard: a scoped caller cannot create a correction for an
    // out-of-branch employee.
    assertInBranch(employee.branchId);

    // Enforce monthly self-service request limit (HR-on-behalf bypasses).
    if (!skipLimit) {
      const usage = await this.getMonthlyUsage(employeeId);
      if (!usage.unlimited && usage.used >= usage.limit) {
        throw new BadRequestException(
          `Monthly attendance request limit reached (${usage.limit}). Contact HR for a manual entry.`,
        );
      }
    }

    // Check date cannot be in the future (timezone-aware)
    const tz = await this.tzSvc.getEffectiveTZ(employee.timezone);
    const parts = dto.date.split('-');
    const requestDate = new Date(
      Date.UTC(
        Number(parts[0]),
        Number(parts[1]) - 1,
        Number(parts[2]),
        0,
        0,
        0,
        0,
      ),
    );
    const today = this.tzSvc.toDateKey(new Date(), tz);

    if (requestDate > today) {
      throw new BadRequestException(
        'Cannot adjust attendance for future dates',
      );
    }

    // Attendance cannot predate the employee's onboarding date.
    if (employee.startDate) {
      const startKey = new Date(
        Date.UTC(
          employee.startDate.getUTCFullYear(),
          employee.startDate.getUTCMonth(),
          employee.startDate.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      );
      if (requestDate < startKey) {
        throw new BadRequestException(
          `Cannot adjust attendance before the employee's onboarding date (${startKey.toISOString().slice(0, 10)})`,
        );
      }
    }

    // Check if at least check-in or check-out is provided
    if (!dto.requestedCheckIn && !dto.requestedCheckOut) {
      throw new BadRequestException(
        'Must provide at least check-in or check-out time',
      );
    }

    // Find current attendance record (if any)
    const existingAttendance = await this.prisma.attendance.findUnique({
      where: {
        unique_employee_date: {
          employeeId,
          date: requestDate,
        },
      },
    });

    // Check if there is a PENDING correction request for this date
    const pendingCorrection = await this.prisma.attendanceCorrection.findFirst({
      where: {
        employeeId,
        date: requestDate,
        status: 'PENDING',
      },
    });

    if (pendingCorrection) {
      throw new BadRequestException(
        'There is already a pending correction request for this date',
      );
    }

    // Create correction request
    const correction = await this.prisma.attendanceCorrection.create({
      data: {
        employeeId,
        attendanceId: existingAttendance?.id,
        date: requestDate,
        originalCheckIn: existingAttendance?.checkIn,
        originalCheckOut: existingAttendance?.checkOut,
        requestedCheckIn: dto.requestedCheckIn
          ? new Date(dto.requestedCheckIn)
          : null,
        requestedCheckOut: dto.requestedCheckOut
          ? new Date(dto.requestedCheckOut)
          : null,
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
            department: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        attendance: true,
      },
    });

    // Notify HR/Admin reviewers of the new request.
    await this.notifyReviewers(correction);

    return correction;
  }

  /**
   * Monthly self-service usage for an employee: how many requests they have
   * submitted this calendar month (all statuses, incl. cancelled) vs the
   * configured limit. `limit === 0` means unlimited.
   */
  async getMonthlyUsage(employeeId: string) {
    const limitRaw = await this.settingsService.getSetting(
      'monthly_attendance_request_limit',
      '3',
    );
    const limit = parseInt(limitRaw, 10) || 0;
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const monthEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    const used = await this.prisma.attendanceCorrection.count({
      where: { employeeId, createdAt: { gte: monthStart, lt: monthEnd } },
    });
    const unlimited = limit <= 0;
    return {
      used,
      limit,
      unlimited,
      remaining: unlimited ? null : Math.max(0, limit - used),
    };
  }

  /** Fan out an in-app notification to all active ADMIN/HR_MANAGER reviewers. */
  private async notifyReviewers(correction: any) {
    try {
      const reviewers = await this.prisma.user.findMany({
        where: { role: { in: ['ADMIN', 'HR_MANAGER'] }, isActive: true },
        select: { id: true },
      });
      const dateStr = correction.date.toLocaleDateString('en-US');
      await Promise.all(
        reviewers.map((r) =>
          this.notifications.notifyUser(
            r.id,
            'New attendance request',
            `${correction.employee.fullName} requested an attendance adjustment for ${dateStr}.`,
            'INFO',
            '/dashboard/attendance/corrections',
          ),
        ),
      );
    } catch {
      // Notification failure must not block the request itself.
    }
  }

  /**
   * Notify the requesting employee's user account of an approve/reject decision.
   *
   * `type` is what selects the WhatsApp template, so it must discriminate —
   * the generic 'INFO' this used to send resolved to no template, which is why
   * the decision arrived by email and in the portal but never on WhatsApp.
   */
  private async notifyRequester(
    employeeId: string,
    title: string,
    message: string,
    type: 'ATTENDANCE_CORRECTION_APPROVED' | 'ATTENDANCE_CORRECTION_REJECTED',
    waData?: Record<string, unknown>,
  ) {
    try {
      const user = await this.prisma.user.findFirst({
        where: { employeeId },
        select: { id: true },
      });
      if (user) {
        await this.notifications.notifyUser(
          user.id,
          title,
          message,
          type,
          '/dashboard/attendance/corrections',
          { waData },
        );
      }
    } catch {
      // Non-fatal.
    }
  }

  /**
   * `approverId` on AttendanceCorrection is a raw User id with no Prisma
   * relation (see schema), so reviewer identity is resolved with a
   * separate batched lookup rather than an `include`.
   */
  private async attachReviewers<T extends { approverId?: string | null }>(
    items: T[],
  ): Promise<(T & { reviewer: { id: string; fullName: string; employeeCode: string } | null })[]> {
    const approverIds = Array.from(
      new Set(items.map((i) => i.approverId).filter(Boolean)),
    ) as string[];

    if (approverIds.length === 0) {
      return items.map((i) => ({ ...i, reviewer: null }));
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: approverIds } },
      select: {
        id: true,
        employee: { select: { fullName: true, employeeCode: true } },
      },
    });

    const reviewerById = new Map(
      users.map((u) => [
        u.id,
        {
          id: u.id,
          fullName: u.employee?.fullName ?? 'Unknown',
          employeeCode: u.employee?.employeeCode ?? '',
        },
      ]),
    );

    return items.map((i) => ({
      ...i,
      reviewer: i.approverId ? (reviewerById.get(i.approverId) ?? null) : null,
    }));
  }

  async findAll(status?: string, employeeId?: string) {
    const where: any = {};

    if (status) {
      where.status = status;
    }

    if (employeeId) {
      where.employeeId = employeeId;
    }

    const corrections = await this.prisma.attendanceCorrection.findMany({
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
        attendance: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return this.attachReviewers(corrections);
  }

  async findPending() {
    return this.findAll('PENDING');
  }

  async findByEmployee(employeeId: string) {
    return this.findAll(undefined, employeeId);
  }

  async findOne(id: string) {
    const correction = await this.prisma.attendanceCorrection.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            branchId: true,
            department: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        attendance: true,
      },
    });

    if (!correction) {
      throw new NotFoundException('Correction request not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(correction.employee.branchId);

    const [withReviewer] = await this.attachReviewers([correction]);
    return withReviewer;
  }

  private readonly LATE_THRESHOLD = 15; // 15 minutes grace period
  private readonly LUNCH_BREAK_THRESHOLD = 4; // Deduct lunch only if worked > 4 hours

  private async getOfficeWorkingHours(): Promise<{
    start: number;
    end: number;
  }> {
    const startStr = await this.settingsService.getSetting(
      'office_start_time',
      '08:30',
    );
    const endStr = await this.settingsService.getSetting(
      'office_end_time',
      '17:30',
    );

    const [startHour, startMin] = startStr.split(':').map(Number);
    const [endHour, endMin] = endStr.split(':').map(Number);

    return {
      start:
        (isNaN(startHour) ? 8 : startHour) * 60 +
        (isNaN(startMin) ? 30 : startMin),
      end: (isNaN(endHour) ? 17 : endHour) * 60 + (isNaN(endMin) ? 30 : endMin),
    };
  }

  async approve(
    id: string,
    approverId: string,
    dto?: ApproveAttendanceCorrectionDto,
  ) {
    const correction = await this.findOne(id);

    if (correction.status !== 'PENDING') {
      throw new BadRequestException('Only pending requests can be approved');
    }

    // Get approver info
    const approver = await this.prisma.user.findUnique({
      where: { id: approverId },
      select: { employeeId: true, employee: { select: { fullName: true } } },
    });

    // Nobody decides a request they raised. Approving rewrites an attendance
    // row, which is a payroll input, so a self-approval is an unreviewed change
    // to one's own pay. Phase 1 established exactly this rule for department
    // change requests; attendance never got it, and an HR could file against
    // their own record and approve it in the same breath.
    if (approver?.employeeId && approver.employeeId === correction.employeeId) {
      throw new ForbiddenException(
        'You cannot approve your own attendance correction request.',
      );
    }

    // Update or create new attendance record
    const checkIn = correction.requestedCheckIn || correction.originalCheckIn;
    let checkOut = correction.requestedCheckOut || correction.originalCheckOut;

    // Fetch scheduled shift on that day
    const dateKey = new Date(
      Date.UTC(
        correction.date.getFullYear(),
        correction.date.getMonth(),
        correction.date.getDate(),
        0,
        0,
        0,
        0,
      ),
    );

    const schedule = await this.prisma.workSchedule.findFirst({
      where: {
        employeeId: correction.employeeId,
        date: dateKey,
        isWorkDay: true,
      },
    });

    // Flexible shifts have no fixed window, so late/early never apply and the
    // auto lunch deduction is skipped (breaks are self-managed via sessions).
    const isFlexible = schedule?.shiftType === 'FLEXIBLE';

    // An approved correction obeys the same attendance-day boundary as a real
    // punch. Two things were wrong before: an overnight correction produced a
    // negative diff that Math.max floored to 0 hours, and nothing stopped a
    // correction from paying hours past the day end.
    const employeeTz = await this.tzSvc.getEffectiveTZ(
      (
        await this.prisma.employee.findUnique({
          where: { id: correction.employeeId },
          select: { timezone: true },
        })
      )?.timezone ?? null,
    );
    const boundaryMinutes = this.tzSvc.parseTimeHHMM(
      await this.settingsService.getSetting('attendance_day_end_time', '23:59'),
      23 * 60 + 59,
    );
    const dayEnd = this.tzSvc.attendanceDayEndUTC(
      DateTime.fromJSDate(dateKey, { zone: 'utc' }).toISODate()!,
      employeeTz,
      boundaryMinutes,
    );

    if (checkIn && checkOut) {
      // Overnight correction: the closing punch is the next morning.
      if (new Date(checkOut).getTime() <= new Date(checkIn).getTime()) {
        checkOut = DateTime.fromJSDate(new Date(checkOut))
          .setZone(employeeTz)
          .plus({ days: 1 })
          .toJSDate();
      }
      if (checkOut && new Date(checkOut).getTime() > dayEnd.getTime()) {
        checkOut = new Date(
          Math.max(new Date(checkIn).getTime(), dayEnd.getTime()),
        );
      }
    }

    // Calculate working hours
    let workHours: number | null = null;
    if (checkIn && checkOut) {
      const diff = new Date(checkOut).getTime() - new Date(checkIn).getTime();
      workHours = diff / (1000 * 60 * 60); // Convert to hours
      workHours = Math.max(0, workHours);

      // Deduct the configured lunch break when worked > threshold, unless the
      // check-in is at/after the lunch start (afternoon/evening shifts).
      if (!isFlexible && workHours > this.LUNCH_BREAK_THRESHOLD) {
        const policy = await this.settingsService.getLunchBreakPolicy();
        const companyTZ = await this.tzSvc.getCompanyTZ();
        if (
          policy.durationMinutes > 0 &&
          this.tzSvc.localMinutesOfDay(new Date(checkIn), companyTZ) <
            policy.startMinutes
        ) {
          workHours = Math.max(0, workHours - policy.durationMinutes / 60);
        }
      }
    }

    const { start: workStart, end: workEnd } =
      await this.getOfficeWorkingHours();
    let isLate = false;
    let isEarlyCheckIn = false;
    if (checkIn && !isFlexible) {
      const checkInTime = new Date(checkIn);
      if (schedule && schedule.startTime) {
        const checkInTimeMs = checkInTime.getTime();
        const startTimeMs = new Date(schedule.startTime).getTime();
        isEarlyCheckIn = checkInTimeMs < startTimeMs;
        isLate = checkInTimeMs > startTimeMs + this.LATE_THRESHOLD * 60 * 1000;
      } else {
        const companyTZ = await this.tzSvc.getCompanyTZ();
        const totalMinutes = this.tzSvc.localMinutesOfDay(
          checkInTime,
          companyTZ,
        );
        isLate =
          this.tzSvc.isReasonableWorkTime(checkInTime, companyTZ) &&
          totalMinutes > workStart + this.LATE_THRESHOLD;
        if (this.tzSvc.isReasonableWorkTime(checkInTime, companyTZ)) {
          isEarlyCheckIn = totalMinutes < workStart;
        }
      }
    }

    let isEarlyLeave = false;
    let isLateCheckout = false;
    if (checkIn && checkOut && !isFlexible) {
      const checkInTime = new Date(checkIn);
      const checkOutTime = new Date(checkOut);
      if (schedule && schedule.endTime) {
        const checkOutTimeMs = checkOutTime.getTime();
        const endTimeMs = new Date(schedule.endTime).getTime();
        isEarlyLeave = checkOutTimeMs < endTimeMs;
        isLateCheckout = checkOutTimeMs > endTimeMs;
      } else {
        const companyTZ = await this.tzSvc.getCompanyTZ();
        const currentMinutes = this.tzSvc.localMinutesOfDay(
          checkOutTime,
          companyTZ,
        );
        const durationHours =
          (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60);
        isEarlyLeave =
          durationHours < 4
            ? true
            : this.tzSvc.isReasonableWorkTime(checkOutTime, companyTZ) &&
              currentMinutes < workEnd;
        isLateCheckout = currentMinutes >= workEnd;
      }
    }

    // Upsert attendance record
    await (this.prisma.attendance as any).upsert({
      where: {
        unique_employee_date: {
          employeeId: correction.employeeId,
          date: correction.date,
        },
      },
      create: {
        employeeId: correction.employeeId,
        date: correction.date,
        // Stamp the branch, exactly as `buildAndUpsertAttendance` does on every
        // other write path. `upsert` is in neither BRANCH_READ_ACTIONS nor
        // BRANCH_WRITE_MANY_ACTIONS, so the middleware never filled this in —
        // and `Attendance` is a `direct`-rule model where `branchId IN (…)`
        // cannot match NULL. The result was that the day an employee had
        // successfully corrected DISAPPEARED from their own branch's list,
        // report and logs grid.
        branchId: correction.employee?.branchId ?? null,
        checkIn,
        checkOut,
        workHours:
          workHours !== null ? Math.round(workHours * 100) / 100 : null,
        isLate,
        isEarlyLeave,
        isEarlyCheckIn,
        isLateCheckout,
        status: 'PRESENT',
        notes: `Adjustment: ${correction.reason}`,
      },
      update: {
        checkIn,
        checkOut,
        workHours:
          workHours !== null ? Math.round(workHours * 100) / 100 : null,
        isLate,
        isEarlyLeave,
        isEarlyCheckIn,
        isLateCheckout,
        status: 'PRESENT',
        notes: `Adjustment: ${correction.reason}`,
      },
    });

    // Update correction status
    const updated = await this.prisma.attendanceCorrection.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approverId,
        approvedAt: new Date(),
        approverNotes: dto?.notes ?? null,
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
          },
        },
        attendance: true,
      },
    });

    // Send email notification
    await this.mailService.sendAttendanceCorrectionApproved(
      correction.employee.email,
      {
        employeeName: correction.employee.fullName,
        date: correction.date.toLocaleDateString('en-US'),
        originalCheckIn:
          correction.originalCheckIn?.toLocaleTimeString('en-US') || 'None',
        originalCheckOut:
          correction.originalCheckOut?.toLocaleTimeString('en-US') || 'None',
        requestedCheckIn:
          correction.requestedCheckIn?.toLocaleTimeString('en-US') ||
          'No change',
        requestedCheckOut:
          correction.requestedCheckOut?.toLocaleTimeString('en-US') ||
          'No change',
        approverName: approver?.employee?.fullName || 'HR Manager',
      },
    );

    await this.notifyRequester(
      correction.employeeId,
      'Attendance request approved',
      `Your attendance adjustment for ${correction.date.toLocaleDateString('en-US')} was approved.`,
      'ATTENDANCE_CORRECTION_APPROVED',
      { date: correction.date.toISOString(), status: 'Approved' },
    );

    return updated;
  }

  async reject(
    id: string,
    approverId: string,
    dto: RejectAttendanceCorrectionDto,
  ) {
    const correction = await this.findOne(id);

    if (correction.status !== 'PENDING') {
      throw new BadRequestException('Only pending requests can be rejected');
    }

    // Get approver info
    const approver = await this.prisma.user.findUnique({
      where: { id: approverId },
      select: { employee: { select: { fullName: true } } },
    });

    const updated = await this.prisma.attendanceCorrection.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approverId,
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
          },
        },
      },
    });

    // Send email notification
    await this.mailService.sendAttendanceCorrectionRejected(
      correction.employee.email,
      {
        employeeName: correction.employee.fullName,
        date: correction.date.toLocaleDateString('en-US'),
        approverName: approver?.employee?.fullName || 'HR Manager',
        reason: dto.rejectedReason,
      },
    );

    await this.notifyRequester(
      correction.employeeId,
      'Attendance request rejected',
      `Your attendance adjustment for ${correction.date.toLocaleDateString('en-US')} was rejected: ${dto.rejectedReason}`,
      'ATTENDANCE_CORRECTION_REJECTED',
      {
        date: correction.date.toISOString(),
        status: 'Rejected',
        rejectionReason: dto.rejectedReason,
      },
    );

    return updated;
  }

  async cancel(id: string, employeeId: string) {
    const correction = await this.findOne(id);

    // Only the employee who created the request can cancel it
    if (correction.employeeId !== employeeId) {
      throw new ForbiddenException(
        'You do not have permission to cancel this request',
      );
    }

    if (correction.status !== 'PENDING') {
      throw new BadRequestException('Only pending requests can be cancelled');
    }

    return this.prisma.attendanceCorrection.update({
      where: { id },
      data: {
        status: 'CANCELLED',
      },
    });
  }

  /**
   * The correction queue, scored by how long it has been waiting.
   *
   * `avgResolutionHours` is measured over the last 30 days of decided requests
   * only: a lifetime average is dominated by whatever the backlog looked like
   * when the feature launched, and never moves again.
   */
  async stats() {
    const now = Date.now();
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [pending, olderThan3Days, oldest, decided] = await Promise.all([
      this.prisma.attendanceCorrection.count({ where: { status: 'PENDING' } }),
      this.prisma.attendanceCorrection.count({
        where: { status: 'PENDING', createdAt: { lt: threeDaysAgo } },
      }),
      this.prisma.attendanceCorrection.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.attendanceCorrection.findMany({
        where: { status: { in: ['APPROVED', 'REJECTED'] }, updatedAt: { gte: monthAgo } },
        select: { createdAt: true, updatedAt: true },
        take: 500,
      }),
    ]);

    const avgResolutionHours =
      decided.length > 0
        ? Math.round(
            (decided.reduce((a, r) => a + (r.updatedAt.getTime() - r.createdAt.getTime()), 0) /
              decided.length /
              3_600_000) *
              10,
          ) / 10
        : null;

    return {
      success: true,
      data: {
        pending,
        olderThan3Days,
        oldestPendingAt: oldest?.createdAt ?? null,
        avgResolutionHours,
        decidedSampleSize: decided.length,
      },
    };
  }
}
