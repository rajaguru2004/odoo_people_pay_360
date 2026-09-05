import {
  GRIEVANCE_AGING_DAYS,
  GRIEVANCE_STATUSES,
  GrievancesService,
  OPEN_GRIEVANCE_STATUSES,
} from './grievances.service';

/**
 * `stats()` and the one definition of an open grievance.
 *
 * There were three definitions before this. `stats()` counted
 * `OPEN, ACKNOWLEDGED` and silently dropped `INVESTIGATING` — the status a
 * grievance spends the longest in — while the Talent hub counted four statuses
 * that have never existed in this schema. Both under-reported, in different
 * directions, and neither agreed with `GRIEVANCE_STATUSES`.
 */
describe('GrievancesService.stats', () => {
  let statusRows: any[];
  let staleCount: number;
  let oldest: any;

  const prisma: any = {
    grievance: {
      groupBy: jest.fn(async () => statusRows),
      count: jest.fn(async () => staleCount),
      findFirst: jest.fn(async () => oldest),
    },
  };

  let service: GrievancesService;

  beforeEach(() => {
    jest.clearAllMocks();
    statusRows = [
      { status: 'OPEN', _count: { _all: 2 } },
      { status: 'ACKNOWLEDGED', _count: { _all: 1 } },
      { status: 'INVESTIGATING', _count: { _all: 4 } },
      { status: 'RESOLVED', _count: { _all: 9 } },
      { status: 'CLOSED', _count: { _all: 3 } },
      { status: 'WITHDRAWN', _count: { _all: 1 } },
    ];
    staleCount = 2;
    oldest = { createdAt: new Date('2026-07-02T00:00:00Z') };
    service = new GrievancesService(prisma, {} as any, {} as any);
  });

  it('counts a grievance under investigation as open', async () => {
    const { data } = await service.stats();
    // 2 OPEN + 1 ACKNOWLEDGED + 4 INVESTIGATING. The old definition answered 3
    // and left four live cases off the dashboard entirely.
    expect(data.open).toBe(7);
  });

  it('counts resolved, closed and withdrawn as finished', async () => {
    const { data } = await service.stats();
    const finished = data.byStatus.RESOLVED + data.byStatus.CLOSED + data.byStatus.WITHDRAWN;
    expect(finished).toBe(13);
    expect(data.open + finished).toBe(20);
  });

  it('ages the queue against the same open set it counts', async () => {
    await service.stats();
    expect(prisma.grievance.count).toHaveBeenCalledWith({
      where: {
        status: { in: [...OPEN_GRIEVANCE_STATUSES] },
        createdAt: { lt: expect.any(Date) },
      },
    });
    expect(prisma.grievance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: [...OPEN_GRIEVANCE_STATUSES] } } }),
    );
  });

  it('keeps the open set a strict subset of the canonical status list', () => {
    // The phantom statuses the frontend used — SUBMITTED, IN_PROGRESS,
    // UNDER_REVIEW, ESCALATED — would fail this.
    for (const s of OPEN_GRIEVANCE_STATUSES) {
      expect(GRIEVANCE_STATUSES).toContain(s);
    }
    expect(OPEN_GRIEVANCE_STATUSES).toEqual(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING']);
  });

  it('exports the aging threshold instead of hardcoding it per caller', async () => {
    // It was written as a literal 14 in the service AND again in the Talent
    // page, with nothing keeping the two in step.
    expect(GRIEVANCE_AGING_DAYS).toBe(14);
    const { data } = await service.stats();
    expect(data.olderThan14Days).toBe(2);
  });

  it('returns a null oldest date rather than a fabricated one on an empty queue', async () => {
    oldest = null;
    const { data } = await service.stats();
    expect(data.oldestOpenAt).toBeNull();
  });
});

/**
 * `findAll()` scoping — who is on the list, and who must never be.
 *
 * The exclusion was written as `where.NOT = { againstEmployeeId }`, which
 * Prisma compiles to `NOT (against_employee_id = $1)`. On a row that names
 * nobody that comparison is NULL, `NOT NULL` is NULL, and SQL keeps only rows
 * where the predicate is TRUE — so every grievance that was not about a named
 * person was thrown away. Against the live data that was nine rows out of nine:
 * HR opened the screen and read "No grievances."
 */
