import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SalaryStructuresService } from './salary-structures.service';
import type { PrismaService } from '../prisma/prisma.service';

const BASIC = {
  id: 'component-basic',
  code: 'BASIC',
  name: 'Basic salary',
  type: 'EARNING' as const,
  isActive: true,
};
const HRA = {
  id: 'component-hra',
  code: 'HRA',
  name: 'Housing allowance',
  type: 'EARNING' as const,
  isActive: true,
};
const SOCIAL_SEC_EE = {
  id: 'component-ss',
  code: 'SOCIAL_SEC_EE',
  name: 'Social security (employee)',
  type: 'DEDUCTION' as const,
  isActive: true,
};

function prismaMock() {
  const mock = {
    salaryStructure: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    salaryStructureLine: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    salaryComponent: { findMany: jest.fn() },
    employee: { findUnique: jest.fn() },
    contract: { findFirst: jest.fn() },
    payslip: { count: jest.fn() },
    // The callback form hands the transaction client straight back — the real
    // client passes a scoped `tx`, and the tests then assert on the writes it
    // received, in the order it received them.
    $transaction: jest.fn(),
  };

  mock.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof mock) => unknown)(mock)
      : Promise.all(arg as unknown[]),
  );

  return mock;
}

type PrismaMock = ReturnType<typeof prismaMock>;

/** The first argument a mocked Prisma call received, typed for the assertion. */
function firstArg<T>(mock: jest.Mock, call = 0): T {
  return (mock.mock.calls as T[][])[call][0];
}

const createDto = {
  employeeId: 'employee-1',
  effectiveFrom: '2026-01-01',
  lines: [
    { componentId: BASIC.id, amount: 600 },
    { componentId: SOCIAL_SEC_EE.id, amount: 42 },
  ],
};

