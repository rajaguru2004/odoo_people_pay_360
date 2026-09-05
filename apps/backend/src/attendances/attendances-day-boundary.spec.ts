import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AttendancesService } from './attendances.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { MailService } from '../mail/mail.service';
import { HolidaysService } from '../holidays/holidays.service';

/**
 * Day-boundary + flexible-shift regression suite.
 *
 * Every case here maps to a bug that shipped: hours paid past the configured
 * attendance_day_end_time, a whole flexible day discarded by strict mode, a
 * multi-punch day paid for its breaks, an overnight correction/entry collapsing
 * to zero, and progress that only appeared after check-out.
 *
 * Company timezone is Asia/Kolkata (UTC+5:30) throughout: IST 09:00 = 03:30Z.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** UTC instant for a wall-clock time in Asia/Kolkata. */
const ist = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min) - IST_OFFSET_MS);

const dateKey = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));

describe('AttendancesService — attendance day boundary & flexible shifts', () => {
  let service: AttendancesService;
  let prisma: any;
  let settingsMap: Record<string, string>;

  const buildService = async () => {
    const settings = {
      getSetting: jest
        .fn()
        .mockImplementation((key: string, fallback: string) =>
          Promise.resolve(settingsMap[key] ?? fallback),
        ),
      getLunchBreakPolicy: jest
        .fn()
        .mockResolvedValue({ startMinutes: 780, durationMinutes: 60 }),
      // Branch-aware office hours, reading the SAME map the spec configures —
      // a hardcoded stub would disconnect every late/early case from the
      // `office_start_time` its own test sets.
      getOfficeHours: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({
            start: settingsMap.office_start_time ?? '08:30',
            end: settingsMap.office_end_time ?? '17:30',
          }),
        ),
      getGeofencingPolicy: jest
        .fn()
        .mockResolvedValue({
          enabled: false,
          officeLat: null,
          officeLng: null,
          radiusMeters: 100,
        }),
    };

    prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'emp-1',
          timezone: null,
          branchId: null,
          startDate: new Date(Date.UTC(2020, 0, 1)),
        }),
      },
      attendance: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'att-1', ...data }),
          ),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'att-1', ...data }),
          ),
        upsert: jest
          .fn()
          .mockImplementation(({ create }) =>
            Promise.resolve({ id: 'att-1', ...create }),
          ),
      },
      workSchedule: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const tzService = new TimezoneService(
      settings as unknown as SystemSettingsService,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendancesService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: settings },
        { provide: TimezoneService, useValue: tzService },
        { provide: MailService, useValue: {} },
        {
          provide: HolidaysService,
          useValue: { getWorkingDatesBetween: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = module.get<AttendancesService>(AttendancesService);
  };

  beforeEach(async () => {
    settingsMap = {
      system_timezone: 'Asia/Kolkata',
      office_start_time: '09:00',
      office_end_time: '18:00',
      attendance_face_only: 'false',
      allow_multiple_checkin: 'false',
      attendance_day_end_time: '23:59',
    };
    await buildService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const flexibleSchedule = (hours = 8) => ({
    shiftType: 'FLEXIBLE',
    startTime: null,
    endTime: null,
    requiredHours: hours,
  });

  // ── check-in past the day end ───────────────────────────────────────────────
  describe('checkIn', () => {
    it('rejects a check-in made after the attendance day has closed', async () => {
      settingsMap.attendance_day_end_time = '20:00';
      jest.useFakeTimers().setSystemTime(ist(2026, 6, 11, 21, 0));

      await expect(service.checkIn('emp-1')).rejects.toThrow(
        BadRequestException,
      );
      // The old behaviour created a session the cron instantly closed for 0h.
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('still allows a check-in before the boundary (regression)', async () => {
      settingsMap.attendance_day_end_time = '20:00';
      jest.useFakeTimers().setSystemTime(ist(2026, 6, 11, 19, 0));

      const res = await service.checkIn('emp-1');
      expect(res.success).toBe(true);
      expect(prisma.attendance.create).toHaveBeenCalled();
    });
  });

  // ── check-out past the day end ──────────────────────────────────────────────
  describe('checkOut', () => {
    it('trims the closing punch to the day end when the cron did not get there first', async () => {
      settingsMap.attendance_day_end_time = '20:00';
      jest.useFakeTimers().setSystemTime(ist(2026, 6, 11, 21, 30));

      prisma.attendance.findFirst.mockResolvedValue({
        id: 'att-1',
        employeeId: 'emp-1',
        date: dateKey(2026, 6, 11),
        checkIn: ist(2026, 6, 11, 9, 0),
        checkOut: null,
        notes: null,
        sessions: [{ checkIn: ist(2026, 6, 11, 9, 0), checkOut: null }],
      });

      await service.checkOut('emp-1');

      const data = prisma.attendance.update.mock.calls[0][0].data;
      expect(new Date(data.checkOut).getTime()).toBe(
        ist(2026, 6, 11, 20, 0).getTime(),
      );
      // 09:00 → 20:00 = 11h, minus the 1h lunch deduction.
      expect(data.workHours).toBe(10);
      expect(data.notes).toContain('trimmed');
    });

    it('leaves a normal check-out untouched (regression)', async () => {
      jest.useFakeTimers().setSystemTime(ist(2026, 6, 11, 18, 0));

      prisma.attendance.findFirst.mockResolvedValue({
        id: 'att-1',
        employeeId: 'emp-1',
        date: dateKey(2026, 6, 11),
        checkIn: ist(2026, 6, 11, 9, 0),
        checkOut: null,
        notes: null,
        sessions: [{ checkIn: ist(2026, 6, 11, 9, 0), checkOut: null }],
      });

      await service.checkOut('emp-1');

      const data = prisma.attendance.update.mock.calls[0][0].data;
      expect(new Date(data.checkOut).getTime()).toBe(
        ist(2026, 6, 11, 18, 0).getTime(),
      );
      expect(data.workHours).toBe(8);
      expect(data.notes).toBeUndefined();
    });
  });

  // ── strict mode must not discard closed sessions ────────────────────────────
  describe('autoCheckoutMidnight (strict mode)', () => {
    it('keeps the hours of sessions the employee DID close on a flexible day', async () => {
      settingsMap.attendance_day_end_time = '01:00';
      settingsMap.strict_attendance_mode = 'true';
      // June 12 01:00 IST — the instant the June 11 attendance day closes.
      jest.useFakeTimers().setSystemTime(ist(2026, 6, 12, 1, 0));

      prisma.attendance.findMany.mockResolvedValue([
        {
          id: 'att-1',
          employeeId: 'emp-1',
          date: dateKey(2026, 6, 11),
          checkIn: ist(2026, 6, 11, 9, 0),
          checkOut: null,
          notes: null,
          sessions: [
            {
              checkIn: ist(2026, 6, 11, 9, 0),
              checkOut: ist(2026, 6, 11, 13, 0),
            },
            { checkIn: ist(2026, 6, 11, 18, 0), checkOut: null },
          ],
          employee: { id: 'emp-1', timezone: 'Asia/Kolkata' },
        },
      ]);
      prisma.workSchedule.findFirst.mockResolvedValue(flexibleSchedule(8));

      await service.autoCheckoutMidnight();

      const data = prisma.attendance.update.mock.calls[0][0].data;
      expect(data.status).toBe('MISSED_CHECKOUT');
      // 4h closed session survives; the open one is not counted. No lunch
      // deduction on a flexible day.
      expect(data.workHours).toBe(4);
      expect(data.notes).toContain('1 unclosed session');
      expect(data.checkOut).toBeUndefined();
    });

    it('still reports zero when nothing was ever closed', async () => {
      settingsMap.attendance_day_end_time = '01:00';
      settingsMap.strict_attendance_mode = 'true';
      jest.useFakeTimers().setSystemTime(ist(2026, 6, 12, 1, 0));

      prisma.attendance.findMany.mockResolvedValue([
        {
          id: 'att-1',
          employeeId: 'emp-1',
          date: dateKey(2026, 6, 11),
          checkIn: ist(2026, 6, 11, 9, 0),
          checkOut: null,
          notes: null,
          sessions: [{ checkIn: ist(2026, 6, 11, 9, 0), checkOut: null }],
          employee: { id: 'emp-1', timezone: 'Asia/Kolkata' },
        },
      ]);

      await service.autoCheckoutMidnight();

      const data = prisma.attendance.update.mock.calls[0][0].data;
      expect(data.status).toBe('MISSED_CHECKOUT');
      expect(data.workHours).toBe(0);
    });
  });

  // ── manual entry: overnight + boundary ──────────────────────────────────────
  describe('createManualAttendance', () => {
    it('treats an earlier check-out clock time as the next morning', async () => {
      settingsMap.attendance_day_end_time = '03:00';
      prisma.workSchedule.findFirst.mockResolvedValue(flexibleSchedule(8));

      await service.createManualAttendance({
        employeeId: 'emp-1',
        date: '2026-06-11',
        checkIn: '22:00',
        checkOut: '02:00',
        status: 'PRESENT',
      });

      const { create } = prisma.attendance.upsert.mock.calls[0][0];
      expect(create.workHours).toBe(4);
    });

    it('clamps a manual entry that runs past the day end', async () => {
      settingsMap.attendance_day_end_time = '03:00';
      prisma.workSchedule.findFirst.mockResolvedValue(flexibleSchedule(8));

      await service.createManualAttendance({
        employeeId: 'emp-1',
        date: '2026-06-11',
        checkIn: '22:00',
        checkOut: '05:00',
        status: 'PRESENT',
      });

      const { create } = prisma.attendance.upsert.mock.calls[0][0];
      expect(create.workHours).toBe(5); // 22:00 → 03:00, not 07:00
    });

    it('files an after-midnight entry under the attendance day it belongs to', async () => {
      settingsMap.attendance_day_end_time = '03:00';

      await service.createManualAttendance({
        employeeId: 'emp-1',
        date: '2026-06-12',
        checkIn: '00:30',
        checkOut: '02:00',
        status: 'PRESENT',
      });

      const { where } = prisma.attendance.upsert.mock.calls[0][0];
      // 00:30 with a 03:00 boundary still belongs to June 11 — the same day an
      // ESS punch at that instant would land on.
      expect(where.unique_employee_date.date.getTime()).toBe(
        dateKey(2026, 6, 11).getTime(),
      );
    });
  });

  // ── live progress toward a flexible target ──────────────────────────────────
  describe('getTodayAttendance', () => {
    it('reports hours worked so far including the open session', async () => {
      jest.useFakeTimers().setSystemTime(ist(2026, 6, 11, 12, 0));
      prisma.workSchedule.findFirst.mockResolvedValue(flexibleSchedule(8));
      prisma.attendance.findFirst.mockResolvedValue({
        id: 'att-1',
        employeeId: 'emp-1',
        date: dateKey(2026, 6, 11),
        checkIn: ist(2026, 6, 11, 9, 0),
        checkOut: null,
        workHours: null,
        sessions: [{ checkIn: ist(2026, 6, 11, 9, 0), checkOut: null }],
      });

      const res: any = await service.getTodayAttendance('emp-1');

      expect(res.data.isFlexible).toBe(true);
      expect(res.data.workedHours).toBe(3);
      expect(res.data.targetMet).toBe(false);
      expect(res.data.shortfallHours).toBe(5);
    });

    it('marks the target met once the required hours are logged', async () => {
      jest.useFakeTimers().setSystemTime(ist(2026, 6, 11, 18, 0));
      prisma.workSchedule.findFirst.mockResolvedValue(flexibleSchedule(8));
      prisma.attendance.findFirst.mockResolvedValue({
        id: 'att-1',
        employeeId: 'emp-1',
        date: dateKey(2026, 6, 11),
        checkIn: ist(2026, 6, 11, 9, 0),
        checkOut: ist(2026, 6, 11, 18, 0),
        workHours: 9,
        sessions: [
          {
            checkIn: ist(2026, 6, 11, 9, 0),
            checkOut: ist(2026, 6, 11, 18, 0),
          },
        ],
      });

      const res: any = await service.getTodayAttendance('emp-1');

      expect(res.data.workedHours).toBe(9);
      expect(res.data.targetMet).toBe(true);
      expect(res.data.shortfallHours).toBe(0);
    });
  });

  // ── monthly view surfaces the target ────────────────────────────────────────
  describe('getEmployeeAttendances', () => {
    it('reports per-day shortfall against the flexible target', async () => {
      prisma.attendance.findMany.mockResolvedValue([
        {
          id: 'att-1',
          employeeId: 'emp-1',
          date: dateKey(2026, 6, 11),
          status: 'PRESENT',
          workHours: 5,
          isLate: false,
          isEarlyLeave: false,
          isEarlyCheckIn: false,
          isLateCheckout: false,
        },
      ]);
      prisma.workSchedule.findMany.mockResolvedValue([
        { date: dateKey(2026, 6, 11), requiredHours: 8 },
      ]);

      const res: any = await service.getEmployeeAttendances('emp-1', 6, 2026);

      expect(res.data[0].isFlexible).toBe(true);
      expect(res.data[0].shortfallHours).toBe(3);
      expect(res.data[0].targetMet).toBe(false);
      expect(res.summary.flexibleShortfallHours).toBe(3);
      expect(res.summary.flexibleDaysBelowTarget).toBe(1);
    });
  });
});
