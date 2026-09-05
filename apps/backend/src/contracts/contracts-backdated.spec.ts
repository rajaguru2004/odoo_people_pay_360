import { ConflictException } from '@nestjs/common';
import { ContractsService } from './contracts.service';

/**
 * Backdated contracts.
 *
 * Onboarding a hire whose paperwork arrived late means entering contracts that
 * already started — and sometimes already ended. Two things follow:
 *
 *  - a contract whose end date has passed is born EXPIRED, rather than sitting
 *    ACTIVE until the midnight autoExpireContracts cron notices;
 *  - the "employee already has an active contract" guard only applies when the
 *    new contract would itself be active, otherwise a historical chain can
 *    never be entered.
 */
describe('ContractsService — backdated contract creation', () => {
  let prisma: any;
  let service: ContractsService;

  const EMPLOYEE = {
    id: 'emp-1',
    branchId: null,
    employeeCode: 'E1',
    salaryType: 'MONTHLY',
    isActive: true,
  };

  const daysFromToday = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  };

  beforeEach(() => {
    prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue(EMPLOYEE),
        update: jest.fn().mockResolvedValue({}),
      },
      contract: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'c-1' }),
        update: jest.fn().mockResolvedValue({ id: 'c-1' }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new ContractsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { assertCleared: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
          // GarnishmentsService — appended to the ctor when court orders became a
      // real model; an exit flips any unrecovered balance to RECEIVABLE.
      { markOutstandingAsReceivable: jest.fn().mockResolvedValue(0) } as any,
);
    jest
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => undefined);
  });

  const create = (over: Record<string, any> = {}) =>
    service.create({
      employeeId: 'emp-1',
      contractType: 'FIXED_TERM',
      contractNumber: 'CT-1',
      startDate: daysFromToday(-540),
      endDate: daysFromToday(-180),
      salary: 13000,
      ...over,
    } as any);

  const written = () => prisma.contract.create.mock.calls[0][0].data;

  describe('status at creation', () => {
    it('marks a contract whose end date has passed as EXPIRED', async () => {
      await create();
      expect(written().status).toBe('EXPIRED');
    });

    it('keeps a backdated contract with a future end date ACTIVE', async () => {
      await create({ endDate: daysFromToday(180) });
      expect(written().status).toBe('ACTIVE');
    });

    it('keeps an indefinite contract with no end date ACTIVE', async () => {
      await create({ contractType: 'INDEFINITE', endDate: undefined });
      expect(written().status).toBe('ACTIVE');
    });

    it('treats a contract ending today as still ACTIVE, matching the expiry cron', async () => {
      // autoExpireContracts uses `endDate: { lt: today }`, so today is not past.
      await create({ endDate: daysFromToday(0) });
      expect(written().status).toBe('ACTIVE');
    });

    it('records the backdated start date as given', async () => {
      const startDate = '2019-04-01';
      await create({ startDate });
      expect(written().startDate).toEqual(new Date(startDate));
    });
  });

  describe('conflict with an existing active contract', () => {
    const existingActive = () =>
      prisma.contract.findFirst.mockResolvedValue({
        id: 'c-old',
        status: 'ACTIVE',
      });

    it('allows a historical contract alongside a current one', async () => {
      existingActive();
      await expect(create()).resolves.toBeDefined();
      expect(written().status).toBe('EXPIRED');
    });

    it('still rejects a second contract that would also be active', async () => {
      existingActive();
      await expect(create({ endDate: daysFromToday(180) })).rejects.toThrow(
        ConflictException,
      );
    });

    it('does not even query for a conflict when the new contract is already expired', async () => {
      await create();
      expect(prisma.contract.findFirst).not.toHaveBeenCalled();
    });
  });

  it('accepts a contract starting before the employee record does', async () => {
    // No server-side consistency rule exists between the two dates, and adding
    // one would break data migrations and historical entry.
    await expect(create({ startDate: '2005-01-01' })).resolves.toBeDefined();
  });

  it('still mirrors the salary onto a monthly employee', async () => {
    await create();
    expect(prisma.employee.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { baseSalary: 13000 } }),
    );
  });
});
