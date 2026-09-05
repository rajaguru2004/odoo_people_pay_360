import { ContractsService } from './contracts.service';

/**
 * A Contract has no pay basis of its own — `salary` is just a number, and HR
 * types a monthly figure into it. Mirroring that number onto
 * `Employee.baseSalary` is correct for monthly staff and catastrophic for
 * daily-wage staff, whose baseSalary is a PER-DAY rate: saving a contract
 * turned e.g. 500/day into 13000/day, roughly a 26x overpayment on the next
 * payroll run.
 */
describe('ContractsService — contract salary vs a daily-wage rate', () => {
  let prisma: any;
  let service: ContractsService;

  const EMPLOYEE = { id: 'emp-1', branchId: null, employeeCode: 'E1' };

  const setBasis = (salaryType: string) =>
    prisma.employee.findUnique.mockResolvedValue({
      ...EMPLOYEE,
      salaryType,
      isActive: true,
    });

  beforeEach(() => {
    prisma = {
      employee: {
        findUnique: jest.fn(),
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
      // ClearanceService — no-op here; clearance behaviour is covered by
      // clearance.service.spec.ts and asset-clearance.e2e-spec.ts.
      { assertCleared: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
          // GarnishmentsService — appended to the ctor when court orders became a
      // real model; an exit flips any unrecovered balance to RECEIVABLE.
      { markOutstandingAsReceivable: jest.fn().mockResolvedValue(0) } as any,
);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  });

  const createDto = {
    employeeId: 'emp-1',
    contractType: 'INDEFINITE',
    contractNumber: 'CT-1',
    startDate: '2026-07-01',
    salary: 13000,
  } as any;

  it('mirrors the contract salary onto a MONTHLY employee', async () => {
    setBasis('MONTHLY');
    await service.create(createDto);
    expect(prisma.employee.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { baseSalary: 13000 } }),
    );
  });

  it('leaves a DAILY employee’s per-day rate untouched', async () => {
    setBasis('DAILY');
    await service.create(createDto);
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it('still records the figure on the contract itself', async () => {
    setBasis('DAILY');
    await service.create(createDto);
    expect(prisma.contract.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ salary: 13000 }),
      }),
    );
  });

  it('renewing a DAILY employee’s contract does not overwrite their rate either', async () => {
    setBasis('DAILY');
    prisma.contract.findUnique.mockResolvedValue({
      id: 'c-1',
      employeeId: 'emp-1',
      contractType: 'INDEFINITE',
      endDate: new Date('2026-06-30'),
      salary: 500,
      employee: { branchId: null },
    });
    await service.renew('c-1', { newEndDate: '2027-06-30', newSalary: 13000 } as any);
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it('an absent salaryType is treated as MONTHLY, so existing data keeps syncing', async () => {
    prisma.employee.findUnique.mockResolvedValue({ ...EMPLOYEE, isActive: true });
    await service.create(createDto);
    expect(prisma.employee.update).toHaveBeenCalled();
  });
});
