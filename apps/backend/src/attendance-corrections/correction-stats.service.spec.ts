import { AttendanceCorrectionsService } from './attendance-corrections.service';

/**
 * The correction queue aggregate.
 *
 * The Time & Attendance hub scores this queue by AGE, not size: three requests
 * waiting a week is a worse state than ten opened this morning. These cases
 * pin the two figures that carry that meaning, and the deliberate 30-day bound
 * on the resolution average — a lifetime average is dominated by whatever the
 * backlog looked like at launch and never moves again.
 */
describe('AttendanceCorrectionsService.stats', () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  let rows: any[];

  const matches = (r: any, where: any): boolean => {
    if (where.status?.in) {
      if (!where.status.in.includes(r.status)) return false;
    } else if (where.status && r.status !== where.status) return false;
    if (where.createdAt?.lt && !(r.createdAt < where.createdAt.lt)) return false;
    if (where.updatedAt?.gte && !(r.updatedAt >= where.updatedAt.gte)) return false;
    return true;
  };

  const prisma: any = {
    attendanceCorrection: {
      count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
      findFirst: jest.fn(async ({ where }: any) => {
        const found = rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.createdAt - b.createdAt);
        return found[0] ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
    },
  };

  const service = new AttendanceCorrectionsService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    const now = Date.now();
    rows = [
      { status: 'PENDING', createdAt: new Date(now - 6 * DAY), updatedAt: new Date(now - 6 * DAY) },
      { status: 'PENDING', createdAt: new Date(now - 4 * DAY), updatedAt: new Date(now - 4 * DAY) },
      { status: 'PENDING', createdAt: new Date(now - 1 * HOUR), updatedAt: new Date(now - 1 * HOUR) },
      // Decided inside the 30-day window: two hours to resolve.
      { status: 'APPROVED', createdAt: new Date(now - 5 * DAY), updatedAt: new Date(now - 5 * DAY + 2 * HOUR) },
      { status: 'REJECTED', createdAt: new Date(now - 6 * DAY), updatedAt: new Date(now - 6 * DAY + 4 * HOUR) },
      // Decided long ago; excluded from the average on purpose.
      { status: 'APPROVED', createdAt: new Date(now - 200 * DAY), updatedAt: new Date(now - 200 * DAY + 400 * HOUR) },
    ];
  });

  it('counts the queue and the part of it that has gone stale', async () => {
    const res: any = await service.stats();
    expect(res.data.pending).toBe(3);
    // Two of the three have been waiting more than three days.
    expect(res.data.olderThan3Days).toBe(2);
  });

  it('names when the oldest request arrived, not just how many there are', async () => {
    const res: any = await service.stats();
    expect(res.data.oldestPendingAt).toBeInstanceOf(Date);
  });

  it('averages resolution over recent decisions only', async () => {
    // 2h and 4h inside the window; the 400h decision from 200 days ago would
    // drag this to ~135h and never recover.
    const res: any = await service.stats();
    expect(res.data.avgResolutionHours).toBe(3);
    expect(res.data.decidedSampleSize).toBe(2);
  });

  it('reports an unknown average rather than zero when nothing was decided', async () => {
    rows = rows.filter((r) => r.status === 'PENDING');
    const res: any = await service.stats();
    // Zero hours would read as "we answer instantly", which is the opposite
    // of "we have never answered".
    expect(res.data.avgResolutionHours).toBeNull();
  });
});
