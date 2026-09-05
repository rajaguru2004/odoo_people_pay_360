import { BadRequestException } from '@nestjs/common';
import { AssetStatus } from '@prisma/client';
import { AssetsService } from './assets.service';
import { PrismaService } from '../prisma/prisma.service';

const prismaMock = () => ({
  assetItem: {
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  branch: { findUnique: jest.fn() },
});

type PrismaMock = ReturnType<typeof prismaMock>;

/** The first argument a mocked Prisma call received, typed for the assertion. */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as T[][])[0][0];
}

describe('AssetsService — the open assignment rule', () => {
  let prisma: PrismaMock;
  let service: AssetsService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new AssetsService(prisma as unknown as PrismaService);
  });

  it('refuses to delete an asset somebody is holding', async () => {
    prisma.assetItem.findUnique.mockResolvedValue({
      id: 'asset-1',
      assetTag: 'LT-0042',
      _count: { assignments: 1 },
      assignments: [{ id: 'assignment-1' }],
    });

    await expect(service.remove('asset-1')).rejects.toThrow(
      /Record its return before deleting it/,
    );
    expect(prisma.assetItem.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete an asset with a closed custody history either', async () => {
    // The acknowledgement that proved receipt and the return that cleared an
    // offboarding both cascade away with the asset, and nothing reconstructs
    // them.
    prisma.assetItem.findUnique.mockResolvedValue({
      id: 'asset-1',
      assetTag: 'LT-0042',
      _count: { assignments: 3 },
      assignments: [],
    });

    await expect(service.remove('asset-1')).rejects.toThrow(
      /Retire it instead/,
    );
    expect(prisma.assetItem.delete).not.toHaveBeenCalled();
  });

  it('deletes an asset that has never been in anybody’s hands', async () => {
    prisma.assetItem.findUnique.mockResolvedValue({
      id: 'asset-1',
      assetTag: 'LT-0042',
      _count: { assignments: 0 },
      assignments: [],
    });

    await expect(service.remove('asset-1')).resolves.toEqual({ deleted: true });
    expect(prisma.assetItem.delete).toHaveBeenCalledWith({
      where: { id: 'asset-1' },
    });
  });

  it('refuses to move a held asset out of ASSIGNED by hand', async () => {
    prisma.assetItem.findUnique.mockResolvedValue({
      id: 'asset-1',
      assetTag: 'LT-0042',
      branchId: 'branch-1',
      status: AssetStatus.ASSIGNED,
    });

    await expect(
      service.update('asset-1', { status: AssetStatus.AVAILABLE }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to set ASSIGNED by hand, because custody derives it', async () => {
    prisma.assetItem.findUnique.mockResolvedValue({
      id: 'asset-1',
      assetTag: 'LT-0042',
      branchId: 'branch-1',
      status: AssetStatus.AVAILABLE,
    });

    await expect(
      service.update('asset-1', { status: AssetStatus.ASSIGNED }),
    ).rejects.toThrow(/by assigning it to an employee/);
  });

  it('treats "nobody holds it" as a different filter from AVAILABLE', async () => {
    prisma.assetItem.findMany.mockResolvedValue([]);
    prisma.assetItem.count.mockResolvedValue(0);

    await service.findAll({ unassignedOnly: true });

    const { where } = firstArg<{ where: Record<string, unknown> }>(
      prisma.assetItem.findMany,
    );
    expect(where).toEqual({ assignments: { none: { returnedAt: null } } });
    expect(where).not.toHaveProperty('status');
  });

  it('only counts an asset as held while its assignment is open', async () => {
    prisma.assetItem.findMany.mockResolvedValue([]);
    prisma.assetItem.count.mockResolvedValue(0);

    await service.findAll({});

    const { include } = firstArg<{
      include: { assignments: { where: unknown; take: number } };
    }>(prisma.assetItem.findMany);
    expect(include.assignments.where).toEqual({ returnedAt: null });
    expect(include.assignments.take).toBe(1);
  });
});
