import { Test, TestingModule } from '@nestjs/testing';
import { AttendancesService } from './attendances.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { MailService } from '../mail/mail.service';
import { HolidaysService } from '../holidays/holidays.service';

// Treats every queried date as a working day unless a test overrides it — enough
// for the auto-absent path to reach the employee loop.
const makeHolidaysMock = () => ({
  getWorkingDatesBetween: jest.fn(async (s: Date) => [s]),
  getWorkDaysBetween: jest.fn(async () => 22),
  getWorkDaysInMonth: jest.fn(async () => 22),
  isHoliday: jest.fn(async () => false),
  getHolidaysInRange: jest.fn(async () => []),
});

describe('AttendancesService - toDateKey', () => {
  let service: AttendancesService;
  let mockSettingsService: Partial<SystemSettingsService>;
  let mockPrismaService: Partial<PrismaService>;
  let mockMailService: Partial<MailService>;
  let tzService: TimezoneService;

  const mockSettings: Record<string, string> = {
    office_start_time: '08:30',
    office_end_time: '17:30',
    system_timezone: 'Asia/Kolkata',
  };

  beforeEach(async () => {
    mockSettingsService = {
      getSetting: jest
        .fn()
        .mockImplementation((key: string, fallback: string) => {
          return Promise.resolve(mockSettings[key] ?? fallback);
        }),
      /**
       * Branch-aware office hours. The service resolves start/end through this
       * (branch column -> global -> default) so `Branch.officeStartTime` and
       * `officeEndTime` are honoured. These specs have no branch, so it reads
       * the same `mockSettings` map the spec already configures — a stub with
       * hardcoded times would quietly disconnect every late/early case from the
       * values its own test sets.
       */
      getOfficeHours: jest.fn().mockImplementation(() =>
        Promise.resolve({
          start: mockSettings.office_start_time ?? '08:30',
          end: mockSettings.office_end_time ?? '17:30',
        }),
      ),
      getLunchBreakPolicy: jest.fn().mockImplementation(() => {
        const [h, m] = (mockSettings.lunch_break_start ?? '13:00')
          .split(':')
          .map(Number);
        const duration = parseInt(
          mockSettings.lunch_break_duration_minutes ?? '60',
          10,
        );
        return Promise.resolve({
          startMinutes: h * 60 + m,
          durationMinutes: isNaN(duration) ? 60 : Math.max(0, duration),
        });
      }),
    };

    mockPrismaService = {};

    mockMailService = {
      sendLunchBreakReminder: jest.fn().mockResolvedValue(undefined),
      sendDailyAttendanceReport: jest.fn().mockResolvedValue(undefined),
    };

    tzService = new TimezoneService(
      mockSettingsService as SystemSettingsService,
    );
    // Company-TZ cache is process-global; clear it so each test's mockSettings
    // timezone is read fresh instead of a value cached by a prior test.
    tzService.invalidateCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendancesService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: SystemSettingsService, useValue: mockSettingsService },
        { provide: TimezoneService, useValue: tzService },
        { provide: MailService, useValue: mockMailService },
        { provide: HolidaysService, useValue: makeHolidaysMock() },
      ],
    }).compile();

    service = module.get<AttendancesService>(AttendancesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('toAttendanceDateKey shift verification', () => {
    const callToDateKey = async (
      date: Date,
      tz?: string | null,
    ): Promise<Date> => {
      const method = (
        service as unknown as {
          toAttendanceDateKey: (
            date: Date,
            employeeTimezone?: string | null,
          ) => Promise<Date>;
        }
      ).toAttendanceDateKey;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result = await method.call(service, date, tz);
      return result as Date;
    };

    afterEach(() => {
      delete mockSettings.attendance_day_end_time;
    });

    it('should keep same day if check-in is at/after office_start_time', async () => {
      // 2026-06-11 08:30:00 AM local time in Asia/Kolkata (UTC+5:30)
      // UTC: 2026-06-11 03:00:00 AM
      const date = new Date(Date.UTC(2026, 5, 11, 3, 0, 0));
      const dateKey = await callToDateKey(date, 'Asia/Kolkata');

      // Should map to June 11 UTC midnight
      expect(dateKey.getUTCDate()).toBe(11);
      expect(dateKey.getUTCMonth()).toBe(5); // June
      expect(dateKey.getUTCFullYear()).toBe(2026);
    });

    it('should keep same day if check-in is late afternoon', async () => {
      // 2026-06-11 02:30:00 PM local time in Asia/Kolkata (UTC+5:30)
      // UTC: 2026-06-11 09:00:00 AM
      const date = new Date(Date.UTC(2026, 5, 11, 9, 0, 0));
      const dateKey = await callToDateKey(date, 'Asia/Kolkata');

      expect(dateKey.getUTCDate()).toBe(11);
      expect(dateKey.getUTCMonth()).toBe(5);
      expect(dateKey.getUTCFullYear()).toBe(2026);
    });

    it('should NOT shift to previous day if transaction is after midnight but before office_start_time', async () => {
      // 2026-06-11 01:05:00 AM local time in Asia/Kolkata (UTC+5:30)
      // UTC: 2026-06-10 07:35:00 PM
      const date = new Date(Date.UTC(2026, 5, 10, 19, 35, 0));
      const dateKey = await callToDateKey(date, 'Asia/Kolkata');

      // Should map to June 11 (UTC date 11)
      expect(dateKey.getUTCDate()).toBe(11);
      expect(dateKey.getUTCMonth()).toBe(5);
      expect(dateKey.getUTCFullYear()).toBe(2026);
    });

    it('should NOT shift to previous day if transaction is just before office_start_time', async () => {
      // 2026-06-11 08:29:00 AM local time in Asia/Kolkata (UTC+5:30)
      // UTC: 2026-06-11 02:59:00 AM
      const date = new Date(Date.UTC(2026, 5, 11, 2, 59, 0));
      const dateKey = await callToDateKey(date, 'Asia/Kolkata');

      // Should map to June 11 (UTC date 11)
      expect(dateKey.getUTCDate()).toBe(11);
      expect(dateKey.getUTCMonth()).toBe(5);
      expect(dateKey.getUTCFullYear()).toBe(2026);
    });

    it('should shift to previous day when before an after-midnight boundary (01:00)', async () => {
      mockSettings.attendance_day_end_time = '01:00';
      // 2026-06-12 00:30:00 AM local in Asia/Kolkata = 2026-06-11 19:00 UTC
      const date = new Date(Date.UTC(2026, 5, 11, 19, 0, 0));
      const dateKey = await callToDateKey(date, 'Asia/Kolkata');

      // Before the 01:00 boundary → belongs to June 11
      expect(dateKey.getUTCDate()).toBe(11);
      expect(dateKey.getUTCMonth()).toBe(5);
    });

    it('should NOT shift once the after-midnight boundary has passed (01:00 exactly)', async () => {
      mockSettings.attendance_day_end_time = '01:00';
      // 2026-06-12 01:00:00 AM local in Asia/Kolkata = 2026-06-11 19:30 UTC
      const date = new Date(Date.UTC(2026, 5, 11, 19, 30, 0));
      const dateKey = await callToDateKey(date, 'Asia/Kolkata');

      // Boundary instant belongs to the new day → June 12
      expect(dateKey.getUTCDate()).toBe(12);
      expect(dateKey.getUTCMonth()).toBe(5);
    });
  });

  describe('autoCheckoutMidnight cron job verification', () => {
    it('should auto-checkout employees checked in if local time is 11:59 PM or later', async () => {
      // We will mock now to be June 12 00:05 AM in Asia/Kolkata (June 11 18:35 UTC)
      // The open attendance is for June 11.
      const mockNow = new Date(Date.UTC(2026, 5, 11, 18, 35, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const findManyMock = jest.fn().mockResolvedValue([
        {
          id: 'attendance-1',
          employeeId: 'emp-1',
          date: new Date(Date.UTC(2026, 5, 11, 0, 0, 0)),
          checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)), // June 11 10:00 AM Asia/Kolkata
          checkOut: null,
          sessions: [
            {
              checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)),
              checkOut: null,
            },
          ],
          employee: {
            id: 'emp-1',
            timezone: 'Asia/Kolkata',
          },
        },
      ]);

      const findFirstMock = jest.fn().mockResolvedValue(null); // No work schedule
      const updateMock = jest.fn().mockResolvedValue({ id: 'attendance-1' });

      (mockPrismaService as any).attendance = {
        findMany: findManyMock,
        update: updateMock,
      };
      (mockPrismaService as any).workSchedule = {
        findFirst: findFirstMock,
      };

      await service.autoCheckoutMidnight();

      expect(findManyMock).toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalled();

      const updateCall = updateMock.mock.calls[0][0];
      expect(updateCall.where.id).toBe('attendance-1');

      // checkout time should be June 11 11:59 PM local = June 11 18:29 UTC
      const expectedCheckout = new Date(Date.UTC(2026, 5, 11, 18, 29, 0));
      expect(updateCall.data.checkOut.getTime()).toBe(
        expectedCheckout.getTime(),
      );
      expect(updateCall.data.isLateCheckout).toBe(true);

      jest.useRealTimers();
    });

    it('should NOT auto-checkout employees if local time is before 11:59 PM', async () => {
      // Current time is June 11 8:00 PM local = June 11 14:30 UTC
      const mockNow = new Date(Date.UTC(2026, 5, 11, 14, 30, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const findManyMock = jest.fn().mockResolvedValue([
        {
          id: 'attendance-1',
          employeeId: 'emp-1',
          date: new Date(Date.UTC(2026, 5, 11, 0, 0, 0)),
          checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)),
          checkOut: null,
          sessions: [
            {
              checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)),
              checkOut: null,
            },
          ],
          employee: {
            id: 'emp-1',
            timezone: 'Asia/Kolkata',
          },
        },
      ]);

      const updateMock = jest.fn();

      (mockPrismaService as any).attendance = {
        findMany: findManyMock,
        update: updateMock,
      };

      await service.autoCheckoutMidnight();

      expect(findManyMock).toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should close the previous day at the boundary when it is after midnight (01:00)', async () => {
      mockSettings.attendance_day_end_time = '01:00';
      // Now = June 12 01:00 AM Asia/Kolkata = June 11 19:30 UTC
      const mockNow = new Date(Date.UTC(2026, 5, 11, 19, 30, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const findManyMock = jest.fn().mockResolvedValue([
        {
          id: 'attendance-1',
          employeeId: 'emp-1',
          date: new Date(Date.UTC(2026, 5, 11, 0, 0, 0)), // June 11 record
          checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)),
          checkOut: null,
          sessions: [
            {
              checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)),
              checkOut: null,
            },
          ],
          employee: { id: 'emp-1', timezone: 'Asia/Kolkata' },
        },
      ]);
      const updateMock = jest.fn().mockResolvedValue({ id: 'attendance-1' });

      (mockPrismaService as any).attendance = {
        findMany: findManyMock,
        update: updateMock,
      };
      (mockPrismaService as any).workSchedule = {
        findFirst: jest.fn().mockResolvedValue(null),
      };

      await service.autoCheckoutMidnight();

      expect(updateMock).toHaveBeenCalled();
      const updateCall = updateMock.mock.calls[0][0];
      // Close time = June 12 01:00 IST = June 11 19:30 UTC (hours stay on June 11's record)
      const expectedCheckout = new Date(Date.UTC(2026, 5, 11, 19, 30, 0));
      expect(updateCall.data.checkOut.getTime()).toBe(
        expectedCheckout.getTime(),
      );
      expect(updateCall.data.isLateCheckout).toBe(true);
      expect(updateCall.data.isEarlyLeave).toBe(false);

      jest.useRealTimers();
    });

    it('should NOT close before an after-midnight boundary (00:30 with boundary 01:00)', async () => {
      mockSettings.attendance_day_end_time = '01:00';
      // Now = June 12 00:30 AM Asia/Kolkata = June 11 19:00 UTC
      const mockNow = new Date(Date.UTC(2026, 5, 11, 19, 0, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const findManyMock = jest.fn().mockResolvedValue([
        {
          id: 'attendance-1',
          employeeId: 'emp-1',
          date: new Date(Date.UTC(2026, 5, 11, 0, 0, 0)),
          checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)),
          checkOut: null,
          sessions: [
            {
              checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)),
              checkOut: null,
            },
          ],
          employee: { id: 'emp-1', timezone: 'Asia/Kolkata' },
        },
      ]);
      const updateMock = jest.fn();

      (mockPrismaService as any).attendance = {
        findMany: findManyMock,
        update: updateMock,
      };

      await service.autoCheckoutMidnight();

      expect(updateMock).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should mark MISSED_CHECKOUT with 0 hours at the boundary in strict mode', async () => {
      mockSettings.attendance_day_end_time = '01:00';
      mockSettings.strict_attendance_mode = 'true';
      const mockNow = new Date(Date.UTC(2026, 5, 11, 19, 30, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const findManyMock = jest.fn().mockResolvedValue([
        {
          id: 'attendance-1',
          employeeId: 'emp-1',
          date: new Date(Date.UTC(2026, 5, 11, 0, 0, 0)),
          checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)),
          checkOut: null,
          notes: null,
          sessions: [
            {
              checkIn: new Date(Date.UTC(2026, 5, 11, 4, 30, 0)),
              checkOut: null,
            },
          ],
          employee: { id: 'emp-1', timezone: 'Asia/Kolkata' },
        },
      ]);
      const updateMock = jest.fn().mockResolvedValue({ id: 'attendance-1' });

      (mockPrismaService as any).attendance = {
        findMany: findManyMock,
        update: updateMock,
      };
      // Strict mode now resolves the shift too (flexible days must not take the
      // lunch deduction on the sessions it keeps).
      (mockPrismaService as any).workSchedule = {
        findFirst: jest.fn().mockResolvedValue(null),
      };

      await service.autoCheckoutMidnight();

      expect(updateMock).toHaveBeenCalled();
      const updateCall = updateMock.mock.calls[0][0];
      expect(updateCall.data.status).toBe('MISSED_CHECKOUT');
      expect(updateCall.data.workHours).toBe(0);
      expect(updateCall.data.checkOut).toBeUndefined();

      delete mockSettings.strict_attendance_mode;
      jest.useRealTimers();
    });

    afterEach(() => {
      delete mockSettings.attendance_day_end_time;
    });
  });

  describe('autoMarkAbsent cron dynamic timing verification', () => {
    afterEach(() => {
      delete mockSettings.attendance_day_end_time;
    });

    it('should skip if not the day-end boundary when isManual = false', async () => {
      // 10:00 AM local time in Asia/Kolkata
      const mockNow = new Date(Date.UTC(2026, 5, 11, 4, 30, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const result = await service.autoMarkAbsent(false);
      expect(result).toEqual({
        success: true,
        message: 'Skipped (Not day-end boundary)',
      });

      jest.useRealTimers();
    });

    it('should proceed at the default boundary (23:59) when isManual = false', async () => {
      // 11:59 PM local time in Asia/Kolkata = 18:29 UTC
      const mockNow = new Date(Date.UTC(2026, 5, 11, 18, 29, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const findManyEmployeeMock = jest.fn().mockResolvedValue([]);
      const findFirstHolidayMock = jest.fn().mockResolvedValue(null);

      (mockPrismaService as any).employee = { findMany: findManyEmployeeMock };
      (mockPrismaService as any).holiday = { findFirst: findFirstHolidayMock };

      const result = await service.autoMarkAbsent(false);
      expect(result.success).toBe(true);
      expect(findManyEmployeeMock).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should mark the PREVIOUS day absent at an after-midnight boundary (01:00)', async () => {
      mockSettings.attendance_day_end_time = '01:00';
      // Now = Friday June 12 01:00 AM IST = June 11 19:30 UTC
      const mockNow = new Date(Date.UTC(2026, 5, 11, 19, 30, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const findManyEmployeeMock = jest.fn().mockResolvedValue([
        {
          id: 'emp-1',
          employeeCode: 'EMP001',
          fullName: 'John Doe',
          email: 'john@test.com',
          department: { name: 'Engineering' },
        },
      ]);
      const findFirstHolidayMock = jest.fn().mockResolvedValue(null);
      const findUniqueAttendanceMock = jest.fn().mockResolvedValue(null);
      const findFirstLeaveMock = jest.fn().mockResolvedValue(null);
      const createAttendanceMock = jest.fn().mockResolvedValue({});

      (mockPrismaService as any).employee = { findMany: findManyEmployeeMock };
      (mockPrismaService as any).holiday = { findFirst: findFirstHolidayMock };
      (mockPrismaService as any).attendance = {
        findUnique: findUniqueAttendanceMock,
        create: createAttendanceMock,
      };
      (mockPrismaService as any).leaveRequest = {
        findFirst: findFirstLeaveMock,
      };

      const result = await service.autoMarkAbsent(false);
      expect(result.success).toBe(true);
      expect(createAttendanceMock).toHaveBeenCalled();

      // The ABSENT row must be dated June 11 (the day that just closed), not June 12
      const createCall = createAttendanceMock.mock.calls[0][0];
      expect(createCall.data.date.getUTCDate()).toBe(11);
      expect(createCall.data.date.getUTCMonth()).toBe(5);
      expect(createCall.data.status).toBe('ABSENT');

      jest.useRealTimers();
    });
  });

  describe('sendDailyAttendanceReportCron verification', () => {
    it('should send report if enabled and time matches office_end_time', async () => {
      // 5:30 PM local time in Asia/Kolkata = 12:00 PM UTC
      const mockNow = new Date(Date.UTC(2026, 5, 11, 12, 0, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const activeEmployees = [
        {
          id: 'emp-1',
          fullName: 'John Doe',
          employeeCode: 'EMP001',
          department: { name: 'Engineering' },
        },
      ];
      const attendances = [
        {
          id: 'att-1',
          employeeId: 'emp-1',
          date: new Date(Date.UTC(2026, 5, 11, 0, 0, 0)),
          status: 'PRESENT',
          checkIn: new Date(Date.UTC(2026, 5, 11, 3, 0, 0)),
          checkOut: new Date(Date.UTC(2026, 5, 11, 12, 0, 0)),
          workHours: 8,
          isLate: false,
          isEarlyLeave: false,
          isLateCheckout: false,
        },
      ];

      const findManyEmployeeMock = jest.fn().mockResolvedValue(activeEmployees);
      const findManyAttendanceMock = jest
        .fn()
        .mockResolvedValue(attendances);
      const findManyLeaveMock = jest.fn().mockResolvedValue([]);
      const findFirstHolidayMock = jest.fn().mockResolvedValue(null);

      const findUniqueAttendanceMock = jest.fn().mockResolvedValue(attendances[0]);
      const createAttendanceMock = jest.fn().mockResolvedValue(null);

      (mockPrismaService as any).employee = { findMany: findManyEmployeeMock };
      (mockPrismaService as any).attendance = {
        findMany: findManyAttendanceMock,
        findUnique: findUniqueAttendanceMock,
        create: createAttendanceMock,
      };
      (mockPrismaService as any).leaveRequest = { findMany: findManyLeaveMock };
      (mockPrismaService as any).holiday = { findFirst: findFirstHolidayMock };

      await service.sendDailyAttendanceReportCron();

      expect(mockMailService.sendDailyAttendanceReport).toHaveBeenCalledWith(
        expect.objectContaining({
          date: '2026-06-11',
          totalEmployees: 1,
          presentCount: 1,
          absentCount: 0,
          onLeaveCount: 0,
        }),
      );
      // Absentees are computed dynamically — the report must never persist rows
      expect(createAttendanceMock).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should count no-record employees as absent dynamically without persisting', async () => {
      // 5:30 PM local time in Asia/Kolkata = 12:00 PM UTC
      const mockNow = new Date(Date.UTC(2026, 5, 11, 12, 0, 0));
      jest.useFakeTimers().setSystemTime(mockNow);

      const activeEmployees = [
        {
          id: 'emp-1',
          fullName: 'John Doe',
          employeeCode: 'EMP001',
          department: { name: 'Engineering' },
        },
      ];

      const createAttendanceMock = jest.fn();
      (mockPrismaService as any).employee = {
        findMany: jest.fn().mockResolvedValue(activeEmployees),
      };
      (mockPrismaService as any).attendance = {
        findMany: jest.fn().mockResolvedValue([]), // no records yet
        create: createAttendanceMock,
      };
      (mockPrismaService as any).leaveRequest = {
        findMany: jest.fn().mockResolvedValue([]),
      };
      (mockPrismaService as any).holiday = {
        findFirst: jest.fn().mockResolvedValue(null),
      };

      await service.sendDailyAttendanceReportCron();

      expect(mockMailService.sendDailyAttendanceReport).toHaveBeenCalledWith(
        expect.objectContaining({
          date: '2026-06-11',
          totalEmployees: 1,
          presentCount: 0,
          absentCount: 1,
        }),
      );
      expect(createAttendanceMock).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('flexible shift behaviour', () => {
    const sumSessionHours = (
      sessions: any[],
      lunchDeductionHours?: number,
    ): number =>
      (
        service as unknown as {
          sumSessionHours: (s: any[], d?: number) => number;
        }
      ).sumSessionHours.call(service, sessions, lunchDeductionHours);

    it('deducts the lunch break for fixed shifts when total exceeds 4h', () => {
      const base = Date.UTC(2026, 5, 11, 3, 0, 0);
      const sessions = [
        { checkIn: new Date(base), checkOut: new Date(base + 5 * 3600 * 1000) },
      ];
      expect(sumSessionHours(sessions, 1)).toBe(4); // 5h - 1h lunch
    });

    it('deducts a custom lunch duration (30 min)', () => {
      const base = Date.UTC(2026, 5, 11, 3, 0, 0);
      const sessions = [
        { checkIn: new Date(base), checkOut: new Date(base + 5 * 3600 * 1000) },
      ];
      expect(sumSessionHours(sessions, 0.5)).toBe(4.5); // 5h - 30min lunch
    });

    it('does NOT deduct when total is exactly at the 4h threshold', () => {
      const base = Date.UTC(2026, 5, 11, 3, 0, 0);
      const sessions = [
        { checkIn: new Date(base), checkOut: new Date(base + 4 * 3600 * 1000) },
      ];
      expect(sumSessionHours(sessions, 1)).toBe(4);
    });

    it('does NOT deduct lunch for flexible shifts and excludes LUNCH sessions', () => {
      const base = Date.UTC(2026, 5, 11, 3, 0, 0);
      const sessions = [
        { checkIn: new Date(base), checkOut: new Date(base + 3 * 3600 * 1000) }, // 3h work
        { type: 'LUNCH', checkIn: new Date(base + 3 * 3600 * 1000), checkOut: new Date(base + 4 * 3600 * 1000) },
        { checkIn: new Date(base + 4 * 3600 * 1000), checkOut: new Date(base + 6 * 3600 * 1000) }, // 2h work
      ];
      expect(sumSessionHours(sessions, 0)).toBe(5); // 3 + 2, lunch excluded, no deduction
    });

    it('does NOT apply the flat deduction when an explicit LUNCH session exists', () => {
      const base = Date.UTC(2026, 5, 11, 3, 0, 0);
      const sessions = [
        { checkIn: new Date(base), checkOut: new Date(base + 3 * 3600 * 1000) }, // 3h work
        { type: 'LUNCH', checkIn: new Date(base + 3 * 3600 * 1000), checkOut: new Date(base + 4 * 3600 * 1000) },
        { checkIn: new Date(base + 4 * 3600 * 1000), checkOut: new Date(base + 6 * 3600 * 1000) }, // 2h work
      ];
      // Even with a deduction requested, the tracked lunch already excluded
      // its time from the sum — no double deduction.
      expect(sumSessionHours(sessions, 1)).toBe(5);
    });

    it('checkOut on a flexible shift skips lunch deduction and late/early flags', async () => {
      const mockNow = new Date(Date.UTC(2026, 5, 11, 12, 0, 0)); // 17:30 IST
      jest.useFakeTimers().setSystemTime(mockNow);

      const sessionStart = new Date(mockNow.getTime() - 5 * 3600 * 1000); // checked in 5h ago
      const updateMock = jest
        .fn()
        .mockImplementation((args: any) => Promise.resolve({ id: 'att-1', ...args.data }));

      (mockPrismaService as any).employee = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'emp-1', timezone: 'Asia/Kolkata' }),
      };
      (mockPrismaService as any).attendance = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'att-1',
          employeeId: 'emp-1',
          date: new Date(Date.UTC(2026, 5, 11, 0, 0, 0)),
          checkIn: sessionStart,
          checkOut: null,
          sessions: [{ checkIn: sessionStart, checkOut: null }],
        }),
        update: updateMock,
      };
      (mockPrismaService as any).workSchedule = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ws-1',
          shiftType: 'FLEXIBLE',
          requiredHours: 8,
          startTime: null,
          endTime: null,
          isWorkDay: true,
        }),
      };

      await service.checkOut('emp-1', true);

      expect(updateMock).toHaveBeenCalled();
      const updateCall = updateMock.mock.calls[0][0];
      expect(updateCall.data.workHours).toBe(5); // full 5h, no lunch deduction
      expect(updateCall.data.isEarlyLeave).toBe(false);
      expect(updateCall.data.isLateCheckout).toBe(false);

      jest.useRealTimers();
    });
  });

  describe('getLunchDeductionHours gate', () => {
    const getLunchDeductionHours = (
      checkIn: Date | string | null,
      isFlexible: boolean,
    ): Promise<number> =>
      (
        service as unknown as {
          getLunchDeductionHours: (
            c: Date | string | null,
            f: boolean,
          ) => Promise<number>;
        }
      ).getLunchDeductionHours.call(service, checkIn, isFlexible);

    afterEach(() => {
      delete mockSettings.lunch_break_start;
      delete mockSettings.lunch_break_duration_minutes;
      delete mockSettings.system_timezone;
    });

    it('returns 0 for flexible shifts without reading the policy', async () => {
      const checkIn = new Date(Date.UTC(2026, 5, 11, 3, 30, 0)); // 09:00 IST
      await expect(getLunchDeductionHours(checkIn, true)).resolves.toBe(0);
      expect(
        (mockSettingsService as any).getLunchBreakPolicy,
      ).not.toHaveBeenCalled();
    });

    it('returns 0 when the admin disabled the deduction (duration 0)', async () => {
      mockSettings.lunch_break_duration_minutes = '0';
      const checkIn = new Date(Date.UTC(2026, 5, 11, 3, 30, 0));
      await expect(getLunchDeductionHours(checkIn, false)).resolves.toBe(0);
    });

    it('deducts for a check-in one minute BEFORE lunch start (12:59 IST)', async () => {
      const checkIn = new Date(Date.UTC(2026, 5, 11, 7, 29, 0)); // 12:59 IST
      await expect(getLunchDeductionHours(checkIn, false)).resolves.toBe(1);
    });

    it('skips for a check-in EXACTLY at lunch start (13:00 IST)', async () => {
      const checkIn = new Date(Date.UTC(2026, 5, 11, 7, 30, 0)); // 13:00 IST
      await expect(getLunchDeductionHours(checkIn, false)).resolves.toBe(0);
    });

    it('skips for a mid-lunch check-in (13:30 IST)', async () => {
      const checkIn = new Date(Date.UTC(2026, 5, 11, 8, 0, 0)); // 13:30 IST
      await expect(getLunchDeductionHours(checkIn, false)).resolves.toBe(0);
    });

    it('skips for an evening/NIGHT-shift check-in (18:00 IST)', async () => {
      const checkIn = new Date(Date.UTC(2026, 5, 11, 12, 30, 0)); // 18:00 IST
      await expect(getLunchDeductionHours(checkIn, false)).resolves.toBe(0);
    });

    it('respects a custom lunch start (14:00): 13:30 check-in still deducts', async () => {
      mockSettings.lunch_break_start = '14:00';
      const checkIn = new Date(Date.UTC(2026, 5, 11, 8, 0, 0)); // 13:30 IST
      await expect(getLunchDeductionHours(checkIn, false)).resolves.toBe(1);
    });

    it('converts a custom duration to hours (45 min => 0.75h)', async () => {
      mockSettings.lunch_break_duration_minutes = '45';
      const checkIn = new Date(Date.UTC(2026, 5, 11, 3, 30, 0)); // 09:00 IST
      await expect(getLunchDeductionHours(checkIn, false)).resolves.toBe(0.75);
    });

    it('evaluates the gate in the configured company timezone', async () => {
      // 14:30 EDT (America/New_York, June) = 18:30 UTC — after lunch start.
      mockSettings.system_timezone = 'America/New_York';
      const checkIn = new Date(Date.UTC(2026, 5, 11, 18, 30, 0));
      await expect(getLunchDeductionHours(checkIn, false)).resolves.toBe(0);
      // 09:00 EDT = 13:00 UTC — before lunch start, deducts.
      const morning = new Date(Date.UTC(2026, 5, 11, 13, 0, 0));
      await expect(getLunchDeductionHours(morning, false)).resolves.toBe(1);
    });

    it('accepts an ISO-string check-in', async () => {
      await expect(
        getLunchDeductionHours('2026-06-11T03:30:00.000Z', false),
      ).resolves.toBe(1);
    });

    it('falls back to deducting when no check-in instant is available', async () => {
      await expect(getLunchDeductionHours(null, false)).resolves.toBe(1);
    });
  });

  describe('calculateWorkHours mechanics', () => {
    const calculateWorkHours = (
      checkIn: Date,
      checkOut: Date,
      lunchDeductionHours?: number,
    ): number =>
      (
        service as unknown as {
          calculateWorkHours: (a: Date, b: Date, d?: number) => number;
        }
      ).calculateWorkHours.call(service, checkIn, checkOut, lunchDeductionHours);

    it('applies the dynamic deduction over the 4h threshold', () => {
      const base = Date.UTC(2026, 5, 11, 3, 30, 0);
      const checkIn = new Date(base);
      const checkOut = new Date(base + 9 * 3600 * 1000);
      expect(calculateWorkHours(checkIn, checkOut, 1)).toBe(8);
      expect(calculateWorkHours(checkIn, checkOut, 0.5)).toBe(8.5);
      expect(calculateWorkHours(checkIn, checkOut, 0)).toBe(9);
    });

    it('does NOT deduct at or below the 4h threshold', () => {
      const base = Date.UTC(2026, 5, 11, 3, 30, 0);
      const checkIn = new Date(base);
      expect(
        calculateWorkHours(checkIn, new Date(base + 4 * 3600 * 1000), 1),
      ).toBe(4);
      expect(
        calculateWorkHours(checkIn, new Date(base + 3 * 3600 * 1000), 1),
      ).toBe(3);
    });

    it('handles overnight spans (checkout clock-time before check-in)', () => {
      // 22:00 -> 04:00 same-date values = -18h, normalized to 6h.
      const checkIn = new Date(Date.UTC(2026, 5, 11, 22, 0, 0));
      const checkOut = new Date(Date.UTC(2026, 5, 11, 4, 0, 0));
      expect(calculateWorkHours(checkIn, checkOut, 0)).toBe(6);
      expect(calculateWorkHours(checkIn, checkOut, 1)).toBe(5);
    });

    it('caps unreasonable spans at 24h before deducting', () => {
      const checkIn = new Date(Date.UTC(2026, 5, 11, 0, 0, 0));
      const checkOut = new Date(Date.UTC(2026, 5, 12, 6, 0, 0)); // 30h
      expect(calculateWorkHours(checkIn, checkOut, 1)).toBe(23);
    });
  });

  describe('lunch deduction policy on checkOut', () => {
    const primeCheckOut = (
      checkInUTC: Date,
      nowUTC: Date,
      sessions?: any[],
    ) => {
      jest.useFakeTimers().setSystemTime(nowUTC);

      const updateMock = jest
        .fn()
        .mockImplementation((args: any) =>
          Promise.resolve({ id: 'att-1', ...args.data }),
        );

      (mockPrismaService as any).employee = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'emp-1', timezone: 'Asia/Kolkata' }),
      };
      (mockPrismaService as any).attendance = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'att-1',
          employeeId: 'emp-1',
          date: new Date(Date.UTC(2026, 5, 11, 0, 0, 0)),
          checkIn: checkInUTC,
          checkOut: null,
          sessions: sessions ?? [{ checkIn: checkInUTC, checkOut: null }],
        }),
        update: updateMock,
      };
      (mockPrismaService as any).workSchedule = {
        findFirst: jest.fn().mockResolvedValue(null), // no schedule = fixed shift
      };

      return updateMock;
    };

    afterEach(() => {
      delete mockSettings.lunch_break_start;
      delete mockSettings.lunch_break_duration_minutes;
      delete mockSettings.allow_multiple_checkin;
      jest.useRealTimers();
    });

    it('deducts the lunch break when check-in is before lunch start', async () => {
      // 09:00 IST check-in, 18:00 IST check-out => 9h - 1h lunch = 8h
      const checkIn = new Date(Date.UTC(2026, 5, 11, 3, 30, 0));
      const now = new Date(Date.UTC(2026, 5, 11, 12, 30, 0));
      const updateMock = primeCheckOut(checkIn, now);

      await service.checkOut('emp-1', true);

      expect(updateMock.mock.calls[0][0].data.workHours).toBe(8);
    });

    it('skips the deduction when check-in is at/after lunch start (evening shift)', async () => {
      // 14:00 IST check-in, 20:00 IST check-out => full 6h, no deduction
      const checkIn = new Date(Date.UTC(2026, 5, 11, 8, 30, 0));
      const now = new Date(Date.UTC(2026, 5, 11, 14, 30, 0));
      const updateMock = primeCheckOut(checkIn, now);

      await service.checkOut('emp-1', true);

      expect(updateMock.mock.calls[0][0].data.workHours).toBe(6);
    });

    it('deducts the configured custom duration', async () => {
      mockSettings.lunch_break_duration_minutes = '30';
      // 09:00 IST check-in, 18:00 IST check-out => 9h - 0.5h = 8.5h
      const checkIn = new Date(Date.UTC(2026, 5, 11, 3, 30, 0));
      const now = new Date(Date.UTC(2026, 5, 11, 12, 30, 0));
      const updateMock = primeCheckOut(checkIn, now);

      await service.checkOut('emp-1', true);

      expect(updateMock.mock.calls[0][0].data.workHours).toBe(8.5);
    });

    it('never deducts when the duration is set to 0', async () => {
      mockSettings.lunch_break_duration_minutes = '0';
      const checkIn = new Date(Date.UTC(2026, 5, 11, 3, 30, 0));
      const now = new Date(Date.UTC(2026, 5, 11, 12, 30, 0));
      const updateMock = primeCheckOut(checkIn, now);

      await service.checkOut('emp-1', true);

      expect(updateMock.mock.calls[0][0].data.workHours).toBe(9);
    });

    it('deducts for a check-in one minute before lunch start (12:59 IST)', async () => {
      // 12:59 IST check-in, 19:59 IST check-out => 7h - 1h = 6h
      const checkIn = new Date(Date.UTC(2026, 5, 11, 7, 29, 0));
      const now = new Date(Date.UTC(2026, 5, 11, 14, 29, 0));
      const updateMock = primeCheckOut(checkIn, now);

      await service.checkOut('emp-1', true);

      expect(updateMock.mock.calls[0][0].data.workHours).toBe(6);
    });

    it('skips for a check-in exactly at lunch start (13:00 IST)', async () => {
      // 13:00 IST check-in, 20:00 IST check-out => full 7h
      const checkIn = new Date(Date.UTC(2026, 5, 11, 7, 30, 0));
      const now = new Date(Date.UTC(2026, 5, 11, 14, 30, 0));
      const updateMock = primeCheckOut(checkIn, now);

      await service.checkOut('emp-1', true);

      expect(updateMock.mock.calls[0][0].data.workHours).toBe(7);
    });

    it('does NOT double-deduct on a fixed shift with an explicit LUNCH session', async () => {
      // 09:00-13:00 IST work, 13:00-14:00 IST tracked lunch, 14:00-18:00 IST work.
      const s1In = new Date(Date.UTC(2026, 5, 11, 3, 30, 0));
      const s1Out = new Date(Date.UTC(2026, 5, 11, 7, 30, 0));
      const lunchIn = s1Out;
      const lunchOut = new Date(Date.UTC(2026, 5, 11, 8, 30, 0));
      const now = new Date(Date.UTC(2026, 5, 11, 12, 30, 0)); // 18:00 IST
      mockSettings.allow_multiple_checkin = 'true';

      const updateMock = primeCheckOut(s1In, now, [
        { checkIn: s1In, checkOut: s1Out },
        { type: 'LUNCH', checkIn: lunchIn, checkOut: lunchOut },
        { checkIn: lunchOut, checkOut: null },
      ]);

      await service.checkOut('emp-1', true);

      // 4h + 4h work; the tracked lunch hour is excluded from the sum and the
      // flat deduction is suppressed — previously this wrongly yielded 7h.
      expect(updateMock.mock.calls[0][0].data.workHours).toBe(8);
    });

    it('applies the flat deduction across multiple plain work sessions', async () => {
      // 09:00-11:00 and 11:30-18:00 IST (gap, no LUNCH type) => 8.5h - 1h = 7.5h
      const s1In = new Date(Date.UTC(2026, 5, 11, 3, 30, 0));
      const s1Out = new Date(Date.UTC(2026, 5, 11, 5, 30, 0));
      const s2In = new Date(Date.UTC(2026, 5, 11, 6, 0, 0));
      const now = new Date(Date.UTC(2026, 5, 11, 12, 30, 0));
      mockSettings.allow_multiple_checkin = 'true';

      const updateMock = primeCheckOut(s1In, now, [
        { checkIn: s1In, checkOut: s1Out },
        { checkIn: s2In, checkOut: null },
      ]);

      await service.checkOut('emp-1', true);

      expect(updateMock.mock.calls[0][0].data.workHours).toBe(7.5);
    });
  });

  describe('lunch deduction policy on createManualAttendance', () => {
    const primeManual = () => {
      const upsertMock = jest
        .fn()
        .mockImplementation((args: any) =>
          Promise.resolve({ id: 'att-1', ...args.create }),
        );

      (mockPrismaService as any).employee = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'emp-1', timezone: null }),
      };
      (mockPrismaService as any).attendance = { upsert: upsertMock };
      (mockPrismaService as any).workSchedule = {
        findFirst: jest.fn().mockResolvedValue(null),
      };

      return upsertMock;
    };

    afterEach(() => {
      delete mockSettings.lunch_break_start;
      delete mockSettings.lunch_break_duration_minutes;
    });

    it('deducts for an HH:MM morning entry (09:00-18:00 IST => 8h)', async () => {
      const upsertMock = primeManual();

      await service.createManualAttendance({
        employeeId: 'emp-1',
        date: '2026-06-11',
        checkIn: '09:00',
        checkOut: '18:00',
      });

      expect(upsertMock.mock.calls[0][0].create.workHours).toBe(8);
      expect(upsertMock.mock.calls[0][0].update.workHours).toBe(8);
    });

    it('skips for an HH:MM afternoon entry (14:00-20:00 IST => 6h)', async () => {
      const upsertMock = primeManual();

      await service.createManualAttendance({
        employeeId: 'emp-1',
        date: '2026-06-11',
        checkIn: '14:00',
        checkOut: '20:00',
      });

      expect(upsertMock.mock.calls[0][0].create.workHours).toBe(6);
    });

    it('deducts for ISO-timestamp inputs (03:30Z = 09:00 IST)', async () => {
      const upsertMock = primeManual();

      await service.createManualAttendance({
        employeeId: 'emp-1',
        date: '2026-06-11',
        checkIn: '2026-06-11T03:30:00.000Z',
        checkOut: '2026-06-11T12:30:00.000Z',
      });

      expect(upsertMock.mock.calls[0][0].create.workHours).toBe(8);
    });

    it('applies a custom duration to manual entries (30 min => 8.5h)', async () => {
      mockSettings.lunch_break_duration_minutes = '30';
      const upsertMock = primeManual();

      await service.createManualAttendance({
        employeeId: 'emp-1',
        date: '2026-06-11',
        checkIn: '09:00',
        checkOut: '18:00',
      });

      expect(upsertMock.mock.calls[0][0].create.workHours).toBe(8.5);
    });

    it('never deducts for a FLEXIBLE schedule on manual entry', async () => {
      const upsertMock = primeManual();
      (mockPrismaService as any).workSchedule = {
        findFirst: jest.fn().mockResolvedValue({
          shiftType: 'FLEXIBLE',
          requiredHours: 8,
          startTime: null,
          endTime: null,
          isWorkDay: true,
        }),
      };

      await service.createManualAttendance({
        employeeId: 'emp-1',
        date: '2026-06-11',
        checkIn: '09:00',
        checkOut: '18:00',
      });

      expect(upsertMock.mock.calls[0][0].create.workHours).toBe(9);
    });
  });
});

