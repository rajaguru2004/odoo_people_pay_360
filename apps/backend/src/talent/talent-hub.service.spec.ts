import { TalentHubService } from './talent-hub.service';

/**
 * The Talent hub aggregate.
 *
 * The hub this replaces counted rewards and disciplinary actions in the browser
 * over one page of each list. These cases pin the figures that had to become
 * real for that panel to be deleted, plus the two places where the honest
 * answer is "unknown" rather than a number: an appraisal run that has not
 * resolved its scope, and a grievance log with no history to rewind.
 */
describe('TalentHubService', () => {
  const NOW = new Date('2026-08-25T09:00:00.000Z');

  let grievanceRows: any[];
  let transitionRows: any[];
  let eventsBefore: number;
  let rewardRows: any[];
  let disciplineRows: any[];
  let referenceRun: any;
  let previousRun: any;
  let resultRows: any[];
  let unassignedOpen: number;
  let attended: Record<string, number>;

  const inWindow = (rows: any[], field: string, where: any) =>
    rows.filter((r) => r[field] >= where[field].gte && r[field] < where[field].lt);

  const prisma: any = {
    grievance: {
      count: jest.fn(async ({ where }: any) => {
        if (where?.assignedToId === null) return unassignedOpen;
        if (where?.createdAt) return inWindow(grievanceRows, 'createdAt', where).length;
        if (where?.resolvedAt)
          return grievanceRows.filter(
            (r) => r.resolvedAt && r.resolvedAt >= where.resolvedAt.gte && r.resolvedAt < where.resolvedAt.lt,
          ).length;
        return 0;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        grievanceRows
          .filter((r) => r.createdAt < where.createdAt.lt)
          .map((r) => ({ id: r.id, status: r.status })),
      ),
    },
    grievanceEvent: {
      findMany: jest.fn(async () => transitionRows),
      count: jest.fn(async () => eventsBefore),
    },
    trainingNomination: {
      count: jest.fn(async ({ where }: any) => {
        if (where?.certificateExpiry) return 3;
        if (where?.session) return 2;
        const key = where.attendedAt.gte.toISOString().slice(0, 7);
        return attended[key] ?? 0;
      }),
    },
    reward: {
      aggregate: jest.fn(async ({ where }: any) => {
        const rows = inWindow(rewardRows, 'rewardDate', where);
        return {
          _count: { _all: rows.length },
          _sum: { amount: rows.reduce((a, r) => a + r.amount, 0) },
        };
      }),
      findMany: jest.fn(async () => rewardRows),
    },
    discipline: {
      aggregate: jest.fn(async ({ where }: any) => {
        const rows = inWindow(disciplineRows, 'disciplineDate', where);
        return {
          _count: { _all: rows.length },
          _sum: { amount: rows.reduce((a, r) => a + r.amount, 0) },
        };
      }),
      findMany: jest.fn(async () => disciplineRows),
    },
    appraisalRun: {
      findFirst: jest.fn(async ({ where }: any) =>
        where?.id?.not ? previousRun : referenceRun,
      ),
    },
    appraisalResult: { groupBy: jest.fn(async () => resultRows) },
  };

  const grievances: any = {
    stats: jest.fn(async () => ({
      success: true,
      data: {
        open: 5,
        byStatus: { OPEN: 2, ACKNOWLEDGED: 1, INVESTIGATING: 2, RESOLVED: 7 },
        olderThan14Days: 1,
        oldestOpenAt: new Date('2026-07-02T00:00:00Z'),
      },
    })),
  };
  const training: any = {
    stats: jest.fn(async () => ({
      success: true,
      data: {
        activeCourses: 4,
        upcomingSessions30Days: 2,
        sessionsByStatus: { SCHEDULED: 2, COMPLETED: 3 },
        nominationsByStatus: {
          PENDING: 5,
          APPROVED: 4,
          ATTENDED: 12,
          NO_SHOW: 4,
          REJECTED: 6,
          CANCELLED: 1,
        },
      },
    })),
  };
  const appraisal: any = {
    stats: jest.fn(async () => ({
      success: true,
      data: {
        byStatus: { COMPLETED: 2, RUNNING: 1 },
        completed: 2,
        activeRun: { id: 'run-live', status: 'RUNNING', totalEmployees: 40 },
        lastCompletedRun: { id: 'run-old' },
      },
    })),
  };

  let service: TalentHubService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);

    grievanceRows = [
      // Open at the baseline, resolved since — the case the rewind exists for.
      { id: 'g1', status: 'RESOLVED', createdAt: new Date('2026-06-01T00:00:00Z'), resolvedAt: new Date('2026-08-10T00:00:00Z') },
      // Open at the baseline and still open.
      { id: 'g2', status: 'INVESTIGATING', createdAt: new Date('2026-07-20T00:00:00Z'), resolvedAt: null },
      // Raised after the baseline: not part of last month's queue.
      { id: 'g3', status: 'OPEN', createdAt: new Date('2026-08-05T00:00:00Z'), resolvedAt: null },
    ];
    // g1 moved INVESTIGATING → RESOLVED after the baseline, so at the baseline
    // it was still open.
    transitionRows = [
      { grievanceId: 'g1', fromStatus: 'INVESTIGATING', createdAt: new Date('2026-08-10T00:00:00Z') },
    ];
    eventsBefore = 4;
    unassignedOpen = 1;
    rewardRows = [
      { rewardDate: new Date('2026-08-03T00:00:00Z'), amount: 500 },
      { rewardDate: new Date('2026-08-14T00:00:00Z'), amount: 250 },
      { rewardDate: new Date('2026-07-09T00:00:00Z'), amount: 100 },
    ];
    disciplineRows = [{ disciplineDate: new Date('2026-08-21T00:00:00Z'), amount: 75 }];
    attended = { '2026-08': 6, '2026-07': 4 };
    referenceRun = {
      id: 'run-live',
      status: 'RUNNING',
      periodLabel: 'H1 2026',
      periodStart: new Date('2026-01-01T00:00:00Z'),
      periodEnd: new Date('2026-06-30T00:00:00Z'),
      totalEmployees: 40,
      completedEmployees: 30,
      completedAt: null,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    };
    previousRun = { totalEmployees: 20, completedEmployees: 10 };
    resultRows = [
      { status: 'COMPLETED', _count: { _all: 30 } },
      { status: 'PENDING', _count: { _all: 8 } },
      { status: 'FAILED', _count: { _all: 1 } },
      { status: 'DEGRADED', _count: { _all: 1 } },
    ];

    service = new TalentHubService(prisma, grievances, training, appraisal);
  });

  afterEach(() => jest.useRealTimers());

  it('counts rewards and disciplinary actions on the server, by their business date', async () => {
    const { data } = await service.getHubSummary();
    // Two August rewards, one August discipline. The July reward is the
    // previous window's. Nothing here depends on a page length.
    expect(data.conduct.rewardsCount).toBe(2);
    expect(data.conduct.rewardsAmount).toBe(750);
    expect(data.conduct.disciplinesCount).toBe(1);
    expect(data.conduct.prevRewardsCount).toBe(1);
  });

  it('measures training completion against nominations that became obligations', async () => {
    const { data } = await service.getHubSummary();
    // APPROVED 4 + ATTENDED 12 + NO_SHOW 4 = 20; 12 attended = 60%.
    // PENDING/REJECTED/CANCELLED are excluded: declining a request is not a
    // failure to train.
    expect(data.training.obligations).toBe(20);
    expect(data.training.completionRate).toBe(60);
  });

  it('expresses appraisal completion against the run in flight', async () => {
    const { data } = await service.getHubSummary();
    expect(data.appraisal.referenceRun!.id).toBe('run-live');
    expect(data.appraisal.completionRate).toBe(75); // 30 / 40
    expect(data.appraisal.prevCompletionRate).toBe(50);
    expect(data.appraisal.failedOrDegraded).toBe(2);
  });

  it('returns null completion for a run that has not resolved its scope', async () => {
    referenceRun = { ...referenceRun, status: 'PENDING', totalEmployees: 0, completedEmployees: 0 };
    const { data } = await service.getHubSummary();
    // 0% would claim nobody has been appraised. The truth is that the run does
    // not yet know how many people it is appraising.
    expect(data.appraisal.completionRate).toBeNull();
  });

  it('returns null completion, not zero, when no appraisal run exists at all', async () => {
    referenceRun = null;
    const { data } = await service.getHubSummary();
    expect(data.appraisal.referenceRun).toBeNull();
    expect(data.appraisal.completionRate).toBeNull();
    expect(data.appraisal.completionDelta).toBeNull();
  });

  it('rewinds the grievance log to count what was open last month', async () => {
    const { data } = await service.getHubSummary();
    // g1 reads RESOLVED today but was INVESTIGATING at the baseline, and g2 was
    // and still is open — so two. Reading today's status without rewinding
    // would report one, and g3 did not exist yet at all.
    expect(data.grievances.openAsOfPrev).toBe(2);
    expect(data.grievances.raisedInWindow).toBe(1);
  });

  it('draws no grievance delta when there is no history to rewind', async () => {
    grievanceRows = [];
    transitionRows = [];
    eventsBefore = 0;
    const { data } = await service.getHubSummary();
    expect(data.grievances.openAsOfPrev).toBeNull();
    expect(data.grievances.openDelta).toBeNull();
  });

  it('publishes the one open-grievance definition rather than leaving it to the page', async () => {
    const { data } = await service.getHubSummary();
    expect(data.grievances.openStatuses).toEqual(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING']);
    expect(data.grievances.agingDays).toBe(14);
  });

  it('draws twelve months of recognition against correction', async () => {
    const { data } = await service.getHubSummary();
    expect(data.trend).toHaveLength(12);
    const aug = data.trend.find((b: any) => b.key === '2026-08')!;
    expect(aug.segments).toEqual([
      { key: 'rewards', value: 2 },
      { key: 'disciplines', value: 1 },
    ]);
  });

  it('surfaces training that happened and was never written down', async () => {
    const { data } = await service.getHubSummary();
    // Sessions past their end date with nominations still APPROVED. The nearest
    // thing to an overdue item the module has, and it is a fact not an
    // inference.
    expect(data.training.sessionsEndedUnrecorded).toBe(2);
    expect(data.training.certificatesExpiring60).toBe(3);
  });
});
