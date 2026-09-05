import {
  carryForwardFor,
  encashableDays,
  quoteEncashment,
  resolvePolicy,
  type LeaveBalanceLike,
  type LeaveTypePolicyLike,
} from './encashment-calculator';

const policy = (
  over: Partial<LeaveTypePolicyLike> = {},
): LeaveTypePolicyLike => ({
  leaveTypeKey: 'Annual Leave',
  branchId: null,
  encashable: true,
  maxEncashDaysPerYear: null,
  encashBasis: 'BASIC',
  monthDays: 30,
  accruedOnly: true,
  allowInService: true,
  allowOnExit: true,
  carryForwardEnabled: false,
  carryForwardMaxDays: null,
  carryForwardExpiryMonths: null,
  isActive: true,
  ...over,
});

const balance = (over: Partial<LeaveBalanceLike> = {}): LeaveBalanceLike => ({
  leaveTypeKey: 'Annual Leave',
  allocated: 30,
  used: 10,
  carriedOver: 0,
  ...over,
});

describe('leave encashment', () => {
  describe('policy resolution', () => {
    it('prefers the branch policy over the company-wide one', () => {
      const p = resolvePolicy(
        [
          policy({ branchId: null, maxEncashDaysPerYear: 5 }),
          policy({ branchId: 'br-1', maxEncashDaysPerYear: 10 }),
        ],
        'Annual Leave',
        'br-1',
      );
      expect(p!.maxEncashDaysPerYear).toBe(10);
    });

    it('falls back to the company-wide policy from any branch', () => {
      // A plain `branchId = x` filter never matches NULL, which is how a
      // company-wide row becomes invisible everywhere at once.
      const p = resolvePolicy([policy({ branchId: null })], 'Annual Leave', 'br-9');
      expect(p).not.toBeNull();
    });

    it('ignores an inactive policy', () => {
      expect(
        resolvePolicy([policy({ isActive: false })], 'Annual Leave', null),
      ).toBeNull();
    });

    it('returns null for a leave type with no policy at all', () => {
      expect(resolvePolicy([policy()], 'Sick Leave', null)).toBeNull();
    });
  });

  describe('how many days may be encashed', () => {
    it('is bounded by the balance', () => {
      const r = encashableDays({
        balance: balance({ allocated: 30, used: 25 }),
        policy: policy(),
        alreadyEncashed: 0,
        onExit: false,
      });
      expect(r.maxDays).toBe(5);
    });

    it('is bounded by the annual cap', () => {
      const r = encashableDays({
        balance: balance({ allocated: 30, used: 0 }),
        policy: policy({ maxEncashDaysPerYear: 10 }),
        alreadyEncashed: 0,
        onExit: false,
      });
      expect(r.maxDays).toBe(10);
    });

    it('counts what has already been encashed against the cap', () => {
      const r = encashableDays({
        balance: balance({ allocated: 30, used: 0 }),
        policy: policy({ maxEncashDaysPerYear: 10 }),
        alreadyEncashed: 6,
        onExit: false,
      });
      expect(r.maxDays).toBe(4);
    });

    it('never goes negative when the cap is already exceeded', () => {
      const r = encashableDays({
        balance: balance(),
        policy: policy({ maxEncashDaysPerYear: 10 }),
        alreadyEncashed: 14,
        onExit: false,
      });
      expect(r.maxDays).toBe(0);
    });

    it('includes carried-over days in the pool', () => {
      const r = encashableDays({
        balance: balance({ allocated: 30, used: 30, carriedOver: 5 }),
        policy: policy(),
        alreadyEncashed: 0,
        onExit: false,
      });
      expect(r.maxDays).toBe(5);
    });

    it('explains what limited it, not just the number', () => {
      const r = encashableDays({
        balance: balance({ allocated: 30, used: 21 }),
        policy: policy({ maxEncashDaysPerYear: 10 }),
        alreadyEncashed: 6,
        onExit: false,
      });
      expect(r.maxDays).toBe(4);
      expect(r.reasons.join(' ')).toMatch(/Balance available: 9/);
      expect(r.reasons.join(' ')).toMatch(/Annual cap: 10 day\(s\), of which 6/);
    });

    it('refuses a leave type that is not encashable', () => {
      const r = encashableDays({
        balance: balance(),
        policy: policy({ encashable: false }),
        alreadyEncashed: 0,
        onExit: false,
      });
      expect(r.refusal).toMatch(/cannot be encashed/i);
    });

    it('refuses in service when the policy is exit-only', () => {
      const r = encashableDays({
        balance: balance(),
        policy: policy({ allowInService: false }),
        alreadyEncashed: 0,
        onExit: false,
      });
      expect(r.refusal).toMatch(/only be encashed as part of a final settlement/i);
    });

    it('allows the same policy on exit', () => {
      const r = encashableDays({
        balance: balance(),
        policy: policy({ allowInService: false }),
        alreadyEncashed: 0,
        onExit: true,
      });
      expect(r.refusal).toBeNull();
      expect(r.maxDays).toBe(20);
    });
  });

  describe('pricing', () => {
    const base = {
      balance: balance({ allocated: 30, used: 10 }),
      policy: policy(),
      alreadyEncashed: 0,
      onExit: false,
      monthlyBasic: 900,
      monthlyGross: 1200,
    };

    it('prices a day from basic by default', () => {
      const q = quoteEncashment({ ...base, requestedDays: 5 });
      expect(q.ratePerDay).toBe(30);
      expect(q.amount).toBe(150);
      expect(q.basis).toBe('BASIC');
    });

    it('prices a day from gross when the policy says so', () => {
      const q = quoteEncashment({
        ...base,
        policy: policy({ encashBasis: 'GROSS' }),
        requestedDays: 5,
      });
      expect(q.ratePerDay).toBe(40);
      expect(q.amount).toBe(200);
    });

    it('refuses more days than are available, and says how many there are', () => {
      const q = quoteEncashment({ ...base, requestedDays: 25 });
      expect(q.amount).toBe(0);
      expect(q.refusal).toMatch(/Only 20 day\(s\).*25 were requested/);
    });

    it('refuses zero and negative days', () => {
      expect(quoteEncashment({ ...base, requestedDays: 0 }).refusal).toMatch(/more than zero/i);
      expect(quoteEncashment({ ...base, requestedDays: -3 }).refusal).toMatch(/more than zero/i);
    });

    it('shows its working', () => {
      const q = quoteEncashment({ ...base, requestedDays: 5 });
      expect(q.workingLines[q.workingLines.length - 1]).toBe(
        '5 day(s) × 30 per day (basic 900 ÷ 30) = 150.',
      );
    });
  });

  describe('carry-forward', () => {
    it('lapses everything when the type does not carry', () => {
      const r = carryForwardFor({
        balance: balance({ allocated: 30, used: 20 }),
        policy: policy({ carryForwardEnabled: false }),
        encashedThisYear: 0,
      });
      expect(r.carried).toBe(0);
      expect(r.lapsed).toBe(10);
    });

    it('carries the unused balance when there is no cap', () => {
      const r = carryForwardFor({
        balance: balance({ allocated: 30, used: 20 }),
        policy: policy({ carryForwardEnabled: true }),
        encashedThisYear: 0,
      });
      expect(r.carried).toBe(10);
      expect(r.lapsed).toBe(0);
    });

    it('caps what carries and lapses the rest', () => {
      const r = carryForwardFor({
        balance: balance({ allocated: 30, used: 10 }),
        policy: policy({ carryForwardEnabled: true, carryForwardMaxDays: 5 }),
        encashedThisYear: 0,
      });
      expect(r.carried).toBe(5);
      expect(r.lapsed).toBe(15);
    });

    it('does NOT carry a day that was already encashed', () => {
      // The compounding error: paid for the day AND keeps it, every year.
      const r = carryForwardFor({
        balance: balance({ allocated: 30, used: 10 }),
        policy: policy({ carryForwardEnabled: true }),
        encashedThisYear: 8,
      });
      expect(r.carried).toBe(12);
      expect(r.reasons.join(' ')).toMatch(/8 day\(s\) were encashed and are not carried/);
    });

    it('never carries a negative balance', () => {
      const r = carryForwardFor({
        balance: balance({ allocated: 10, used: 30 }),
        policy: policy({ carryForwardEnabled: true }),
        encashedThisYear: 0,
      });
      expect(r.carried).toBe(0);
      expect(r.lapsed).toBe(0);
    });

    it('reports an expiry when the policy sets one', () => {
      const r = carryForwardFor({
        balance: balance({ allocated: 30, used: 20 }),
        policy: policy({ carryForwardEnabled: true, carryForwardExpiryMonths: 6 }),
        encashedThisYear: 0,
      });
      expect(r.expiresOn).toEqual({ addMonths: 6 });
    });

    it('carrying zero is not an error', () => {
      const r = carryForwardFor({
        balance: balance({ allocated: 30, used: 30 }),
        policy: policy({ carryForwardEnabled: true }),
        encashedThisYear: 0,
      });
      expect(r.carried).toBe(0);
      expect(r.lapsed).toBe(0);
    });
  });
});
