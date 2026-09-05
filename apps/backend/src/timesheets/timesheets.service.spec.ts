import { Test, TestingModule } from '@nestjs/testing';
import { TimesheetsService } from './timesheets.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

const mockPrisma = {
  timesheet: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(),
  },
  employee: { findUnique: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn() },
};

const mockNotifications = { notifyUser: jest.fn() };

const empUser = { id: 'u1', role: 'EMPLOYEE', employeeId: 'e1' };
const adminUser = { id: 'u2', role: 'ADMIN', employeeId: 'e2' };
const managerUser = {
  id: 'u3',
  role: 'MANAGER',
  employeeId: 'e3',
  departmentId: 'd1',
};

const draftTs = {
  id: 'ts-1',
  employeeId: 'e1',
  workDate: new Date('2026-06-10'),
  hoursWorked: 7.5,
  status: 'DRAFT',
  deletedAt: null,
  employee: { departmentId: 'd1' },
};

describe('TimesheetsService', () => {
  let service: TimesheetsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimesheetsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    service = module.get<TimesheetsService>(TimesheetsService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ─── create ───────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates draft timesheet', async () => {
      mockPrisma.timesheet.create.mockResolvedValueOnce({ ...draftTs });
      const result = await service.create(
        { workDate: '2026-06-10', hoursWorked: 7.5 },
        empUser,
      );
      expect(result.success).toBe(true);
      expect(mockPrisma.timesheet.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'DRAFT',
            employeeId: 'e1',
          }),
        }),
      );
    });

    it('throws if no employeeId', async () => {
      await expect(
        service.create({ workDate: '2026-06-10', hoursWorked: 7.5 }, {
          id: 'u1',
          role: 'EMPLOYEE',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('allows owner to update draft', async () => {
      mockPrisma.timesheet.findFirst.mockResolvedValueOnce(draftTs);
      mockPrisma.timesheet.update.mockResolvedValueOnce({
        ...draftTs,
        hoursWorked: 8,
      });
      const result = await service.update('ts-1', { hoursWorked: 8 }, empUser);
      expect(result.success).toBe(true);
    });

    it('blocks non-DRAFT update', async () => {
      mockPrisma.timesheet.findFirst.mockResolvedValueOnce({
        ...draftTs,
        status: 'SUBMITTED',
      });
      await expect(
        service.update('ts-1', { hoursWorked: 8 }, empUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('blocks update by another employee', async () => {
      mockPrisma.timesheet.findFirst.mockResolvedValueOnce({
        ...draftTs,
        employeeId: 'other',
      });
      await expect(service.update('ts-1', {}, empUser)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── submit ───────────────────────────────────────────────────────────────────

  describe('submit', () => {
    it('transitions DRAFT → SUBMITTED', async () => {
      mockPrisma.timesheet.findFirst.mockResolvedValueOnce(draftTs);
      mockPrisma.timesheet.update.mockResolvedValueOnce({
        ...draftTs,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      });
      mockPrisma.user.findMany.mockResolvedValueOnce([]);
      const result = await service.submit('ts-1', empUser);
      expect(result.success).toBe(true);
      expect(mockPrisma.timesheet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SUBMITTED' }),
        }),
      );
    });

    it('throws if not DRAFT', async () => {
      mockPrisma.timesheet.findFirst.mockResolvedValueOnce({
        ...draftTs,
        status: 'SUBMITTED',
      });
      await expect(service.submit('ts-1', empUser)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── approve ──────────────────────────────────────────────────────────────────

  describe('approve', () => {
    it('ADMIN can approve SUBMITTED timesheet', async () => {
      mockPrisma.timesheet.findFirst.mockResolvedValueOnce({
        ...draftTs,
        status: 'SUBMITTED',
      });
      mockPrisma.timesheet.update.mockResolvedValueOnce({
        ...draftTs,
        status: 'APPROVED',
      });
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      mockNotifications.notifyUser.mockResolvedValueOnce({});
      const result = await service.approve('ts-1', {}, adminUser);
      expect(result.success).toBe(true);
    });

    it('EMPLOYEE cannot approve', async () => {
      await expect(service.approve('ts-1', {}, empUser)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('cannot approve non-SUBMITTED', async () => {
      mockPrisma.timesheet.findFirst.mockResolvedValueOnce({
        ...draftTs,
        status: 'DRAFT',
      });
      await expect(service.approve('ts-1', {}, adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── reject ───────────────────────────────────────────────────────────────────

  describe('reject', () => {
    it('MANAGER can reject SUBMITTED with reason', async () => {
      mockPrisma.timesheet.findFirst.mockResolvedValueOnce({
        ...draftTs,
        status: 'SUBMITTED',
      });
      mockPrisma.timesheet.update.mockResolvedValueOnce({
        ...draftTs,
        status: 'REJECTED',
      });
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'u1' });
      mockNotifications.notifyUser.mockResolvedValueOnce({});
      const result = await service.reject(
        'ts-1',
        { rejectionReason: 'Incorrect hours' },
        managerUser,
      );
      expect(result.success).toBe(true);
    });
  });
});
