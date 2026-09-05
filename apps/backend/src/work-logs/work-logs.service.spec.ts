import { Test, TestingModule } from '@nestjs/testing';
import { WorkLogsService } from './work-logs.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/rbac/project-access.service';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

const mockPrisma = {
  workLog: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(),
  },
  task: { findFirst: jest.fn(), update: jest.fn() },
  taskActivity: { create: jest.fn() },
};

const mockProjectAccess = {
  getAccess: jest
    .fn()
    .mockResolvedValue({ isGlobalAdmin: false, isOwner: false, permissions: [] }),
};

const empUser = { id: 'u1', role: 'EMPLOYEE', employeeId: 'e1' };
const adminUser = { id: 'u2', role: 'ADMIN', employeeId: 'e2' };

const mockTask = { id: 't1', deletedAt: null };
const mockLog = {
  id: 'wl-1',
  taskId: 't1',
  employeeId: 'e1',
  startTime: new Date('2026-06-12T09:00:00Z'),
  endTime: new Date('2026-06-12T11:00:00Z'),
  duration: 2,
  timerActive: false,
  timerPausedAt: null,
  timerPausedSecs: 0,
  deletedAt: null,
};

describe('WorkLogsService', () => {
  let service: WorkLogsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkLogsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ProjectAccessService, useValue: mockProjectAccess },
      ],
    }).compile();
    service = module.get<WorkLogsService>(WorkLogsService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ─── Manual create ────────────────────────────────────────────────────────────

  describe('create (manual)', () => {
    it('calculates duration and creates log', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce(mockTask);
      mockPrisma.workLog.create.mockResolvedValueOnce({ ...mockLog });
      mockPrisma.workLog.aggregate.mockResolvedValueOnce({
        _sum: { duration: 2 },
      });
      mockPrisma.taskActivity?.create?.mockResolvedValueOnce({});

      const result = await service.create(
        {
          taskId: 't1',
          startTime: '2026-06-12T09:00:00.000Z',
          endTime: '2026-06-12T11:00:00.000Z',
        },
        empUser,
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.workLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ duration: 2 }),
        }),
      );
    });

    it('throws if end <= start', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce(mockTask);
      await expect(
        service.create(
          {
            taskId: 't1',
            startTime: '2026-06-12T11:00:00.000Z',
            endTime: '2026-06-12T09:00:00.000Z',
          },
          empUser,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for missing task', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create(
          {
            taskId: 'bad',
            startTime: '2026-06-12T09:00:00.000Z',
            endTime: '2026-06-12T11:00:00.000Z',
          },
          empUser,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Timer ────────────────────────────────────────────────────────────────────

  describe('startTimer', () => {
    it('creates active timer entry', async () => {
      mockPrisma.workLog.findFirst.mockResolvedValueOnce(null); // no active timer
      // Timing is gated to task assignees — empUser (e1) is assigned here.
      mockPrisma.task.findFirst.mockResolvedValueOnce({
        ...mockTask,
        assignees: [{ id: 'e1' }],
      });
      mockPrisma.workLog.create.mockResolvedValueOnce({
        ...mockLog,
        timerActive: true,
        endTime: null,
      });

      const result = await service.startTimer({ taskId: 't1' }, empUser);
      expect(result.success).toBe(true);
      expect(mockPrisma.workLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ timerActive: true }),
        }),
      );
    });

    it('blocks second timer start', async () => {
      mockPrisma.workLog.findFirst.mockResolvedValueOnce({
        ...mockLog,
        timerActive: true,
      });
      await expect(
        service.startTimer({ taskId: 't1' }, empUser),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('pauseTimer', () => {
    it('sets timerPausedAt on active timer', async () => {
      mockPrisma.workLog.findFirst.mockResolvedValueOnce({
        ...mockLog,
        timerActive: true,
        timerPausedAt: null,
      });
      mockPrisma.workLog.update.mockResolvedValueOnce({
        ...mockLog,
        timerPausedAt: new Date(),
      });
      const result = await service.pauseTimer(empUser);
      expect(result.success).toBe(true);
    });

    it('throws if timer already paused', async () => {
      mockPrisma.workLog.findFirst.mockResolvedValueOnce({
        ...mockLog,
        timerActive: true,
        timerPausedAt: new Date(),
      });
      await expect(service.pauseTimer(empUser)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('stopTimer', () => {
    it('calculates net duration excluding paused time and syncs task hours', async () => {
      const start = new Date(Date.now() - 3600 * 1000); // 1h ago
      mockPrisma.workLog.findFirst.mockResolvedValueOnce({
        ...mockLog,
        timerActive: true,
        startTime: start,
        timerPausedAt: null,
        timerPausedSecs: 0,
      });
      mockPrisma.workLog.update.mockResolvedValueOnce({
        ...mockLog,
        timerActive: false,
        duration: 1,
      });
      mockPrisma.workLog.aggregate.mockResolvedValueOnce({
        _sum: { duration: 3 },
      });
      mockPrisma.task.update.mockResolvedValueOnce({});

      const result = await service.stopTimer({}, empUser);
      expect(result.success).toBe(true);
      expect(mockPrisma.workLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ timerActive: false }),
        }),
      );
    });
  });

  // ─── Ownership ────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('allows owner to delete own log', async () => {
      mockPrisma.workLog.findFirst.mockResolvedValueOnce(mockLog);
      mockPrisma.workLog.update.mockResolvedValueOnce({
        ...mockLog,
        deletedAt: new Date(),
      });
      mockPrisma.workLog.aggregate.mockResolvedValueOnce({
        _sum: { duration: 0 },
      });
      mockPrisma.task.update.mockResolvedValueOnce({});
      const result = await service.remove('wl-1', empUser);
      expect(result.success).toBe(true);
    });

    it('blocks another employee from deleting', async () => {
      mockPrisma.workLog.findFirst.mockResolvedValueOnce({
        ...mockLog,
        employeeId: 'other',
      });
      await expect(service.remove('wl-1', empUser)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
