import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClearanceService } from './clearance.service';

function makeService(opts: {
  openAssets?: any[];
  blockingEnabled?: string;
  outstandingLoans?: any[];
  /** `null` => the employee does not exist. */
  employee?: any;
} = {}) {
  const prisma = {
    // `getClearanceStatus` resolves the SUBJECT first now: an unknown id used
    // to answer a confident `cleared: true` (R27), and an id in a branch the
    // caller cannot reach did the same (R26). No branch context is installed in
    // a unit test, so `assertInBranch` is a no-op here.
    employee: {
      findUnique: jest.fn().mockResolvedValue(
        opts.employee === null
          ? null
          : (opts.employee ?? { id: 'emp-1', branchId: null, departmentId: null }),
      ),
    },
    assetAssignment: {
      findMany: jest.fn().mockResolvedValue(opts.openAssets ?? []),
    },
    // Clearance now covers loans as well as assets: an employee must not walk
    // with an unrecovered balance.
    advanceLoanRequest: {
      findMany: jest.fn().mockResolvedValue(opts.outstandingLoans ?? []),
    },
  } as any;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as any;
  const settings = {
    getSetting: jest
      .fn()
      .mockResolvedValue(opts.blockingEnabled ?? 'true'),
  } as any;
  return {
    service: new ClearanceService(prisma, audit, settings),
    prisma,
    audit,
  };
}

const laptop = {
  id: 'asg-1',
  assignedAt: new Date('2026-01-10'),
  asset: { id: 'a-1', assetTag: 'LT-0042', name: 'Dell Latitude', category: 'Laptop' },
};

describe('ClearanceService', () => {
  describe('getClearanceStatus', () => {
    it('is cleared when nothing is held', async () => {
      const { service } = makeService({ openAssets: [] });
      await expect(service.getClearanceStatus('emp-1')).resolves.toEqual({
        cleared: true,
        assetCleared: true,
        loanCleared: true,
        openAssets: [],
        outstandingLoans: [],
      });
    });

    it('queries only OPEN assignments', async () => {
      const { service, prisma } = makeService();
      await service.getClearanceStatus('emp-1');
      expect(prisma.assetAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { employeeId: 'emp-1', returnedAt: null },
        }),
      );
    });

    it('404s an employeeId that belongs to nobody, instead of clearing it', async () => {
      // R27 — the projection queries assignments and loans by a raw id, so an
      // id belonging to nobody matched nothing and read as "owes nothing".
      const { service } = makeService({ employee: null });
      await expect(service.getClearanceStatus('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lists what is still held', async () => {
      const { service } = makeService({ openAssets: [laptop] });
      const status = await service.getClearanceStatus('emp-1');
      expect(status.cleared).toBe(false);
      expect(status.openAssets).toEqual([
        {
          assignmentId: 'asg-1',
          assetId: 'a-1',
          assetTag: 'LT-0042',
          name: 'Dell Latitude',
          category: 'Laptop',
          assignedAt: laptop.assignedAt,
        },
      ]);
    });
  });

  describe('assertCleared', () => {
    it('passes when the employee holds nothing', async () => {
      const { service } = makeService({ openAssets: [] });
      await expect(service.assertCleared('emp-1')).resolves.toBeUndefined();
    });

    it('blocks offboarding, naming the assets', async () => {
      const { service } = makeService({ openAssets: [laptop] });
      await expect(service.assertCleared('emp-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.assertCleared('emp-1')).rejects.toThrow(
        /LT-0042 \(Dell Latitude\)/,
      );
    });

    it('rejects an override with no reason', async () => {
      const { service } = makeService({ openAssets: [laptop] });
      await expect(
        service.assertCleared('emp-1', { actorRole: 'ADMIN' }),
      ).rejects.toThrow(/still has/);
    });

    it('rejects an override from a role that may not override', async () => {
      const { service } = makeService({ openAssets: [laptop] });
      await expect(
        service.assertCleared('emp-1', {
          actorRole: 'MANAGER',
          actorUserId: 'u-1',
          reason: 'laptop written off',
        }),
      ).rejects.toThrow(/Only ADMIN or HR_MANAGER/);
    });

    it('allows an audited ADMIN override', async () => {
      const { service, audit } = makeService({ openAssets: [laptop] });
      await expect(
        service.assertCleared('emp-1', {
          actorRole: 'ADMIN',
          actorUserId: 'u-1',
          reason: 'laptop written off',
        }),
      ).resolves.toBeUndefined();

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CLEARANCE_OVERRIDDEN',
          resourceType: 'Employee',
          resourceId: 'emp-1',
          userId: 'u-1',
        }),
      );
    });

    it('allows an audited HR_MANAGER override', async () => {
      const { service, audit } = makeService({ openAssets: [laptop] });
      await service.assertCleared('emp-1', {
        actorRole: 'HR_MANAGER',
        actorUserId: 'u-2',
        reason: 'lost in transit',
      });
      expect(audit.log).toHaveBeenCalled();
    });

    it('treats a whitespace-only reason as no reason', async () => {
      const { service } = makeService({ openAssets: [laptop] });
      await expect(
        service.assertCleared('emp-1', { actorRole: 'ADMIN', reason: '   ' }),
      ).rejects.toThrow(/still has/);
    });

    it('skips the gate entirely when blocking is switched off', async () => {
      const { service, prisma } = makeService({
        openAssets: [laptop],
        blockingEnabled: 'false',
      });
      await expect(service.assertCleared('emp-1')).resolves.toBeUndefined();
      // Short-circuits before even looking at assignments.
      expect(prisma.assetAssignment.findMany).not.toHaveBeenCalled();
    });
  });
});
