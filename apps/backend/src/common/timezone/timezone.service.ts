import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { SystemSettingsService } from '../../system-settings/system-settings.service';
import { companyTzCache } from './timezone-cache';

/**
 * Shared timezone service — implements the Workday/SAP SuccessFactors model:
 *
 *  • Company TZ  (admin-set via system_timezone setting)
 *    → Used for business rules: late/early check, office hours, payroll boundaries
 *
 *  • Employee TZ  (per-employee optional, stored on Employee.timezone)
 *    → Used for "today" date boundary and display; falls back to company TZ
 *
 * All timestamps in the DB are UTC.  This service converts as needed.
 */
@Injectable()
export class TimezoneService {
  constructor(private readonly settings: SystemSettingsService) {}

  // ── Company TZ ─────────────────────────────────────────────────────────────

  /**
   * Returns the admin-configured company IANA timezone.
   * Cached ~60 s (shared companyTzCache) to avoid a DB read on every check-in;
   * the cache is invalidated immediately when the setting is saved.
   */
  async getCompanyTZ(): Promise<string> {
    const cached = companyTzCache.get();
    if (cached) return cached;

    const tz = await this.settings.getSetting(
      'system_timezone',
      'Asia/Kolkata',
    );
    // Validate — fall back to Asia/Kolkata if garbage value stored
    const valid = DateTime.now().setZone(tz).isValid;
    const finalTz = valid ? tz : 'Asia/Kolkata';
    companyTzCache.set(finalTz);
    return finalTz;
  }

  /** Force-clear the cache (e.g., after admin saves new TZ setting). */
  invalidateCache(): void {
    companyTzCache.invalidate();
  }

  // ── Effective TZ per employee ───────────────────────────────────────────────

  /**
   * Returns the effective IANA timezone for a given employee.
   * Fallback chain: employee.timezone → company system_timezone → 'Asia/Kolkata'
   */
  async getEffectiveTZ(employeeTimezone?: string | null): Promise<string> {
    if (employeeTimezone) {
      const valid = DateTime.now().setZone(employeeTimezone).isValid;
      if (valid) return employeeTimezone;
    }
    return this.getCompanyTZ();
  }

  // ── Date key helpers ────────────────────────────────────────────────────────

  /**
   * Produce a "date key" (UTC midnight) that represents the calendar day
   * in the given IANA timezone.
   *
   * e.g. 2026-06-05T22:00:00Z + 'America/New_York' (UTC-4 summer)
   *   → local date is 2026-06-05 18:00 NY → date key: 2026-06-05T00:00:00Z
   *
   * This is what gets stored in Attendance.date (@db.Date).
   */
  toDateKey(utcDate: Date, tz: string): Date {
    const local = DateTime.fromJSDate(utcDate, { zone: 'utc' }).setZone(tz);
    return new Date(
      Date.UTC(local.year, local.month - 1, local.day, 0, 0, 0, 0),
    );
  }

  /**
   * ISO date string 'YYYY-MM-DD' representing the local calendar date
   * in the given IANA timezone.
   */
  toLocalDateStr(utcDate: Date, tz: string): string {
    return DateTime.fromJSDate(utcDate, { zone: 'utc' })
      .setZone(tz)
      .toISODate()!;
  }

  // ── Time-of-day helpers ─────────────────────────────────────────────────────

  /**
   * Minutes since midnight (0–1439) in the given IANA timezone.
   * e.g. 09:30 local → 570
   */
  localMinutesOfDay(utcDate: Date, tz: string): number {
    const dt = DateTime.fromJSDate(utcDate, { zone: 'utc' }).setZone(tz);
    return dt.hour * 60 + dt.minute;
  }

  /**
   * Hour (0–23) in the given IANA timezone.
   */
  localHour(utcDate: Date, tz: string): number {
    return DateTime.fromJSDate(utcDate, { zone: 'utc' }).setZone(tz).hour;
  }