describe('GrievancesService.findAll', () => {
  /**
   * A deliberately small stand-in for Prisma's `where` → SQL translation, with
   * SQL's three-valued logic left intact. It has to be: in JavaScript
   * `null !== 'emp-admin'` is `true`, in SQL it is NULL, and the entire defect
   * lives in that gap. A mock that answered in JS semantics would have called
   * the broken query correct.
   */
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
      if (key === 'AND') return cond.every((c: any) => matches(row, c));
      if (key === 'OR') return cond.some((c: any) => matches(row, c));
      if (key === 'NOT') {
        // `NOT (col = $1)` — NULL, not TRUE, when col is NULL, so the row goes.
        // Only the single-field form is modelled; that is the form that shipped.
        return Object.entries(cond).every(([f, v]) => {
          const actual = row[f] ?? null;
          return actual !== null && actual !== v;
        });
      }
      const actual = row[key] ?? null;
      if (cond === null) return actual === null; // IS NULL
      if (cond && typeof cond === 'object' && 'not' in cond) {
        // `col <> $1`, equally NULL for a NULL column — which is why the fix
        // pairs it with an explicit IS NULL arm rather than relying on it alone.
        return cond.not === null ? actual !== null : actual !== null && actual !== cond.not;
      }
      return actual === cond;
    });

  // emp-staff complains; emp-admin is ADMIN with a staff record; emp-boss is a
  // MANAGER who also handles cases.
  const row = (
    id: string,
    employeeId: string,
    assignedToId: string | null,
    againstEmployeeId: string | null,
    status = 'OPEN',
  ) => ({ id, status, employeeId, assignedToId, againstEmployeeId });

  const rows = [
    row('g-unnamed', 'emp-staff', null, null),
    row('g-vs-admin', 'emp-staff', null, 'emp-admin'),
    // Assigned to the very person it is about. `update()` refuses to create
    // that pairing today, but rows predating the check exist and this list is
    // the belt-and-braces layer that must still hide them.
    row('g-vs-boss', 'emp-staff', 'user-boss', 'emp-boss'),
    row('g-assigned-to-boss', 'emp-other', 'user-boss', null, 'RESOLVED'),
    row('g-someone-elses', 'emp-other', 'user-hr', null),
  ];

  const prisma: any = {
    grievance: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
    },
  };

  let service: GrievancesService;
  const ids = async (user: any, params: any = {}) =>
    (await service.findAll(params, user)).data.map((g: any) => g.id);

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GrievancesService(prisma, {} as any, {} as any);
  });

  it('shows HR the grievances that name nobody', async () => {
    // THE REGRESSION. An ADMIN who also has an employee record — the ordinary
    // state of a working HR account — saw an empty list, because every row
    // whose `againstEmployeeId` is NULL failed `NOT (against_employee_id = $1)`.
    const seen = await ids({ id: 'user-admin', role: 'ADMIN', employeeId: 'emp-admin' });
    expect(seen).toContain('g-unnamed');
    expect(seen).toContain('g-someone-elses');
    expect(seen).toContain('g-assigned-to-boss');
  });

  it('differs from an unlinked HR account by exactly the one case about them', async () => {
    // An HR user with no employee record is the account that masked the bug —
    // the exclusion never ran for it, so its list was always right. A linked
    // account should now match it apart from the single case naming that person.
    const unlinked = await ids({ id: 'user-hr', role: 'HR_MANAGER', employeeId: null });
    expect(unlinked.sort()).toEqual(rows.map((r) => r.id).sort());

    const linked = await ids({ id: 'user-admin', role: 'ADMIN', employeeId: 'emp-admin' });
    expect(linked.sort()).toEqual(
      rows
        .map((r) => r.id)
        .filter((id) => id !== 'g-vs-admin')
        .sort(),
    );
  });

  it.each(['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'])(
    'never shows a %s the grievance raised against them',
    async (role) => {
      // Role does not override being the subject, and neither does being the
      // assigned handler: `g-vs-boss` is assigned to this very user.
      const seen = await ids({ id: 'user-boss', role, employeeId: 'emp-boss' });
      expect(seen).not.toContain('g-vs-boss');
    },
  );

  it('keeps a non-HR caller to their own cases and the ones assigned to them', async () => {
    const boss = await ids({ id: 'user-boss', role: 'MANAGER', employeeId: 'emp-boss' });
    expect(boss).toEqual(['g-assigned-to-boss']);

    const staff = await ids({ id: 'user-staff', role: 'EMPLOYEE', employeeId: 'emp-staff' });
    // Own cases, including the ones they raised about other people...
    expect(staff.sort()).toEqual(['g-unnamed', 'g-vs-admin', 'g-vs-boss']);
    // ...and nothing of anybody else's. This is the other half of the fix: the
    // two rules are both ORs, and writing the second one to `where.OR` would
    // have replaced this scope and shown every employee the whole register.
    expect(staff).not.toContain('g-someone-elses');
  });

  it('does not crash for a caller with no employee record', async () => {
    await expect(
      ids({ id: 'user-nobody', role: 'EMPLOYEE', employeeId: null }),
    ).resolves.toEqual([]);
    // Nor for a principal that carries nothing at all.
    await expect(ids(undefined)).resolves.toEqual([]);
  });

  it('still applies the status filter alongside the scoping', async () => {
    const seen = await ids(
      { id: 'user-admin', role: 'ADMIN', employeeId: 'emp-admin' },
      { status: 'RESOLVED' },
    );
    expect(seen).toEqual(['g-assigned-to-boss']);
  });
});
