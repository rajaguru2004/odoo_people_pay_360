import { BadRequestException } from '@nestjs/common';
import { ContractsService } from './contracts.service';
import { PrismaService } from '../prisma/prisma.service';

const prismaMock = () => ({
  contract: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  employee: { findUnique: jest.fn() },
  // The array form resolves every operation it is handed, which is what the
  // real client does; the tests then assert on the individual calls.
  $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
});

type PrismaMock = ReturnType<typeof prismaMock>;

/** The first argument a mocked Prisma call received, typed for the assertion. */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as T[][])[0][0];
}

const baseDto = {
  employeeId: 'employee-1',
  contractType: 'FIXED_TERM' as const,
  startDate: '2026-05-01',
  salary: 1200,
};

describe('ContractsService', () => {
  let prisma: PrismaMock;
  let service: ContractsService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new ContractsService(prisma as unknown as PrismaService);
    prisma.employee.findUnique.mockResolvedValue({ id: 'employee-1' });
    prisma.contract.create.mockResolvedValue({ id: 'contract-new' });
  });

  describe('contract numbering', () => {
    it('continues the sequence for the year', async () => {
      prisma.contract.count.mockResolvedValue(4);

      await service.create(baseDto);

      expect(
        firstArg<{ data: { contractNumber: string } }>(prisma.contract.create)
          .data.contractNumber,
      ).toBe('CTR-2026-0005');
    });

    it('takes the year from the start date, not from today', async () => {
      prisma.contract.count.mockResolvedValue(0);

      await service.create({ ...baseDto, startDate: '2027-01-01' });

      expect(prisma.contract.count).toHaveBeenCalledWith({
        where: { contractNumber: { startsWith: 'CTR-2027-' } },
      });
      expect(
        firstArg<{ data: { contractNumber: string } }>(prisma.contract.create)
          .data.contractNumber,
      ).toBe('CTR-2027-0001');
    });

    it('keeps a number the caller supplied', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);

      await service.create({ ...baseDto, contractNumber: 'LEGACY-77' });

      expect(prisma.contract.count).not.toHaveBeenCalled();
      expect(
        firstArg<{ data: { contractNumber: string } }>(prisma.contract.create)
          .data.contractNumber,
      ).toBe('LEGACY-77');
    });
  });

  describe('term validation', () => {
    it('refuses an end date on or before the start date', async () => {
      await expect(
        service.create({ ...baseDto, endDate: '2026-04-30' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.create({ ...baseDto, endDate: '2026-05-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.contract.create).not.toHaveBeenCalled();
    });

    it('refuses probation running past the end of the contract', async () => {
      await expect(
        service.create({
          ...baseDto,
          endDate: '2026-12-31',
          probationEndDate: '2027-02-01',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.contract.create).not.toHaveBeenCalled();
    });
  });

  describe('renew', () => {
    const current = {
      id: 'contract-1',
      employeeId: 'employee-1',
      contractNumber: 'CTR-2026-0001',
      contractType: 'FIXED_TERM',
      workType: 'FULL_TIME',
      status: 'ACTIVE',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2027-12-31'),
      probationEndDate: null,
      workHoursPerWeek: 40,
      salary: 1200,
      currency: 'OMR',
      noticePeriodDays: 30,
      annualLeaveDays: 30,
      terms: null,
    };

    it('marks the old contract RENEWED and creates the successor together', async () => {
      prisma.contract.findUnique.mockResolvedValue(current);
      prisma.contract.count.mockResolvedValue(0);
      prisma.contract.update.mockResolvedValue({
        ...current,
        status: 'RENEWED',
      });
      prisma.contract.create.mockResolvedValue({ id: 'contract-2' });

      const successor = await service.renew('contract-1', {
        startDate: '2028-01-01',
        endDate: '2029-12-31',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(firstArg<unknown[]>(prisma.$transaction)).toHaveLength(2);

      expect(prisma.contract.update).toHaveBeenCalledWith({
        where: { id: 'contract-1' },
        data: { status: 'RENEWED' },
      });
      expect(
        firstArg<{ data: Record<string, unknown> }>(prisma.contract.create)
          .data,
      ).toMatchObject({
        employeeId: 'employee-1',
        status: 'ACTIVE',
        contractNumber: 'CTR-2028-0001',
      });
      expect(successor).toEqual({ id: 'contract-2' });
    });

    it('carries over terms the caller did not restate', async () => {
      prisma.contract.findUnique.mockResolvedValue(current);
      prisma.contract.count.mockResolvedValue(0);
      prisma.contract.update.mockResolvedValue(current);
      prisma.contract.create.mockResolvedValue({ id: 'contract-2' });

      await service.renew('contract-1', { startDate: '2028-01-01' });

      expect(
        firstArg<{ data: Record<string, unknown> }>(prisma.contract.create)
          .data,
      ).toMatchObject({
        salary: 1200,
        contractType: 'FIXED_TERM',
        workHoursPerWeek: 40,
      });
    });

    it('refuses to renew a contract that has already been renewed', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        ...current,
        status: 'RENEWED',
      });

      await expect(
        service.renew('contract-1', { startDate: '2028-01-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
