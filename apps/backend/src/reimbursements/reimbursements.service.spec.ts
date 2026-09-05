import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ReimbursementsService } from './reimbursements.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * End-to-end style unit coverage for the reimbursement request flow:
 *   - create(): module toggle, configurable type validation, future-date guard,
 *               approver fan-out notifications (dept-scoped for MANAGER)
 *   - findPending(): configurable approver roles (Settings checkboxes) and
 *               MANAGER department scoping
 *   - approve()/reject(): configurable-role authorization, dept scope,
 *               PENDING-only race guard (updateMany count), mail + in-app notify
 *   - cancel(): owner-only, PENDING-only
 *
 * Prisma and all collaborators are mocked so the service logic is exercised
 * deterministically without a live database.
 */
describe('ReimbursementsService', () => {
  let service: ReimbursementsService;

  let prisma: any;
  let mail: any;
  let settings: any;
  let notifications: any;

  const EMPLOYEE_ID = 'emp-1';
  const DEPT_ID = 'dept-1';
  const OTHER_DEPT_ID = 'dept-2';

  const ADMIN = { id: 'user-admin', role: 'ADMIN', employeeId: 'emp-admin', departmentId: null };
  const HR = { id: 'user-hr', role: 'HR_MANAGER', employeeId: 'emp-hr', departmentId: OTHER_DEPT_ID };
  const SAME_DEPT_MANAGER = { id: 'user-mgr', role: 'MANAGER', employeeId: 'emp-mgr', departmentId: DEPT_ID };
  const OTHER_DEPT_MANAGER = { id: 'user-mgr2', role: 'MANAGER', employeeId: 'emp-mgr2', departmentId: OTHER_DEPT_ID };
  const OWNER = { id: 'user-emp', role: 'EMPLOYEE', employeeId: EMPLOYEE_ID, departmentId: DEPT_ID };

  // Settings the service reads; overridable per test.
  let settingsMap: Record<string, string>;

  const pendingReimbursement = (overrides: any = {}) => ({
    id: 'reimb-1',
    employeeId: EMPLOYEE_ID,
    type: 'Travel',
    amount: 2500,
    expenseDate: new Date('2026-06-15T00:00:00.000Z'),
    status: 'PENDING',
    attachments: [],
    employee: {
      id: EMPLOYEE_ID,
      employeeCode: 'TRS001',
      fullName: 'Raja Guru R',
      email: 'raja@x.com',
      departmentId: DEPT_ID,
      department: { id: DEPT_ID, name: 'Engineering' },
    },
    approver: null,
    ...overrides,
  });

  const buildService = async () => {
    prisma = {
      employee: { findUnique: jest.fn() },
      reimbursement: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      user: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
    };

    mail = {
      sendReimbursementApproved: jest.fn().mockResolvedValue(undefined),
      sendReimbursementRejected: jest.fn().mockResolvedValue(undefined),
    };

    settings = {
      getSetting: jest
        .fn()
        .mockImplementation((key: string, fallback: string) =>
          Promise.resolve(settingsMap[key] ?? fallback),
        ),
    };

    notifications = { notifyUser: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReimbursementsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: SystemSettingsService, useValue: settings },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = moduleRef.get(ReimbursementsService);
  };

  beforeEach(async () => {
    settingsMap = {
      reimbursement_enabled: 'true',
      reimbursement_approver_roles: 'MANAGER,HR_MANAGER,ADMIN',
      reimbursement_types: 'Travel,Medical,Food,Office Supplies,Other',
    };
    await buildService();
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  // ── create() ──────────────────────────────────────────────────────────────
  describe('create', () => {
    const dto = {
      type: 'Travel',
      amount: 2500,
      expenseDate: '2026-06-15',
      description: 'Client visit cab fare',
    };

    const primeHappyPath = () => {
      prisma.employee.findUnique.mockResolvedValue({
        id: EMPLOYEE_ID,
        departmentId: DEPT_ID,
      });
      prisma.reimbursement.create.mockResolvedValue(pendingReimbursement());
      prisma.user.findMany.mockResolvedValue([{ id: 'hr-1' }, { id: 'mgr-1' }]);
    };

    it('rejects when the module is disabled in settings', async () => {
      settingsMap.reimbursement_enabled = 'false';
      await expect(service.create(EMPLOYEE_ID, dto)).rejects.toThrow(
        /disabled/,
      );
      expect(prisma.reimbursement.create).not.toHaveBeenCalled();
    });

    it('throws NotFound when the employee does not exist', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);
      await expect(service.create(EMPLOYEE_ID, dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a type that is not in the configured list', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: EMPLOYEE_ID });
      await expect(
        service.create(EMPLOYEE_ID, { ...dto, type: 'Yacht Rental' }),
      ).rejects.toThrow(/Invalid reimbursement type/);
      expect(prisma.reimbursement.create).not.toHaveBeenCalled();
    });

    it('accepts a custom type once the admin adds it to settings', async () => {
      settingsMap.reimbursement_types = 'Travel,Internet';
      primeHappyPath();
      await expect(
        service.create(EMPLOYEE_ID, { ...dto, type: 'Internet' }),
      ).resolves.toMatchObject({ id: 'reimb-1' });
    });

    it('rejects a future expense date', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: EMPLOYEE_ID });
      await expect(
        service.create(EMPLOYEE_ID, { ...dto, expenseDate: '2999-01-01' }),
      ).rejects.toThrow(/future/);
    });

    it('creates the request as PENDING', async () => {
      primeHappyPath();
      await service.create(EMPLOYEE_ID, dto);
      expect(prisma.reimbursement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            employeeId: EMPLOYEE_ID,
            type: 'Travel',
            amount: 2500,
            status: 'PENDING',
          }),
        }),
      );
    });

    it('notifies configured approver roles, dept-scoping MANAGER recipients', async () => {
      primeHappyPath();
      await service.create(EMPLOYEE_ID, dto);

      const where = prisma.user.findMany.mock.calls[0][0].where;
      expect(where.isActive).toBe(true);
      // Non-manager roles are notified unconditionally...
      expect(where.OR).toContainEqual({
        role: { in: ['HR_MANAGER', 'ADMIN'] },
      });
      // ...MANAGER only within the requester's department.
      expect(where.OR).toContainEqual({
        role: 'MANAGER',
        employee: { departmentId: DEPT_ID },
      });
      expect(notifications.notifyUser).toHaveBeenCalledTimes(2);
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'hr-1',
        expect.any(String),
        expect.stringContaining('Raja Guru R'),
        'INFO',
        '/dashboard/reimbursements',
      );
    });

    it('does not notify MANAGER users when MANAGER is not a configured approver role', async () => {
      settingsMap.reimbursement_approver_roles = 'HR_MANAGER,ADMIN';
      primeHappyPath();
      await service.create(EMPLOYEE_ID, dto);
      const where = prisma.user.findMany.mock.calls[0][0].where;
      expect(JSON.stringify(where)).not.toContain('"MANAGER"');
    });

    it('still creates the request when notification fan-out fails', async () => {
      primeHappyPath();
      prisma.user.findMany.mockRejectedValue(new Error('db down'));
      await expect(service.create(EMPLOYEE_ID, dto)).resolves.toMatchObject({
        id: 'reimb-1',
      });
    });
  });

  // ── findPending() ───────────────────────────────────────────────────────────
  describe('findPending', () => {
    beforeEach(() => {
      prisma.reimbursement.findMany.mockResolvedValue([pendingReimbursement()]);
    });

    it('forbids a role that is not in the configured approver roles', async () => {
      settingsMap.reimbursement_approver_roles = 'HR_MANAGER,ADMIN';
      await expect(
        service.findPending(SAME_DEPT_MANAGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('this is what makes the Settings checkboxes effective: unchecking a role revokes access', async () => {
      settingsMap.reimbursement_approver_roles = 'ADMIN';
      await expect(service.findPending(HR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.findPending(ADMIN)).resolves.toHaveLength(1);
    });

    it('scopes MANAGER queues to every department they manage', async () => {
      await service.findPending(SAME_DEPT_MANAGER);
      expect(prisma.reimbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'PENDING',
            employee: { departmentId: { in: [DEPT_ID] } },
          },
        }),
      );
    });

    it('does not scope ADMIN/HR_MANAGER queues by department', async () => {
      await service.findPending(HR);
      expect(prisma.reimbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'PENDING' } }),
      );
    });

    it('returns an empty queue for a MANAGER with no department', async () => {
      await expect(
        service.findPending({ ...SAME_DEPT_MANAGER, departmentId: null }),
      ).resolves.toEqual([]);
      expect(prisma.reimbursement.findMany).not.toHaveBeenCalled();
    });
  });

  // ── approve() ───────────────────────────────────────────────────────────────
  describe('approve', () => {
    const primeApprove = (overrides: any = {}) => {
      prisma.reimbursement.findUnique.mockResolvedValue(
        pendingReimbursement(overrides),
      );
      prisma.reimbursement.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUnique.mockResolvedValue({
        employee: { fullName: 'HR Admin' },
      });
      prisma.user.findFirst.mockResolvedValue({ id: 'requester-user' });
    };

    it('forbids a role not present in the configured approver roles', async () => {
      settingsMap.reimbursement_approver_roles = 'ADMIN';
      primeApprove();
      await expect(service.approve('reimb-1', HR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.reimbursement.updateMany).not.toHaveBeenCalled();
    });

    it('forbids a MANAGER from another department', async () => {
      primeApprove();
      await expect(
        service.approve('reimb-1', OTHER_DEPT_MANAGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the department manager of the requester', async () => {
      primeApprove();
      await service.approve('reimb-1', SAME_DEPT_MANAGER, {
        remarks: 'Verified invoice',
      });
      expect(prisma.reimbursement.updateMany).toHaveBeenCalledWith({
        where: { id: 'reimb-1', status: 'PENDING' },
        data: expect.objectContaining({
          status: 'APPROVED',
          approverId: SAME_DEPT_MANAGER.id,
          approverRemarks: 'Verified invoice',
        }),
      });
    });

    it('guards PENDING-only via updateMany so only the first of two racing approvers wins', async () => {
      primeApprove();
      // Second approver: the row already flipped, so the guarded update matches 0 rows.
      prisma.reimbursement.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.approve('reimb-1', ADMIN)).rejects.toThrow(
        /already been processed/,
      );
      expect(mail.sendReimbursementApproved).not.toHaveBeenCalled();
      expect(notifications.notifyUser).not.toHaveBeenCalled();
    });

    it('emails and in-app notifies the requester on approval', async () => {
      primeApprove();
      await service.approve('reimb-1', ADMIN, { remarks: 'ok' });
      expect(mail.sendReimbursementApproved).toHaveBeenCalledWith(
        'raja@x.com',
        expect.objectContaining({
          employeeName: 'Raja Guru R',
          type: 'Travel',
          approverName: 'HR Admin',
          remarks: 'ok',
        }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'requester-user',
        expect.stringContaining('approved'),
        expect.stringContaining('payroll'),
        // Discriminating type, not 'INFO': this is what routes the decision to
        // WhatsApp. 'INFO' resolves to no template.
        'REIMBURSEMENT_APPROVED',
        '/dashboard/reimbursements',
        expect.objectContaining({ waData: expect.objectContaining({ status: 'Approved' }) }),
      );
    });
  });

  // ── reject() ────────────────────────────────────────────────────────────────
  describe('reject', () => {
    const primeReject = () => {
      prisma.reimbursement.findUnique.mockResolvedValue(pendingReimbursement());
      prisma.reimbursement.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUnique.mockResolvedValue({
        employee: { fullName: 'HR Admin' },
      });
      prisma.user.findFirst.mockResolvedValue({ id: 'requester-user' });
    };

    it('persists REJECTED + reason', async () => {
      primeReject();
      await service.reject('reimb-1', ADMIN, {
        remarks: 'Invoice mismatch',
      } as any);
      expect(prisma.reimbursement.updateMany).toHaveBeenCalledWith({
        where: { id: 'reimb-1', status: 'PENDING' },
        data: expect.objectContaining({
          status: 'REJECTED',
          rejectedReason: 'Invoice mismatch',
        }),
      });
    });

    it('applies the same race guard as approve', async () => {
      primeReject();
      prisma.reimbursement.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.reject('reimb-1', ADMIN, { remarks: 'no' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mail.sendReimbursementRejected).not.toHaveBeenCalled();
    });

    it('emails and in-app notifies the requester with the reason', async () => {
      primeReject();
      await service.reject('reimb-1', HR, { remarks: 'nope' } as any);
      expect(mail.sendReimbursementRejected).toHaveBeenCalledWith(
        'raja@x.com',
        expect.objectContaining({ reason: 'nope' }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'requester-user',
        expect.stringContaining('rejected'),
        expect.stringContaining('nope'),
        'REIMBURSEMENT_REJECTED',
        '/dashboard/reimbursements',
        expect.objectContaining({
          waData: expect.objectContaining({ rejectionReason: 'nope' }),
        }),
      );
    });
  });

  // ── findOne() access control ────────────────────────────────────────────────
  describe('findOne', () => {
    beforeEach(() => {
      prisma.reimbursement.findUnique.mockResolvedValue(pendingReimbursement());
    });

    it('throws NotFound for a missing request', async () => {
      prisma.reimbursement.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing', ADMIN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([
      ['owner', OWNER],
      ['admin', ADMIN],
      ['hr manager', HR],
      ['same-dept manager', SAME_DEPT_MANAGER],
    ])('allows the %s to view', async (_label, user) => {
      await expect(service.findOne('reimb-1', user)).resolves.toMatchObject({
        id: 'reimb-1',
      });
    });

    it('forbids an unrelated employee and an other-dept manager', async () => {
      await expect(
        service.findOne('reimb-1', { ...OWNER, employeeId: 'someone-else' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.findOne('reimb-1', OTHER_DEPT_MANAGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('serializes BigInt attachment sizes to Number', async () => {
      prisma.reimbursement.findUnique.mockResolvedValue(
        pendingReimbursement({
          attachments: [{ id: 'att-1', fileSize: BigInt(1024) }],
        }),
      );
      const result = await service.findOne('reimb-1');
      expect(result.attachments[0].fileSize).toBe(1024);
    });
  });

  // ── cancel() ────────────────────────────────────────────────────────────────
  describe('cancel', () => {
    it('lets the owner cancel a PENDING request', async () => {
      prisma.reimbursement.findUnique.mockResolvedValue(pendingReimbursement());
      prisma.reimbursement.update.mockResolvedValue({ status: 'CANCELLED' });
      await service.cancel('reimb-1', EMPLOYEE_ID);
      expect(prisma.reimbursement.update).toHaveBeenCalledWith({
        where: { id: 'reimb-1' },
        data: { status: 'CANCELLED' },
      });
    });

    it('forbids cancelling someone else\'s request', async () => {
      prisma.reimbursement.findUnique.mockResolvedValue(pendingReimbursement());
      await expect(
        service.cancel('reimb-1', 'other-emp'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each(['APPROVED', 'REJECTED', 'PAID', 'CANCELLED'])(
      'blocks cancelling a %s request',
      async (status) => {
        prisma.reimbursement.findUnique.mockResolvedValue(
          pendingReimbursement({ status }),
        );
        await expect(
          service.cancel('reimb-1', EMPLOYEE_ID),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );
  });
});
