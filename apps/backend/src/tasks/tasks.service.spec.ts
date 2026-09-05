import { Test, TestingModule } from '@nestjs/testing';
import { TasksService } from './tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkLogsService } from '../work-logs/work-logs.service';
import { MailService } from '../mail/mail.service';
import { ProjectAccessService } from '../projects/rbac/project-access.service';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';

const mockPrisma = {
  // Task codes are generated via a raw MAX() query, not an ORM read.
  $queryRawUnsafe: jest.fn().mockResolvedValue([{ max: null }]),
  task: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  taskActivity: {
    create: jest.fn(),
    createMany: jest.fn(),
  },
  employee: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  label: {
    findMany: jest.fn(),
  },
  sprint: {
    findUnique: jest.fn(),
  },
  projectTaskStatus: {
    findUnique: jest.fn(),
  },
  taskDependency: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  user: {
    findFirst: jest.fn(),
  },
};

const mockNotifications = { notifyUser: jest.fn() };
const mockWorkLogs = { stopActiveTimersForTask: jest.fn() };
const mockMail = {
  sendTaskAssigned: jest.fn(),
  sendTaskCompleted: jest.fn(),
};
/**
 * The project guard decides project-scoped writes (findings R41/R42/R43); the
 * service reads the resolved permission set rather than re-checking the global
 * role. `[]` here is "the caller holds nothing on this project", which is the
 * strictest answer and the one these unit cases are written against — the
 * per-permission behaviour is asserted live over HTTP in
 * `test/workplace-project-rbac.e2e-spec.ts`.
 */
const mockAccess = {
  getAccess: jest.fn(),
  has: jest.fn(),
};

const adminUser = { id: 'user-1', role: 'ADMIN', employeeId: 'emp-1' };
const managerUser = {
  id: 'user-2',
  role: 'MANAGER',
  employeeId: 'emp-2',
  departmentId: 'dept-1',
};
const employeeUser = { id: 'user-3', role: 'EMPLOYEE', employeeId: 'emp-3' };

const mockTask = {
  id: 'task-1',
  taskCode: 'TASK-0001',
  title: 'Fix login bug',
  status: 'TODO',
  priority: 'HIGH',
  assignees: [{ id: 'emp-3', fullName: 'Employee Three' }],
  reporterId: 'emp-1',
  deletedAt: null,
  isArchived: false,
};

