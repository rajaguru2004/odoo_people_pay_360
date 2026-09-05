/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  VERIFICATION_MODE,
  VerificationPurpose,
  resolveVerificationMode,
} from '../common/verification/verification.types';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { MailService } from '../mail/mail.service';
import { HolidaysService } from '../holidays/holidays.service';
import { haversineDistanceMeters } from '../common/utils/geo.util';
import { managerDeptScope } from '../common/services/manager-scope.util';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { DateTime } from 'luxon';

export interface CheckInCoords {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

export interface UserPayload {
  role: string;
  departmentId?: string;
  employeeId?: string;
}

export interface AttendanceSession {
  checkIn: Date | string;
  checkOut?: Date | string | null;
  type?: string;
  reminderSent?: boolean;
}

@Injectable()
export class AttendancesService {

  /**
   * Is face verification already satisfied by the channel the request came
   * through?
   *
   * Face-only exists to answer one question: "is this really that employee?"
   * A linked WhatsApp or Discord identity answers the same question by a
   * different route — the account was proved by a one-time code that had to
   * cross an authenticated web session AND the account itself, so neither side
   * alone could have produced it. Treating that as equivalent is a policy
   * choice, so it is a per-channel setting rather than a hardcoded exemption,
   * and it fails closed when the setting is absent.
   *
   * Unchanged in the one way that matters: the CHANNEL comes from
   * AsyncLocalStorage, which the runtime sets. There is still no parameter for
   * it and no tool argument that reaches it. `purpose` IS a parameter, but
   * every value of it is one of four literals written at the enforcement sites
   * in this file, so a caller cannot reach that either.
   *
   * The verification enum NARROWS this rather than widening it. Only
   * IDENTITY_ONLY returns true; SELFIE_IN_CHAT and SECURE_LINK exempt nobody —
   * they arrive as `byFace: true` from a path that actually matched a face.
   */
  private async faceCheckSatisfiedByChannel(purpose: VerificationPurpose): Promise<boolean> {
    const mode = await resolveVerificationMode(
      (key, fallback) => this.settingsService.getSetting(key, fallback),
      purpose,
    );
    return mode === VERIFICATION_MODE.IDENTITY_ONLY;
  }
  // Work hours config (in minutes from midnight)
  private readonly LATE_THRESHOLD = 15; // 15 minutes grace period
  private readonly MIN_WORK_DURATION = 0.5; // Minimum 30 minutes to be valid
  private readonly LUNCH_BREAK_THRESHOLD = 4; // Deduct lunch only if worked > 4 hours

  private absentMarkedDate = '';
  private reportSentDate = '';

  constructor(
    private prisma: PrismaService,
    private settingsService: SystemSettingsService,
    private tzSvc: TimezoneService,
    private mailService: MailService,
    private holidaysService: HolidaysService,
  ) {}

  /**
   * Office hours in minutes past midnight, for the employee's own BRANCH.
   *
   * This used to read the global `office_start_time` / `office_end_time` and
   * nothing else, which meant `Branch.officeStartTime` and
   * `Branch.officeEndTime` were dead on the attendance path: a branch that
   * opened at 08:00 had its staff judged late against the company's 08:30, and
   * a branch closing at 16:00 never produced an early-leave. Two of the seven
   * per-branch configuration columns did nothing at all.
   *
   * `SystemSettingsService.getOfficeHours(branchId)` already implemented the
   * branch -> global -> default chain and had no callers. It does now.
   */
  private async getOfficeWorkingHours(branchId?: string | null): Promise<{
    start: number;
    end: number;
  }> {
    const { start: startStr, end: endStr } =
      await this.settingsService.getOfficeHours(branchId ?? undefined);

    const [startHour, startMin] = startStr.split(':').map(Number);
    const [endHour, endMin] = endStr.split(':').map(Number);

    return {
      start:
        (isNaN(startHour) ? 8 : startHour) * 60 +
        (isNaN(startMin) ? 30 : startMin),
      end: (isNaN(endHour) ? 17 : endHour) * 60 + (isNaN(endMin) ? 30 : endMin),
    };
  }

  /**
   * Attendance day-end boundary in minutes past midnight, from the
   * attendance_day_end_time setting (HH:MM, default 23:59). Noon rule:
   * values before 12:00 mean early morning of the NEXT calendar day.
   */
  private async getDayEndBoundaryMinutes(): Promise<number> {
    const raw = await this.settingsService.getSetting(
      'attendance_day_end_time',
      '23:59',
    );
    return this.tzSvc.parseTimeHHMM(raw, 23 * 60 + 59);
  }

  /**
   * The UTC instant at which the attendance day `dateKey` closes for this
   * employee: their effective timezone plus the configured boundary, noon rule
   * applied (a boundary before 12:00 closes the day the NEXT morning).
   *
   * Single source of truth for "how far can this day be worked", shared by the
   * auto-checkout cron, manual entry, provider sync and the ESS check-out.
   */
  private async getAttendanceDayEnd(
    dateKey: Date,
    employeeTimezone?: string | null,
  ): Promise<Date> {
    const tz = await this.tzSvc.getEffectiveTZ(employeeTimezone);
    const boundary = await this.getDayEndBoundaryMinutes();
    // dateKey is a UTC-midnight key — read it in UTC so negative-offset zones
    // don't shift it a day back.
    const localDateStr = DateTime.fromJSDate(dateKey, {
      zone: 'utc',
    }).toISODate()!;
    return this.tzSvc.attendanceDayEndUTC(localDateStr, tz, boundary);
  }

  /**
   * Trim every session to the attendance day's closing instant. Hours worked
   * past the boundary belong to no attendance day and are never paid; a session
   * that starts after the boundary collapses to zero length instead of being
   * dropped, so the punch history stays auditable.
   */
  private clampSessionsToDayEnd(
    sessions: AttendanceSession[],
    dayEnd: Date,
  ): AttendanceSession[] {
    const limit = dayEnd.getTime();
    return sessions.map((s) => {
      if (!s.checkOut) return s;
      const start = new Date(s.checkIn).getTime();
      const end = new Date(s.checkOut).getTime();
      if (end <= limit) return s;
      return { ...s, checkOut: new Date(Math.max(start, limit)) };
    });
  }

  /** Clamp a single closing instant to the day boundary (never before its own start). */
  private clampToDayEnd(
    checkOut: Date,
    checkIn: Date | null,
    dayEnd: Date,
  ): Date {
    if (checkOut.getTime() <= dayEnd.getTime()) return checkOut;
    return new Date(
      Math.max(checkIn?.getTime() ?? dayEnd.getTime(), dayEnd.getTime()),
    );
  }

  /** Public: the module hub needs the same "has today closed yet" answer. */
  async hasDayEndBoundaryPassed(dateKey: Date): Promise<boolean> {
    const companyTZ = await this.tzSvc.getCompanyTZ();
    const boundary = await this.getDayEndBoundaryMinutes();
    const now = new Date();

    const targetYear = dateKey.getUTCFullYear();
    const targetMonth = dateKey.getUTCMonth() + 1;
    const targetDate = dateKey.getUTCDate();

    let boundaryYear = targetYear;
    let boundaryMonth = targetMonth;
    let boundaryDate = targetDate;

    if (boundary < 12 * 60) {
      const nextDay = new Date(Date.UTC(targetYear, targetMonth - 1, targetDate + 1));
      boundaryYear = nextDay.getUTCFullYear();
      boundaryMonth = nextDay.getUTCMonth() + 1;
      boundaryDate = nextDay.getUTCDate();
    }

    const boundaryHour = Math.floor(boundary / 60);
    const boundaryMinute = boundary % 60;
    const boundaryLocalStr = `${boundaryYear}-${String(boundaryMonth).padStart(2, '0')}-${String(boundaryDate).padStart(2, '0')}T${String(boundaryHour).padStart(2, '0')}:${String(boundaryMinute).padStart(2, '0')}:00`;
    const boundaryInstant = DateTime.fromISO(boundaryLocalStr, { zone: companyTZ }).toJSDate();

    return now.getTime() >= boundaryInstant.getTime();
  }

  /**
   * Build a stable date key for @db.Date columns, honoring the configurable
   * day-end boundary: events before the boundary (e.g. 00:30 with a 01:00
   * boundary) belong to the PREVIOUS attendance day.
   * Uses the employee's effective IANA timezone so remote workers get their
   * own day boundary (Workday/SAP model).
   */
  private async toAttendanceDateKey(
    date: Date = new Date(),
    employeeTimezone?: string | null,
  ): Promise<Date> {
    const tz = await this.tzSvc.getEffectiveTZ(employeeTimezone);
    const boundary = await this.getDayEndBoundaryMinutes();
    return this.tzSvc.toAttendanceDateKey(date, tz, boundary);
  }

  /**
   * Check if time is within normal work hours (6 AM - 11 PM) in the company timezone.
   */
  private async isReasonableWorkTime(date: Date): Promise<boolean> {
    const tz = await this.tzSvc.getCompanyTZ();
    return this.tzSvc.isReasonableWorkTime(date, tz);
  }

  /**
   * Calculate if check-in is late (uses company TZ — business rule).
   */
  private async calculateIsLate(
    checkInTime: Date,
    workStart: number,
  ): Promise<boolean> {
    const tz = await this.tzSvc.getCompanyTZ();
    if (!this.tzSvc.isReasonableWorkTime(checkInTime, tz)) return false;
    return (
      this.tzSvc.localMinutesOfDay(checkInTime, tz) >
      workStart + this.LATE_THRESHOLD
    );
  }

  /**
   * Calculate if check-out is early (uses company TZ — business rule).
   */
  private async calculateIsEarlyLeave(
    checkOutTime: Date,
    checkInTime: Date,
    workEnd: number,
  ): Promise<boolean> {
    const tz = await this.tzSvc.getCompanyTZ();
    if (!this.tzSvc.isReasonableWorkTime(checkOutTime, tz)) return false;
    const durationHours =
      (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60);
    if (durationHours < 4) return true;
    return this.tzSvc.localMinutesOfDay(checkOutTime, tz) < workEnd;
  }

  /**
   * How many hours to deduct for the company lunch break, per the admin-set
   * policy (`lunch_break_start` + `lunch_break_duration_minutes`). Returns 0
   * when no deduction applies:
   * - flexible shifts (employees self-manage breaks via sessions)
   * - deduction disabled (duration 0)
   * - the first check-in of the day is at/after the lunch start time
   *   (afternoon/evening shifts never take the company lunch break)
   */
  private async getLunchDeductionHours(
    firstCheckIn: Date | string | null | undefined,
    isFlexible: boolean,
  ): Promise<number> {
    if (isFlexible) return 0;

    const policy = await this.settingsService.getLunchBreakPolicy();
    if (policy.durationMinutes <= 0) return 0;

    if (firstCheckIn) {
      const tz = await this.tzSvc.getCompanyTZ();
      const checkInMinutes = this.tzSvc.localMinutesOfDay(
        new Date(firstCheckIn),
        tz,
      );
      if (checkInMinutes >= policy.startMinutes) return 0;
    }

    return policy.durationMinutes / 60;
  }

  /**
   * Calculate work hours between check-in and check-out
   * Handles overnight shifts and deducts lunch break
   */
  private calculateWorkHours(
    checkInTime: Date,
    checkOutTime: Date,
    lunchDeductionHours = 0,
  ): number {
    // Calculate raw duration in hours
    let durationMs = checkOutTime.getTime() - checkInTime.getTime();

    // If negative, it means check-out is on the next day
    if (durationMs < 0) {
      // Add 24 hours
      durationMs += 24 * 60 * 60 * 1000;
    }

    let workHours = durationMs / (1000 * 60 * 60);

    // Validate reasonable work hours (max 24 hours)
    if (workHours > 24) {
      console.warn(
        `Unreasonable work hours detected: ${workHours}h. Capping at 24h.`,
      );
      workHours = 24;
    }

    // Deduct the configured lunch break if worked more than threshold.
    // Callers compute lunchDeductionHours via getLunchDeductionHours (0 = skip).
    if (lunchDeductionHours > 0 && workHours > this.LUNCH_BREAK_THRESHOLD) {
      workHours -= lunchDeductionHours;
    }

    // Ensure non-negative
    return Math.max(0, workHours);
  }

  /**
   * Sum worked hours across all non-LUNCH sessions. For fixed shifts, the
   * configured lunch deduction (see getLunchDeductionHours) is applied when the
   * total exceeds the threshold — unless the day contains an explicit LUNCH
   * session, whose time is already excluded from the sum. For flexible shifts
   * (lunchDeductionHours=0) the raw session sum is used, since the employee
   * already accounts for breaks by checking out between sessions.
   */
  private sumSessionHours(
    sessions: AttendanceSession[],
    lunchDeductionHours = 0,
  ): number {
    let totalWorkHours = 0;
    for (const session of sessions) {
      if (session.type === 'LUNCH') continue;
      if (session.checkIn && session.checkOut) {
        const start = new Date(session.checkIn);
        const end = new Date(session.checkOut);
        totalWorkHours += (end.getTime() - start.getTime()) / (1000 * 60 * 60);
      }
    }

    const hasExplicitLunch = sessions.some((s) => s.type === 'LUNCH');
    if (
      lunchDeductionHours > 0 &&
      !hasExplicitLunch &&
      totalWorkHours > this.LUNCH_BREAK_THRESHOLD
    ) {
      totalWorkHours -= lunchDeductionHours;
    }

    return Math.max(0, totalWorkHours);
  }

