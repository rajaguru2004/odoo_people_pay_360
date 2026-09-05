import { AuditService } from './audit.service';

/**
 * The audit activity aggregate.
 *
 * This exists because the System hub used to count these in the browser over
 * one page of the log — so a busy day silently under-reported and the figure
 * was only ever as wide as the page size. The tests here pin the three things
 * that made moving it server-side worth doing: the window is a real time
 * window, deletions are separated out, and actor ids are resolved to names.
 */
describe('AuditService.stats', () => {
  const HOUR = 3_600_000;
  let rows: any[];
  let users: any[];

  const within = (where: any) =>
    rows.filter((r) => r.createdAt >= where.createdAt.gte);

  const prisma: any = {
    auditLog: {
      count: jest.fn(async ({ where }: any) => {
        let matched = within(where);
        if (where.action?.contains) {
          const needle = String(where.action.contains).toLowerCase();
          matched = matched.filter((r) => String(r.action).toLowerCase().includes(needle));
        }
        return matched.length;
      }),
      groupBy: jest.fn(async ({ by, where }: any) => {
        const key = by[0];
        const counts = new Map<string, number>();
        for (const r of within(where)) {
          const k = String(r[key]);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        return [...counts.entries()].map(([k, n]) => ({ [key]: k, _count: { _all: n } }));
      }),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        users.filter((u) => where.id.in.includes(u.id)),
      ),
    },
  };

  const service = new AuditService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    const now = Date.now();
    rows = [
      { action: 'UPDATE', resourceType: 'Employee', userId: 'u-hr', createdAt: new Date(now - 2 * HOUR) },
      { action: 'DELETE', resourceType: 'Employee', userId: 'u-hr', createdAt: new Date(now - 3 * HOUR) },
      { action: 'CREATE', resourceType: 'Payroll', userId: 'u-admin', createdAt: new Date(now - 5 * HOUR) },
      // Outside the 24h window; must not be counted.
      { action: 'DELETE', resourceType: 'Payroll', userId: 'u-admin', createdAt: new Date(now - 40 * HOUR) },
    ];
    users = [
      { id: 'u-hr', email: 'hr@example.com', employee: { fullName: 'Asha Rahman' } },
      { id: 'u-admin', email: 'admin@example.com', employee: null },
    ];
  });

  it('counts only what happened inside the window', async () => {
    const res: any = await service.stats(24);
    expect(res.data.total).toBe(3);
    expect(res.data.windowHours).toBe(24);
  });

  it('separates deletions from everything else', async () => {
    // The one figure on the System hub that is about risk rather than volume.
    const res: any = await service.stats(24);
    expect(res.data.destructive).toBe(1);
  });

  it('widens with the window rather than being fixed at a page size', async () => {
    const res: any = await service.stats(72);
    expect(res.data.total).toBe(4);
    expect(res.data.destructive).toBe(2);
  });

  it('resolves actor ids to the name a reader recognises', async () => {
    const res: any = await service.stats(24);
    const top = res.data.topActors[0];
    expect(top.count).toBe(2);
    expect(top.name).toBe('Asha Rahman');
  });

  it('falls back to the login when an actor has no employee record', async () => {
    const res: any = await service.stats(24);
    const admin = res.data.topActors.find((a: any) => a.userId === 'u-admin');
    expect(admin.name).toBe('admin@example.com');
  });
});
