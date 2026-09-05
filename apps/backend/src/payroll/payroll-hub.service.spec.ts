import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PrismaService } from '../prisma/prisma.service';
import { PayrollHubQueryDto } from './dto/hub-query.dto';
import {
  buildAttention,
  NAME_CAP,
  PayrollHubService,
  trendWindow,
} from './payroll-hub.service';

/**
 * 15 September 2026, in the company clock the fake reports (`UTC`).
 *
 * The anchor period is therefore `Sep 2026` and its predecessor `Aug 2026`,
 * which is what every expectation below is written against.
 */
const NOW = new Date('2026-09-15T09:00:00.000Z');

const date = (key: string) => new Date(`${key}T00:00:00.000Z`);

type Status = 'DRAFT' | 'CALCULATED' | 'APPROVED' | 'PAID' | 'CANCELLED';

interface FakeRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: Status;
  currency?: string;
  totalGross?: number;
  totalNet?: number;
  employeeCount?: number;
  calculatedAt?: Date | null;
}

interface FakeSlip {
  employeeId: string;
  runId: string;
  grossPay?: number;
  netPay?: number;
  totalDeductions?: number;
  totalEmployerCost?: number;
}

interface FakeEmployee {
  firstName: string;
  lastName: string;
  status?: string;
  hasStructure?: boolean;
  hasActiveContract?: boolean;
}

/** The slices of a Prisma `where` this fake understands. */
interface RunWhere {
  OR?: RunWhere[];
  status?: { in: Status[] };
  periodStart?: { gte?: Date };
  periodEnd?: { lt?: Date };
}

interface SlipWhere {
  payrollRun?: { status?: { in: Status[] }; periodStart?: Date };
}

interface EmployeeWhere {
  status?: string;
  salaryStructure?: { is: null };
  contracts?: { none: unknown };
}

/** Does this run match the `where` the service passed for a run read? */
function runMatches(run: FakeRun, where: RunWhere = {}): boolean {
  if (where.OR) {
    return where.OR.some((clause) => runMatches(run, clause));
  }
  if (where.status?.in && !where.status.in.includes(run.status)) return false;
  if (where.periodStart?.gte && date(run.periodStart) < where.periodStart.gte) {
    return false;
  }
  if (where.periodEnd?.lt && !(date(run.periodEnd) < where.periodEnd.lt)) {
    return false;
  }
  return true;
}

/** Does this payslip's run match the nested `payrollRun` filter? */
function slipMatches(
  slip: FakeSlip,
  runs: FakeRun[],
  where: SlipWhere = {},
): boolean {
  const run = runs.find((r) => r.id === slip.runId);
  if (!run) return false;
  const filter = where.payrollRun ?? {};
  if (filter.status?.in && !filter.status.in.includes(run.status)) return false;
  if (
    filter.periodStart instanceof Date &&
    date(run.periodStart).getTime() !== filter.periodStart.getTime()
  ) {
    return false;
  }
  return true;
}

function employeeMatches(
  employee: FakeEmployee,
  where: EmployeeWhere = {},
): boolean {
  if (where.status && (employee.status ?? 'ACTIVE') !== where.status) {
    return false;
  }
  if (where.salaryStructure?.is === null && employee.hasStructure !== false) {
    return false;
  }
  if (where.contracts?.none && employee.hasActiveContract !== false) {
    return false;
  }
  return true;
}

function makePrisma(
  options: {
    runs?: FakeRun[];
    payslips?: FakeSlip[];
    employees?: FakeEmployee[];
    timezone?: string;
  } = {},
) {
  const runs = options.runs ?? [];
  const payslips = options.payslips ?? [];
  const employees = options.employees ?? [];

  const sum = (rows: FakeSlip[], field: keyof FakeSlip) =>
    rows.reduce((total, row) => total + ((row[field] as number) ?? 0), 0);

  return {
    company: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ timezone: options.timezone ?? 'UTC' }),
    },
    payrollRun: {
      groupBy: jest.fn(() =>
        Promise.resolve(
          [...new Set(runs.map((run) => run.status))].map((status) => ({
            status,
            _count: { _all: runs.filter((r) => r.status === status).length },
          })),
        ),
      ),
      findMany: jest.fn(({ where }: { where?: RunWhere } = {}) =>
        Promise.resolve(
          runs
            .filter((run) => runMatches(run, where))
            .map((run) => ({
              id: run.id,
              periodStart: date(run.periodStart),
              periodEnd: date(run.periodEnd),
              status: run.status,
              currency: run.currency ?? 'OMR',
              totalGross: run.totalGross ?? 0,
              totalNet: run.totalNet ?? 0,
              employeeCount: run.employeeCount ?? 0,
              calculatedAt: run.calculatedAt ?? null,
            }))
            .sort((a, b) => b.periodStart.getTime() - a.periodStart.getTime()),
        ),
      ),
      count: jest.fn(({ where }: { where?: RunWhere } = {}) =>
        Promise.resolve(runs.filter((run) => runMatches(run, where)).length),
      ),
    },
    payslip: {
      aggregate: jest.fn(
        ({
          where,
          _sum,
        }: {
          where?: SlipWhere;
          _sum?: Record<string, boolean>;
        }) => {
          const rows = payslips.filter((slip) =>
            slipMatches(slip, runs, where),
          );
          const sums: Record<string, number> = {};
          for (const field of Object.keys(_sum ?? {})) {
            sums[field] = sum(rows, field as keyof FakeSlip);
          }
          return Promise.resolve({
            _sum: sums,
            _count: { _all: rows.length },
          });
        },
      ),
      groupBy: jest.fn(({ where }: { where?: SlipWhere }) =>
        Promise.resolve(
          [
            ...new Set(
              payslips
                .filter((slip) => slipMatches(slip, runs, where))
                .map((slip) => slip.employeeId),
            ),
          ].map((employeeId) => ({ employeeId })),
        ),
      ),
    },
    employee: {
      count: jest.fn(({ where }: { where?: EmployeeWhere }) =>
        Promise.resolve(
          employees.filter((person) => employeeMatches(person, where)).length,
        ),
      ),
      findMany: jest.fn(
        ({ where, take }: { where?: EmployeeWhere; take?: number }) =>
          Promise.resolve(
            employees
              .filter((person) => employeeMatches(person, where))
              .slice(0, take)
              .map(({ firstName, lastName }) => ({ firstName, lastName })),
          ),
      ),
    },
  };
}

