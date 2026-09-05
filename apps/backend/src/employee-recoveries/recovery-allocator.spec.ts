import {
  allocateRecoveries,
  isRecoveryLive,
  labelFor,
  type RecoveryContext,
  type RecoveryOrder,
} from './recovery-allocator';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const order = (over: Partial<RecoveryOrder> = {}): RecoveryOrder => ({
  id: 'r1',
  kind: 'ASSET_DAMAGE',
  reference: 'AST-001',
  totalAmount: 600,
  amountRecovered: 0,
  instalmentAmount: 200,
  startDate: d('2044-01-01'),
  endDate: null,
  priority: 200,
  status: 'ACTIVE',
  ...over,
});

const ctx = (over: Partial<RecoveryContext> = {}): RecoveryContext => ({
  employeeId: 'emp-1',
  available: 1000,
  periodStart: d('2044-06-01'),
  periodEnd: d('2044-06-30'),
  ...over,
});

describe('employee recovery allocator', () => {
  describe('liveness', () => {
    it('ignores anything that is not ACTIVE', () => {
      for (const status of ['CANCELLED', 'WAIVED', 'COMPLETED', 'RECEIVABLE']) {
        expect(isRecoveryLive(order({ status }), d('2044-06-01'), d('2044-06-30'))).toBe(false);
      }
    });

    it('ignores one that has not started', () => {
      expect(
        isRecoveryLive(order({ startDate: d('2044-07-01') }), d('2044-06-01'), d('2044-06-30')),
      ).toBe(false);
    });

    it('ignores one that ended before the period', () => {
      expect(
        isRecoveryLive(order({ endDate: d('2044-05-31') }), d('2044-06-01'), d('2044-06-30')),
      ).toBe(false);
    });

    it('still runs for a recovery that expires INSIDE the period', () => {
      expect(
        isRecoveryLive(order({ endDate: d('2044-06-15') }), d('2044-06-01'), d('2044-06-30')),
      ).toBe(true);
    });

    it('ignores one already fully recovered', () => {
      expect(
        isRecoveryLive(order({ amountRecovered: 600 }), d('2044-06-01'), d('2044-06-30')),
      ).toBe(false);
    });
  });

  describe('taking an instalment', () => {
    it('takes the instalment when the pay can bear it', () => {
      const r = allocateRecoveries(ctx(), [order()]);
      expect(r.totalTaken).toBe(200);
      expect(r.lines[0]).toMatchObject({ amount: 200, shortfall: 0, closes: false });
    });

    it('takes everything available and carries the rest', () => {
      const r = allocateRecoveries(ctx({ available: 120 }), [order()]);
      expect(r.totalTaken).toBe(120);
      expect(r.lines[0].shortfall).toBe(80);
      expect(r.noteLines[0]).toBe('Asset damage recovery AST-001: 120 recovered, 80 carried to the next payroll.');
    });

    it('records a line even when NOTHING could be taken', () => {
      // So "why was nothing recovered in June?" is answerable from the payslip
      // rather than by re-deriving it later.
      const r = allocateRecoveries(ctx({ available: 0 }), [order()]);
      expect(r.totalTaken).toBe(0);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0].shortfall).toBe(200);
      expect(r.noteLines[0]).toMatch(/nothing could be recovered this period/);
    });

    it('takes whatever is available when there is no instalment', () => {
      const r = allocateRecoveries(ctx({ available: 250 }), [
        order({ instalmentAmount: null }),
      ]);
      expect(r.totalTaken).toBe(250);
    });

    it('never collects past the debt, whatever the instalment says', () => {
      const r = allocateRecoveries(ctx(), [
        order({ totalAmount: 600, amountRecovered: 550, instalmentAmount: 200 }),
      ]);
      expect(r.totalTaken).toBe(50);
      expect(r.lines[0].closes).toBe(true);
    });

    it('marks the instalment that settles the debt', () => {
      const r = allocateRecoveries(ctx(), [
        order({ totalAmount: 400, amountRecovered: 200, instalmentAmount: 200 }),
      ]);
      expect(r.lines[0].closes).toBe(true);
    });
  });

  describe('several recoveries at once', () => {
    it('runs the lower priority NUMBER first', () => {
      const r = allocateRecoveries(ctx({ available: 250 }), [
        order({ id: 'later', priority: 300, reference: 'B' }),
        order({ id: 'first', priority: 100, reference: 'A' }),
      ]);
      expect(r.lines[0].recoveryId).toBe('first');
      expect(r.lines[0].amount).toBe(200);
      // Only 50 left for the second.
      expect(r.lines[1].amount).toBe(50);
      expect(r.lines[1].shortfall).toBe(150);
    });

    it('breaks a priority tie on the OLDER recovery, so the order is total', () => {
      // A partial order would let a regenerated payroll differ from the one it
      // replaced for no reason anybody could explain.
      const r = allocateRecoveries(ctx({ available: 200 }), [
        order({ id: 'b', startDate: d('2044-03-01'), reference: 'B' }),
        order({ id: 'a', startDate: d('2044-01-01'), reference: 'A' }),
      ]);
      expect(r.lines[0].reference).toBe('A');
    });

    it('breaks a full tie on the id, deterministically', () => {
      const r = allocateRecoveries(ctx({ available: 400 }), [
        order({ id: 'zzz', reference: 'Z' }),
        order({ id: 'aaa', reference: 'A' }),
      ]);
      expect(r.lines.map((l) => l.reference)).toEqual(['A', 'Z']);
    });

    it('never takes more than the pool, across all of them', () => {
      const r = allocateRecoveries(ctx({ available: 150 }), [
        order({ id: 'a' }),
        order({ id: 'b' }),
        order({ id: 'c' }),
      ]);
      expect(r.totalTaken).toBe(150);
    });
  });

  describe('the pool', () => {
    it('treats a negative available pool as zero', () => {
      // Net has already floored at zero by this point in the ladder; a negative
      // pool here would mean paying the employee to be recovered from.
      const r = allocateRecoveries(ctx({ available: -50 }), [order()]);
      expect(r.totalTaken).toBe(0);
    });
  });

  describe('labels', () => {
    it('names each kind the way a payslip should', () => {
      expect(labelFor('ASSET_DAMAGE')).toBe('Asset damage recovery');
      expect(labelFor('ASSET_LOSS')).toBe('Unreturned asset recovery');
      expect(labelFor('TRAINING_BOND')).toBe('Training bond');
      expect(labelFor('NOTICE_SHORTFALL')).toBe('Short notice recovery');
      expect(labelFor('OTHER')).toBe('Recovery');
      expect(labelFor('SOMETHING_NEW')).toBe('Recovery');
    });
  });
});
