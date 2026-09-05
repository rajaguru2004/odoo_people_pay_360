import {
  allocateGarnishments,
  isOrderLive,
  type CarriedShortfall,
  type GarnishmentContext,
  type AllocatableOrder,
} from './garnishment-allocator';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const ctx = (over: Partial<GarnishmentContext> = {}): GarnishmentContext => ({
  employeeId: 'emp-1',
  netPreRecovery: 1000,
  periodStart: d('2034-06-01'),
  periodEnd: d('2034-06-30'),
  ...over,
});

const order = (over: Partial<AllocatableOrder> = {}): AllocatableOrder => ({
  id: 'g-1',
  amount: 200,
  percentOfNet: null,
  reference: 'CR-001',
  priority: 100,
  startDate: d('2034-01-01'),
  endDate: null,
  totalCap: null,
  collected: 0,
  ...over,
});

describe('garnishment allocator', () => {
  describe('liveness window', () => {
    it('attaches a period an order started inside — not only whole periods', () => {
      expect(
        isOrderLive({ startDate: d('2034-06-15'), endDate: null }, d('2034-06-01'), d('2034-06-30')),
      ).toBe(true);
    });

    it('does not attach a period that ends before the order starts', () => {
      expect(
        isOrderLive({ startDate: d('2034-07-01'), endDate: null }, d('2034-06-01'), d('2034-06-30')),
      ).toBe(false);
    });

    it('still attaches the period an order expired inside', () => {
      expect(
        isOrderLive({ startDate: d('2034-01-01'), endDate: d('2034-06-10') }, d('2034-06-01'), d('2034-06-30')),
      ).toBe(true);
    });

    it('does not attach a period beginning after the order ended', () => {
      expect(
        isOrderLive({ startDate: d('2034-01-01'), endDate: d('2034-05-31') }, d('2034-06-01'), d('2034-06-30')),
      ).toBe(false);
    });
  });

  it('takes a flat amount in full when pay covers it', () => {
    const r = allocateGarnishments(ctx(), [order({ amount: 200 })], []);
    expect(r.totalTaken).toBe(200);
    expect(r.lines[0].shortfall).toBe(0);
    expect(r.noteLines[0]).toBe('Court order CR-001: 200 recovered.');
  });

  it('takes a percentOfNet of net-of-statutory pay, not of gross', () => {
    const r = allocateGarnishments(
      ctx({ netPreRecovery: 800 }),
      [order({ amount: null, percentOfNet: 25 })],
      [],
    );
    expect(r.totalTaken).toBe(200);
  });

  it('ignores an order that is not live for the period', () => {
    const r = allocateGarnishments(ctx(), [order({ startDate: d('2034-07-01') })], []);
    expect(r.totalTaken).toBe(0);
    expect(r.lines).toEqual([]);
  });

  describe('short pay carries forward rather than lapsing', () => {
    it('takes what is available and carries the remainder', () => {
      const r = allocateGarnishments(
        ctx({ netPreRecovery: 300 }),
        [order({ amount: 500 })],
        [],
      );
      expect(r.totalTaken).toBe(300);
      expect(r.lines[0].due).toBe(500);
      expect(r.lines[0].shortfall).toBe(200);
      expect(r.noteLines[0]).toContain('200 carried forward to the next payroll');
    });

    it('attaches nothing at all when net is zero, and carries the whole order', () => {
      const r = allocateGarnishments(ctx({ netPreRecovery: 0 }), [order({ amount: 500 })], []);
      expect(r.totalTaken).toBe(0);
      expect(r.lines[0].shortfall).toBe(500);
    });

    it('never attaches backwards when net has already floored below zero', () => {
      const r = allocateGarnishments(ctx({ netPreRecovery: -50 }), [order({ amount: 500 })], []);
      expect(r.totalTaken).toBe(0);
      expect(r.lines[0].taken).toBe(0);
    });
  });

  describe('arrears', () => {
    const carried: CarriedShortfall[] = [
      { id: 'cf-1', sourceId: 'g-1', amount: 200, amountRecovered: 0 },
    ];

    it('adds a carried shortfall to this period\'s instalment', () => {
      const r = allocateGarnishments(ctx({ netPreRecovery: 1000 }), [order({ amount: 200 })], carried);
      expect(r.lines[0].due).toBe(400);
      expect(r.totalTaken).toBe(400);
      expect(r.lines[0].arrearsTaken).toBe(200);
      expect(r.lines[0].settled).toEqual([{ carryForwardId: 'cf-1', amount: 200 }]);
      expect(r.noteLines[0]).toContain('including 200 carried forward');
    });

    it('settles the OLDEST arrears first when pay covers only part', () => {
      const two: CarriedShortfall[] = [
        { id: 'cf-old', sourceId: 'g-1', amount: 200, amountRecovered: 0 },
        { id: 'cf-new', sourceId: 'g-1', amount: 200, amountRecovered: 0 },
      ];
      const r = allocateGarnishments(ctx({ netPreRecovery: 250 }), [order({ amount: 200 })], two);
      expect(r.totalTaken).toBe(250);
      // 250 taken against 400 arrears + 200 instalment: arrears absorb all of it.
      expect(r.lines[0].arrearsTaken).toBe(250);
      expect(r.lines[0].settled).toEqual([
        { carryForwardId: 'cf-old', amount: 200 },
        { carryForwardId: 'cf-new', amount: 50 },
      ]);
      expect(r.lines[0].shortfall).toBe(350);
    });

    it('ignores a shortfall carried against a DIFFERENT order', () => {
      const other: CarriedShortfall[] = [
        { id: 'cf-x', sourceId: 'g-OTHER', amount: 900, amountRecovered: 0 },
      ];
      const r = allocateGarnishments(ctx(), [order({ amount: 200 })], other);
      expect(r.lines[0].due).toBe(200);
    });

    it('ignores a carried row that later runs already cleared', () => {
      const cleared: CarriedShortfall[] = [
        { id: 'cf-1', sourceId: 'g-1', amount: 200, amountRecovered: 200 },
      ];
      const r = allocateGarnishments(ctx(), [order({ amount: 200 })], cleared);
      expect(r.lines[0].due).toBe(200);
    });
  });

  describe('a finite order closes itself', () => {
    it('never collects past the total it is for', () => {
      const r = allocateGarnishments(
        ctx(),
        [order({ amount: 200, totalCap: 500, collected: 450 })],
        [],
      );
      expect(r.totalTaken).toBe(50);
    });

    it('collects nothing once the debt is settled', () => {
      const r = allocateGarnishments(
        ctx(),
        [order({ amount: 200, totalCap: 500, collected: 500 })],
        [],
      );
      expect(r.totalTaken).toBe(0);
      expect(r.lines).toEqual([]);
    });

    it('caps ARREARS at the remaining debt too, so a carry cannot over-collect', () => {
      const r = allocateGarnishments(
        ctx(),
        [order({ amount: 200, totalCap: 500, collected: 450 })],
        [{ id: 'cf-1', sourceId: 'g-1', amount: 300, amountRecovered: 0 }],
      );
      // 300 arrears + 200 instalment = 500 due, but only 50 of the debt is left.
      expect(r.lines[0].due).toBe(50);
    });
  });

  describe('several orders against one employee', () => {
    it('satisfies the lower priority NUMBER first, and carries the rest', () => {
      const r = allocateGarnishments(
        ctx({ netPreRecovery: 500 }),
        [
          order({ id: 'g-low', priority: 200, amount: 400, reference: 'CR-LOW' }),
          order({ id: 'g-high', priority: 10, amount: 400, reference: 'CR-HIGH' }),
        ],
        [],
      );
      expect(r.lines.map((l) => l.reference)).toEqual(['CR-HIGH', 'CR-LOW']);
      expect(r.lines[0].taken).toBe(400);
      expect(r.lines[1].taken).toBe(100);
      expect(r.lines[1].shortfall).toBe(300);
      expect(r.totalTaken).toBe(500);
    });

    it('breaks a priority tie on the OLDER order, so the ladder is total', () => {
      const r = allocateGarnishments(
        ctx({ netPreRecovery: 100 }),
        [
          order({ id: 'g-new', startDate: d('2034-03-01'), amount: 100, reference: 'CR-NEW' }),
          order({ id: 'g-old', startDate: d('2034-01-01'), amount: 100, reference: 'CR-OLD' }),
        ],
        [],
      );
      expect(r.lines[0].reference).toBe('CR-OLD');
      expect(r.lines[0].taken).toBe(100);
      expect(r.lines[1].taken).toBe(0);
    });

    it('prices each percentOfNet order off the ORIGINAL net, not the dwindling pool', () => {
      // Otherwise the second 25% order would silently mean 25% of 75%.
      const r = allocateGarnishments(
        ctx({ netPreRecovery: 1000 }),
        [
          order({ id: 'g-a', priority: 1, amount: null, percentOfNet: 25 }),
          order({ id: 'g-b', priority: 2, amount: null, percentOfNet: 25 }),
        ],
        [],
      );
      expect(r.lines[0].due).toBe(250);
      expect(r.lines[1].due).toBe(250);
      expect(r.totalTaken).toBe(500);
    });
  });
});
