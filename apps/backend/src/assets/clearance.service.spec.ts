import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ClearanceService } from './clearance.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';

const prismaMock = () => ({
  employee: { findUnique: jest.fn() },
  department: { findMany: jest.fn() },
  assetAssignment: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
});

type PrismaMock = ReturnType<typeof prismaMock>;

/** The first argument a mocked Prisma call received, typed for the assertion. */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as T[][])[0][0];
}

const OPEN_ASSIGNMENT = {
  id: 'assignment-1',
  assignedAt: new Date('2026-01-15T00:00:00.000Z'),
  asset: {
    id: 'asset-1',
    assetTag: 'LT-0042',
    name: 'Dell Latitude 5540',
    category: 'Laptop',
  },
};

const admin = {
  id: 'user-admin',
  email: 'admin@example.com',
  role: UserRole.ADMIN,
  employeeId: null,
  departmentId: null,
  branchId: null,
};

describe('ClearanceService', () => {
  let prisma: PrismaMock;
  let settings: { get: jest.Mock };
  let service: ClearanceService;

  beforeEach(() => {
    prisma = prismaMock();
    settings = { get: jest.fn().mockResolvedValue(undefined) };
    service = new ClearanceService(
      prisma as unknown as PrismaService,
      settings as unknown as SystemSettingsService,
    );
    prisma.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      departmentId: 'department-1',
    });
  });

  describe('an open assignment is what blocks offboarding', () => {
    it('reports the employee as not cleared while an asset is still out', async () => {
      prisma.assetAssignment.findMany.mockResolvedValue([OPEN_ASSIGNMENT]);

      const status = await service.getClearanceStatus('employee-1', admin);

      expect(status.cleared).toBe(false);
      expect(status.openAssets).toEqual([
        {
          assignmentId: 'assignment-1',
          assetId: 'asset-1',
          assetTag: 'LT-0042',
          name: 'Dell Latitude 5540',
          category: 'Laptop',
          assignedAt: OPEN_ASSIGNMENT.assignedAt,
        },
      ]);
    });

    it('keys on returnedAt, never on the employee status', async () => {
      prisma.assetAssignment.findMany.mockResolvedValue([]);

      await service.getClearanceStatus('employee-1', admin);

      expect(prisma.assetAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { employeeId: 'employee-1', returnedAt: null },
        }),
      );
    });

    it('clears the employee once everything has come back', async () => {
      prisma.assetAssignment.findMany.mockResolvedValue([]);

      const status = await service.getClearanceStatus('employee-1', admin);

      expect(status).toMatchObject({ cleared: true, assetCleared: true });
      expect(status.openAssets).toHaveLength(0);
    });

    it('refuses an unknown employee rather than answering "clear to go"', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.getClearanceStatus('nobody', admin)).rejects.toThrow(
        'Employee not found',
      );
    });

    it('keeps a manager out of another department', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      const manager = {
        ...admin,
        role: UserRole.MANAGER,
        employeeId: 'employee-manager',
        departmentId: 'department-other',
      };

      await expect(
        service.getClearanceStatus('employee-1', manager),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assertCleared', () => {
    it('throws and names what is still held', async () => {
      prisma.assetAssignment.findMany.mockResolvedValue([OPEN_ASSIGNMENT]);

      await expect(service.assertCleared('employee-1')).rejects.toThrow(
        /LT-0042 \(Dell Latitude 5540\)/,
      );
      await expect(service.assertCleared('employee-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('passes when nothing is out', async () => {
      prisma.assetAssignment.findMany.mockResolvedValue([]);
      await expect(
        service.assertCleared('employee-1'),
      ).resolves.toBeUndefined();
    });

    it('lets a site that does not track assets switch the block off', async () => {
      settings.get.mockResolvedValue('false');
      await expect(
        service.assertCleared('employee-1'),
      ).resolves.toBeUndefined();
      expect(prisma.assetAssignment.findMany).not.toHaveBeenCalled();
    });

    it('refuses an override from a role that may not give one', async () => {
      prisma.assetAssignment.findMany.mockResolvedValue([OPEN_ASSIGNMENT]);

      await expect(
        service.assertCleared('employee-1', {
          actorUserId: 'user-manager',
          actorRole: UserRole.MANAGER,
          reason: 'They have already left the country',
        }),
      ).rejects.toThrow(/Only ADMIN or HR_MANAGER/);
    });

    it('records an accepted override with what was still owed', async () => {
      prisma.assetAssignment.findMany.mockResolvedValue([OPEN_ASSIGNMENT]);

      await service.assertCleared('employee-1', {
        actorUserId: 'user-admin',
        actorRole: UserRole.ADMIN,
        reason: 'Laptop written off after the fire',
      });

      const row = firstArg<{
        data: { action: string; metadata: { openAssets: unknown[] } };
      }>(prisma.auditLog.create);
      expect(row.data.action).toBe('CLEARANCE_OVERRIDDEN');
      // Recorded even though it was overridden: what was owed is the half an
      // auditor is most likely to be looking for once the person has gone.
      expect(row.data.metadata.openAssets).toEqual([
        { assetTag: 'LT-0042', name: 'Dell Latitude 5540' },
      ]);
    });
  });
});
