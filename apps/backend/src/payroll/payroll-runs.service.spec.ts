import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { AttendanceCalendarService } from '../attendances/attendance-calendar.service';
import { PayrollRunsService } from './payroll-runs.service';

const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

/** A Muscat branch resting Friday and Saturday. */
const MUSCAT = {
  branchId: 'b1',
  zone: 'Asia/Muscat',
  officeStart: '08:00',
  officeEnd: '17:00',
  graceMinutes: 15,
  weeklyOffDays: [5, 6],
  expectedHours: 8,
};

const component = (
  id: string,
  code: string,
  type: string,
  sequence: number,
) => ({ id, code, name: code, type, sequence });

const structureFor = (
  employeeId: string,
  amounts: Array<[string, string, number, number]>,
) => ({
  id: `st-${employeeId}`,
  employeeId,
  currency: 'OMR',
  lines: amounts.map(([code, type, amount, sequence], i) => ({
    id: `l-${employeeId}-${i}`,
    amount,
    component: component(`c-${code}`, code, type, sequence),
  })),
});

const PAYING_LINES: Array<[string, string, number, number]> = [
  ['BASIC', 'EARNING', 600, 10],
  ['HRA', 'EARNING', 400, 20],
  ['SOCIAL_SEC_EE', 'DEDUCTION', 70, 200],
  ['SOCIAL_SEC_ER', 'EMPLOYER_CONTRIBUTION', 105, 300],
];

interface StatusFilter {
  in?: string[];
  notIn?: string[];
}

interface UpdateManyArgs {
  where: { id?: string; status?: string | StatusFilter };
  data: Record<string, unknown>;
}

interface Fixture {
  employees: Array<{
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
    branchId: string | null;
    departmentId: string | null;
  }>;
  structures: ReturnType<typeof structureFor>[];
  attendance: Array<{ employeeId: string; date: Date; status: string }>;
  contracts: Array<{ employeeId: string; status: string }>;
  run: Record<string, unknown> | null;
  existingRun: Record<string, unknown> | null;
}

function build(overrides: Partial<Fixture> = {}) {
  const fixture: Fixture = {
    employees: [
      {
        id: 'e1',
        employeeCode: 'EMP001',
        firstName: 'Aisha',
        lastName: 'Rahman',
        branchId: 'b1',
        departmentId: 'd1',
      },
    ],
    structures: [structureFor('e1', PAYING_LINES)],
    attendance: [
      { employeeId: 'e1', date: day('2026-08-03'), status: 'PRESENT' },
    ],
    contracts: [{ employeeId: 'e1', status: 'ACTIVE' }],
    run: {
      id: 'run-1',
      periodStart: day('2026-08-01'),
      periodEnd: day('2026-08-31'),
      status: 'DRAFT',
      currency: 'OMR',
      totalGross: 0,
      totalNet: 0,
      employeeCount: 0,
    },
    existingRun: null,
    ...overrides,
  };

  const created: Array<Record<string, unknown>> = [];
  const runUpdates: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const updateManyCalls: UpdateManyArgs[] = [];

  const tx = {
    payslip: {
      deleteMany: jest.fn((args: { where: { payrollRunId: string } }) => {
        deleted.push(args.where.payrollRunId);
        return Promise.resolve({ count: 0 });
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: `ps-${created.length}` });
      }),
    },
    payrollRun: {
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        runUpdates.push(args.data);
        return Promise.resolve({ ...fixture.run, ...args.data });
      }),
    },
  };

  const prismaMock = {
    employee: {
      findMany: jest.fn(() => Promise.resolve(fixture.employees)),
    },
    salaryStructure: {
      findMany: jest.fn(() => Promise.resolve(fixture.structures)),
    },
    attendance: {
      findMany: jest.fn(() => Promise.resolve(fixture.attendance)),
    },
    contract: {
      findMany: jest.fn(() => Promise.resolve(fixture.contracts)),
      findFirst: jest.fn(() => Promise.resolve({ currency: 'OMR' })),
    },
    payrollRun: {
      findUnique: jest.fn(() => Promise.resolve(fixture.run)),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(fixture.run)),
      findFirst: jest.fn(() => Promise.resolve(fixture.existingRun)),
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'new', ...args.data }),
      ),
      update: jest.fn(() => Promise.resolve(fixture.run)),
      updateMany: jest.fn((args: UpdateManyArgs) => {
        updateManyCalls.push(args);
        const status = fixture.run?.status as string | undefined;
        const expected = args.where.status;
        const matches =
          expected === undefined ||
          (typeof expected === 'string' && expected === status) ||
          (typeof expected === 'object' &&
            ((expected.notIn
              ? !expected.notIn.includes(status ?? '')
              : false) ||
              (expected.in ? expected.in.includes(status ?? '') : false)));
        return Promise.resolve({ count: matches ? 1 : 0 });
      }),
      delete: jest.fn(() => Promise.resolve(fixture.run)),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const prisma = prismaMock as unknown as PrismaService;

  const calendar = {
    branchConfigs: jest.fn(() =>
      Promise.resolve(
        new Map([
          ['b1', MUSCAT],
          ['__none__', MUSCAT],
        ]),
      ),
    ),
    holidayIndex: jest.fn(() => Promise.resolve(new Map())),
    configFor: jest.fn(() => MUSCAT),
    isBranchWorkingDay: jest.fn((_config: unknown, dayKey: string) => {
      const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
      return weekday !== 5 && weekday !== 6;
    }),
  } as unknown as AttendanceCalendarService;

  const service = new PayrollRunsService(prisma, calendar);
  // The mocks are handed back typed, so a spec reads `mocks.runCreate.mock.calls`
  // rather than casting the service's Prisma dependency back to `any`.
  const mocks = {
    runCreate: prismaMock.payrollRun.create,
    transaction: prismaMock.$transaction,
    payslipCreate: tx.payslip.create,
  };
  return {
    service,
    mocks,
    created,
    runUpdates,
    deleted,
    updateManyCalls,
    fixture,
  };
}

