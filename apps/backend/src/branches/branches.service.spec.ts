import { BadRequestException, ConflictException } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { PrismaService } from '../prisma/prisma.service';

const prismaMock = () => ({
  branch: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  company: { findFirst: jest.fn() },
  attendance: { count: jest.fn() },
});

type PrismaMock = ReturnType<typeof prismaMock>;

/** A branch as `findOne` returns it — the counts are what `remove` reads. */
const storedBranch = (counts: { employees: number; departments: number }) => ({
  id: 'branch-1',
  code: 'HQ',
  name: 'Head Office',
  _count: counts,
});

describe('BranchesService', () => {
  let prisma: PrismaMock;
  let service: BranchesService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new BranchesService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('refuses a code another branch already holds', async () => {
      prisma.branch.findUnique.mockResolvedValue({ id: 'other', code: 'HQ' });

      await expect(
        service.create({ code: 'HQ', name: 'Head Office' }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.branch.create).not.toHaveBeenCalled();
    });

    it('refuses to switch geofencing on without a centre and a radius', async () => {
      prisma.branch.findUnique.mockResolvedValue(null);
      prisma.company.findFirst.mockResolvedValue({ id: 'company-1' });

      await expect(
        service.create({
          code: 'SOH',
          name: 'Sohar',
          geofencingEnabled: true,
          latitude: 24.34,
        }),
      ).rejects.toThrow(/longitude, geofenceRadiusM/);

      expect(prisma.branch.create).not.toHaveBeenCalled();
    });

    it('accepts a complete geofence', async () => {
      prisma.branch.findUnique.mockResolvedValue(null);
      prisma.company.findFirst.mockResolvedValue({ id: 'company-1' });
      prisma.branch.create.mockResolvedValue({ id: 'branch-2' });

      await service.create({
        code: 'SOH',
        name: 'Sohar',
        geofencingEnabled: true,
        latitude: 24.34,
        longitude: 56.71,
        geofenceRadiusM: 150,
      });

      expect(prisma.branch.create).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('refuses while employees are still assigned', async () => {
      prisma.branch.findUnique.mockResolvedValue(
        storedBranch({ employees: 3, departments: 0 }),
      );

      await expect(service.remove('branch-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(prisma.branch.delete).not.toHaveBeenCalled();
      expect(prisma.branch.update).not.toHaveBeenCalled();
    });

    it('deactivates instead of deleting when attendance history exists', async () => {
      prisma.branch.findUnique.mockResolvedValue(
        storedBranch({ employees: 0, departments: 0 }),
      );
      prisma.attendance.count.mockResolvedValue(412);

      await expect(service.remove('branch-1')).resolves.toEqual({
        deleted: false,
        deactivated: true,
      });

      expect(prisma.branch.update).toHaveBeenCalledWith({
        where: { id: 'branch-1' },
        data: { isActive: false },
      });
      expect(prisma.branch.delete).not.toHaveBeenCalled();
    });

    it('deletes a branch nothing references', async () => {
      prisma.branch.findUnique.mockResolvedValue(
        storedBranch({ employees: 0, departments: 0 }),
      );
      prisma.attendance.count.mockResolvedValue(0);

      await expect(service.remove('branch-1')).resolves.toEqual({
        deleted: true,
        deactivated: false,
      });

      expect(prisma.branch.delete).toHaveBeenCalledWith({
        where: { id: 'branch-1' },
      });
    });
  });
});