  async checkIn(
    employeeId: string,
    byFace = false,
    coords?: CheckInCoords,
    skipGeofence = false,
  ) {
    const isFaceOnly =
      (await this.settingsService.getSetting(
        'attendance_face_only',
        'false',
      )) === 'true';

    if (isFaceOnly && !byFace && !(await this.faceCheckSatisfiedByChannel('CHECKIN'))) {
      throw new BadRequestException(
        'Attendance can only be registered using face verification.',
      );
    }

    // An account with no linked employee record reaches here with
    // `employeeId === undefined`, and `findUnique({ where: { id: undefined } })`
    // is a Prisma error, not an empty result — so the caller used to get a 500
    // carrying driver text. ADMIN accounts are routinely unlinked.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record.',
      );
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    if (!skipGeofence) {
      // Per-branch geofence: validate against the employee's own branch office.
      const geofencePolicy = await this.settingsService.getGeofencingPolicy(
        employee.branchId ?? undefined,
      );
      if (geofencePolicy.enabled) {
        if (geofencePolicy.officeLat === null || geofencePolicy.officeLng === null) {
          throw new BadRequestException(
            'Geofencing is enabled but office location has not been configured. Contact HR/Admin.',
          );
        }
        if (coords?.latitude === undefined || coords?.longitude === undefined) {
          throw new BadRequestException(
            'Location access is required to check in. Please enable location permissions and try again.',
          );
        }
        const distance = haversineDistanceMeters(
          coords.latitude,
          coords.longitude,
          geofencePolicy.officeLat,
          geofencePolicy.officeLng,
        );
        if (distance > geofencePolicy.radiusMeters) {
          throw new ForbiddenException(
            `You are out of office range (${Math.round(distance)}m away, allowed ${geofencePolicy.radiusMeters}m). Check-in denied.`,
          );
        }
      }
    }

    const now = new Date();
    const today = await this.toAttendanceDateKey(now, employee.timezone);

    // The attendance day this punch falls in may already be closed (boundaries
    // from 12:00 onward close the day before local midnight). Recording the
    // session anyway is worthless — the auto-checkout cron immediately closes it
    // at its own start instant for zero hours — so reject it with a reason
    // instead of silently logging an empty session.
    const dayEnd = await this.getAttendanceDayEnd(today, employee.timezone);
    if (now.getTime() >= dayEnd.getTime()) {
      const boundaryStr = await this.settingsService.getSetting(
        'attendance_day_end_time',
        '23:59',
      );
      throw new BadRequestException(
        `The attendance day has already closed (day end ${boundaryStr}). Check-in reopens when the next attendance day starts.`,
      );
    }

    const globalAllowMultiple =
      (await this.settingsService.getSetting(
        'allow_multiple_checkin',
        'false',
      )) === 'true';

    // Check if already checked in today
    const existing = await this.prisma.attendance.findFirst({
      where: {
        employeeId,
        date: today,
      },
    });

    // Fetch today's scheduled shift (if any)
    const schedule = await this.prisma.workSchedule.findFirst({
      where: {
        employeeId,
        date: today,
        isWorkDay: true,
      },
    });

    // Flexible shifts always permit multiple sessions and have no late/early
    // concept (the employee works `requiredHours` across any sessions).
    const isFlexible = schedule?.shiftType === 'FLEXIBLE';
    const allowMultiple = isFlexible || globalAllowMultiple;

    const { start: workStart } = await this.getOfficeWorkingHours(
      employee.branchId,
    );
    let isLate = false;
    let isEarlyCheckIn = false;

    if (schedule && !isFlexible && schedule.startTime) {
      const checkInTimeMs = now.getTime();
      const startTimeMs = new Date(schedule.startTime).getTime();
      isEarlyCheckIn = checkInTimeMs < startTimeMs;
      const lateThresholdMs = startTimeMs + this.LATE_THRESHOLD * 60 * 1000;
      isLate = checkInTimeMs > lateThresholdMs;
    } else if (!isFlexible) {
      isLate = await this.calculateIsLate(now, workStart);
      const companyTZ = await this.tzSvc.getCompanyTZ();
      const totalMinutes = this.tzSvc.localMinutesOfDay(now, companyTZ);
      if (this.tzSvc.isReasonableWorkTime(now, companyTZ)) {
        isEarlyCheckIn = totalMinutes < workStart;
      }
    }

    if (existing) {
      if (!allowMultiple) {
        if (existing.checkIn) {
          throw new BadRequestException('You have already checked in today');
        }

        // Update existing record (it exists but without checkIn, e.g. from cron)
        const sessions = [{ checkIn: now, checkOut: null }];
        const attendance = await this.prisma.attendance.update({
          where: { id: existing.id },
          data: {
            checkIn: now,
            isLate,
            isEarlyCheckIn,
            status: 'PRESENT',
            notes: isLate ? 'Late' : isEarlyCheckIn ? 'Early' : null,
            sessions,
            checkInLatitude: coords?.latitude ?? null,
            checkInLongitude: coords?.longitude ?? null,
            checkInAccuracy: coords?.accuracy ?? null,
          },
        });

        return {
          success: true,
          message: isLate
            ? 'Checked in successfully (Late)'
            : isEarlyCheckIn
              ? 'Checked in successfully (Early)'
              : 'Checked in successfully',
          data: {
            ...attendance,
            allowMultiple,
            isLate,
            isEarlyCheckIn,
            checkInTime: now.toLocaleTimeString('en-US'),
          },
        };
      } else {
        // Parse sessions
        let sessions: AttendanceSession[] = [];
        if (existing.sessions) {
          sessions = existing.sessions as unknown as AttendanceSession[];
        } else if (existing.checkIn) {
          sessions = [
            { checkIn: existing.checkIn, checkOut: existing.checkOut },
          ];
        }

        const activeSession = sessions.find((s) => !s.checkOut);
        if (activeSession) {
          throw new BadRequestException('You are already checked in');
        }

        // Add new session
        sessions.push({ checkIn: now, checkOut: null });

        // Update existing attendance
        const attendance = await this.prisma.attendance.update({
          where: { id: existing.id },
          data: {
            checkIn: existing.checkIn || now,
            checkOut: null, // Clear checkout to show currently checked in
            sessions: sessions as unknown as Prisma.InputJsonValue,
            status: 'PRESENT',
            isLate: existing.checkIn ? existing.isLate : isLate,
            isEarlyCheckIn: existing.checkIn ? existing.isEarlyCheckIn : isEarlyCheckIn,
            notes: existing.checkIn ? existing.notes : (isLate ? 'Late' : isEarlyCheckIn ? 'Early' : null),
            checkInLatitude: coords?.latitude ?? null,
            checkInLongitude: coords?.longitude ?? null,
            checkInAccuracy: coords?.accuracy ?? null,
          },
        });

        return {
          success: true,
          message: isLate
            ? 'Checked in successfully (Late)'
            : isEarlyCheckIn
              ? 'Checked in successfully (Early)'
              : 'Checked in successfully',
          data: {
            ...attendance,
            allowMultiple,
            isLate: attendance.isLate,
            isEarlyCheckIn: attendance.isEarlyCheckIn,
            checkInTime: now.toLocaleTimeString('en-US'),
          },
        };
      }
    }

    const sessions = [{ checkIn: now, checkOut: null }];

    const attendance = await this.prisma.attendance.create({
      data: {
        employeeId,
        // Denormalize the branch where this check-in happened (stays put on transfer).
        branchId: employee.branchId ?? undefined,
        date: today,
        checkIn: now,
        isLate,
        isEarlyCheckIn,
        status: 'PRESENT',
        notes: isLate ? 'Late' : isEarlyCheckIn ? 'Early' : null,
        source: 'ESS',
        sessions,
        checkInLatitude: coords?.latitude ?? null,
        checkInLongitude: coords?.longitude ?? null,
        checkInAccuracy: coords?.accuracy ?? null,
      },
    });

    return {
      success: true,
      message: isLate
        ? 'Checked in successfully (Late)'
        : isEarlyCheckIn
          ? 'Checked in successfully (Early)'
          : 'Checked in successfully',
      data: {
        ...attendance,
        allowMultiple,
        isLate,
        isEarlyCheckIn,
        checkInTime: now.toLocaleTimeString('en-US'),
      },
    };
  }

  async checkOut(employeeId: string, byFace = false, coords?: CheckInCoords) {
    const isFaceOnly =
      (await this.settingsService.getSetting(
        'attendance_face_only',
        'false',
      )) === 'true';

    if (isFaceOnly && !byFace && !(await this.faceCheckSatisfiedByChannel('CHECKOUT'))) {
      throw new BadRequestException(
        'Attendance can only be registered using face verification.',
      );
    }

    // An account with no linked employee record reaches here with
    // `employeeId === undefined`, and `findUnique({ where: { id: undefined } })`
    // is a Prisma error, not an empty result — so the caller used to get a 500
    // carrying driver text. ADMIN accounts are routinely unlinked.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record.',
      );
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Geofence, validated WHEN COORDINATES ARE PROVIDED — deliberately weaker
    // than check-in, which demands them. The web checkout has never sent a
    // position and hard-requiring one here would break every geofenced branch's
    // portal overnight. The chat flow closes the gap from its own side: the
    // verification link's token row carries requireLocation, the page always
    // collects a fix, and the tool always passes it — so a checkout that came
    // through a chat channel is genuinely range-checked, and one from the
    // signed-in portal behaves exactly as it always has.
    if (coords?.latitude !== undefined && coords?.longitude !== undefined) {
      const geofencePolicy = await this.settingsService.getGeofencingPolicy(
        employee.branchId ?? undefined,
      );
      if (
        geofencePolicy.enabled &&
        geofencePolicy.officeLat !== null &&
        geofencePolicy.officeLng !== null
      ) {
        const distance = haversineDistanceMeters(
          coords.latitude,
          coords.longitude,
          geofencePolicy.officeLat,
          geofencePolicy.officeLng,
        );
        if (distance > geofencePolicy.radiusMeters) {
          throw new ForbiddenException(
            `You are out of office range (${Math.round(distance)}m away, allowed ${geofencePolicy.radiusMeters}m). Check-out denied.`,
          );
        }
      }
    }

    let now = new Date();
    const today = await this.toAttendanceDateKey(now, employee.timezone);

    const attendance = await this.prisma.attendance.findFirst({
      where: {
        employeeId,
        date: today,
      },
    });

    if (!attendance) {
      throw new BadRequestException('You have not checked in today');
    }

    const globalAllowMultiple =
      (await this.settingsService.getSetting(
        'allow_multiple_checkin',
        'false',
      )) === 'true';

    let sessions: AttendanceSession[] = [];
    if (attendance.sessions) {
      sessions = attendance.sessions as unknown as AttendanceSession[];
    } else if (attendance.checkIn) {
      sessions = [
        { checkIn: attendance.checkIn, checkOut: attendance.checkOut },
      ];
    } else {
      throw new BadRequestException(
        'You have not checked in, cannot check out',
      );
    }

    const activeSessionIndex = sessions.findIndex((s) => !s.checkOut);
    if (activeSessionIndex === -1) {
      throw new BadRequestException('You have already checked out today');
    }

    now = new Date();

    // An attendance day never extends past its configured boundary. Normally the
    // auto-checkout cron closes the session there first; if it didn't (downtime,
    // restart, paused scheduler) trim the closing punch to the boundary rather
    // than paying hours that fall outside the day.
    const dayEnd = await this.getAttendanceDayEnd(today, employee.timezone);
    const activeStart = new Date(sessions[activeSessionIndex].checkIn);
    const clampedByBoundary = now.getTime() > dayEnd.getTime();
    const effectiveCheckOut = this.clampToDayEnd(now, activeStart, dayEnd);

    sessions[activeSessionIndex].checkOut = effectiveCheckOut;
    sessions = this.clampSessionsToDayEnd(sessions, dayEnd);

    // Fetch today's scheduled shift (if any)
    const schedule = await this.prisma.workSchedule.findFirst({
      where: {
        employeeId,
        date: today,
        isWorkDay: true,
      },
    });

    // Flexible shifts always permit multiple sessions, skip the auto lunch
    // deduction (breaks are self-managed via sessions), and have no late/early.
    const isFlexible = schedule?.shiftType === 'FLEXIBLE';
    const allowMultiple = isFlexible || globalAllowMultiple;

    // Total work hours across all sessions
    const lunchDeduction = await this.getLunchDeductionHours(
      attendance.checkIn ?? sessions[0]?.checkIn,
      isFlexible,
    );
    const totalWorkHours = this.sumSessionHours(sessions, lunchDeduction);

    const { end: workEnd } = await this.getOfficeWorkingHours(
      employee.branchId,
    );
    let isEarlyLeave = false;
    let isLateCheckout = false;

    if (schedule && !isFlexible && schedule.endTime) {
      const checkOutTimeMs = effectiveCheckOut.getTime();
      const endTimeMs = new Date(schedule.endTime).getTime();
      isEarlyLeave = checkOutTimeMs < endTimeMs;
      isLateCheckout = checkOutTimeMs > endTimeMs;
    } else if (!isFlexible) {
      const companyTZ = await this.tzSvc.getCompanyTZ();
      // Anchor office end to the attendance day as a full instant so an
      // after-midnight checkout (next calendar day) still reads as late,
      // not early.
      const recordDateStr = DateTime.fromJSDate(attendance.date, {
        zone: 'utc',
      }).toISODate()!;
      const officeEndUTC = this.tzSvc.buildUTCFromLocal(
        recordDateStr,
        Math.floor(workEnd / 60),
        workEnd % 60,
        companyTZ,
      );
      isEarlyLeave =
        this.tzSvc.isReasonableWorkTime(effectiveCheckOut, companyTZ) &&
        effectiveCheckOut.getTime() < officeEndUTC.getTime();
      isLateCheckout = effectiveCheckOut.getTime() >= officeEndUTC.getTime();
    }