  /**
   * Check whether the time is within "reasonable work hours" (6:00–23:00)
   * in the given IANA timezone.  Times outside this window are likely errors.
   */
  isReasonableWorkTime(utcDate: Date, tz: string): boolean {
    const hour = this.localHour(utcDate, tz);
    return hour >= 6 && hour < 23;
  }

  // ── UTC builder ─────────────────────────────────────────────────────────────

  /**
   * Build a UTC Date representing a specific HH:MM on a given calendar date
   * in the given IANA timezone, properly handling DST.
   *
   * @param localDateStr  'YYYY-MM-DD'
   * @param hour          0–23
   * @param minute        0–59
   * @param tz            IANA timezone string
   */
  buildUTCFromLocal(
    localDateStr: string,
    hour: number,
    minute: number,
    tz: string,
  ): Date {
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return DateTime.fromISO(`${localDateStr}T${hh}:${mm}:00`, { zone: tz })
      .toUTC()
      .toJSDate();
  }

  // ── Attendance day boundary helpers ─────────────────────────────────────────

  /**
   * Parse an 'HH:MM' string into minutes past midnight (0–1439).
   * Returns fallbackMinutes for malformed input.
   */
  parseTimeHHMM(value: string, fallbackMinutes: number): number {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value?.trim() ?? '');
    if (!match) return fallbackMinutes;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  /**
   * Noon rule: boundaries before 12:00 shift the attendance-day start past
   * midnight (day D covers [D 00:00+offset, D+1 00:00+offset)); boundaries
   * from 12:00 onward keep the calendar-day window.
   */
  attendanceDayStartOffset(boundaryMinutes: number): number {
    return boundaryMinutes < 720 ? boundaryMinutes : 0;
  }

  /**
   * Attendance-day date key (UTC midnight) for an instant, honoring the
   * day-end boundary. With an after-midnight boundary (e.g. 01:00), local
   * times before the boundary belong to the PREVIOUS calendar day.
   */
  toAttendanceDateKey(utcDate: Date, tz: string, boundaryMinutes: number): Date {
    const offset = this.attendanceDayStartOffset(boundaryMinutes);
    if (offset === 0) return this.toDateKey(utcDate, tz);
    let local = DateTime.fromJSDate(utcDate, { zone: 'utc' }).setZone(tz);
    if (local.hour * 60 + local.minute < offset) {
      local = local.minus({ days: 1 });
    }
    return new Date(
      Date.UTC(local.year, local.month - 1, local.day, 0, 0, 0, 0),
    );
  }

  /**
   * UTC instant at which the attendance day `localDateStr` ('YYYY-MM-DD')
   * closes: same-day boundary (>= 12:00) → that date at HH:MM; after-midnight
   * boundary (< 12:00) → the NEXT date at HH:MM.
   */
  attendanceDayEndUTC(
    localDateStr: string,
    tz: string,
    boundaryMinutes: number,
  ): Date {
    const hour = Math.floor(boundaryMinutes / 60);
    const minute = boundaryMinutes % 60;
    const dateStr =
      boundaryMinutes < 720
        ? DateTime.fromISO(localDateStr).plus({ days: 1 }).toISODate()!
        : localDateStr;
    return this.buildUTCFromLocal(dateStr, hour, minute, tz);
  }

  // ── Convenience: "now" helpers ──────────────────────────────────────────────

  /**
   * Current UTC Date as a date key in the company timezone.
   * Shorthand for: toDateKey(new Date(), await getCompanyTZ())
   */
  async nowDateKeyCompany(): Promise<Date> {
    const tz = await this.getCompanyTZ();
    return this.toDateKey(new Date(), tz);
  }

  /**
   * Current UTC Date as a date key in the given employee's effective timezone.
   */
  async nowDateKeyEmployee(employeeTimezone?: string | null): Promise<Date> {
    const tz = await this.getEffectiveTZ(employeeTimezone);
    return this.toDateKey(new Date(), tz);
  }
}