describe('SalaryStructuresService', () => {
  let prisma: PrismaMock;
  let service: SalaryStructuresService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new SalaryStructuresService(prisma as unknown as PrismaService);

    prisma.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      firstName: 'Aisha',
      lastName: 'Al Balushi',
      status: 'ACTIVE',
    });
    prisma.salaryStructure.findUnique.mockResolvedValue(null);
    prisma.salaryComponent.findMany.mockResolvedValue([BASIC, SOCIAL_SEC_EE]);
    prisma.contract.findFirst.mockResolvedValue(null);
    prisma.salaryStructure.create.mockResolvedValue({ id: 'structure-1' });
  });

  describe('create', () => {
    it('writes the structure and its lines in one transaction', async () => {
      prisma.salaryStructure.findUnique
        // The "does this employee already have one?" probe.
        .mockResolvedValueOnce(null)
        // The re-read inside the transaction.
        .mockResolvedValueOnce({ id: 'structure-1', lines: [] });

      const result = await service.create(createDto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.salaryStructure.create).toHaveBeenCalledWith({
        data: {
          employeeId: 'employee-1',
          currency: 'OMR',
          effectiveFrom: new Date('2026-01-01'),
        },
      });
      expect(prisma.salaryStructureLine.createMany).toHaveBeenCalledWith({
        data: [
          { structureId: 'structure-1', componentId: BASIC.id, amount: 600 },
          {
            structureId: 'structure-1',
            componentId: SOCIAL_SEC_EE.id,
            amount: 42,
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: 'structure-1', lines: [] });
    });

    it('uppercases the currency it stores', async () => {
      await service.create({ ...createDto, currency: 'omr' });

      expect(
        firstArg<{ data: { currency: string } }>(prisma.salaryStructure.create)
          .data.currency,
      ).toBe('OMR');
    });

    it('points a second structure at PATCH rather than writing one', async () => {
      prisma.salaryStructure.findUnique.mockResolvedValue({
        id: 'structure-existing',
      });

      await expect(service.create(createDto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.create(createDto)).rejects.toThrow(
        /PATCH \/salary-structures\/structure-existing/,
      );
      expect(prisma.salaryStructure.create).not.toHaveBeenCalled();
    });

    it('refuses a terminated employee by name', async () => {
      prisma.employee.findUnique.mockResolvedValue({
        id: 'employee-1',
        firstName: 'Aisha',
        lastName: 'Al Balushi',
        status: 'TERMINATED',
      });

      await expect(service.create(createDto)).rejects.toThrow(
        /Aisha Al Balushi has been terminated/,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('404s on an employee that does not exist', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.create(createDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects the same component listed twice with a 409 sentence', async () => {
      const dto = {
        ...createDto,
        lines: [
          { componentId: BASIC.id, amount: 600 },
          { componentId: BASIC.id, amount: 50 },
        ],
      };

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
      await expect(service.create(dto)).rejects.toThrow(
        /appears twice in this structure/,
      );
      // Caught before the catalogue is even consulted, and long before a write.
      expect(prisma.salaryComponent.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a structure with no earning line', async () => {
      prisma.salaryComponent.findMany.mockResolvedValue([SOCIAL_SEC_EE]);

      await expect(
        service.create({
          ...createDto,
          lines: [{ componentId: SOCIAL_SEC_EE.id, amount: 42 }],
        }),
      ).rejects.toThrow(
        'A salary structure must have at least one earning line.',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses an earning line of zero — it pays nobody anything', async () => {
      prisma.salaryComponent.findMany.mockResolvedValue([BASIC, SOCIAL_SEC_EE]);

      await expect(
        service.create({
          ...createDto,
          lines: [
            { componentId: BASIC.id, amount: 0 },
            { componentId: SOCIAL_SEC_EE.id, amount: 42 },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a retired component, naming its code', async () => {
      prisma.salaryComponent.findMany.mockResolvedValue([
        BASIC,
        { ...SOCIAL_SEC_EE, isActive: false },
      ]);

      await expect(service.create(createDto)).rejects.toThrow(
        /SOCIAL_SEC_EE has been retired/,
      );
    });

    it('refuses a component id the catalogue does not know', async () => {
      prisma.salaryComponent.findMany.mockResolvedValue([BASIC]);

      await expect(service.create(createDto)).rejects.toThrow(
        /no longer exist/,
      );
    });

    it('names both currencies when the contract disagrees', async () => {
      prisma.contract.findFirst.mockResolvedValue({ currency: 'AED' });

      await expect(
        service.create({ ...createDto, currency: 'OMR' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create({ ...createDto, currency: 'OMR' }),
      ).rejects.toThrow(
        "This employee's active contract is in AED, but the salary structure was submitted in OMR. Both must use the same currency.",
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts a structure for an employee with no active contract', async () => {
      prisma.contract.findFirst.mockResolvedValue(null);

      await expect(service.create(createDto)).resolves.toMatchObject({
        success: true,
      });
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.salaryStructure.findUnique.mockResolvedValue({
        id: 'structure-1',
        employeeId: 'employee-1',
        currency: 'OMR',
      });
      prisma.salaryComponent.findMany.mockResolvedValue([BASIC, HRA]);
    });

    it('replaces the whole line set inside one transaction', async () => {
      const result = await service.update('structure-1', {
        effectiveFrom: '2026-07-01',
        lines: [
          { componentId: BASIC.id, amount: 700 },
          { componentId: HRA.id, amount: 250 },
        ],
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.salaryStructureLine.deleteMany).toHaveBeenCalledWith({
        where: { structureId: 'structure-1' },
      });
      expect(prisma.salaryStructureLine.createMany).toHaveBeenCalledWith({
        data: [
          { structureId: 'structure-1', componentId: BASIC.id, amount: 700 },
          { structureId: 'structure-1', componentId: HRA.id, amount: 250 },
        ],
      });
      // The delete has to precede the insert, or the insert is what gets wiped.
      expect(
        prisma.salaryStructureLine.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(
        prisma.salaryStructureLine.createMany.mock.invocationCallOrder[0],
      );
      expect(prisma.salaryStructure.update).toHaveBeenCalledWith({
        where: { id: 'structure-1' },
        data: { currency: 'OMR', effectiveFrom: new Date('2026-07-01') },
      });
      expect(result.success).toBe(true);
    });

    it('leaves the lines alone when the payload does not carry any', async () => {
      await service.update('structure-1', { effectiveFrom: '2026-07-01' });

      expect(prisma.salaryStructureLine.deleteMany).not.toHaveBeenCalled();
      expect(prisma.salaryStructureLine.createMany).not.toHaveBeenCalled();
      expect(prisma.salaryComponent.findMany).not.toHaveBeenCalled();
    });

    it('touches nothing when the replacement has no earning line', async () => {
      prisma.salaryComponent.findMany.mockResolvedValue([SOCIAL_SEC_EE]);

      await expect(
        service.update('structure-1', {
          lines: [{ componentId: SOCIAL_SEC_EE.id, amount: 42 }],
        }),
      ).rejects.toThrow(
        'A salary structure must have at least one earning line.',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.salaryStructureLine.deleteMany).not.toHaveBeenCalled();
    });

    it('404s on a structure that is not there', async () => {
      prisma.salaryStructure.findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { currency: 'OMR' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      prisma.salaryStructure.findUnique.mockResolvedValue({
        id: 'structure-1',
        employeeId: 'employee-1',
      });
    });

    it('deletes a structure that has never paid anybody', async () => {
      prisma.payslip.count.mockResolvedValue(0);

      const result = await service.remove('structure-1');

      expect(prisma.salaryStructure.delete).toHaveBeenCalledWith({
        where: { id: 'structure-1' },
      });
      expect(result).toMatchObject({
        success: true,
        data: { id: 'structure-1' },
      });
    });

    it('refuses once the employee has a payslip, naming the count', async () => {
      prisma.payslip.count.mockResolvedValue(3);

      await expect(service.remove('structure-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.remove('structure-1')).rejects.toThrow(
        /has 3 payslips already/,
      );
      expect(prisma.salaryStructure.delete).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('sums the EARNING lines into a gross and counts every line', async () => {
      prisma.salaryStructure.findMany.mockResolvedValue([
        {
          id: 'structure-1',
          currency: 'OMR',
          employee: { id: 'employee-1', employeeCode: 'EMP-001' },
          lines: [
            { amount: 600, component: { type: 'EARNING' } },
            { amount: 250.125, component: { type: 'EARNING' } },
            { amount: 42, component: { type: 'DEDUCTION' } },
            { amount: 63, component: { type: 'EMPLOYER_CONTRIBUTION' } },
          ],
        },
      ]);
      prisma.salaryStructure.count.mockResolvedValue(1);

      const result = await service.findAll({});

      expect(result.data[0]).toMatchObject({
        id: 'structure-1',
        lineCount: 4,
        grossPay: 850.125,
      });
      // The nested lines do not travel to the browser; the register asks one
      // question and gets one answer.
      expect(result.data[0]).not.toHaveProperty('lines');
      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
    });

    it('filters on the employee rather than on the structure', async () => {
      prisma.salaryStructure.findMany.mockResolvedValue([]);
      prisma.salaryStructure.count.mockResolvedValue(0);

      await service.findAll({ branchId: 'branch-1', search: 'ali' });

      const where = firstArg<{ where: { employee: Record<string, unknown> } }>(
        prisma.salaryStructure.findMany,
      ).where;
      expect(where.employee).toMatchObject({ branchId: 'branch-1' });
      expect(where.employee.OR).toHaveLength(3);
    });
  });

  describe('findByEmployee', () => {
    it('says what is missing rather than "not found"', async () => {
      prisma.salaryStructure.findUnique.mockResolvedValue(null);

      await expect(service.findByEmployee('employee-9')).rejects.toThrow(
        /no salary structure yet/,
      );
    });
  });
});