const makeHub = (options: Parameters<typeof makePrisma>[0] = {}) =>
  new PayrollHubService(makePrisma(options) as unknown as PrismaService);

const person = (n: number, overrides: Partial<FakeEmployee> = {}) => ({
  firstName: `Person${String(n).padStart(2, '0')}`,
  lastName: 'Test',
  status: 'ACTIVE',
  hasStructure: true,
  hasActiveContract: true,
  ...overrides,
});

describe('trendWindow', () => {
  it('runs oldest first and ends at the anchor month', () => {
    const window = trendWindow(9, 2026, 6);
    expect(window).toHaveLength(6);
    expect(window[0].label).toBe('Apr 2026');
    expect(window[5].label).toBe('Sep 2026');
    expect(window[5].periodStart).toBe('2026-09-01');
    expect(window[5].periodEnd).toBe('2026-09-30');
  });

  it('wraps the year backwards', () => {
    expect(trendWindow(2, 2026, 6)[0].label).toBe('Sep 2025');
  });
});

describe('buildAttention', () => {
  const empty = { count: 0, names: [] };

  it('leaves out everything that is not actually wrong', () => {
    expect(
      buildAttention({
        noStructure: empty,
        noContract: empty,
        awaitingApproval: empty,
        staleOpen: empty,
      }),
    ).toEqual([]);
  });

  it('says "employee" once and "employees" more than once', () => {
    const [item] = buildAttention({
      noStructure: { count: 1, names: ['Ada Lovelace'] },
      noContract: empty,
      awaitingApproval: empty,
      staleOpen: empty,
    });
    expect(item.message).toBe(
      '1 active employee has no salary structure and cannot be paid',
    );
  });
});