describe('TasksService', () => {
  let service: TasksService;

  beforeEach(async () => {
    // resetAllMocks (not clear) so unconsumed `mockResolvedValueOnce` queue
    // values from one test can't leak into the next; re-seed persistent defaults.
    jest.resetAllMocks();
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ max: null }]);
    // A task with no subtasks is the ordinary case, and Prisma returns [] for
    // it — never undefined. Without this default `descendantIds`' cascade walk
    // hits `for (const child of undefined)` and every delete case dies on a
    // TypeError that says nothing about deletes.
    mockPrisma.task.findMany.mockResolvedValue([]);
    // Every referenced FK resolves unless a case says otherwise; the create
    // path checks them all up front now (finding R61).
    mockPrisma.employee.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve((where?.id?.in ?? []).map((id: string) => ({ id }))),
    );
    mockPrisma.label.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve((where?.id?.in ?? []).map((id: string) => ({ id }))),
    );
    mockAccess.getAccess.mockResolvedValue({
      isGlobalAdmin: false,
      isOwner: false,
      roleSlug: null,
      permissions: [],
    });
    mockAccess.has.mockResolvedValue(false);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: WorkLogsService, useValue: mockWorkLogs },
        { provide: MailService, useValue: mockMail },
        { provide: ProjectAccessService, useValue: mockAccess },
      ],
    }).compile();
    service = module.get<TasksService>(TasksService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── Create ───────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('generates taskCode and creates task', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce(null); // no last task
      mockPrisma.task.create.mockResolvedValueOnce({
        ...mockTask,
        taskCode: 'TASK-0001',
      });
      mockPrisma.taskActivity.create.mockResolvedValueOnce({});

      const result = await service.create(
        { title: 'Fix login bug', priority: 'HIGH' },
        adminUser,
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.task.create).toHaveBeenCalled();
    });

    it('notifies assignee when assigneeId provided', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce({
        taskCode: 'TASK-0001',
      });
      mockPrisma.task.create.mockResolvedValueOnce({
        ...mockTask,
        id: 'task-2',
        taskCode: 'TASK-0002',
        assignees: [{ id: 'emp-3' }],
      });
      mockPrisma.taskActivity.create.mockResolvedValueOnce({});
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'user-3' });
      mockNotifications.notifyUser.mockResolvedValueOnce({});

      await service.create(
        { title: 'New task', assigneeId: 'emp-3' },
        adminUser,
      );
      // Assignment notifications are fire-and-forget — let the queued promise settle.
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockNotifications.notifyUser).toHaveBeenCalledWith(
        'user-3',
        'Task Assigned',
        expect.any(String),
        // Discriminating type, not 'INFO': it is what selects the WhatsApp
        // template, and 'INFO' resolves to none.
        'TASK_ASSIGNED',
        expect.any(String),
        expect.objectContaining({ waData: expect.any(Object) }),
      );
    });
  });

  // ─── findOne ─────────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('returns task for ADMIN', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce({
        ...mockTask,
        comments: [],
        attachments: [],
        activities: [],
        workLogs: [],
        reporter: null,
        _count: { comments: 0, attachments: 0, workLogs: 0 },
      });
      const result = await service.findOne('task-1', adminUser);
      expect(result.success).toBe(true);
    });

    it('throws NotFoundException for missing task', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce(null);
      await expect(service.findOne('bad-id', adminUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException for EMPLOYEE accessing unassigned task', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce({
        ...mockTask,
        assignees: [{ id: 'other-emp' }],
        reporterId: null,
      });
      await expect(service.findOne('task-1', employeeUser)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── assign ──────────────────────────────────────────────────────────────────

  describe('assign', () => {
    it('assigns task and logs activity', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce({
        ...mockTask,
        assignees: [],
      });
      mockPrisma.employee.findUnique.mockResolvedValueOnce({
        id: 'emp-4',
        fullName: 'Jane Doe',
      });
      mockPrisma.task.update.mockResolvedValueOnce({
        ...mockTask,
        assignees: [{ id: 'emp-4', fullName: 'Jane Doe' }],
      });
      mockPrisma.taskActivity.create.mockResolvedValueOnce({});
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'user-4' });
      mockNotifications.notifyUser.mockResolvedValueOnce({});

      const result = await service.assign(
        'task-1',
        { assigneeId: 'emp-4' },
        adminUser,
      );
      expect(result.success).toBe(true);
      expect(mockPrisma.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            assignees: {
              connect: { id: 'emp-4' },
            },
          },
        }),
      );
    });

    it('does NOT re-check the global role — the project permission governs (R41)', async () => {
      // The controller gates this door with `@RequireProjectPermission(
      // TASK_ASSIGN, { from: 'task' })`. `assign()` used to ALSO demand a
      // global ADMIN/HR_MANAGER/MANAGER role, which made the `manager` preset —
      // a PROJECT role held by an EMPLOYEE — unable to exercise the very
      // permission it ships with: 403 always. The guard has already decided by
      // the time the service runs, so an EMPLOYEE reaching here proceeds and
      // the only remaining refusal is a real one (an unknown assignee).
      mockPrisma.task.findFirst.mockResolvedValueOnce({
        ...mockTask,
        assignees: [],
      });
      mockPrisma.employee.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.assign('task-1', { assigneeId: 'emp-4' }, employeeUser),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── changeStatus ─────────────────────────────────────────────────────────────

  describe('changeStatus', () => {
    it('changes status and logs activity', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce({
        ...mockTask,
        assignees: [{ id: 'emp-3' }],
      });
      mockPrisma.task.update.mockResolvedValueOnce({
        ...mockTask,
        status: 'IN_PROGRESS',
      });
      mockPrisma.taskActivity.create.mockResolvedValueOnce({});

      const result = await service.changeStatus(
        'task-1',
        { status: 'IN_PROGRESS' },
        employeeUser,
      );
      expect(result.success).toBe(true);
    });

    it('EMPLOYEE cannot change status of unassigned task', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce({
        ...mockTask,
        assignees: [{ id: 'different-emp' }],
      });
      await expect(
        service.changeStatus('task-1', { status: 'IN_PROGRESS' }, employeeUser),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('soft deletes task for ADMIN', async () => {
      mockPrisma.task.findFirst.mockResolvedValueOnce(mockTask);
      mockPrisma.task.update.mockResolvedValueOnce({
        ...mockTask,
        deletedAt: new Date(),
      });
      const result = await service.remove('task-1', adminUser);
      expect(result.success).toBe(true);
    });

    it('does NOT re-check the global role — TASK_DELETE governs (R41)', async () => {
      // Same shape as `assign` above: `@RequireProjectPermission(TASK_DELETE)`
      // on the controller is the authority, so an EMPLOYEE who got past it —
      // the `manager` preset holder — really can delete.
      mockPrisma.task.findFirst.mockResolvedValueOnce(mockTask);
      const result = await service.remove('task-1', employeeUser);
      expect(result.success).toBe(true);
      // `updateMany`, not `update`: deleting a task cascades to its subtasks in
      // one statement, so the row this case is about is reached through an `in`
      // list rather than by id. The assertion said `update` from before that
      // change and had been failing ever since.
      expect(mockPrisma.task.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['task-1'] } },
        }),
      );
    });
  });
});