    const boundaryNote = clampedByBoundary
      ? `Check-out trimmed to the attendance day end (${DateTime.fromJSDate(
          effectiveCheckOut,
        )
          .setZone(await this.tzSvc.getEffectiveTZ(employee.timezone))
          .toFormat('HH:mm')})`
      : null;

    const updated = await this.prisma.attendance.update({
      where: { id: attendance.id },
      data: {
        checkIn:
          attendance.checkIn || sessions[0]?.checkIn || effectiveCheckOut,
        checkOut: effectiveCheckOut,
        isEarlyLeave,
        isLateCheckout,
        workHours: Math.round(totalWorkHours * 100) / 100,
        sessions: sessions as unknown as Prisma.InputJsonValue,
        ...(boundaryNote
          ? {
              notes: attendance.notes
                ? `${attendance.notes} (${boundaryNote})`
                : boundaryNote,
            }
          : {}),
      },
    });

    return {
      success: true,
      message: isEarlyLeave
        ? 'Checked out successfully (Early Leave)'
        : isLateCheckout
          ? 'Checked out successfully (Late Departure)'
          : 'Checked out successfully',
      data: {
        ...updated,
        allowMultiple,
        isLateCheckout,
        clampedByBoundary,
        checkOutTime: effectiveCheckOut.toLocaleTimeString('en-US'),
        workHours: Math.round(totalWorkHours * 100) / 100,
      },
    };
  }

  async getTodayAttendance(employeeId: string) {
    // Use employee's own TZ for their "today" boundary (remote worker support)
    // An account with no linked employee record reaches here with
    // `employeeId === undefined`, and `findUnique({ where: { id: undefined } })`
    // is a Prisma error, not an empty result — so the caller used to get a 500
    // carrying driver text. ADMIN accounts are routinely unlinked.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record.',
      );
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { timezone: true },
    });
    const today = await this.toAttendanceDateKey(new Date(), employee?.timezone);

    const attendance = await this.prisma.attendance.findFirst({
      where: {
        employeeId,
        date: today,
      },
    });

    const globalAllowMultiple =
      (await this.settingsService.getSetting(
        'allow_multiple_checkin',
        'false',
      )) === 'true';

    // Reported to the client so it knows whether to open the camera. Must agree
    // with the write-side guard, or a WhatsApp reply would tell the employee
    // face verification is required when it is not.
    const attendanceFaceOnly =
      (await this.settingsService.getSetting('attendance_face_only', 'false')) === 'true' &&
      !(await this.faceCheckSatisfiedByChannel('CHECKIN'));

    // Today's scheduled shift drives flexible behaviour (target hours + always
    // multi-session) so the client can render a progress bar toward the target.
    const schedule = await this.prisma.workSchedule.findFirst({
      where: { employeeId, date: today, isWorkDay: true },
    });
    const isFlexible = schedule?.shiftType === 'FLEXIBLE';
    const requiredHours =
      isFlexible && schedule?.requiredHours != null
        ? Number(schedule.requiredHours)
        : null;
    const allowMultiple = isFlexible || globalAllowMultiple;

    // Hours worked SO FAR, including the session still open. attendance.workHours
    // is only written on check-out, so reading it alone reports 0 progress for
    // the whole first session of the day to every non-browser consumer.
    const sessions =
      (attendance?.sessions as unknown as AttendanceSession[] | null) ?? [];
    let workedHours = Number(attendance?.workHours) || 0;
    if (sessions.length) {
      const dayEnd = await this.getAttendanceDayEnd(today, employee?.timezone);
      const nowInstant = new Date();
      const runningSessions = sessions.map((s) =>
        s.checkOut ? s : { ...s, checkOut: nowInstant },
      );
      workedHours = this.sumSessionHours(
        this.clampSessionsToDayEnd(runningSessions, dayEnd),
        await this.getLunchDeductionHours(
          attendance?.checkIn ?? sessions[0]?.checkIn,
          isFlexible,
        ),
      );
      workedHours = Math.round(workedHours * 100) / 100;
    }

    const targetMet =
      requiredHours != null ? workedHours >= requiredHours : false;
    const shortfallHours =
      requiredHours != null
        ? Math.round(Math.max(0, requiredHours - workedHours) * 100) / 100
        : null;

    const flexibleInfo = {
      isFlexible,
      requiredHours,
      targetMet,
      workedHours,
      shortfallHours,
    };

    return {
      success: true,
      data: attendance
        ? {
            ...attendance,
            allowMultiple,
            attendanceFaceOnly,
            ...flexibleInfo,
          }
        : {
            status: 'NOT_CHECKED_IN',
            allowMultiple,
            attendanceFaceOnly,
            ...flexibleInfo,
          },
    };
  }

  async getTodayAllAttendances() {
    // Admin view: use company TZ for "today" boundary
    const today = await this.toAttendanceDateKey(new Date(), null);

    const attendances = await this.prisma.attendance.findMany({
      where: {
        date: today,
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            department: {
              select: {
                name: true,
              },
            },
          },
        },
      },
      orderBy: { checkIn: 'asc' },
    });

    return {
      success: true,
      data: attendances,
    };
  }

  async getEmployeeAttendances(
    employeeId: string,
    month?: number,
    year?: number,
  ) {
    // An account with no linked employee record reaches here with
    // `employeeId === undefined`, and `findUnique({ where: { id: undefined } })`
    // is a Prisma error, not an empty result — so the caller used to get a 500
    // carrying driver text. ADMIN accounts are routinely unlinked.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record.',
      );
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const now = new Date();
    const targetMonth = month || now.getMonth() + 1;
    const targetYear = year || now.getFullYear();

    const startDate = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
    const endDate = new Date(Date.UTC(targetYear, targetMonth, 0));

    const attendances = await this.prisma.attendance.findMany({
      where: {
        employeeId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { date: 'asc' },
    });

    // Flexible days carry an hours TARGET instead of a shift window, so the
    // record alone can't say whether the day was actually completed. Join the
    // month's flexible schedules and expose target/shortfall per day.
    const flexSchedules = await this.prisma.workSchedule.findMany({
      where: {
        employeeId,
        date: { gte: startDate, lte: endDate },
        isWorkDay: true,
        shiftType: 'FLEXIBLE',
      },
      select: { date: true, requiredHours: true },
    });
    const dayKey = (d: Date) =>
      DateTime.fromJSDate(d, { zone: 'utc' }).toISODate()!;
    const flexByDay = new Map(
      flexSchedules.map((s) => [
        dayKey(s.date),
        s.requiredHours != null ? Number(s.requiredHours) : null,
      ]),
    );

    let flexibleShortfallHours = 0;
    let flexibleDaysBelowTarget = 0;
    const data = attendances.map((a) => {
      const key = dayKey(a.date);
      if (!flexByDay.has(key)) return a;
      const requiredHours = flexByDay.get(key) ?? null;
      const worked = Number(a.workHours) || 0;
      const shortfallHours =
        requiredHours != null && a.status === 'PRESENT'
          ? Math.round(Math.max(0, requiredHours - worked) * 100) / 100
          : null;
      if (shortfallHours) {
        flexibleShortfallHours += shortfallHours;
        flexibleDaysBelowTarget++;
      }
      return {
        ...a,
        isFlexible: true,
        requiredHours,
        shortfallHours,
        targetMet: requiredHours != null ? worked >= requiredHours : null,
      };
    });

    // Calculate summary
    const summary = {
      totalDays: attendances.length,
      presentDays: attendances.filter((a) => a.status === 'PRESENT').length,
      lateDays: attendances.filter((a) => a.isLate).length,
      earlyLeaveDays: attendances.filter((a) => a.isEarlyLeave).length,
      earlyCheckInDays: attendances.filter((a) => a.isEarlyCheckIn).length,
      lateCheckoutDays: attendances.filter((a) => a.isLateCheckout).length,
      totalWorkHours: attendances.reduce(
        (sum, a) => sum + (Number(a.workHours) || 0),
        0,
      ),
      flexibleDays: flexByDay.size,
      flexibleDaysBelowTarget,
      flexibleShortfallHours: Math.round(flexibleShortfallHours * 100) / 100,
    };

    return {
      success: true,
      data,
      summary,
      meta: { month: targetMonth, year: targetYear },
    };
  }

  async getMonthlyReport(month: number, year: number) {
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    const attendances = await this.prisma.attendance.findMany({
      where: {
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
    });

    // Group by employee
    const byEmployee = new Map<string, any>();
    attendances.forEach((att) => {
      const empId = att.employeeId;
      if (!byEmployee.has(empId)) {
        byEmployee.set(empId, {
          employee: att.employee,
          attendances: [],
          summary: {
            present: 0,
            late: 0,
            earlyLeave: 0,
            earlyCheckIn: 0,
            lateCheckout: 0,
            totalHours: 0,
          },
        });
      }
      const emp = byEmployee.get(empId);
      emp.attendances.push(att);
      if (att.status === 'PRESENT') emp.summary.present++;
      if (att.isLate) emp.summary.late++;
      if (att.isEarlyLeave) emp.summary.earlyLeave++;
      if (att.isEarlyCheckIn) emp.summary.earlyCheckIn++;
      if (att.isLateCheckout) emp.summary.lateCheckout++;
      emp.summary.totalHours += Number(att.workHours) || 0;
    });

    return {
      success: true,
      data: Array.from(byEmployee.values()),
      meta: { month, year, totalRecords: attendances.length },
    };
  }

  async getStatistics(month?: number, year?: number) {
    const now = new Date();
    const targetMonth = month || now.getMonth() + 1;
    const targetYear = year || now.getFullYear();

    const startDate = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
    const endDate = new Date(Date.UTC(targetYear, targetMonth, 0));

    const [totalRecords, lateCount, earlyLeaveCount, avgWorkHours] =
      await Promise.all([
        this.prisma.attendance.count({
          where: { date: { gte: startDate, lte: endDate } },
        }),
        this.prisma.attendance.count({
          where: { date: { gte: startDate, lte: endDate }, isLate: true },
        }),
        this.prisma.attendance.count({
          where: { date: { gte: startDate, lte: endDate }, isEarlyLeave: true },
        }),
        this.prisma.attendance.aggregate({
          where: { date: { gte: startDate, lte: endDate } },
          _avg: { workHours: true },
        }),
      ]);

    return {
      success: true,
      data: {
        totalRecords,
        lateCount,
        earlyLeaveCount,
        lateRate:
          totalRecords > 0 ? Math.round((lateCount / totalRecords) * 100) : 0,
        earlyLeaveRate:
          totalRecords > 0
            ? Math.round((earlyLeaveCount / totalRecords) * 100)
            : 0,
        avgWorkHours:
          Math.round((Number(avgWorkHours._avg.workHours) || 0) * 100) / 100,
      },
      meta: { month: targetMonth, year: targetYear },
    };
  }

  async getAbsenteeismStats() {
    const now = new Date();
    const companyTZ = await this.tzSvc.getCompanyTZ();
    const today = this.tzSvc.toDateKey(now, companyTZ);

    // Calculate date ranges using company TZ
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - 6); // Last 7 days
    const startOfWeekKey = this.tzSvc.toDateKey(startOfWeek, companyTZ);

    const startOfMonth = this.tzSvc.toDateKey(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      companyTZ,
    );
    const endOfMonth = this.tzSvc.toDateKey(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
      companyTZ,
    );

    const startOfLastWeek = new Date(startOfWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
    const startOfLastWeekKey = this.tzSvc.toDateKey(startOfLastWeek, companyTZ);
    const endOfLastWeek = new Date(startOfWeek);
    endOfLastWeek.setDate(endOfLastWeek.getDate() - 1);
    const endOfLastWeekKey = this.tzSvc.toDateKey(endOfLastWeek, companyTZ);

    // Get total active employees
    const totalEmployees = await this.prisma.employee.count({
      where: { status: 'ACTIVE' },
    });

    // Today's stats
    const [todayAbsentRaw, todayLate, todayTotal] = await Promise.all([
      this.prisma.attendance.count({
        where: {
          date: today,
          status: 'ABSENT',
        },
      }),
      this.prisma.attendance.count({
        where: {
          date: today,
          isLate: true,
        },
      }),
      this.prisma.attendance.count({
        where: { date: today },
      }),
    ]);

    const boundaryPassed = await this.hasDayEndBoundaryPassed(today);
    const todayAbsent = boundaryPassed ? todayAbsentRaw : 0;

    // Week's stats (last 7 days)
    const weekAbsentWhere: any = {
      status: 'ABSENT',
    };
    if (!boundaryPassed) {
      weekAbsentWhere.date = { gte: startOfWeekKey, lt: today };
    } else {
      weekAbsentWhere.date = { gte: startOfWeekKey, lte: today };
    }

    const [weekAbsent, weekLate, weekTotal] = await Promise.all([
      this.prisma.attendance.count({
        where: weekAbsentWhere,
      }),
      this.prisma.attendance.count({
        where: {
          date: { gte: startOfWeekKey, lte: today },
          isLate: true,
        },
      }),
      this.prisma.attendance.count({
        where: {
          date: { gte: startOfWeekKey, lte: today },
        },
      }),
    ]);

    // Month's stats
    const monthAbsentWhere: any = {
      status: 'ABSENT',
    };
    if (!boundaryPassed && today >= startOfMonth && today <= endOfMonth) {
      monthAbsentWhere.date = { gte: startOfMonth, lt: today };
    } else {
      monthAbsentWhere.date = { gte: startOfMonth, lte: endOfMonth };
    }

    const [monthAbsent, monthLate, monthTotal] = await Promise.all([
      this.prisma.attendance.count({
        where: monthAbsentWhere,
      }),
      this.prisma.attendance.count({
        where: {
          date: { gte: startOfMonth, lte: endOfMonth },
          isLate: true,
        },
      }),
      this.prisma.attendance.count({
        where: {
          date: { gte: startOfMonth, lte: endOfMonth },
        },
      }),
    ]);

    // Last week's stats for trend calculation
    const [lastWeekAbsent, lastWeekTotal] = await Promise.all([
      this.prisma.attendance.count({
        where: {
          date: { gte: startOfLastWeekKey, lte: endOfLastWeekKey },
          status: 'ABSENT',
        },
      }),
      this.prisma.attendance.count({
        where: {
          date: { gte: startOfLastWeekKey, lte: endOfLastWeekKey },
        },
      }),
    ]);

    // Calculate rates
    const todayAbsentRate =
      todayTotal > 0 ? (todayAbsent / todayTotal) * 100 : 0;
    const todayLateRate = todayTotal > 0 ? (todayLate / todayTotal) * 100 : 0;

    const weekAbsentRate = weekTotal > 0 ? (weekAbsent / weekTotal) * 100 : 0;
    const lastWeekAbsentRate =
      lastWeekTotal > 0 ? (lastWeekAbsent / lastWeekTotal) * 100 : 0;

    // Calculate trend (negative = improvement)
    const trend =
      lastWeekAbsentRate > 0
        ? ((weekAbsentRate - lastWeekAbsentRate) / lastWeekAbsentRate) * 100
        : 0;

    return {
      success: true,
      data: {
        today: {
          absent: todayAbsent,
          late: todayLate,
          absentRate: Math.round(todayAbsentRate * 10) / 10,
          lateRate: Math.round(todayLateRate * 10) / 10,
        },
        week: {
          absent: weekAbsent,
          late: weekLate,
          absentRate: Math.round(weekAbsentRate * 10) / 10,
        },
        month: {
          absent: monthAbsent,
          late: monthLate,
          absentRate: Math.round((monthAbsent / monthTotal) * 100 * 10) / 10,
        },
        trend: Math.round(trend * 10) / 10, // % change vs last week
        totalEmployees,
      },
    };
  }

  /**
   * CRON JOB: Auto-checkout checked-in employees at the attendance day-end
   * boundary (attendance_day_end_time setting, default 23:59 local; values
   * before 12:00 mean early morning of the next calendar day).
   * Runs every minute to support multiple timezones.
   */
  @Cron('0 * * * * *', {
    name: 'auto-checkout-midnight',
  })
  async autoCheckoutMidnight() {
    const now = new Date();

    const strictMode =
      (await this.settingsService.getSetting(
        'strict_attendance_mode',
        'false',
      )) === 'true';

    const boundaryStr = await this.settingsService.getSetting(
      'attendance_day_end_time',
      '23:59',
    );
    const boundary = this.tzSvc.parseTimeHHMM(boundaryStr, 23 * 60 + 59);

    // Fetch active attendances that are checked in (checkOut is null). Bounded
    // to the recent past: a live record is closed within a minute of its
    // boundary, so anything older is stale data that re-scanning every minute
    // would never fix — and the unbounded scan grows with table size forever.
    const scanFrom = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const activeAttendances = await this.prisma.attendance.findMany({
      where: {
        checkOut: null,
        status: 'PRESENT',
        date: { gte: scanFrom },
      },
      include: {
        employee: {
          select: {
            id: true,
            timezone: true,
          },
        },
      },
    });

    for (const attendance of activeAttendances) {
      try {
        const tz = await this.tzSvc.getEffectiveTZ(
          attendance.employee.timezone,
        );
        // attendance.date is a UTC-midnight date key — slice it in UTC to get
        // the local calendar day it represents (toLocalDateStr would shift it
        // a day back in negative-UTC-offset timezones).
        const localDateStr = DateTime.fromJSDate(attendance.date, {
          zone: 'utc',
        }).toISODate()!;
        let autoCheckOutTime = this.tzSvc.attendanceDayEndUTC(
          localDateStr,
          tz,
          boundary,
        );

        // Auto-checkout if now is at or past the day-end boundary
        if (now.getTime() >= autoCheckOutTime.getTime()) {
          // The instant the day closes, before any clamp-to-check-in below.
          const dayEnd = autoCheckOutTime;

          let sessions: AttendanceSession[] = [];
          if (attendance.sessions) {
            sessions = attendance.sessions as unknown as AttendanceSession[];
          } else if (attendance.checkIn) {
            sessions = [
              { checkIn: attendance.checkIn, checkOut: attendance.checkOut },
            ];
          }

          // Shift lookup is shared by both modes: flexible days skip the auto
          // lunch deduction and have no late/early concept.
          const schedule = await this.prisma.workSchedule.findFirst({
            where: {
              employeeId: attendance.employeeId,
              date: attendance.date,
              isWorkDay: true,
            },
          });
          const isFlexible = schedule?.shiftType === 'FLEXIBLE';
          const lunchDeduction = await this.getLunchDeductionHours(
            attendance.checkIn ?? sessions[0]?.checkIn,
            isFlexible,
          );

          if (strictMode) {
            // Strict attendance: the session left open is not counted. Sessions
            // the employee DID close still are — a flexible day is several
            // sessions, and discarding a full day of closed punches because the
            // last punch-out was missed is data loss, not strictness.
            const closedSessions = this.clampSessionsToDayEnd(
              sessions.filter((s) => s.checkOut),
              dayEnd,
            );
            const countedHours = closedSessions.length
              ? this.sumSessionHours(closedSessions, lunchDeduction)
              : 0;
            const openCount = sessions.length - closedSessions.length;
            const strictNote =
              openCount > 0
                ? `Missed checkout — ${openCount} unclosed session${openCount > 1 ? 's' : ''} not counted (strict attendance)`
                : 'Missed checkout — hours not counted (strict attendance)';

            await this.prisma.attendance.update({
              where: { id: attendance.id },
              data: {
                status: 'MISSED_CHECKOUT',
                workHours: Math.round(countedHours * 100) / 100,
                // Sessions are left exactly as punched: the unclosed one stays
                // open so the record shows WHY the day was flagged.
                notes: attendance.notes
                  ? `${attendance.notes} (${strictNote})`
                  : strictNote,
              },
            });
            console.log(
              `[Cron] Strict mode: marked attendance ${attendance.id} as MISSED_CHECKOUT for employee ${attendance.employeeId} on ${localDateStr} (kept ${countedHours}h from ${closedSessions.length} closed session(s))`,
            );
          } else {
            const activeSessionIndex = sessions.findIndex((s) => !s.checkOut);
            if (activeSessionIndex !== -1) {
              const checkInDate = new Date(
                sessions[activeSessionIndex].checkIn,
              );
              if (autoCheckOutTime.getTime() < checkInDate.getTime()) {
                autoCheckOutTime = checkInDate;
              }

              sessions[activeSessionIndex].checkOut = autoCheckOutTime;
              sessions = this.clampSessionsToDayEnd(sessions, dayEnd);

              // Total work hours across all sessions.
              const totalWorkHours = this.sumSessionHours(
                sessions,
                lunchDeduction,
              );

              // The row's own denormalised branch: the branch the punch
              // actually happened in, which is what its early-leave flag should
              // be judged against even if the employee has since transferred.
              const { end: workEnd } = await this.getOfficeWorkingHours(
                attendance.branchId,
              );
              let isEarlyLeave = false;
              let isLateCheckout = false;

              if (schedule && !isFlexible && schedule.endTime) {
                const checkOutTimeMs = autoCheckOutTime.getTime();
                const endTimeMs = new Date(schedule.endTime).getTime();
                isEarlyLeave = checkOutTimeMs < endTimeMs;
                isLateCheckout = checkOutTimeMs > endTimeMs;
              } else if (!isFlexible) {
                const companyTZ = await this.tzSvc.getCompanyTZ();
                // Anchor office end to the attendance day as a full instant —
                // an after-midnight boundary close is a late checkout, not an
                // early leave.
                const officeEndUTC = this.tzSvc.buildUTCFromLocal(
                  localDateStr,
                  Math.floor(workEnd / 60),
                  workEnd % 60,
                  companyTZ,
                );
                isEarlyLeave =
                  this.tzSvc.isReasonableWorkTime(
                    autoCheckOutTime,
                    companyTZ,
                  ) && autoCheckOutTime.getTime() < officeEndUTC.getTime();
                isLateCheckout =
                  autoCheckOutTime.getTime() >= officeEndUTC.getTime();
              }

              await this.prisma.attendance.update({
                where: { id: attendance.id },
                data: {
                  checkOut: autoCheckOutTime,
                  isEarlyLeave,
                  isLateCheckout,
                  workHours: Math.round(totalWorkHours * 100) / 100,
                  sessions: sessions as unknown as Prisma.InputJsonValue,
                  notes: attendance.notes
                    ? `${attendance.notes} (Auto-checkout at day end (${boundaryStr}))`
                    : `Auto-checkout at day end (${boundaryStr})`,
                },
              });

              console.log(
                `[Cron] Auto-checked out employee ${attendance.employeeId} at day end (${boundaryStr} local) for date ${localDateStr}`,
              );
            }
          }
        }
      } catch (err) {
        console.error(
          `[Cron] Error auto-checking out attendance ${attendance.id}:`,
          err,
        );
      }
    }
  }

  /**
   * CRON JOB: Auto-mark absent employees
   * Runs every minute, fires at the attendance day-end boundary
   * (attendance_day_end_time setting). Marks employees ABSENT for the day
   * that just closed if they didn't check in and have no approved leave.
   */
  @Cron('0 * * * * *', {
    name: 'auto-mark-absent',
  })
  async autoMarkAbsent(isManual = false) {
    const companyTZ = await this.tzSvc.getCompanyTZ();
    const now = new Date();
    const boundary = await this.getDayEndBoundaryMinutes();

    if (!isManual) {
      const nowMins = this.tzSvc.localMinutesOfDay(now, companyTZ);
      // Widened window (not exact-minute match) so a missed tick or DST gap
      // still triggers; dedup below guarantees once per day.
      if (nowMins < boundary || nowMins >= boundary + 5) {
        return { success: true, message: 'Skipped (Not day-end boundary)' };
      }
    }

    // The day being settled: one minute before the boundary instant always
    // lies inside the closing day (today for same-day boundaries >= 12:00,
    // yesterday for after-midnight boundaries). Manual runs target the
    // currently open attendance day instead.
    const targetDay = isManual
      ? this.tzSvc.toAttendanceDateKey(now, companyTZ, boundary)
      : this.tzSvc.toAttendanceDateKey(
          new Date(now.getTime() - 10 * 60_000),
          companyTZ,
          boundary,
        );
    const targetDayStr = DateTime.fromJSDate(targetDay, {
      zone: 'utc',
    }).toISODate()!;

    const boundaryPassed = await this.hasDayEndBoundaryPassed(targetDay);
    if (!boundaryPassed) {
      console.log(
        `[Cron] Skipping target day ${targetDayStr} because its day-end boundary has not been reached yet.`,
      );
      return {
        success: true,
        message: `Skipped (Day-end boundary for ${targetDayStr} has not been reached yet)`,
      };
    }

    if (!isManual) {
      // Deduplication check
      if (this.absentMarkedDate === targetDayStr) {
        return { success: true, message: 'Skipped (Already marked today)' };
      }
      this.absentMarkedDate = targetDayStr;
    }

    // Whether targetDay is a working day for a given branch (its weekly-off days
    // + holidays honored). Memoized for this run. Branches can run different
    // working weeks, so this is decided per employee rather than skipping the
    // whole run when the day is off for one branch.
    const workingDayByBranch = new Map<string | null, boolean>();
    const isWorkingDayForBranch = async (
      branchId: string | null,
    ): Promise<boolean> => {
      const key = branchId ?? null;
      if (!workingDayByBranch.has(key)) {
        const dates = await this.holidaysService.getWorkingDatesBetween(
          targetDay,
          targetDay,
          branchId ?? undefined,
        );
        workingDayByBranch.set(key, dates.length > 0);
      }
      return workingDayByBranch.get(key)!;
    };

    console.log(`[Cron] Starting auto-absent marking for ${targetDayStr}`);

    // Get all active employees
    const activeEmployees = await this.prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        branchId: true,
        department: {
          select: { name: true },
        },
      },
    });

    const absentEmployees: any[] = [];
    const employeesWithLeave: any[] = [];

    for (const employee of activeEmployees) {
      // Skip employees whose branch treats the target day as a weekly-off day
      // or a (branch/company) holiday — they are never marked absent.
      if (!(await isWorkingDayForBranch(employee.branchId))) {
        continue;
      }

      // Check if attendance record exists
      const attendance = await this.prisma.attendance.findUnique({
        where: {
          unique_employee_date: {
            employeeId: employee.id,
            date: targetDay,
          },
        },
      });

      // If no attendance record
      if (!attendance) {
        // Check if employee has approved leave for the target day
        const leave = await this.prisma.leaveRequest.findFirst({
          where: {
            employeeId: employee.id,
            status: 'APPROVED',
            startDate: { lte: targetDay },
            endDate: { gte: targetDay },
          },
        });

        if (leave) {
          // Employee has approved leave - skip
          employeesWithLeave.push({
            ...employee,
            leaveType: leave.leaveType,
          });
        } else {
          // No leave - mark as absent
          await this.prisma.attendance.create({
            data: {
              employeeId: employee.id,
              date: targetDay,
              status: 'ABSENT',
              notes: 'Auto-marked absent (no check-in)',
              source: 'AUTO',
              // Stamp from the EMPLOYEE, never from the request context. The
              // middleware only fills `branchId` on a create when the caller
              // has an effective branch, so this cron wrote NULL for everyone
              // when triggered without a header — and, worse, wrote the
              // caller's chosen branch onto employees of every OTHER branch in
              // their envelope when triggered with one.
              branchId: employee.branchId ?? null,
            },
          });

          absentEmployees.push(employee);
        }
      }
    }

    console.log(
      `[Cron] Auto-marked ${absentEmployees.length} employees as absent`,
    );
    console.log(
      `[Cron] ${employeesWithLeave.length} employees on approved leave`,
    );
    console.log(
      `[Cron] ${activeEmployees.length - absentEmployees.length - employeesWithLeave.length} employees checked in`,
    );

    return {
      success: true,
      message: `Auto-marked ${absentEmployees.length} employees as absent`,
      data: {
        date: targetDay,
        totalActive: activeEmployees.length,
        markedAbsent: absentEmployees.length,
        onLeave: employeesWithLeave.length,
        checkedIn:
          activeEmployees.length -
          absentEmployees.length -
          employeesWithLeave.length,
        absentEmployees: absentEmployees.map((e) => ({
          id: e.id,
          code: e.employeeCode,
          name: e.fullName,
          department: e.department?.name,
        })),
      },
    };
  }

  /**
   * Validate attendance data for a month
   * Checks for missing days and incomplete records
   */
  async validateAttendanceData(month: number, year: number) {
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    // Get all active employees
    const employees = await this.prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
        startDate: { lte: endDate },
        OR: [{ endDate: null }, { endDate: { gte: startDate } }],
      },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        startDate: true,
        endDate: true,
        branchId: true,
        department: {
          select: { name: true },
        },
      },
    });

    const issues: any[] = [];

    for (const employee of employees) {
      // Calculate expected work days for this employee
      const empStartDate =
        employee.startDate > startDate ? employee.startDate : startDate;
      const empEndDate =
        employee.endDate && employee.endDate < endDate
          ? employee.endDate
          : endDate;

      const expectedDays = await this.calculateExpectedWorkDays(
        empStartDate,
        empEndDate,
        employee.branchId ?? undefined,
      );

      // Count attendance records
      const attendanceCount = await this.prisma.attendance.count({
        where: {
          employeeId: employee.id,
          date: { gte: empStartDate, lte: empEndDate },
        },
      });

      // Check for missing days
      if (attendanceCount < expectedDays) {
        issues.push({
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          employeeName: employee.fullName,
          department: employee.department?.name,
          expectedDays,
          actualDays: attendanceCount,
          missingDays: expectedDays - attendanceCount,
          severity: 'WARNING',
          type: 'MISSING_DAYS',
        });
      }

      // Check for incomplete records (check-in but no check-out)
      const incompleteRecords = await this.prisma.attendance.count({
        where: {
          employeeId: employee.id,
          date: { gte: empStartDate, lte: empEndDate },
          checkIn: { not: null },
          checkOut: null,
          status: 'PRESENT', // Only check PRESENT status
        },
      });

      if (incompleteRecords > 0) {
        issues.push({
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          employeeName: employee.fullName,
          department: employee.department?.name,
          incompleteRecords,
          severity: 'ERROR',
          type: 'INCOMPLETE_RECORDS',
        });
      }
    }

    return {
      success: true,
      data: {
        month,
        year,
        totalEmployees: employees.length,
        issuesFound: issues.length,
        issues: issues.sort((a, b) => {
          // Sort by severity (ERROR first, then WARNING)
          if (a.severity === 'ERROR' && b.severity === 'WARNING') return -1;
          if (a.severity === 'WARNING' && b.severity === 'ERROR') return 1;
          return 0;
        }),
      },
    };
  }

  async createManualAttendance(dto: any) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }
    // The subject here always comes from the request BODY, never from the
    // token, so this is one of the two doors that genuinely needs the explicit
    // guard: `findUnique` is not in BRANCH_READ_ACTIONS, so nothing else stops
    // a branch-scoped HR booking attendance into a branch they cannot see.
    assertInBranch(employee.branchId);

    // Parse date safely — use UTC directly to avoid server-timezone shifting the date
    const parts = dto.date.split('-');
    const dateKey = new Date(
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
      if (dateKey < startKey) {
        throw new BadRequestException(
          `Cannot record attendance before the employee's onboarding date (${startKey.toISOString().slice(0, 10)})`,
        );
      }
    }

    const tz = await this.tzSvc.getEffectiveTZ(employee.timezone);
    const dateStr = dto.date; // 'YYYY-MM-DD'

    let checkInDate: Date | null = null;
    if (dto.checkIn) {
      if (dto.checkIn.includes('T')) {
        // ISO timestamp — already a proper UTC instant, use as-is
        checkInDate = new Date(dto.checkIn);
      } else {
        // Plain HH:MM — interpret as local time on the given date
        const [hours, minutes] = dto.checkIn.split(':').map(Number);
        checkInDate = this.tzSvc.buildUTCFromLocal(dateStr, hours, minutes, tz);
      }
    }

    let checkOutDate: Date | null = null;
    if (dto.checkOut) {
      if (dto.checkOut.includes('T')) {
        // ISO timestamp — already a proper UTC instant, use as-is
        checkOutDate = new Date(dto.checkOut);
      } else {
        // Plain HH:MM — interpret as local time on the given date
        const [hours, minutes] = dto.checkOut.split(':').map(Number);
        checkOutDate = this.tzSvc.buildUTCFromLocal(
          dateStr,
          hours,
          minutes,
          tz,
        );
      }
    }

    // Overnight entry: a checkout clock time at/before the check-in is the next
    // morning, not a negative day. Rolling the date here (in the employee's own
    // zone, so DST is handled) keeps calculateWorkHours off its +24h fallback.
    if (
      checkInDate &&
      checkOutDate &&
      checkOutDate.getTime() <= checkInDate.getTime()
    ) {
      checkOutDate = DateTime.fromJSDate(checkOutDate)
        .setZone(tz)
        .plus({ days: 1 })
        .toJSDate();
    }

    // File the row under the attendance day the check-in really belongs to, the
    // same way an ESS punch is filed. With an after-midnight boundary a 00:30
    // entry belongs to the PREVIOUS day; keying it off the raw calendar date
    // would put the same punch on two different days depending on its source.
    const effectiveDateKey = checkInDate
      ? await this.toAttendanceDateKey(checkInDate, employee.timezone)
      : dateKey;

    const status = dto.status || 'PRESENT';

    const attendance = await this.buildAndUpsertAttendance({
      employeeId: dto.employeeId,
      branchId: employee.branchId,
      dateKey: effectiveDateKey,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      status,
      notes: dto.notes || 'Manually entered by admin',
      source: 'MANUAL',
      timezone: employee.timezone,
    });

    return {
      success: true,
      message: 'Attendance record saved successfully',
      data: attendance,
    };
  }

  /**
   * Derive every computed attendance field for a whole-day record and upsert it.
   *
   * Extracted verbatim from createManualAttendance so that admin-entered rows
   * and rows mirrored from an external attendance provider go through exactly
   * the same shift lookup, lunch deduction, late/early derivation and upsert.
   * Duplicating this logic in the sync path would guarantee the two drift.
   *
   * Shift precedence is unchanged: an explicit WorkSchedule for the day wins,
   * otherwise the global office-hours settings apply; FLEXIBLE shifts disable
   * late/early/lunch entirely.
   */
  private async buildAndUpsertAttendance(input: {
    employeeId: string;
    branchId: string | null;
    dateKey: Date;
    checkIn: Date | null;
    checkOut: Date | null;
    status: string;
    notes: string;
    /** Provenance. Null/omitted leaves the column untouched for legacy callers. */
    source?: string;
    externalRef?: string | null;
    syncedAt?: Date | null;
    /** Explicit multi-punch sessions. Omitted => a single session from checkIn/checkOut. */
    sessions?: { checkIn: Date; checkOut: Date | null }[] | null;
    /** Employee timezone, for the day-boundary clamp. Looked up when omitted. */
    timezone?: string | null;
  }) {
    const {
      employeeId,
      branchId,
      dateKey,
      checkIn: checkInDate,
      status,
      notes,
    } = input;

    // Fetch scheduled shift on that day
    const schedule = await this.prisma.workSchedule.findFirst({
      where: {
        employeeId,
        date: dateKey,
        isWorkDay: true,
      },
    });
    // Flexible shifts skip the auto lunch deduction and have no late/early.
    const isFlexible = schedule?.shiftType === 'FLEXIBLE';

    // Admin-entered and provider-mirrored rows obey the same day boundary as
    // punches: nothing past the attendance day end is payable.
    const timezone =
      input.timezone !== undefined
        ? input.timezone
        : ((
            await this.prisma.employee.findUnique({
              where: { id: employeeId },
              select: { timezone: true },
            })
          )?.timezone ?? null);
    const dayEnd = await this.getAttendanceDayEnd(dateKey, timezone);

    const checkOutDate = input.checkOut
      ? this.clampToDayEnd(input.checkOut, checkInDate, dayEnd)
      : null;
    const clampedSessions = input.sessions?.length
      ? this.clampSessionsToDayEnd(
          input.sessions as AttendanceSession[],
          dayEnd,
        )
      : null;

    const lunchDeduction = await this.getLunchDeductionHours(
      checkInDate,
      isFlexible,
    );

    let workHours: number | null = null;
    if (clampedSessions && clampedSessions.length > 1) {
      // Multi-punch day: pay the sessions, not the span from the first to the
      // last punch — the gaps between them are unpaid breaks. On flexible days
      // there is no lunch deduction to mask them, so the span would pay for
      // every break the employee took.
      workHours = this.sumSessionHours(clampedSessions, lunchDeduction);
    } else if (checkInDate && checkOutDate) {
      workHours = this.calculateWorkHours(
        checkInDate,
        checkOutDate,
        lunchDeduction,
      );
    }

    const { start: workStart, end: workEnd } =
      await this.getOfficeWorkingHours(input.branchId);
    let isLate = false;
    let isEarlyCheckIn = false;
    if (checkInDate && status === 'PRESENT' && !isFlexible) {
      if (schedule && schedule.startTime) {
        isEarlyCheckIn =
          checkInDate.getTime() < new Date(schedule.startTime).getTime();
        isLate =
          checkInDate.getTime() >
          new Date(schedule.startTime).getTime() +
            this.LATE_THRESHOLD * 60 * 1000;
      } else {
        isLate = await this.calculateIsLate(checkInDate, workStart);
        const companyTZ = await this.tzSvc.getCompanyTZ();
        const localHour = this.tzSvc.localHour(checkInDate, companyTZ);
        const totalMinutes = this.tzSvc.localMinutesOfDay(
          checkInDate,
          companyTZ,
        );
        if (localHour >= 6 && localHour < 23) {
          isEarlyCheckIn = totalMinutes < workStart;
        }
      }
    }

    let isEarlyLeave = false;
    let isLateCheckout = false;
    if (checkInDate && checkOutDate && status === 'PRESENT' && !isFlexible) {
      if (schedule && schedule.endTime) {
        isEarlyLeave =
          checkOutDate.getTime() < new Date(schedule.endTime).getTime();
        isLateCheckout =
          checkOutDate.getTime() > new Date(schedule.endTime).getTime();
      } else {
        isEarlyLeave = await this.calculateIsEarlyLeave(
          checkOutDate,
          checkInDate,
          workEnd,
        );
        const companyTZ = await this.tzSvc.getCompanyTZ();
        const currentMinutes = this.tzSvc.localMinutesOfDay(
          checkOutDate,
          companyTZ,
        );
        isLateCheckout = currentMinutes >= workEnd;
      }
    }

    const sessions =
      clampedSessions && clampedSessions.length
        ? clampedSessions
        : checkInDate
          ? [{ checkIn: checkInDate, checkOut: checkOutDate }]
          : null;

    // Provenance is only written when the caller supplies it, so existing
    // callers keep producing byte-identical rows.
    const provenance: {
      source?: string;
      externalRef?: string | null;
      syncedAt?: Date | null;
    } = {};
    if (input.source !== undefined) provenance.source = input.source;
    if (input.externalRef !== undefined)
      provenance.externalRef = input.externalRef;
    if (input.syncedAt !== undefined) provenance.syncedAt = input.syncedAt;

    return this.prisma.attendance.upsert({
      where: {
        unique_employee_date: {
          employeeId,
          date: dateKey,
        },
      },
      create: {
        employeeId,
        // Denormalize home branch so branch-scoped reports include this record.
        branchId: branchId ?? undefined,
        date: dateKey,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        workHours:
          workHours !== null ? Math.round(workHours * 100) / 100 : null,
        isLate,
        isEarlyLeave,
        isEarlyCheckIn,
        isLateCheckout,
        status,
        notes,
        sessions: sessions
          ? (sessions as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        ...provenance,
      },
      update: {
        checkIn: checkInDate,
        checkOut: checkOutDate,
        workHours:
          workHours !== null ? Math.round(workHours * 100) / 100 : null,
        isLate,
        isEarlyLeave,
        isEarlyCheckIn,
        isLateCheckout,
        status,
        notes,
        sessions: sessions
          ? (sessions as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        ...provenance,
      },
    });
  }

  /**
   * Write one day of attendance mirrored from an external provider.
   *
   * Deliberately routed through this service rather than letting the sync module
   * touch `prisma.attendance` directly: work hours, lunch deduction and the
   * late/early flags are business rules that belong here, and a synced row must
   * be numerically indistinguishable from a manually entered one.
   *
   * The caller (AttendanceSyncService) owns employee resolution, the date key
   * and the conflict guard. This method just writes.
   */
  async applySyncedAttendance(input: {
    employeeId: string;
    branchId: string | null;
    dateKey: Date;
    checkIn: Date | null;
    checkOut: Date | null;
    status: string;
    notes: string;
    externalRef?: string | null;
    sessions?: { checkIn: Date; checkOut: Date | null }[] | null;
    timezone?: string | null;
  }) {
    return this.buildAndUpsertAttendance({
      ...input,
      source: 'SYNC',
      externalRef: input.externalRef ?? null,
      syncedAt: new Date(),
    });
  }

  /**
   * Resolve an absolute instant to the attendance date key this employee's day
   * boundary puts it in. Exposed for the external-provider sync, which must not
   * trust a vendor's own notion of "day" (fusion-analytics, for instance, dates
   * every record in Asia/Kolkata regardless of the branch's real location).
   */
  async resolveAttendanceDateKey(
    instant: Date,
    employeeTimezone?: string | null,
  ): Promise<Date> {
    return this.toAttendanceDateKey(instant, employeeTimezone);
  }

  /**
   * GET /attendances/overview?period=today|week|month
   * Returns aggregated stats, trend data, recent check-ins, and department breakdown.
   */
  async getOverview(
    period: 'today' | 'week' | 'month' | 'custom' = 'today',
    user?: UserPayload,
    date?: string,
    startDateParam?: string,
    endDateParam?: string,
  ) {
    const companyTZ = await this.tzSvc.getCompanyTZ();

    let referenceDate: Date;
    let today: Date;
    if (date) {
      const parts = date.split('-');
      referenceDate = new Date(
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
      today = referenceDate;
    } else {
      referenceDate = new Date();
      today = this.tzSvc.toDateKey(referenceDate, companyTZ);
    }

    let startDate: Date;
    let endDate: Date = today;

    if (period === 'custom' && startDateParam && endDateParam) {
      const startParts = startDateParam.split('-');
      startDate = new Date(
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
      const endParts = endDateParam.split('-');
      endDate = new Date(
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
    } else if (period === 'today') {
      startDate = today;
    } else if (period === 'week') {
      const refUTC = new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth(),
          referenceDate.getUTCDate(),
        ),
      );
      const sixDaysAgo = new Date(
        Date.UTC(
          refUTC.getUTCFullYear(),
          refUTC.getUTCMonth(),
          refUTC.getUTCDate() - 6,
        ),
      );
      startDate = date
        ? sixDaysAgo
        : this.tzSvc.toDateKey(sixDaysAgo, companyTZ);
    } else {
      const firstDay = new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth(),
          1,
        ),
      );
      const lastDay = new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth() + 1,
          0,
        ),
      );
      startDate = date ? firstDay : this.tzSvc.toDateKey(firstDay, companyTZ);
      endDate = date ? lastDay : this.tzSvc.toDateKey(lastDay, companyTZ);
    }

    const employeeFilter: any = {
      status: 'ACTIVE',
      NOT: { user: { role: 'ADMIN' } },
    };
    if (user?.role === 'MANAGER' && user?.departmentId) {
      employeeFilter.departmentId = { in: managerDeptScope(user) };
    }
    const totalEmployees = await this.prisma.employee.count({
      where: employeeFilter,
    });

    const getDistinctEmployeeNames = async (baseWhere: any) => {
      const where = { ...baseWhere };
      const empFilter: any = { NOT: { user: { role: 'ADMIN' } } };
      if (user?.role === 'MANAGER' && user?.departmentId) {
        empFilter.departmentId = { in: managerDeptScope(user) };
      }
      where.employee = empFilter;
      const records = await this.prisma.attendance.findMany({
        where,
        select: { employee: { select: { fullName: true } } },
        distinct: ['employeeId'],
      });
      return records.map((r) => r.employee?.fullName).filter(Boolean);
    };

    // Aggregate attendance for the period
    const attendanceWhere: any = {
      date: { gte: startDate, lte: endDate },
      employee: { NOT: { user: { role: 'ADMIN' } } },
    };
    if (user?.role === 'MANAGER' && user?.departmentId) {
      attendanceWhere.employee.departmentId = { in: managerDeptScope(user) };
    }

    let [
      presentCount,
      lateCount,
      absentCount,
      earlyLeaveCount,
      avgWorkHoursAgg,
    ] = await Promise.all([
      this.prisma.attendance.count({
        where: { ...attendanceWhere, status: 'PRESENT' },
      }),
      this.prisma.attendance.count({
        where: { ...attendanceWhere, isLate: true },
      }),
      this.prisma.attendance.count({
        where: { ...attendanceWhere, status: 'ABSENT' },
      }),
      this.prisma.attendance.count({
        where: { ...attendanceWhere, isEarlyLeave: true },
      }),
      this.prisma.attendance.aggregate({
        where: { ...attendanceWhere, workHours: { not: null } },
        _avg: { workHours: true },
      }),
    ]);

    // Over multi-day periods (week/month/custom) an employee has one row
    // per day, so the raw counts above are sums across days, not headcounts.
    // Turn them into a per-day average so the cards stay in the same scale
    // as totalEmployees instead of ballooning with the number of days.
    const daysInPeriod =
      period === 'today'
        ? 1
        : Math.round(
            (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000),
          ) + 1;
    if (period !== 'today') {
      presentCount = Math.round(presentCount / daysInPeriod);
      lateCount = Math.round(lateCount / daysInPeriod);
      absentCount = Math.round(absentCount / daysInPeriod);
      earlyLeaveCount = Math.round(earlyLeaveCount / daysInPeriod);
    }

    const lateUsers = await getDistinctEmployeeNames({
      date: { gte: startDate, lte: endDate },
      isLate: true,
    });
    let absentUsers = await getDistinctEmployeeNames({
      date: { gte: startDate, lte: endDate },
      status: 'ABSENT',
    });
    const earlyLeaveUsers = await getDistinctEmployeeNames({
      date: { gte: startDate, lte: endDate },
      isEarlyLeave: true,
    });

    const boundaryPassed = await this.hasDayEndBoundaryPassed(today);
    if (period === 'today' && !boundaryPassed) {
      absentCount = 0;
      absentUsers = [];
    }

    // For today: also compute notCheckedOut
    let notCheckedOut = 0;
    let notCheckedOutUsers: string[] = [];
    let notCheckedInUsers: string[] = [];

    if (period === 'today') {
      const notCheckedOutWhere: any = {
        date: today,
        status: 'PRESENT',
        checkIn: { not: null },
        checkOut: null,
      };
      if (user?.role === 'MANAGER' && user?.departmentId) {
        notCheckedOutWhere.employee = { departmentId: { in: managerDeptScope(user) } };
      }
      notCheckedOut = await this.prisma.attendance.count({
        where: notCheckedOutWhere,
      });
      notCheckedOutUsers = await getDistinctEmployeeNames(notCheckedOutWhere);

      const todayAttendancesWhere: any = { date: today };
      if (user?.role === 'MANAGER' && user?.departmentId) {
        todayAttendancesWhere.employee = { departmentId: { in: managerDeptScope(user) } };
      }
      const todayAttendances = await this.prisma.attendance.findMany({
        where: todayAttendancesWhere,
        select: { employeeId: true, status: true },
      });
      const ids = todayAttendances
        .filter((a) => boundaryPassed ? true : a.status !== 'ABSENT')
        .map((a) => a.employeeId);

      const notCheckedInEmployeeWhere: any = {
        status: 'ACTIVE',
        id: { notIn: ids },
      };
      if (user?.role === 'MANAGER' && user?.departmentId) {
        notCheckedInEmployeeWhere.departmentId = { in: managerDeptScope(user) };
      }
      const notCheckedIn = await this.prisma.employee.findMany({
        where: notCheckedInEmployeeWhere,
        select: { fullName: true },
        take: 10,
      });
      notCheckedInUsers = notCheckedIn.map((e) => e.fullName);
    }

    const avgWorkHours =
      Math.round((Number(avgWorkHoursAgg._avg.workHours) || 0) * 100) / 100;
    const presentRate =
      period === 'today'
        ? totalEmployees > 0
          ? Math.round((presentCount / totalEmployees) * 100)
          : 0
        : 0; // For week/month use per-day average
    const lateRate =
      presentCount > 0 ? Math.round((lateCount / presentCount) * 100) : 0;

    // ── Trend Data ──────────────────────────────────────────────────────────────
    const trendData: {
      date: string;
      attendanceRate: number;
      lateRate: number;
      present: number;
      absent: number;
      total: number;
    }[] = [];

    if (period === 'today') {
      // Hourly distribution of check-ins for today
      const todayAttendancesWhere: any = {
        date: today,
        checkIn: { not: null },
      };
      if (user?.role === 'MANAGER' && user?.departmentId) {
        todayAttendancesWhere.employee = { departmentId: { in: managerDeptScope(user) } };
      }
      const todayAttendances = await this.prisma.attendance.findMany({
        where: todayAttendancesWhere,
        select: { checkIn: true, isLate: true },
      });

      const hours: Record<string, { present: number; late: number }> = {};
      for (let h = 7; h <= 18; h++) {
        hours[`${h}:00`] = { present: 0, late: 0 };
      }
      todayAttendances.forEach((a) => {
        if (a.checkIn) {
          const h = this.tzSvc.localHour(a.checkIn, companyTZ);
          const key = `${h}:00`;
          if (hours[key]) {
            hours[key].present++;
            if (a.isLate) hours[key].late++;
          }
        }
      });
      Object.entries(hours).forEach(([hour, data]) => {
        trendData.push({
          date: hour,
          attendanceRate: data.present,
          lateRate: data.late,
          present: data.present,
          absent: 0,
          total: totalEmployees,
        });
      });
    } else {
      // Daily breakdown for week or month
      const current = new Date(startDate);
      while (current <= endDate) {
        const dayKey = this.tzSvc.toDateKey(new Date(current), companyTZ);
        const nextDay = new Date(dayKey);
        nextDay.setDate(nextDay.getDate() + 1);

        const dayTrendWhere: any = { date: dayKey };
        if (user?.role === 'MANAGER' && user?.departmentId) {
          dayTrendWhere.employee = { departmentId: { in: managerDeptScope(user) } };
        }

        const [dayPresent, dayLate, dayAbsent] = await Promise.all([
          this.prisma.attendance.count({
            where: { ...dayTrendWhere, status: 'PRESENT' },
          }),
          this.prisma.attendance.count({
            where: { ...dayTrendWhere, isLate: true },
          }),
          this.prisma.attendance.count({
            where: { ...dayTrendWhere, status: 'ABSENT' },
          }),
        ]);

        const dayTotal = dayPresent + dayAbsent;
        const dayRate =
          dayTotal > 0 ? Math.round((dayPresent / dayTotal) * 100) : 0;
        const dayLateRate =
          dayPresent > 0 ? Math.round((dayLate / dayPresent) * 100) : 0;

        // Label: "Mon 26", "Tue 27", etc.
        const label = current.toLocaleDateString('en-US', {
          weekday: 'short',
          day: 'numeric',
        });
        trendData.push({
          date: label,
          attendanceRate: dayRate,
          lateRate: dayLateRate,
          present: dayPresent,
          absent: dayAbsent,
          total: dayTotal || totalEmployees,
        });

        current.setDate(current.getDate() + 1);
      }
    }

    // ── Recent Check-ins ────────────────────────────────────────────────────────
    const recentCheckInsWhere: any = {
      date: { gte: startDate, lte: endDate },
      checkIn: { not: null },
    };
    if (user?.role === 'MANAGER' && user?.departmentId) {
      recentCheckInsWhere.employee = { departmentId: { in: managerDeptScope(user) } };
    }
    const recentCheckIns = await this.prisma.attendance.findMany({
      where: recentCheckInsWhere,
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { checkIn: 'desc' },
      take: 10,
    });

    // ── Department Breakdown ────────────────────────────────────────────────────
    const departmentFilterWhere: any = {};
    if (user?.role === 'MANAGER' && user?.departmentId) {
      departmentFilterWhere.id = { in: managerDeptScope(user) };
    }
    const departments = await this.prisma.department.findMany({
      where: departmentFilterWhere,
      select: { id: true, name: true },
    });

    const departmentBreakdown = await Promise.all(
      departments.map(async (dept) => {
        const deptEmployees = await this.prisma.employee.count({
          where: { departmentId: dept.id, status: 'ACTIVE' },
        });

        let [deptPresent, deptLate, deptAbsent] = await Promise.all([
          this.prisma.attendance.count({
            where: {
              date: { gte: startDate, lte: endDate },
              status: 'PRESENT',
              employee: { departmentId: dept.id },
            },
          }),
          this.prisma.attendance.count({
            where: {
              date: { gte: startDate, lte: endDate },
              isLate: true,
              employee: { departmentId: dept.id },
            },
          }),
          this.prisma.attendance.count({
            where: {
              date: { gte: startDate, lte: endDate },
              status: 'ABSENT',
              employee: { departmentId: dept.id },
            },
          }),
        ]);
        if (period !== 'today') {
          deptPresent = Math.round(deptPresent / daysInPeriod);
          deptLate = Math.round(deptLate / daysInPeriod);
          deptAbsent = Math.round(deptAbsent / daysInPeriod);
        }

        return {
          department: dept.name,
          present: deptPresent,
          late: deptLate,
          absent: deptAbsent,
          total: deptEmployees,
        };
      }),
    );

    return {
      success: true,
      data: {
        period,
        stats: {
          totalEmployees,
          present: presentCount,
          late: lateCount,
          absent: absentCount,
          earlyLeave: earlyLeaveCount,
          notCheckedOut,
          avgWorkHours,
          presentRate,
          lateRate,
          lateUsers,
          absentUsers,
          earlyLeaveUsers,
          notCheckedOutUsers,
          notCheckedInUsers,
        },
        trendData,
        recentCheckIns,
        departmentBreakdown: departmentBreakdown.filter((d) => d.total > 0),
      },
    };
  }

  /**
   * GET /attendances/list?period=today|week|month&page=&limit=&status=&departmentId=&search=
   * Returns paginated, filterable attendance records for any period.
   */
  async getAttendanceList(
    params: {
      period?: 'today' | 'week' | 'month' | 'custom';
      page?: number;
      limit?: number;
      status?: string;
      departmentId?: string;
      search?: string;
      date?: string;
      startDate?: string;
      endDate?: string;
    },
    user?: UserPayload,
  ) {
    const {
      period = 'today',
      page = 1,
      limit = 10,
      status,
      departmentId,
      search,
      date,
      startDate: startDateParam,
      endDate: endDateParam,
    } = params;

    const now = new Date();
    const companyTZ = await this.tzSvc.getCompanyTZ();
    let referenceDate: Date;
    let today: Date;
    if (date) {
      const parts = date.split('-');
      referenceDate = new Date(
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
      today = referenceDate;
    } else {
      referenceDate = now;
      today = this.tzSvc.toDateKey(referenceDate, companyTZ);
    }
    let startDate: Date;
    let endDate: Date = today;

    if (period === 'custom' && startDateParam && endDateParam) {
      const startParts = startDateParam.split('-');
      startDate = new Date(
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
      const endParts = endDateParam.split('-');
      endDate = new Date(
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
    } else if (period === 'today') {
      startDate = today;
    } else if (period === 'week') {
      const refUTC = new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth(),
          referenceDate.getUTCDate(),
        ),
      );
      const sixDaysAgo = new Date(
        Date.UTC(
          refUTC.getUTCFullYear(),
          refUTC.getUTCMonth(),
          refUTC.getUTCDate() - 6,
        ),
      );
      startDate = date
        ? sixDaysAgo
        : this.tzSvc.toDateKey(sixDaysAgo, companyTZ);
    } else {
      const firstDay = new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth(),
          1,
        ),
      );
      const lastDay = new Date(
        Date.UTC(
          referenceDate.getUTCFullYear(),
          referenceDate.getUTCMonth() + 1,
          0,
        ),
      );
      startDate = date ? firstDay : this.tzSvc.toDateKey(firstDay, companyTZ);
      endDate = date ? lastDay : this.tzSvc.toDateKey(lastDay, companyTZ);
    }

    const employeeFilter: any = {
      status: 'ACTIVE',
      NOT: { user: { role: 'ADMIN' } },
    };

    // An EMPLOYEE sees only themselves. Without this the roster filter is just
    // "every ACTIVE non-admin", and since the route admits EMPLOYEE, any
    // employee could page the whole company's attendance — names, check-in
    // times and lateness flags — bounded only by their branch envelope.
    // `/attendances/my` is the self-service read; this door is the roster.
    if (user?.role === 'EMPLOYEE') {
      // `{ in: [] }` rather than a sentinel string: `id` is a @db.Uuid column,
      // so an unparseable value is a Prisma P2023 and a 500, not an empty list.
      employeeFilter.id = user.employeeId ? user.employeeId : { in: [] };
    } else if (user?.role === 'MANAGER') {
      // Gate on the SCOPE, not on `user.departmentId`: a manager who heads
      // departments while their own departmentId is null would otherwise fall
      // through this branch entirely and get the whole company.
      // `managerDeptScope` already falls back to their own department.
      employeeFilter.departmentId = { in: managerDeptScope(user) };
    }

    // Snapshot of scope before the user's department/search picks are applied —
    // used as the "unfiltered" denominator so the filter panel compares
    // like-for-like (same unit, same period) instead of against headcount.
    const baseEmployeeFilter = { ...employeeFilter };

    if (departmentId && departmentId !== 'all') {
      // INTERSECT with the caller's scope rather than replacing it. Assigning
      // `employeeFilter.departmentId` outright let a MANAGER read any sibling
      // department by passing the query parameter the screen already sends —
      // and a sibling in the same branch is invisible to the branch middleware.
      if (user?.role === 'MANAGER') {
        const allowed = managerDeptScope(user);
        employeeFilter.departmentId = allowed.includes(departmentId)
          ? departmentId
          : // Asking for a department they do not head yields nothing, rather
            // than everything. Empty IN, not a sentinel: departmentId is a
            // @db.Uuid column and junk would be a 500.
            { in: [] };
      } else if (user?.role !== 'EMPLOYEE') {
        employeeFilter.departmentId = departmentId;
      }
    }

    if (search) {
      employeeFilter.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { employeeCode: { contains: search, mode: 'insensitive' } },
      ];
    }

    const isSingleDay = startDate.getTime() === endDate.getTime();

    if (isSingleDay) {
      const activeEmployees = await this.prisma.employee.findMany({
        where: employeeFilter,
        select: {
          id: true,
          employeeCode: true,
          fullName: true,
          department: { select: { id: true, name: true } },
        },
      });

      const attendanceWhere: any = {
        date: startDate,
        employee: employeeFilter,
      };

      const existingAttendances = await this.prisma.attendance.findMany({
        where: attendanceWhere,
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
              department: { select: { id: true, name: true } },
            },
          },
        },
      });

      const attendanceMap = new Map(existingAttendances.map((a) => [a.employeeId, a]));
      const boundaryPassed = await this.hasDayEndBoundaryPassed(startDate);

      let mergedRecords: any[] = activeEmployees.map((emp) => {
        const existing = attendanceMap.get(emp.id);
        if (existing) {
          if (existing.status === 'ABSENT' && !boundaryPassed) {
            return {
              ...existing,
              status: 'NOT_CHECKED_IN',
            };
          }
          return existing;
        }

        return {
          id: `virtual-${emp.id}`,
          employeeId: emp.id,
          date: startDate,
          checkIn: null,
          checkOut: null,
          workHours: null,
          isLate: false,
          isEarlyLeave: false,
          isEarlyCheckIn: false,
          isLateCheckout: false,
          status: 'NOT_CHECKED_IN',
          notes: null,
          sessions: null,
          checkInLatitude: null,
          checkInLongitude: null,
          checkInAccuracy: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          employee: emp,
        };
      });

      if (status && status !== 'all') {
        if (status === 'late') {
          mergedRecords = mergedRecords.filter((r) => r.isLate && r.checkIn);
        } else if (status === 'on-time') {
          mergedRecords = mergedRecords.filter((r) => r.status === 'PRESENT' && !r.isLate);
        } else if (status === 'absent') {
          mergedRecords = mergedRecords.filter((r) => r.status === 'ABSENT');
        } else if (status === 'not-checked-out') {
          mergedRecords = mergedRecords.filter((r) => r.checkIn !== null && r.checkOut === null);
        } else if (status === 'early-leave') {
          mergedRecords = mergedRecords.filter((r) => r.isEarlyLeave);
        }
      }

      mergedRecords.sort((a, b) => {
        if (a.checkIn && b.checkIn) {
          return new Date(b.checkIn).getTime() - new Date(a.checkIn).getTime();
        }
        if (a.checkIn) return -1;
        if (b.checkIn) return 1;
        return a.employee.fullName.localeCompare(b.employee.fullName);
      });

      const total = mergedRecords.length;
      const totalUnfiltered = await this.prisma.employee.count({
        where: baseEmployeeFilter,
      });
      const skip = (Number(page) - 1) * Number(limit);
      const paginatedRecords = mergedRecords.slice(skip, skip + Number(limit));

      return {
        success: true,
        data: paginatedRecords,
        meta: {
          total,
          totalUnfiltered,
          page: Number(page),
          limit: Number(limit),
          totalPages: Math.ceil(total / Number(limit)),
          period,
          startDate,
          endDate,
        },
      };
    }

    // Build where clause for multi-day queries
    const where: any = {
      date: { gte: startDate, lte: endDate },
      employee: employeeFilter,
    };

    if (status && status !== 'all') {
      if (status === 'late') {
        where.isLate = true;
      } else if (status === 'on-time') {
        where.isLate = false;
        where.status = 'PRESENT';
      } else if (status === 'absent') {
        const boundaryPassed = await this.hasDayEndBoundaryPassed(today);
        if (!boundaryPassed) {
          where.status = 'ABSENT';
          where.date = { ...where.date, lt: today };
        } else {
          where.status = 'ABSENT';
        }
      } else if (status === 'not-checked-out') {
        where.checkIn = { not: null };
        where.checkOut = null;
        where.status = 'PRESENT';
      } else if (status === 'early-leave') {
        where.isEarlyLeave = true;
      }
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [total, totalUnfiltered, records] = await Promise.all([
      this.prisma.attendance.count({ where }),
      this.prisma.attendance.count({
        where: {
          date: { gte: startDate, lte: endDate },
          employee: baseEmployeeFilter,
        },
      }),
      this.prisma.attendance.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
              department: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [{ date: 'desc' }, { checkIn: 'desc' }],
        skip,
        take: Number(limit),
      }),
    ]);

    const mappedRecords = await Promise.all(
      records.map(async (r) => {
        if (r.status === 'ABSENT') {
          const boundaryPassed = await this.hasDayEndBoundaryPassed(r.date);
          if (!boundaryPassed) {
            return {
              ...r,
              status: 'NOT_CHECKED_IN',
            };
          }
        }
        return r;
      }),
    );

    return {
      success: true,
      data: mappedRecords,
      meta: {
        total,
        totalUnfiltered,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
        period,
        startDate,
        endDate,
      },
    };
  }

  /**
   * Calculate expected work days between two dates for a branch.
   * Excludes the branch's weekly-off days and holidays (company-wide + branch).
   */
  private async calculateExpectedWorkDays(
    startDate: Date,
    endDate: Date,
    branchId?: string,
  ): Promise<number> {
    return this.holidaysService.getWorkDaysBetween(startDate, endDate, branchId);
  }

  /**
   * Refuses a subject outside the caller's branch envelope, for the routes that
   * take an employee id as a PARAMETER.
   *
   * This lives here rather than inside `checkIn`/`checkOut`/`getEmployeeAttendances`
   * because those are SELF-SERVICE doors as well as on-behalf ones — the
   * controller passes `user.employeeId` for `/my`, `/today`, `/lunch-status` and
   * the bare punch routes. Guarding them unconditionally broke a user reading
   * their OWN attendance whenever the branch picker pointed at another branch,
   * which is precisely the mistake the People phase made with
   * `/document-vault/me`. The rule: guard the id the CALLER supplied, never the
   * one their token did.
   */
  async assertEmployeeInBranch(employeeId: string): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(employee.branchId);
  }

  /** Helper: fetch just departmentId for a given employee (used for MANAGER scope checks). */
  async getEmployeeDept(employeeId: string) {
    return this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true },
    });
  }

  async getAttendanceById(id: string) {
    const record = await this.prisma.attendance.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            branchId: true,
            department: { select: { id: true, name: true } },
          },
        },
        corrections: {
          include: {
            employee: {
              select: {
                id: true,
                fullName: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!record) {
      throw new NotFoundException('Attendance record not found');
    }
    // Object-level branch guard: `findUnique` bypasses the auto-scoping
    // middleware, so a branch-scoped caller could read any attendance row in
    // the company by id. The row carries its own denormalised branch, which is
    // the branch the punch actually happened in.
    assertInBranch(record.branchId ?? record.employee?.branchId ?? null);
    return {
      success: true,
      data: record,
    };
  }

  async lunchCheckOut(employeeId: string, byFace = false) {
    const isFaceOnly =
      (await this.settingsService.getSetting(
        'attendance_face_only',
        'false',
      )) === 'true';

    if (isFaceOnly && !byFace && !(await this.faceCheckSatisfiedByChannel('LUNCH_OUT'))) {
      throw new BadRequestException(
        'Attendance can only be registered using face verification.',
      );
    }

    // An account with no linked employee record reaches here with
    // `employeeId === undefined`, and `findUnique({ where: { id: undefined } })`
    // is a Prisma error, not an empty result — so the caller used to get a 500
    // carrying driver text. ADMIN accounts are routinely unlinked.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record.',
      );
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const now = new Date();
    const today = await this.toAttendanceDateKey(now, employee.timezone);

    const attendance = await this.prisma.attendance.findFirst({
      where: {
        employeeId,
        date: today,
      },
    });

    if (!attendance) {
      throw new BadRequestException('You have not checked in today');
    }

    let sessions: AttendanceSession[] = [];
    if (attendance.sessions) {
      sessions = attendance.sessions as unknown as AttendanceSession[];
    } else if (attendance.checkIn) {
      sessions = [
        { checkIn: attendance.checkIn, checkOut: attendance.checkOut },
      ];
    } else {
      throw new BadRequestException('You have not checked in today');
    }

    // Check if employee has already had a LUNCH session today
    const hasLunchSession = sessions.some((s) => s.type === 'LUNCH');
    if (hasLunchSession) {
      throw new BadRequestException('You can only take one lunch break per day');
    }

    // Find active work session (not lunch, and has no checkOut)
    const activeWorkSessionIndex = sessions.findIndex((s) => !s.checkOut && s.type !== 'LUNCH');
    if (activeWorkSessionIndex === -1) {
      throw new BadRequestException('You do not have an active work session to start a lunch break');
    }

    // End the active work session
    sessions[activeWorkSessionIndex].checkOut = now;

    // Start lunch break session
    sessions.push({
      type: 'LUNCH',
      checkIn: now,
      checkOut: null,
      reminderSent: false,
    });

    const updated = await this.prisma.attendance.update({
      where: { id: attendance.id },
      data: {
        sessions: sessions as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      success: true,
      message: 'Lunch break started successfully',
      data: updated,
    };
  }

  async lunchCheckIn(employeeId: string, byFace = false) {
    const isFaceOnly =
      (await this.settingsService.getSetting(
        'attendance_face_only',
        'false',
      )) === 'true';

    if (isFaceOnly && !byFace && !(await this.faceCheckSatisfiedByChannel('LUNCH_IN'))) {
      throw new BadRequestException(
        'Attendance can only be registered using face verification.',
      );
    }

    // An account with no linked employee record reaches here with
    // `employeeId === undefined`, and `findUnique({ where: { id: undefined } })`
    // is a Prisma error, not an empty result — so the caller used to get a 500
    // carrying driver text. ADMIN accounts are routinely unlinked.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record.',
      );
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const now = new Date();
    const today = await this.toAttendanceDateKey(now, employee.timezone);

    const attendance = await this.prisma.attendance.findFirst({
      where: {
        employeeId,
        date: today,
      },
    });

    if (!attendance) {
      throw new BadRequestException('You have not checked in today');
    }

    let sessions: AttendanceSession[] = [];
    if (attendance.sessions) {
      sessions = attendance.sessions as unknown as AttendanceSession[];
    } else if (attendance.checkIn) {
      sessions = [
        { checkIn: attendance.checkIn, checkOut: attendance.checkOut },
      ];
    } else {
      throw new BadRequestException('You have not checked in today');
    }

    // Find active lunch session (type === 'LUNCH' and has no checkOut)
    const activeLunchIndex = sessions.findIndex((s) => s.type === 'LUNCH' && !s.checkOut);
    if (activeLunchIndex === -1) {
      throw new BadRequestException('You are not currently on a lunch break');
    }

    // End lunch break session
    sessions[activeLunchIndex].checkOut = now;

    // Start a new work session
    sessions.push({
      checkIn: now,
      checkOut: null,
    });

    const updated = await this.prisma.attendance.update({
      where: { id: attendance.id },
      data: {
        sessions: sessions as unknown as Prisma.InputJsonValue,
      },
    });

    const lunchSession = sessions[activeLunchIndex];
    const durationMs = new Date(lunchSession.checkOut as string | Date).getTime() - new Date(lunchSession.checkIn as string | Date).getTime();
    const durationMinutes = Math.round(durationMs / (1000 * 60));

    return {
      success: true,
      message: 'Checked back in from lunch break successfully',
      data: updated,
      lunchDurationMinutes: durationMinutes,
    };
  }

  async getLunchBreakStatus(employeeId: string) {
    // An account with no linked employee record reaches here with
    // `employeeId === undefined`, and `findUnique({ where: { id: undefined } })`
    // is a Prisma error, not an empty result — so the caller used to get a 500
    // carrying driver text. ADMIN accounts are routinely unlinked.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record.',
      );
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const now = new Date();
    const today = await this.toAttendanceDateKey(now, employee.timezone);

    const attendance = await this.prisma.attendance.findFirst({
      where: {
        employeeId,
        date: today,
      },
    });

    if (!attendance) {
      return {
        isOnLunchBreak: false,
        lunchCheckOutTime: null,
        lunchDurationMinutes: 0,
        hasTakenLunchToday: false,
      };
    }

    let sessions: AttendanceSession[] = [];
    if (attendance.sessions) {
      sessions = attendance.sessions as unknown as AttendanceSession[];
    } else if (attendance.checkIn) {
      sessions = [
        { checkIn: attendance.checkIn, checkOut: attendance.checkOut },
      ];
    }

    const activeLunchSession = sessions.find((s) => s.type === 'LUNCH' && !s.checkOut);
    const completedLunchSession = sessions.find((s) => s.type === 'LUNCH' && s.checkOut);

    let lunchDurationMinutes = 0;
    if (activeLunchSession) {
      const durationMs = now.getTime() - new Date(activeLunchSession.checkIn as string | Date).getTime();
      lunchDurationMinutes = Math.round(durationMs / (1000 * 60));
    } else if (completedLunchSession) {
      const durationMs = new Date(completedLunchSession.checkOut as string | Date).getTime() - new Date(completedLunchSession.checkIn as string | Date).getTime();
      lunchDurationMinutes = Math.round(durationMs / (1000 * 60));
    }

    const hasTakenLunchToday = sessions.some((s) => s.type === 'LUNCH');

    return {
      isOnLunchBreak: !!activeLunchSession,
      lunchCheckOutTime: activeLunchSession ? activeLunchSession.checkIn : null,
      lunchDurationMinutes,
      hasTakenLunchToday,
    };
  }

  @Cron('0 * * * * *')
  async checkLunchBreakReminders() {
    const now = new Date();
    const durationSetting = await this.settingsService.getSetting(
      'lunch_break_duration_minutes',
      '60',
    );
    const lunchDurationMinutes = parseInt(durationSetting, 10) || 60;

    const activeAttendances = await this.prisma.attendance.findMany({
      where: {
        checkOut: null,
      },
      include: {
        employee: true,
      },
    });

    for (const attendance of activeAttendances) {
      if (!attendance.sessions) continue;

      const sessions = attendance.sessions as unknown as AttendanceSession[];
      const activeLunchSessionIndex = sessions.findIndex(
        (s) => s.type === 'LUNCH' && !s.checkOut && !s.reminderSent,
      );

      if (activeLunchSessionIndex !== -1) {
        const lunchSession = sessions[activeLunchSessionIndex];
        const checkInTime = new Date(lunchSession.checkIn);
        const durationMs = now.getTime() - checkInTime.getTime();
        const durationMinutes = durationMs / (1000 * 60);

        if (durationMinutes >= lunchDurationMinutes) {
          if (attendance.employee && attendance.employee.email) {
            const startTimeStr = checkInTime.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });

            const frontendUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
            const checkInUrl = `${frontendUrl}/dashboard/my-attendance`;

            await this.mailService.sendLunchBreakReminder(
              attendance.employee.email,
              {
                employeeName: attendance.employee.fullName,
                lunchStartTime: startTimeStr,
                lunchDurationMinutes,
                checkInUrl,
              },
            );
          }

          sessions[activeLunchSessionIndex].reminderSent = true;

          await this.prisma.attendance.update({
            where: { id: attendance.id },
            data: {
              sessions: sessions as unknown as Prisma.InputJsonValue,
            },
          });
        }
      }
    }
  }

  /**
   * CRON JOB: Send daily attendance report
   * Runs every minute, fires at attendance_daily_report_time from settings
   * (falls back to office_end_time). Absentees are computed dynamically —
   * employees with no record and no approved leave — without writing rows,
   * since the report may fire before the day-end boundary settles the day.
   */
  @Cron('0 * * * * *', {
    name: 'daily-attendance-report',
  })
  async sendDailyAttendanceReportCron() {
    const enabled = await this.settingsService.getSetting(
      'attendance_daily_report_enabled',
      'true',
    );
    if (enabled !== 'true') return;

    const companyTZ = await this.tzSvc.getCompanyTZ();
    const now = new Date();

    // Check if current local time is the configured report time
    // Office end is the fallback for BOTH an absent row and a blank one: the
    // setting is seeded with a value, so `getSetting`'s default never fired and
    // clearing the field in the UI left an empty string, not "follow office
    // hours". The report time is a company-local wall clock either way.
    const officeEnd = await this.settingsService.getSetting(
      'office_end_time',
      '17:30',
    );
    const configuredReportTime = await this.settingsService.getSetting(
      'attendance_daily_report_time',
      officeEnd,
    );
    const reportTimeStr = configuredReportTime?.trim()
      ? configuredReportTime
      : officeEnd;
    const targetMins = this.tzSvc.parseTimeHHMM(reportTimeStr, 17 * 60 + 30);
    const nowMins = this.tzSvc.localMinutesOfDay(now, companyTZ);

    // Widened window (not exact-minute match) so a missed tick or DST gap
    // still triggers; dedup below guarantees once per day.
    if (nowMins < targetMins || nowMins >= targetMins + 5) {
      return;
    }

    // Report on the currently open attendance day (with an after-midnight
    // boundary, a report sent at 00:30 still covers yesterday's day)
    const boundary = await this.getDayEndBoundaryMinutes();
    const reportDay = this.tzSvc.toAttendanceDateKey(now, companyTZ, boundary);
    const reportDayStr = DateTime.fromJSDate(reportDay, {
      zone: 'utc',
    }).toISODate()!;

    // Deduplication check
    if (this.reportSentDate === reportDayStr) {
      return;
    }
    this.reportSentDate = reportDayStr;

    // Skip non-working days — otherwise the report lists every employee as
    // absent on weekends/holidays
    const holidaysSetting = await this.settingsService.getSetting(
      'calendar_weekly_holidays',
      '0',
    );
    const weeklyHolidays = holidaysSetting.split(',').map(Number);
    if (weeklyHolidays.includes(reportDay.getUTCDay())) {
      console.log(
        `[Cron] ${reportDayStr} is a weekend. Skipping daily attendance report.`,
      );
      return;
    }
    const holiday = await this.prisma.holiday.findFirst({
      where: { date: reportDay },
    });
    if (holiday) {
      console.log(
        `[Cron] ${reportDayStr} is a holiday (${holiday.name}). Skipping daily attendance report.`,
      );
      return;
    }

    try {
      console.log(`[Cron] Starting daily attendance report for ${reportDayStr}`);

      // 1. Get all active employees
      const activeEmployees = await this.prisma.employee.findMany({
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          fullName: true,
          employeeCode: true,
          department: { select: { name: true } },
        },
      });

      // 2. Report day's attendance records
      const attendances = await this.prisma.attendance.findMany({
        where: { date: reportDay },
      });

      // 3. Report day's approved leave requests
      const leaveRequests = await this.prisma.leaveRequest.findMany({
        where: {
          status: 'APPROVED',
          startDate: { lte: reportDay },
          endDate: { gte: reportDay },
        },
      });

      const leaveMap = new Map<string, string>(); // employeeId -> leaveType
      for (const lr of leaveRequests) {
        leaveMap.set(lr.employeeId, lr.leaveType);
      }

      const formatLocalTime = (date: Date | null | undefined, tz: string): string => {
        if (!date) return '—';
        return DateTime.fromJSDate(date).setZone(tz).toFormat('hh:mm a');
      };

      const presentEmployees: Array<{
        name: string;
        department: string;
        checkIn: string;
        checkOut: string;
        workHours: string;
        isLate: boolean;
        isEarlyLeave: boolean;
        isLateCheckout: boolean;
      }> = [];
      const absentEmployees: Array<{ name: string; department: string }> = [];
      const onLeaveEmployees: Array<{ name: string; department: string; leaveType: string }> = [];

      let lateCount = 0;
      let earlyLeaveCount = 0;

      for (const employee of activeEmployees) {
        if (leaveMap.has(employee.id)) {
          onLeaveEmployees.push({
            name: employee.fullName,
            department: employee.department?.name || 'No Department',
            leaveType: leaveMap.get(employee.id) || 'Approved Leave',
          });
          continue;
        }

        const record = attendances.find((a) => a.employeeId === employee.id);
        if (record) {
          if (record.status === 'PRESENT') {
            if (record.isLate) lateCount++;
            if (record.isEarlyLeave) earlyLeaveCount++;

            presentEmployees.push({
              name: employee.fullName,
              department: employee.department?.name || 'No Department',
              checkIn: formatLocalTime(record.checkIn, companyTZ),
              checkOut: formatLocalTime(record.checkOut, companyTZ),
              workHours: record.workHours !== null ? String(record.workHours) : '0',
              isLate: !!record.isLate,
              isEarlyLeave: !!record.isEarlyLeave,
              isLateCheckout: !!record.isLateCheckout,
            });
          } else {
            absentEmployees.push({
              name: employee.fullName,
              department: employee.department?.name || 'No Department',
            });
          }
        } else {
          absentEmployees.push({
            name: employee.fullName,
            department: employee.department?.name || 'No Department',
          });
        }
      }

      const companyName = await this.settingsService.getSetting(
        'company_name',
        'TRS',
      );

      const generatedAt = DateTime.fromJSDate(now).setZone(companyTZ).toFormat('yyyy-MM-dd hh:mm a (ZZZZ)');

      await this.mailService.sendDailyAttendanceReport({
        date: reportDayStr,
        totalEmployees: activeEmployees.length,
        presentCount: presentEmployees.length,
        absentCount: absentEmployees.length,
        onLeaveCount: onLeaveEmployees.length,
        lateCount,
        earlyLeaveCount,
        presentEmployees,
        absentEmployees,
        onLeaveEmployees,
        generatedAt,
        companyName,
      });

      console.log(`[Cron] Daily attendance report sent successfully for ${reportDayStr}`);
    } catch (err) {
      console.error('[Cron] Error generating or sending daily attendance report:', err);
    }
  }
}