describe('PayrollHubService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('anchors on the current month in the company clock and labels it', async () => {
    const summary = await makeHub().hubSummary(6);

    expect(summary.period).toEqual({
      label: 'Sep 2026',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
    });
    expect(summary.previousPeriod.label).toBe('Aug 2026');
    // The server owns every bucket label — the browser does no calendar maths.
    expect(summary.trend.map((bucket) => bucket.label)).toEqual([
      'Apr 2026',
      'May 2026',
      'Jun 2026',
      'Jul 2026',
      'Aug 2026',
      'Sep 2026',
    ]);
  });

  it('excludes DRAFT and CALCULATED runs from every money figure', async () => {
    const summary = await makeHub({
      runs: [
        {
          id: 'draft',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'DRAFT',
          totalGross: 9_000,
          totalNet: 8_000,
          employeeCount: 3,
        },
        {
          id: 'locked',
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          status: 'PAID',
          totalGross: 4_000,
          totalNet: 3_500,
          employeeCount: 2,
        },
      ],
      payslips: [
        { employeeId: 'e1', runId: 'draft', grossPay: 9_000, netPay: 8_000 },
        { employeeId: 'e2', runId: 'locked', grossPay: 4_000, netPay: 3_500 },
      ],
    }).hubSummary(6);

    // September's only run is a draft, so the anchor period paid nothing.
    expect(summary.money.gross).toBe(0);
    expect(summary.money.net).toBe(0);
    expect(summary.money.previousNet).toBe(3_500);
    expect(summary.employees.paid).toBe(0);

    // The draft is still visible as work in progress — just not as money.
    expect(summary.runs.byStatus.DRAFT).toBe(1);
    expect(summary.employees.inOpenRun).toBe(1);

    const september = summary.trend.at(-1);
    const august = summary.trend.at(-2);
    expect(september).toMatchObject({ gross: 0, net: 0, employeeCount: 0 });
    expect(august).toMatchObject({
      gross: 4_000,
      net: 3_500,
      employeeCount: 2,
    });
  });

  it('reports a change against a period that paid nothing as null, not zero', async () => {
    const summary = await makeHub({
      runs: [
        {
          id: 'sep',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'APPROVED',
          totalGross: 5_000,
          totalNet: 4_500,
          employeeCount: 1,
        },
      ],
      payslips: [
        { employeeId: 'e1', runId: 'sep', grossPay: 5_000, netPay: 4_500 },
      ],
    }).hubSummary(6);

    expect(summary.money.net).toBe(4_500);
    expect(summary.money.previousNet).toBe(0);
    // Nought per cent would claim the month was unchanged, which is a statement
    // about a comparison that cannot be made. The frontend renders null as an
    // em dash.
    expect(summary.money.changePct).toBeNull();
  });

  it('computes a real change when there is something to divide by', async () => {
    const summary = await makeHub({
      runs: [
        {
          id: 'sep',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'PAID',
        },
        {
          id: 'aug',
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          status: 'PAID',
        },
      ],
      payslips: [
        { employeeId: 'e1', runId: 'sep', netPay: 1_200 },
        { employeeId: 'e1', runId: 'aug', netPay: 1_000 },
      ],
    }).hubSummary(6);

    expect(summary.money.changePct).toBe(20);
  });

  it('caps the names sample while the count stays the true total', async () => {
    const employees = Array.from({ length: 12 }, (_, index) =>
      person(index + 1, { hasStructure: false }),
    );
    const summary = await makeHub({ employees }).hubSummary(6);

    expect(summary.employees.active).toBe(12);
    expect(summary.employees.withoutStructure).toBe(12);
    expect(summary.employees.withoutStructureNames).toHaveLength(NAME_CAP);

    const item = summary.attention.find((row) => row.code === 'NO_STRUCTURE');
    expect(item?.count).toBe(12);
    expect(item?.names).toHaveLength(NAME_CAP);
    expect(item?.names[0]).toBe('Person01 Test');
  });

  it('raises a run left open for a period that has already ended', async () => {
    const summary = await makeHub({
      runs: [
        {
          id: 'jul',
          periodStart: '2026-07-01',
          periodEnd: '2026-07-31',
          status: 'CALCULATED',
          calculatedAt: new Date('2026-08-02T10:00:00.000Z'),
        },
        {
          id: 'sep',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'DRAFT',
        },
      ],
    }).hubSummary(6);

    // September is still running, so only July is stale.
    const stale = summary.attention.find(
      (row) => row.code === 'DRAFT_FOR_CLOSED_PERIOD',
    );
    expect(stale?.count).toBe(1);
    expect(stale?.names).toEqual(['Jul 2026']);

    expect(summary.runs.oldestAwaitingApproval).toEqual({
      id: 'jul',
      label: 'Jul 2026',
      calculatedAt: new Date('2026-08-02T10:00:00.000Z'),
    });
  });

  it('flags active employees with no active contract behind their pay', async () => {
    const summary = await makeHub({
      employees: [
        person(1),
        person(2, { hasActiveContract: false }),
        person(3, { status: 'TERMINATED', hasActiveContract: false }),
      ],
    }).hubSummary(6);

    const item = summary.attention.find(
      (row) => row.code === 'NO_ACTIVE_CONTRACT',
    );
    // The terminated employee is not an omission — nobody is paying them.
    expect(item?.count).toBe(1);
    expect(item?.names).toEqual(['Person02 Test']);
  });

  it('names every run status, so a card never reads undefined as zero', async () => {
    const summary = await makeHub().hubSummary(12);

    expect(summary.months).toBe(12);
    expect(summary.trend).toHaveLength(12);
    expect(summary.runs.byStatus).toEqual({
      DRAFT: 0,
      CALCULATED: 0,
      APPROVED: 0,
      PAID: 0,
      CANCELLED: 0,
    });
    expect(summary.runs.oldestAwaitingApproval).toBeNull();
    expect(summary.attention).toEqual([]);
    expect(summary.money.currency).toBe('OMR');
  });

  it('counts a person sitting in two open runs once', async () => {
    const summary = await makeHub({
      runs: [
        {
          id: 'aug',
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          status: 'DRAFT',
        },
        {
          id: 'sep',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          status: 'CALCULATED',
        },
      ],
      payslips: [
        { employeeId: 'e1', runId: 'aug' },
        { employeeId: 'e1', runId: 'sep' },
      ],
    }).hubSummary(6);

    expect(summary.employees.inOpenRun).toBe(1);
  });
});

describe('PayrollHubQueryDto', () => {
  const check = (value: unknown) =>
    validateSync(plainToInstance(PayrollHubQueryDto, { months: value }));

  it.each([6, 12, '6', '12'])('accepts %s', (value) => {
    expect(check(value)).toHaveLength(0);
  });

  it('refuses a window the hub does not offer rather than defaulting', () => {
    const errors = check(7);
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {})).toContain(
      'months must be 6 or 12',
    );
  });

  it('refuses a non-numeric window', () => {
    expect(check('half a year')).toHaveLength(1);
  });

  it('leaves months unset when it is not supplied', () => {
    expect(validateSync(plainToInstance(PayrollHubQueryDto, {}))).toHaveLength(
      0,
    );
  });
});
