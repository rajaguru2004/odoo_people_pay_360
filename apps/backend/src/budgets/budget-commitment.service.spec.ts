import { BudgetCommitmentService } from './budget-commitment.service';

/**
 * In-memory stand-in for the commitment ledger, honouring the unique index on
 * (sourceType, sourceId).
 */
function makeStore() {
  const rows: any[] = [];
  const key = (r: any) => `${r.sourceType}|${r.sourceId}`;
  return {
    rows,
    findUnique: jest.fn(async ({ where }: any) => {
      const k = `${where.sourceType_sourceId.sourceType}|${where.sourceType_sourceId.sourceId}`;
      return rows.find((r) => key(r) === k) ?? null;
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `c${rows.length + 1}`, ...data };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const match = rows.filter((r) => {
        if (where.status && r.status !== where.status) return false;
        if (where.OR) {
          return where.OR.some(
            (o: any) => o.sourceType === r.sourceType && o.sourceId === r.sourceId,
          );
        }
        return r.sourceType === where.sourceType && r.sourceId === where.sourceId;
      });
      match.forEach((r) => Object.assign(r, data));
      return { count: match.length };
    }),
    groupBy: jest.fn(async ({ where }: any) => {
      const match = rows.filter(
        (r) =>
          where.budgetLineId.in.includes(r.budgetLineId) &&
          r.status === where.status,
      );
      const sums = new Map<string, number>();
      for (const r of match) {
        sums.set(r.budgetLineId, (sums.get(r.budgetLineId) ?? 0) + Number(r.amount));
      }
      return [...sums.entries()].map(([budgetLineId, amount]) => ({
        budgetLineId,
        _sum: { amount },
      }));
    }),
  };
}

function makeService(opts: { budget?: any; lines?: any[] } = {}) {
  const store = makeStore();
  const prisma = {
    budgetCommitment: store,
    budget: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.budget === undefined ? { id: 'budget-1' } : opts.budget,
        ),
    },
    budgetLine: {
      findMany: jest.fn().mockResolvedValue(opts.lines ?? [
        { id: 'line-dept', departmentId: 'dept-1' },
        { id: 'line-company', departmentId: null },
      ]),
    },
  } as any;
  return { service: new BudgetCommitmentService(prisma), store, prisma };
}

const base = {
  sourceType: 'TRAVEL' as const,
  sourceId: 'trip-1',
  amount: 500,
  departmentId: 'dept-1',
  category: 'Travel',
  branchId: 'branch-1',
  onDate: new Date('2027-03-15'),
};