describe('preflight', () => {
  it('is ready when everybody can be paid', async () => {
    const { service } = build();
    const result = await service.preflight({ month: 8, year: 2026 });
    expect(result.data.canGenerate).toBe(true);
    expect(result.data.period.label).toBe('Aug 2026');
    expect(
      result.data.findings.filter((f) => f.severity === 'BLOCKER'),
    ).toEqual([]);
  });

  it('names the employee with no salary structure as a blocker', async () => {
    const { service } = build({ structures: [] });
    const result = await service.preflight({ month: 8, year: 2026 });
    expect(result.data.canGenerate).toBe(false);
    expect(result.data.findings).toContainEqual(
      expect.objectContaining({
        code: 'NO_STRUCTURE',
        severity: 'BLOCKER',
        employeeId: 'e1',
        employeeName: 'Aisha Rahman',
      }),
    );
  });

  it('blocks a period where nobody has any attendance at all', async () => {
    // The expensive mistake: LOP is zero for everyone and the run pays a full
    // month against a period that was never processed.
    const { service } = build({ attendance: [] });
    const result = await service.preflight({ month: 8, year: 2026 });
    expect(result.data.canGenerate).toBe(false);
    expect(
      result.data.findings.some((f) => f.code === 'NO_ATTENDANCE_AT_ALL'),
    ).toBe(true);
  });

  it('warns rather than blocks when a contract has lapsed', async () => {
    const { service } = build({ contracts: [] });
    const result = await service.preflight({ month: 8, year: 2026 });
    const finding = result.data.findings.find(
      (f) => f.code === 'NO_ACTIVE_CONTRACT',
    );
    expect(finding?.severity).toBe('WARNING');
    expect(result.data.canGenerate).toBe(true);
  });

  it('writes nothing', async () => {
    const { service, mocks } = build();
    await service.preflight({ month: 8, year: 2026 });
    expect(mocks.runCreate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('calculate', () => {
  it('refuses in the same words the pre-flight used', async () => {
    const { service } = build({ structures: [] });
    const preflight = await service.preflight({ month: 8, year: 2026 });
    const blocker = preflight.data.findings.find(
      (f) => f.severity === 'BLOCKER',
    );

    await expect(service.calculate('run-1')).rejects.toThrow(
      new BadRequestException(blocker!.message),
    );
  });

  it('writes the payslips and the run totals inside ONE transaction', async () => {
    const { service, mocks, created, runUpdates, deleted } = build();
    await service.calculate('run-1');

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    // The previous payslips go before the new ones arrive; half a
    // recalculation is worse than none.
    expect(deleted).toEqual(['run-1']);
    expect(created).toHaveLength(1);
    expect(runUpdates[0]).toMatchObject({
      status: 'CALCULATED',
      employeeCount: 1,
    });
  });

  it('numbers payslips from the period', async () => {
    const { service, created } = build();
    await service.calculate('run-1');
    expect(created[0].payslipNumber).toBe('PS-2026-08-0001');
  });

  it('clears a stale rejection reason', async () => {
    const { service, runUpdates } = build();
    await service.calculate('run-1');
    expect(runUpdates[0].rejectionReason).toBeNull();
  });

  it('keeps employer contributions out of gross, deductions and net', async () => {
    const { service, created } = build();
    await service.calculate('run-1');
    const slip = created[0];
    expect(Number(slip.grossPay)).toBe(1000);
    expect(Number(slip.totalEmployerCost)).toBe(105);
    expect(Number(slip.netPay)).toBe(
      Number(slip.grossPay) - Number(slip.totalDeductions),
    );
  });

  it('refuses to recalculate an approved run', async () => {
    const { service } = build({
      run: {
        id: 'run-1',
        periodStart: day('2026-08-01'),
        periodEnd: day('2026-08-31'),
        status: 'APPROVED',
      },
    });
    await expect(service.calculate('run-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('404s for a run that does not exist', async () => {
    const { service } = build({ run: null });
    await expect(service.calculate('run-1')).rejects.toThrow(NotFoundException);
  });
});

describe('create', () => {
  it('refuses a second run for the same period, naming it', async () => {
    const { service } = build({ existingRun: { id: 'other' } });
    await expect(service.create({ month: 8, year: 2026 })).rejects.toThrow(
      new ConflictException('A payroll run for Aug 2026 already exists.'),
    );
  });

  it('opens the run as a draft over the whole month', async () => {
    const { service, mocks } = build();
    await service.create({ month: 2, year: 2024 });
    const args = mocks.runCreate.mock.calls[0][0];
    expect(args.data.status).toBe('DRAFT');
    // Leap year, and not shifted by a zone.
    expect(args.data.periodEnd).toEqual(day('2024-02-29'));
  });
});

describe('transitions', () => {
  const runIn = (status: string) => ({
    id: 'run-1',
    periodStart: day('2026-08-01'),
    periodEnd: day('2026-08-31'),
    status,
  });

  it('approves with the expected status in the where clause, not read-then-write', async () => {
    // Two approvals racing would otherwise both read CALCULATED and both win.
    const { service, updateManyCalls } = build({ run: runIn('CALCULATED') });
    await service.approve('run-1', 'user-9');
    expect(updateManyCalls[0].where).toMatchObject({
      id: 'run-1',
      status: 'CALCULATED',
    });
    expect(updateManyCalls[0].data).toMatchObject({
      status: 'APPROVED',
      approvedById: 'user-9',
    });
  });

  it('refuses to approve a run that is not calculated', async () => {
    const { service } = build({ run: runIn('DRAFT') });
    await expect(service.approve('run-1', 'user-9')).rejects.toThrow(
      'Only a calculated payroll run can be approved.',
    );
  });

  it('sends a rejected run back to draft with its reason', async () => {
    const { service, updateManyCalls } = build({ run: runIn('CALCULATED') });
    await service.reject('run-1', 'The transport allowance is wrong');
    expect(updateManyCalls[0].data).toMatchObject({
      status: 'DRAFT',
      rejectionReason: 'The transport allowance is wrong',
      approvedAt: null,
      approvedById: null,
    });
  });

  it('marks only an approved run paid', async () => {
    const { service } = build({ run: runIn('CALCULATED') });
    await expect(service.markPaid('run-1')).rejects.toThrow(
      'Only an approved payroll run can be marked paid.',
    );
  });

  it('cancels anything that has not been paid', async () => {
    const { service, updateManyCalls } = build({ run: runIn('CALCULATED') });
    await service.cancel('run-1');
    const statusFilter = updateManyCalls[0].where.status as StatusFilter;
    expect(statusFilter.notIn).toEqual(
      expect.arrayContaining(['PAID', 'CANCELLED']),
    );
  });

  it('refuses to cancel a paid run', async () => {
    const { service } = build({ run: runIn('PAID') });
    await expect(service.cancel('run-1')).rejects.toThrow(
      'A paid or already cancelled payroll run cannot be cancelled.',
    );
  });

  it('deletes only a draft', async () => {
    const { service } = build({ run: runIn('CALCULATED') });
    await expect(service.remove('run-1')).rejects.toThrow(
      'Only a draft payroll run can be deleted. Cancel it instead.',
    );
  });
});
