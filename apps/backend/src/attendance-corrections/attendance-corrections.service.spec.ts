import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AttendanceCorrectionsService } from './attendance-corrections.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DateTime } from 'luxon';

/**
 * End-to-end style unit coverage for the attendance-request (correction) flow:
 *   - create(): monthly self-service limit, HR bypass, future-date + duplicate guards, reviewer notifications
 *   - approve(): auto-creates/updates the real Attendance row as PRESENT (regression guard),
 *                persists approver notes, computes work hours, notifies the requester
 *   - reject(): status + reason persistence, requester notification
 *
 * Prisma and all collaborators are mocked so the service logic is exercised deterministically
 * without a live database.
 */
describe('AttendanceCorrectionsService', () => {
  let service: AttendanceCorrectionsService;

  // Collaborator mocks (re-created per test via buildService()).
  let prisma: any;
  let mail: any;
  let settings: any;
  let tz: any;
  let notifications: any;

  const EMPLOYEE_ID = 'emp-1';
  const APPROVER_USER_ID = 'user-hr';

  // Settings the limit path reads; overridable per test.
  let settingsMap: Record<string, string>;

  const buildService = async () => {
    prisma = {
      employee: { findUnique: jest.fn() },
      attendance: { findUnique: jest.fn(), upsert: jest.fn() },
      attendanceCorrection: {
        count: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
      workSchedule: { findFirst: jest.fn() },
    };

    mail = {
      sendAttendanceCorrectionApproved: jest.fn().mockResolvedValue(undefined),
      sendAttendanceCorrectionRejected: jest.fn().mockResolvedValue(undefined),
    };

    settings = {
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
    };

    // Deterministic timezone stub: "today" is far in the future so any real-world
    // test date counts as past, and non-flexible schedules avoid the TZ branch.
    tz = {
      getEffectiveTZ: jest.fn().mockResolvedValue('Asia/Kolkata'),
      toDateKey: jest.fn().mockReturnValue(new Date(Date.UTC(2999, 0, 1))),
      getCompanyTZ: jest.fn().mockResolvedValue('Asia/Kolkata'),
      localMinutesOfDay: jest.fn().mockReturnValue(540),
      isReasonableWorkTime: jest.fn().mockReturnValue(true),
      // Real behaviour (mirrors TimezoneService) — approve() clamps corrections
      // to the attendance day boundary, so these cannot be inert stubs.
      parseTimeHHMM: jest.fn((value: string, fallback: number) => {
        const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value?.trim() ?? '');
        return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
      }),
      attendanceDayEndUTC: jest.fn(
        (localDateStr: string, zone: string, boundaryMinutes: number) => {
          const base = DateTime.fromISO(localDateStr, { zone });
          const day = boundaryMinutes < 720 ? base.plus({ days: 1 }) : base;
          return day
            .set({
              hour: Math.floor(boundaryMinutes / 60),
              minute: boundaryMinutes % 60,
              second: 0,
              millisecond: 0,
            })
            .toJSDate();
        },
      ),
    };

    notifications = { notifyUser: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceCorrectionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: SystemSettingsService, useValue: settings },
        { provide: TimezoneService, useValue: tz },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = moduleRef.get(AttendanceCorrectionsService);
  };

  beforeEach(async () => {
    settingsMap = {
      monthly_attendance_request_limit: '3',
      office_start_time: '09:00',
      office_end_time: '18:00',
    };
    await buildService();
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  // ── create() ──────────────────────────────────────────────────────────────
  describe('create', () => {
    const dto = {
      date: '2020-06-15',
      requestedCheckIn: '2020-06-15T09:00:00.000Z',
      requestedCheckOut: '2020-06-15T18:00:00.000Z',
      reason: 'Forgot to check in',
    };

    const primeHappyPath = () => {
      prisma.employee.findUnique.mockResolvedValue({
        id: EMPLOYEE_ID,
        timezone: null,
      });
      prisma.attendanceCorrection.count.mockResolvedValue(0);
      prisma.attendance.findUnique.mockResolvedValue(null);
      prisma.attendanceCorrection.findFirst.mockResolvedValue(null);
      prisma.attendanceCorrection.create.mockResolvedValue({
        id: 'corr-1',
        employeeId: EMPLOYEE_ID,
        date: new Date(Date.UTC(2020, 5, 15)),
        employee: { fullName: 'Raja Guru R', email: 'raja@x.com' },
      });
      prisma.user.findMany.mockResolvedValue([{ id: 'hr-1' }, { id: 'hr-2' }]);
    };

    it('throws NotFound when the employee does not exist', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);
      await expect(service.create(EMPLOYEE_ID, dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('blocks a self-service request once the monthly limit is reached', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: EMPLOYEE_ID });
      prisma.attendanceCorrection.count.mockResolvedValue(3); // == limit
      await expect(service.create(EMPLOYEE_ID, dto)).rejects.toThrow(
        /Monthly attendance request limit/,
      );
      expect(prisma.attendanceCorrection.create).not.toHaveBeenCalled();
    });

    it('allows the request when under the monthly limit', async () => {
      primeHappyPath();
      prisma.attendanceCorrection.count.mockResolvedValue(2); // < limit
      await expect(service.create(EMPLOYEE_ID, dto)).resolves.toMatchObject({
        id: 'corr-1',
      });
      expect(prisma.attendanceCorrection.create).toHaveBeenCalledTimes(1);
    });

    it('treats a limit of 0 as unlimited', async () => {
      settingsMap.monthly_attendance_request_limit = '0';
      primeHappyPath();
      prisma.attendanceCorrection.count.mockResolvedValue(999);
      await expect(service.create(EMPLOYEE_ID, dto)).resolves.toMatchObject({
        id: 'corr-1',
      });
      // count must not gate the request when unlimited
      expect(prisma.attendanceCorrection.create).toHaveBeenCalledTimes(1);
    });

    it('bypasses the limit for HR-on-behalf (skipLimit=true) without counting', async () => {
      primeHappyPath();
      await service.create(EMPLOYEE_ID, dto, true);
      expect(prisma.attendanceCorrection.count).not.toHaveBeenCalled();
      expect(prisma.attendanceCorrection.create).toHaveBeenCalledTimes(1);
    });

    it('rejects future dates', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: EMPLOYEE_ID });
      prisma.attendanceCorrection.count.mockResolvedValue(0);
      tz.toDateKey.mockReturnValue(new Date(Date.UTC(2000, 0, 1))); // "today" in the past
      await expect(service.create(EMPLOYEE_ID, dto)).rejects.toThrow(
        /future dates/,
      );
    });

    it('requires at least a check-in or check-out', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: EMPLOYEE_ID });
      prisma.attendanceCorrection.count.mockResolvedValue(0);
      await expect(
        service.create(EMPLOYEE_ID, {
          date: '2020-06-15',
          reason: 'x',
        } as any),
      ).rejects.toThrow(/at least check-in or check-out/);
    });

    it('blocks a duplicate PENDING request for the same date', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: EMPLOYEE_ID });
      prisma.attendanceCorrection.count.mockResolvedValue(0);
      prisma.attendance.findUnique.mockResolvedValue(null);
      prisma.attendanceCorrection.findFirst.mockResolvedValue({ id: 'pending' });
      await expect(service.create(EMPLOYEE_ID, dto)).rejects.toThrow(
        /already a pending correction/,
      );
    });

    it('notifies every active HR/Admin reviewer on a new request', async () => {
      primeHappyPath();
      await service.create(EMPLOYEE_ID, dto);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: { in: ['ADMIN', 'HR_MANAGER'] },
            isActive: true,
          }),
        }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledTimes(2);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'hr-1',
        expect.any(String),
        expect.stringContaining('Raja Guru R'),
        'INFO',
        '/dashboard/attendance/corrections',
      );
    });
  });

  // ── getMonthlyUsage() ────────────────────────────────────────────────────────
  describe('getMonthlyUsage', () => {
    it('reports used/limit/remaining for a bounded limit', async () => {
      settingsMap.monthly_attendance_request_limit = '3';
      prisma.attendanceCorrection.count.mockResolvedValue(2);
      await expect(service.getMonthlyUsage(EMPLOYEE_ID)).resolves.toEqual({
        used: 2,
        limit: 3,
        unlimited: false,
        remaining: 1,
      });
    });

    it('never returns negative remaining once over the limit', async () => {
      settingsMap.monthly_attendance_request_limit = '3';
      prisma.attendanceCorrection.count.mockResolvedValue(5);
      const usage = await service.getMonthlyUsage(EMPLOYEE_ID);
      expect(usage.remaining).toBe(0);
    });

    it('reports unlimited when the limit is 0', async () => {
      settingsMap.monthly_attendance_request_limit = '0';
      prisma.attendanceCorrection.count.mockResolvedValue(9);
      await expect(service.getMonthlyUsage(EMPLOYEE_ID)).resolves.toMatchObject({
        used: 9,
        unlimited: true,
        remaining: null,
      });
    });
  });

  // ── approve() ───────────────────────────────────────────────────────────────
  describe('approve', () => {
    const pendingCorrection = {
      id: 'corr-1',
      status: 'PENDING',
      employeeId: EMPLOYEE_ID,
      date: new Date(Date.UTC(2020, 5, 15)),
      originalCheckIn: null,
      originalCheckOut: null,
      requestedCheckIn: new Date('2020-06-15T09:00:00.000Z'),
      requestedCheckOut: new Date('2020-06-15T18:00:00.000Z'),
      reason: 'Forgot to check in',
      employee: { email: 'raja@x.com', fullName: 'Raja Guru R' },
    };

    const primeApprove = (overrides: any = {}) => {
      prisma.attendanceCorrection.findUnique.mockResolvedValue({
        ...pendingCorrection,
        ...overrides,
      });
      prisma.user.findUnique.mockResolvedValue({
        employee: { fullName: 'HR Admin' },
      });
      // Standard shift so the deterministic schedule branch is used.
      prisma.workSchedule.findFirst.mockResolvedValue({
        shiftType: 'STANDARD',
        startTime: new Date('2020-06-15T09:00:00.000Z'),
        endTime: new Date('2020-06-15T18:00:00.000Z'),
      });
      prisma.attendance.upsert.mockResolvedValue({});
      prisma.attendanceCorrection.update.mockResolvedValue({
        id: 'corr-1',
        status: 'APPROVED',
        employee: pendingCorrection.employee,
      });
      prisma.user.findFirst.mockResolvedValue({ id: 'requester-user' });
    };

    it('rejects approving a non-pending request', async () => {
      primeApprove({ status: 'APPROVED' });
      await expect(
        service.approve('corr-1', APPROVER_USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.attendance.upsert).not.toHaveBeenCalled();
    });

    it('upserts the attendance row as PRESENT on BOTH create and update branches (regression)', async () => {
      primeApprove();
      await service.approve('corr-1', APPROVER_USER_ID);

      expect(prisma.attendance.upsert).toHaveBeenCalledTimes(1);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      // The bug: the update branch previously omitted status, leaving a prior
      // ABSENT row stuck at ABSENT after approval.
      expect(arg.create.status).toBe('PRESENT');
      expect(arg.update.status).toBe('PRESENT');
    });

    it('computes work hours with the configured lunch deduction (09:00–18:00 => 8h)', async () => {
      primeApprove();
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBe(8);
      expect(arg.update.workHours).toBe(8);
    });

    it('skips the lunch deduction when check-in is at/after the lunch start', async () => {
      primeApprove();
      // 14:00 local check-in (>= 13:00 lunch start) => full 9h span kept.
      tz.localMinutesOfDay.mockReturnValue(840);
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBe(9);
    });

    it('skips the lunch deduction for FLEXIBLE schedules', async () => {
      primeApprove();
      prisma.workSchedule.findFirst.mockResolvedValue({
        shiftType: 'FLEXIBLE',
        startTime: null,
        endTime: null,
      });
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBe(9);
    });

    it('deducts a custom lunch duration (30 min => 8.5h)', async () => {
      primeApprove();
      settings.getLunchBreakPolicy.mockResolvedValue({
        startMinutes: 780,
        durationMinutes: 30,
      });
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBe(8.5);
    });

    it('still deducts one minute before lunch start (12:59 local)', async () => {
      primeApprove();
      tz.localMinutesOfDay.mockReturnValue(779);
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBe(8);
    });

    it('skips exactly at lunch start (13:00 local)', async () => {
      primeApprove();
      tz.localMinutesOfDay.mockReturnValue(780);
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBe(9);
    });

    it('never deducts when the admin disabled the deduction (duration 0)', async () => {
      primeApprove();
      settings.getLunchBreakPolicy.mockResolvedValue({
        startMinutes: 780,
        durationMinutes: 0,
      });
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBe(9);
    });

    it('does NOT deduct for spans at/below the 4h threshold', async () => {
      primeApprove({
        requestedCheckIn: new Date('2020-06-15T09:00:00.000Z'),
        requestedCheckOut: new Date('2020-06-15T13:00:00.000Z'),
      });
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBe(4);
    });

    it('uses original times when no requested times exist (deduction still applies)', async () => {
      primeApprove({
        requestedCheckIn: null,
        requestedCheckOut: null,
        originalCheckIn: new Date('2020-06-15T09:00:00.000Z'),
        originalCheckOut: new Date('2020-06-15T18:00:00.000Z'),
      });
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBe(8);
    });

    it('stores null workHours when a check-out is missing (no crash)', async () => {
      primeApprove({ requestedCheckOut: null, originalCheckOut: null });
      await service.approve('corr-1', APPROVER_USER_ID);
      const arg = prisma.attendance.upsert.mock.calls[0][0];
      expect(arg.create.workHours).toBeNull();
    });

    it('persists the approver notes and marks the request APPROVED', async () => {
      primeApprove();
      await service.approve('corr-1', APPROVER_USER_ID, {
        notes: 'Confirmed with manager',
      });
      expect(prisma.attendanceCorrection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'corr-1' },
          data: expect.objectContaining({
            status: 'APPROVED',
            approverId: APPROVER_USER_ID,
            approverNotes: 'Confirmed with manager',
          }),
        }),
      );
    });

    it('stores null approver notes when none are provided', async () => {
      primeApprove();
      await service.approve('corr-1', APPROVER_USER_ID);
      const data = prisma.attendanceCorrection.update.mock.calls[0][0].data;
      expect(data.approverNotes).toBeNull();
    });

    it('emails and in-app notifies the requester on approval', async () => {
      primeApprove();
      await service.approve('corr-1', APPROVER_USER_ID);
      expect(mail.sendAttendanceCorrectionApproved).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'requester-user',
        expect.stringContaining('approved'),
        expect.any(String),
        // Discriminating type, not 'INFO': the recipient's list has to tell an
        // attendance decision apart from every other message in the system.
        'ATTENDANCE_CORRECTION_APPROVED',
        '/dashboard/attendance/corrections',
      );
    });
  });

  // ── reject() ────────────────────────────────────────────────────────────────
  describe('reject', () => {
    const primeReject = (status = 'PENDING') => {
      prisma.attendanceCorrection.findUnique.mockResolvedValue({
        id: 'corr-1',
        status,
        employeeId: EMPLOYEE_ID,
        date: new Date(Date.UTC(2020, 5, 15)),
        employee: { email: 'raja@x.com', fullName: 'Raja Guru R' },
      });
      prisma.user.findUnique.mockResolvedValue({
        employee: { fullName: 'HR Admin' },
      });
      prisma.attendanceCorrection.update.mockResolvedValue({ id: 'corr-1' });
      prisma.user.findFirst.mockResolvedValue({ id: 'requester-user' });
    };

    it('rejects a non-pending request', async () => {
      primeReject('REJECTED');
      await expect(
        service.reject('corr-1', APPROVER_USER_ID, {
          rejectedReason: 'no',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('persists REJECTED + reason and never touches attendance', async () => {
      primeReject();
      await service.reject('corr-1', APPROVER_USER_ID, {
        rejectedReason: 'Insufficient evidence',
      } as any);
      expect(prisma.attendanceCorrection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'REJECTED',
            rejectedReason: 'Insufficient evidence',
          }),
        }),
      );
      expect(prisma.attendance.upsert).not.toHaveBeenCalled();
    });

    it('emails and in-app notifies the requester on rejection', async () => {
      primeReject();
      await service.reject('corr-1', APPROVER_USER_ID, {
        rejectedReason: 'nope',
      } as any);
      expect(mail.sendAttendanceCorrectionRejected).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'requester-user',
        expect.stringContaining('rejected'),
        // The reason must survive into the notification body, not just the email.
        expect.stringContaining('nope'),
        'ATTENDANCE_CORRECTION_REJECTED',
        '/dashboard/attendance/corrections',
      );
    });
  });
});