describe('BudgetCommitmentService', () => {
  describe('line resolution', () => {
    it('prefers the department line over the company-wide fallback', async () => {
      const { service, store } = makeService();
      await service.commit(base);
      expect(store.rows[0].budgetLineId).toBe('line-dept');
    });

    it('falls back to the company-wide line when the department has none', async () => {
      const { service, store } = makeService({
        lines: [{ id: 'line-company', departmentId: null }],
      });
      await service.commit(base);
      expect(store.rows[0].budgetLineId).toBe('line-company');
    });

    it('commits nothing when no ACTIVE budget covers the date', async () => {
      const { service, store } = makeService({ budget: null });
      await service.commit(base);
      expect(store.rows).toHaveLength(0);
    });

    it('commits nothing when no line matches the category', async () => {
      const { service, store } = makeService({ lines: [] });
      await service.commit(base);
      expect(store.rows).toHaveLength(0);
    });

    it('commits nothing for an employee with no branch', async () => {
      const { service, store } = makeService();
      await service.commit({ ...base, branchId: null });
      expect(store.rows).toHaveLength(0);
    });
  });

  describe('never blocks an approval', () => {
    it('swallows a database failure rather than throwing', async () => {
      const { service, prisma } = makeService();
      prisma.budget.findFirst.mockRejectedValue(new Error('db down'));
      // An unconfigured or broken budget must not stop travel being approved.
      await expect(service.commit(base)).resolves.toBeUndefined();
    });
  });

  describe('idempotency', () => {
    it('does not double-commit when an approval is replayed', async () => {
      const { service, store } = makeService();
      await service.commit(base);
      await service.commit(base);
      expect(store.rows).toHaveLength(1);
      expect(Number(store.rows[0].amount)).toBe(500);
    });

    it('updates the amount when a request is revised before spend', async () => {
      const { service, store } = makeService();
      await service.commit(base);
      await service.commit({ ...base, amount: 800 });
      expect(store.rows).toHaveLength(1);
      expect(Number(store.rows[0].amount)).toBe(800);
    });

    it('refuses to re-open a REALIZED commitment', async () => {
      const { service, store } = makeService();
      await service.commit(base);
      await service.realize('TRAVEL', 'trip-1');
      await service.commit({ ...base, amount: 999 });
      // The money is spent; re-opening it would double-count against actuals.
      expect(store.rows[0].status).toBe('REALIZED');
      expect(Number(store.rows[0].amount)).toBe(500);
    });
  });

  describe('the double-count guard', () => {
    it('stops counting as committed once realized', async () => {
      const { service } = makeService();
      await service.commit(base);

      let open = await service.openByLine(['line-dept']);
      expect(open.get('line-dept')).toBe(500);

      // The per-diem claim rode a payroll run to PAID — it is now an ACTUAL.
      await service.realize('TRAVEL', 'trip-1', 'Paid in payroll p1');

      open = await service.openByLine(['line-dept']);
      // Zero, not 500: subtracted once as actual, never again as committed.
      expect(open.get('line-dept')).toBeUndefined();
    });

    it('release and realize are different outcomes', async () => {
      const { service, store } = makeService();
      await service.commit(base);
      await service.release('TRAVEL', 'trip-1', 'cancelled');
      expect(store.rows[0].status).toBe('RELEASED');
      expect(store.rows[0].resolvedAt).toBeTruthy();
    });

    it('realize does not touch an already-released commitment', async () => {
      const { service, store } = makeService();
      await service.commit(base);
      await service.release('TRAVEL', 'trip-1');
      await service.realize('TRAVEL', 'trip-1');
      // A cancelled trip whose claim somehow reached payroll must not silently
      // become "spent" — only OPEN commitments are realizable.
      expect(store.rows[0].status).toBe('RELEASED');
    });
  });

  describe('realizeMany', () => {
    it('realizes a whole payroll run in one call', async () => {
      const { service, store } = makeService();
      await service.commit(base);
      await service.commit({ ...base, sourceId: 'trip-2', amount: 300 });
      await service.commit({
        ...base,
        sourceType: 'TRAINING',
        sourceId: 'nom-1',
        amount: 150,
        category: 'Training',
      });

      const count = await service.realizeMany(
        [
          { sourceType: 'TRAVEL', sourceId: 'trip-1' },
          { sourceType: 'TRAINING', sourceId: 'nom-1' },
        ],
        'Paid in payroll p1',
      );

      expect(count).toBe(2);
      expect(store.rows.filter((r) => r.status === 'REALIZED')).toHaveLength(2);
      // trip-2 was not in this run and stays committed.
      expect(store.rows.find((r) => r.sourceId === 'trip-2').status).toBe('OPEN');
    });

    it('is a no-op for an empty list', async () => {
      const { service, store } = makeService();
      await expect(service.realizeMany([])).resolves.toBe(0);
      expect(store.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('openByLine', () => {
    it('sums open commitments per line and ignores resolved ones', async () => {
      const { service } = makeService();
      await service.commit(base);
      await service.commit({ ...base, sourceId: 'trip-2', amount: 300 });
      await service.commit({ ...base, sourceId: 'trip-3', amount: 200 });
      await service.release('TRAVEL', 'trip-3');

      const open = await service.openByLine(['line-dept']);
      expect(open.get('line-dept')).toBe(800);
    });

    it('returns an empty map for no lines', async () => {
      const { service } = makeService();
      await expect(service.openByLine([])).resolves.toEqual(new Map());
    });
  });
});