describe('AttendancesService - geofencing on checkIn', () => {
  let service: AttendancesService;
  let mockSettingsService: Partial<SystemSettingsService> & {
    getGeofencingPolicy: jest.Mock;
  };
  let mockPrismaService: any;
  let mockMailService: Partial<MailService>;
  let tzService: TimezoneService;

  let geofencePolicy: {
    enabled: boolean;
    officeLat: number | null;
    officeLng: number | null;
    radiusMeters: number;
  };

  beforeEach(async () => {
    geofencePolicy = {
      enabled: false,
      officeLat: null,
      officeLng: null,
      radiusMeters: 100,
    };

    mockSettingsService = {
      getSetting: jest.fn().mockImplementation((key: string, fallback: string) => {
        const defaults: Record<string, string> = {
          office_start_time: '08:30',
          office_end_time: '17:30',
          system_timezone: 'Asia/Kolkata',
          attendance_face_only: 'false',
          allow_multiple_checkin: 'false',
        };
        return Promise.resolve(defaults[key] ?? fallback);
      }),
      getGeofencingPolicy: jest.fn().mockImplementation(() => Promise.resolve(geofencePolicy)),
      // Same defaults this mock's `getSetting` serves, so the branch-aware
      // resolver and the global one agree in a spec that has no branch.
      getOfficeHours: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ start: '08:30', end: '17:30' }),
        ),
    };

    mockPrismaService = {
      employee: {
        findUnique: jest.fn().mockResolvedValue({ id: 'emp-1', timezone: null }),
      },
      attendance: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'att-1', ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'att-1', ...data })),
      },
      workSchedule: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    mockMailService = {};

    tzService = new TimezoneService(
      mockSettingsService as unknown as SystemSettingsService,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendancesService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: SystemSettingsService, useValue: mockSettingsService },
        { provide: TimezoneService, useValue: tzService },
        { provide: MailService, useValue: mockMailService },
        { provide: HolidaysService, useValue: makeHolidaysMock() },
      ],
    }).compile();

    service = module.get<AttendancesService>(AttendancesService);
  });

  it('succeeds without coords when geofencing is disabled', async () => {
    const result = await service.checkIn('emp-1');
    expect(result.success).toBe(true);
    expect(mockPrismaService.attendance.create).toHaveBeenCalled();
  });

  it('throws BadRequestException when enabled but office location is not configured', async () => {
    geofencePolicy.enabled = true;
    await expect(
      service.checkIn('emp-1', false, { latitude: 13.08, longitude: 80.27 }),
    ).rejects.toThrow('Geofencing is enabled but office location has not been configured');
  });

  it('throws BadRequestException when enabled and coords are missing', async () => {
    geofencePolicy = {
      enabled: true,
      officeLat: 13.0827,
      officeLng: 80.2707,
      radiusMeters: 100,
    };
    await expect(service.checkIn('emp-1')).rejects.toThrow(
      'Location access is required to check in',
    );
  });

  it('throws ForbiddenException with distance when outside the radius', async () => {
    geofencePolicy = {
      enabled: true,
      officeLat: 13.0827,
      officeLng: 80.2707,
      radiusMeters: 100,
    };
    // ~1.1km away (0.01 degrees latitude)
    await expect(
      service.checkIn('emp-1', false, { latitude: 13.0927, longitude: 80.2707 }),
    ).rejects.toThrow('You are out of office range');
  });

  it('succeeds and persists coords when within the radius', async () => {
    geofencePolicy = {
      enabled: true,
      officeLat: 13.0827,
      officeLng: 80.2707,
      radiusMeters: 100,
    };
    const result = await service.checkIn('emp-1', false, {
      latitude: 13.0827,
      longitude: 80.2707,
      accuracy: 15,
    });
    expect(result.success).toBe(true);
    const createArgs = mockPrismaService.attendance.create.mock.calls[0][0];
    expect(createArgs.data.checkInLatitude).toBe(13.0827);
    expect(createArgs.data.checkInLongitude).toBe(80.2707);
    expect(createArgs.data.checkInAccuracy).toBe(15);
  });

  it('skips the geofence check when skipGeofence is true, even out of range', async () => {
    geofencePolicy = {
      enabled: true,
      officeLat: 13.0827,
      officeLng: 80.2707,
      radiusMeters: 100,
    };
    const result = await service.checkIn(
      'emp-1',
      false,
      { latitude: 20, longitude: 80 },
      true,
    );
    expect(result.success).toBe(true);
  });
});
