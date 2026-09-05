import { EmployeesService } from './employees.service';

/**
 * The workforce as a flow rather than a stock.
 *
 * The People hub used to lead with "Active headcount: 6" — the same number
 * most weeks, and nobody acts on it. Joiners and leavers are work somebody has
 * to do, and a probation end date that slips means the person is confirmed by
 * default: a decision nobody took.
 */
describe('EmployeesService.lifecycleStats', () => {
  const DAY = 86_400_000;
  let employees: any[];
  let contracts: any[];

  const inRange = (d: Date | null, where: any) => {
    if (!d) return false;
    if (where.gte && d < where.gte) return false;
    if (where.lte && d > where.lte) return false;
    if (where.gt && d <= where.gt) return false;
    return true;
  };

  const prisma: any = {
    employee: {
      count: jest.fn(async ({ where }: any) => {
        if (where.startDate) return employees.filter((e) => inRange(e.startDate, where.startDate)).length;
        if (where.endDate) return employees.filter((e) => inRange(e.endDate, where.endDate)).length;
        return employees.filter((e) => e.status === 'ACTIVE').length;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        employees.filter((e) => inRange(e.startDate, where.startDate)),
      ),
    },
    contract: {
      findMany: jest.fn(async ({ where }: any) =>
        contracts.filter(
          (c) =>
            c.contractType === where.contractType &&
            c.status === where.status &&
            inRange(c.endDate, where.endDate),
        ),
      ),
    },
  };

  // Positional construction, matching the other employees specs. Only prisma
  // is exercised by this method.
  const service = new EmployeesService(
    prisma, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any,
  );

  // The clock is PINNED, because these fixtures describe positions relative to
  // "now" and the calendar kept moving underneath them. Two cases failed for
  // most of every month: `thisMonth(9)` is in the FUTURE until the 9th, so
  // "Joiner B" showed up in the onboarding queue; and `now + 10 days` stays
  // inside the current month until roughly the 20th, so "Future" was counted
  // as a joiner and the net change came out 3, not 2.
  //
  // The 25th is chosen deliberately: it is the one shape where every fixture
  // means what it is named — days 3, 5 and 9 are all safely in the past, and
  // now+10d lands in the FOLLOWING month, so it is a starter without also
  // being a joiner this month. Deriving the dates from a live clock cannot
  // give that, because on the 1st of a 31-day month no date is both within 30
  // days and outside the current month.
  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-06-25T00:00:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const now = new Date();
    const thisMonth = (day: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
    employees = [
      { status: 'ACTIVE', fullName: 'Joiner A', startDate: thisMonth(3), endDate: null, department: { name: 'Ops' } },
      { status: 'ACTIVE', fullName: 'Joiner B', startDate: thisMonth(9), endDate: null, department: null },
      { status: 'INACTIVE', fullName: 'Leaver', startDate: new Date('2020-01-01'), endDate: thisMonth(5) },
      { status: 'ACTIVE', fullName: 'Future', startDate: new Date(Date.now() + 10 * DAY), endDate: null, department: null },
    ];
    contracts = [
      {
        id: 'c1',
        contractType: 'PROBATION',
        status: 'ACTIVE',
        endDate: new Date(Date.now() + 12 * DAY),
        employee: { id: 'e9', fullName: 'Probationer' },
      },
      // Ends far beyond the window; not a deadline anybody has to act on yet.
      {
        id: 'c2',
        contractType: 'PROBATION',
        status: 'ACTIVE',
        endDate: new Date(Date.now() + 200 * DAY),
        employee: { id: 'e10', fullName: 'Later' },
      },
    ];
  });

  it('reports the net change, not only the two raw counts', async () => {
    const res: any = await service.lifecycleStats();
    expect(res.data.joinersThisMonth).toBe(2);
    expect(res.data.leaversThisMonth).toBe(1);
    expect(res.data.netChangeThisMonth).toBe(1);
  });

  it('lists the people already hired but not yet started', async () => {
    // The onboarding queue: work that exists before anybody appears in a
    // headcount.
    const res: any = await service.lifecycleStats();
    expect(res.data.startingSoon.map((e: any) => e.fullName)).toEqual(['Future']);
  });

  it('surfaces probations ending inside the window only', async () => {
    const res: any = await service.lifecycleStats();
    expect(res.data.probationEndingSoon.map((p: any) => p.fullName)).toEqual(['Probationer']);
  });

  it('still reports the headcount, as context rather than as the headline', async () => {
    const res: any = await service.lifecycleStats();
    expect(res.data.activeHeadcount).toBe(3);
  });
});
