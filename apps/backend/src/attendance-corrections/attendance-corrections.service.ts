import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import type { Principal } from '../auth/auth.service';
import { AttendanceCalendarService } from '../attendances/attendance-calendar.service';
import {
  computeStatus,
  dayKeyToDate,
  resolveZone,
  round2,
  toDayKey,
} from '../attendances/attendance-calendar.util';
import { ListCorrectionsDto } from './dto/list-corrections.dto';
import { CreateCorrectionDto } from './dto/create-correction.dto';
import { ReviewCorrectionDto } from './dto/review-correction.dto';

const CORRECTION_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      department: { select: { id: true, name: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
  },
  attendance: {
    select: {
      id: true,
      date: true,
      checkIn: true,
      checkOut: true,
      status: true,
      source: true,
    },
  },
  reviewedBy: { select: { id: true, email: true, role: true } },
} satisfies Prisma.AttendanceCorrectionInclude;

@Injectable()
export class AttendanceCorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: AttendanceCalendarService,
  ) {}

  async findAll(query: ListCorrectionsDto, user: Principal) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.AttendanceCorrectionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...this.scopeToCaller(query.employeeId, user),
      ...(query.startDate || query.endDate
        ? {
            date: {
              ...(query.startDate
                ? { gte: dayKeyToDate(query.startDate) }
                : {}),
              ...(query.endDate ? { lte: dayKeyToDate(query.endDate) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.attendanceCorrection.findMany({
        where,
        include: CORRECTION_INCLUDE,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }],
      }),
      this.prisma.attendanceCorrection.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  /**
   * Queue health.
   *
   * `avgResolutionHours` is null when nothing has ever been reviewed — zero
   * would read as "resolved instantly", which is the opposite of the truth for
   * a queue that has never been touched.
   */
  async stats(user: Principal) {
    const scope = this.scopeToCaller(undefined, user);

    const [byStatus, resolved] = await Promise.all([
      this.prisma.attendanceCorrection.groupBy({
        by: ['status'],
        where: scope,
        _count: { _all: true },
      }),
      this.prisma.attendanceCorrection.findMany({
        where: { ...scope, reviewedAt: { not: null } },
        select: { createdAt: true, reviewedAt: true },
      }),
    ]);

    const count = (status: string) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    const hours = resolved.map(
      (row) =>
        ((row.reviewedAt as Date).getTime() - row.createdAt.getTime()) /
        3_600_000,
    );

    return {
      pending: count('PENDING'),
      approved: count('APPROVED'),
      rejected: count('REJECTED'),
      cancelled: count('CANCELLED'),
      total: byStatus.reduce((a, row) => a + row._count._all, 0),
      avgResolutionHours: hours.length
        ? round2(hours.reduce((a, h) => a + h, 0) / hours.length)
        : null,
    };
  }

  async findOne(id: string, user: Principal) {
    const correction = await this.prisma.attendanceCorrection.findUnique({
      where: { id },
      include: CORRECTION_INCLUDE,
    });
    if (!correction)
      throw new NotFoundException('Correction request not found');

    if (
      user.role === UserRole.EMPLOYEE &&
      correction.employeeId !== user.employeeId
    ) {
      throw new ForbiddenException('This request belongs to another employee');
    }
    return correction;
  }

  /**
   * Raise a correction for yourself.
   *
   * The original times are SNAPSHOT onto the request. That snapshot is the
   * point of the record: once the row is rewritten, what the clock originally
   * said exists nowhere else, and a reviewer looking at the request a week
   * later has nothing to compare the ask against.
   */
  async create(dto: CreateCorrectionDto, user: Principal) {
    if (!user.employeeId) {
      throw new ForbiddenException(
        'Your account is not linked to an employee record, so it cannot raise a correction',
      );
    }
    if (!dto.requestedCheckIn && !dto.requestedCheckOut) {
      throw new BadRequestException(
        'A correction must request a check-in time, a check-out time, or both',
      );
    }

    const requestedCheckIn = dto.requestedCheckIn
      ? new Date(dto.requestedCheckIn)
      : null;
    const requestedCheckOut = dto.requestedCheckOut
      ? new Date(dto.requestedCheckOut)
      : null;
    if (
      requestedCheckIn &&
      requestedCheckOut &&
      requestedCheckOut.getTime() < requestedCheckIn.getTime()
    ) {
      throw new BadRequestException(
        'The requested check-out is before the requested check-in',
      );
    }

    await this.assertTimesFallOnDate(
      user.employeeId,
      dto.date,
      requestedCheckIn,
      requestedCheckOut,
    );

    const existing = await this.prisma.attendance.findUnique({
      where: {
        employeeId_date: {
          employeeId: user.employeeId,
          date: dayKeyToDate(dto.date),
        },
      },
      select: { id: true, checkIn: true, checkOut: true },
    });

    const duplicate = await this.prisma.attendanceCorrection.findFirst({
      where: {
        employeeId: user.employeeId,
        date: dayKeyToDate(dto.date),
        status: 'PENDING',
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(
        `You already have a correction awaiting review for ${dto.date}`,
      );
    }

    return this.prisma.attendanceCorrection.create({
      data: {
        employeeId: user.employeeId,
        // Left null when the day has no row at all — a missed punch. Approving
        // that case CREATES the row rather than editing one.
        attendanceId: existing?.id ?? null,
        date: dayKeyToDate(dto.date),
        originalCheckIn: existing?.checkIn ?? null,
        originalCheckOut: existing?.checkOut ?? null,
        requestedCheckIn,
        requestedCheckOut,
        reason: dto.reason,
      },
      include: CORRECTION_INCLUDE,
    });
  }

  /**
   * Approve or reject.
   *
   * Approving writes the requested times onto the attendance row — creating it
   * when the day never had one — re-derives the verdict through the same
   * calendar the punch endpoints use, and stamps the row MANUAL. That stamp is
   * load-bearing: a later biometric import reads `source` before it overwrites
   * anything, so a human decision is not silently undone by a machine.
   */
  async review(id: string, dto: ReviewCorrectionDto, user: Principal) {
    const correction = await this.prisma.attendanceCorrection.findUnique({
      where: { id },
    });
    if (!correction)
      throw new NotFoundException('Correction request not found');
    if (correction.status !== 'PENDING') {
      throw new BadRequestException(
        `This request was already ${correction.status.toLowerCase()} and cannot be reviewed again`,
      );
    }

    const reviewedAt = new Date();

    if (dto.action === 'REJECT') {
      return this.prisma.attendanceCorrection.update({
        where: { id },
        data: {
          status: 'REJECTED',
          reviewedById: user.id,
          reviewedAt,
          reviewNote: dto.reviewNote ?? null,
        },
        include: CORRECTION_INCLUDE,
      });
    }

    const dayKey = toDayKey(correction.date);
    const context = await this.calendar.employeeContext(correction.employeeId);
    const day = await this.calendar.resolveDay(
      correction.employeeId,
      dayKey,
      context,
    );

    const existing = await this.prisma.attendance.findUnique({
      where: {
        employeeId_date: {
          employeeId: correction.employeeId,
          date: correction.date,
        },
      },
    });

    // A request that asks for only one of the two times leaves the other as it
    // stands — a corrected arrival should not wipe a departure that was fine.
    const checkIn = correction.requestedCheckIn ?? existing?.checkIn ?? null;
    const checkOut = correction.requestedCheckOut ?? existing?.checkOut ?? null;

    // Re-checked at the moment the times actually land on the timesheet, not
    // only when they were asked for. A request raised before this rule existed,
    // or seeded straight into the table, has never been through it — and an
    // approval is the one action that turns its contents into hours worked.
    await this.assertTimesFallOnDate(
      correction.employeeId,
      dayKey,
      checkIn,
      checkOut,
    );

    const derived = computeStatus({
      checkIn,
      checkOut,
      expected: day.expectedHours,
      graceMinutes: day.graceMinutes,
      officeStart: day.officeStart,
      zone: day.zone,
    });

    const attendanceData = {
      checkIn,
      checkOut,
      workHours: derived.workHours,
      expectedHours: day.expectedHours,
      status: derived.status,
      source: 'MANUAL' as const,
      isLate: derived.isLate,
      lateMinutes: derived.lateMinutes,
      isEarlyLeave: derived.isEarlyLeave,
    };

    // One transaction: an approved request whose attendance write failed would
    // leave a decision on record that the timesheet does not reflect.
    const [attendance, updated] = await this.prisma.$transaction(async (tx) => {
      const row = existing
        ? await tx.attendance.update({
            where: { id: existing.id },
            data: attendanceData,
          })
        : await tx.attendance.create({
            data: {
              employeeId: correction.employeeId,
              date: correction.date,
              branchId: context.branchId,
              notes: `Created from correction request: ${correction.reason}`,
              ...attendanceData,
            },
          });

      const record = await tx.attendanceCorrection.update({
        where: { id },
        data: {
          status: 'APPROVED',
          attendanceId: row.id,
          reviewedById: user.id,
          reviewedAt,
          reviewNote: dto.reviewNote ?? null,
        },
        include: CORRECTION_INCLUDE,
      });

      return [row, record] as const;
    });

    return { ...updated, attendance };
  }

  /** Withdrawn by the person who raised it, or by an administrator. */
  async cancel(id: string, user: Principal) {
    const correction = await this.prisma.attendanceCorrection.findUnique({
      where: { id },
    });
    if (!correction)
      throw new NotFoundException('Correction request not found');

    const isOwner =
      Boolean(user.employeeId) && correction.employeeId === user.employeeId;
    if (!isOwner && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only the employee who raised this request can withdraw it',
      );
    }
    if (correction.status !== 'PENDING') {
      throw new BadRequestException(
        `This request was already ${correction.status.toLowerCase()} and can no longer be withdrawn`,
      );
    }

    return this.prisma.attendanceCorrection.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: CORRECTION_INCLUDE,
    });
  }

  /**
   * An EMPLOYEE only ever sees their own.
   *
   * Built from the PRINCIPAL, never from the query string: a scope that trusts
   * `?employeeId=` is one edited URL away from being no scope at all.
   */
  private scopeToCaller(
    requested: string | undefined,
    user: Principal,
  ): Prisma.AttendanceCorrectionWhereInput {
    if (user.role === UserRole.EMPLOYEE) {
      if (!user.employeeId) {
        throw new ForbiddenException(
          'Your account is not linked to an employee record',
        );
      }
      // The principal's own id is ANDed with whatever was asked for. Naming
      // somebody else's therefore narrows the result to nothing; it can never
      // widen it to their queue.
      const clauses: Prisma.AttendanceCorrectionWhereInput[] = [
        { employeeId: user.employeeId },
      ];
      if (requested) clauses.push({ employeeId: requested });
      return { AND: clauses };
    }
    return requested ? { employeeId: requested } : {};
  }

  /**
   * The requested times have to belong to the day being corrected.
   *
   * Without this, a correction filed against one date can carry an instant from
   * any other — and approving it writes that instant straight onto the
   * attendance row. A check-in eight months before its check-out produces a
   * working day of several thousand hours, which is not a display glitch: it is
   * summed into the attendance report and, from there, into pay.
   *
   * The comparison is made in the employee's effective zone, because the
   * boundaries of "that day" are wall-clock boundaries where they work, not
   * where the server is. A check-OUT is allowed to land on the following day —
   * a night shift legitimately ends after midnight, and that is the one case
   * where the two timestamps honestly belong to different calendar dates.
   */
  private async assertTimesFallOnDate(
    employeeId: string,
    dayKey: string,
    checkIn: Date | null,
    checkOut: Date | null,
  ) {
    if (!checkIn && !checkOut) return;

    const [context, companyZone] = await Promise.all([
      this.calendar.employeeContext(employeeId),
      this.calendar.companyTimezone(),
    ]);
    const zone = resolveZone(context, context.branch, companyZone);

    const dayStart = DateTime.fromISO(dayKey, { zone }).startOf('day');
    if (!dayStart.isValid) {
      throw new BadRequestException(`${dayKey} is not a valid date`);
    }

    const inWindow = (value: Date, allowNextDay: boolean) => {
      const at = DateTime.fromJSDate(value, { zone });
      const end = dayStart.plus({ days: allowNextDay ? 2 : 1 });
      return at >= dayStart && at < end;
    };

    if (checkIn && !inWindow(checkIn, false)) {
      throw new BadRequestException(
        `The requested check-in is not on ${dayKey}`,
      );
    }
    if (checkOut && !inWindow(checkOut, true)) {
      throw new BadRequestException(
        `The requested check-out is not on ${dayKey} or the morning after`,
      );
    }
  }
}
