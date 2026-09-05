import { LoanRecoveryService, type LoanCandidate } from './loan-recovery.service';
import { DEFAULT_LOAN_POLICY, type ResolvedLoanPolicy } from './loan-policy.service';

/**
 * The affordability / priority / leave matrix.
 *
 * `allocateForEmployee` is pure, so this whole surface is a table with no
 * Prisma, no Nest and no database. Every requirement-doc case in §4 (payroll
 * deduction), §5 (partial salary), §6 (multiple loans) and §12 (leave
 * interaction) lands here.
 */
describe('LoanRecoveryService.allocateForEmployee', () => {
  const policy = (over: Partial<ResolvedLoanPolicy> = {}): ResolvedLoanPolicy => ({
    ...DEFAULT_LOAN_POLICY,
    moduleV2Enabled: true,
    ...over,
  });

  let seq = 0;
  const candidate = (over: Partial<LoanCandidate> = {}): LoanCandidate => {
    seq += 1;
    return {
      requestId: `req-${seq}`,
      employeeId: 'emp-1',
      scheduleId: `sch-${seq}`,
      installmentNo: 1,
      type: 'LOAN',
      priority: 100,
      createdAt: new Date(Date.UTC(2026, 0, seq)),
      outstanding: 100000,
      oldestDueCycleKey: 24318,
      due: { fee: 0, interest: 0, principal: 5000 },
      ...over,
    };
  };

  const ctx = (over: Partial<Parameters<typeof LoanRecoveryService.allocateForEmployee>[0]> = {}) => ({
    employeeId: 'emp-1',
    netPreRecovery: 50000,
    garnishment: 0,
    unpaidLeaveDays: 0,
    leavePolicies: [],
    ...over,
  });

  beforeEach(() => {
    seq = 0;
  });

  // ── kill-switch ───────────────────────────────────────────────────────────
  describe('v2 kill-switch OFF (legacy)', () => {
    it('recovers every instalment in full with no affordability cap at all', () => {
      // The whole point of the switch: turning it on is the ONLY thing that
      // changes how much money moves.
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 1000 }),
        [candidate({ due: { fee: 0, interest: 0, principal: 9000 } })],
        policy({ moduleV2Enabled: false, maxTotalDeductionPercentOfNet: 10 }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(9000);
      expect(plan.lines[0].outcome).toBe('FULL');
    });

    it('ignores the unpaid-leave pause', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ unpaidLeaveDays: 30 }),
        [candidate()],
        policy({ moduleV2Enabled: false }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(5000);
    });
  });

  // ── §4 / §5 affordability ────────────────────────────────────────────────
  describe('§5 partial salary', () => {
    it('recovers in full when the pool covers the instalment', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx(),
        [candidate()],
        policy({ maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(5000);
      expect(plan.lines[0]).toMatchObject({ outcome: 'FULL', reason: 'AFFORDABLE' });
    });

    it('takes a PARTIAL recovery and carries the shortfall forward', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 3000 }),
        [candidate()],
        policy({ maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(3000);
      expect(plan.lines[0]).toMatchObject({
        outcome: 'PARTIAL',
        shortfallAmount: 2000,
      });
      expect(plan.noteLines.join(' ')).toMatch(/Partial loan recovery/);
    });

    it('defers instead of part-paying when the shortfall policy is DEFER', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 3000 }),
        [candidate()],
        policy({ shortfallPolicy: 'DEFER', maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(0);
      expect(plan.lines[0].outcome).toBe('DEFER');
    });

    it('never breaches the protected minimum take-home', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 20000 }),
        [candidate({ due: { fee: 0, interest: 0, principal: 19000 } })],
        policy({ minNetPayAmount: 15000, maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(5000); // 20000 - 15000 floor
    });

    it('caps total recovery at the configured share of net', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 20000 }),
        [candidate({ due: { fee: 0, interest: 0, principal: 19000 } })],
        policy({ maxTotalDeductionPercentOfNet: 30 }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(6000); // 30% of 20000
    });

    it('subtracts a court-ordered garnishment before any loan is considered', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 20000, garnishment: 18000 }),
        [candidate({ due: { fee: 0, interest: 0, principal: 5000 } })],
        policy({ maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(2000);
    });

    it('defers a recovery too small to be worth posting', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 10.5 }),
        [candidate()],
        policy({
          maxTotalDeductionPercentOfNet: 100,
          minPartialRecoveryAmount: 100,
        }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(0);
      expect(plan.lines[0].outcome).toBe('DEFER');
    });

    it('recovers nothing in a zero-salary cycle, and says why', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 0 }),
        [candidate()],
        policy(),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(0);
      expect(plan.lines[0]).toMatchObject({ outcome: 'DEFER', reason: 'ZERO_NET' });
    });

    it('a FINAL_SETTLEMENT run ignores the minimum-take-home floor', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 20000 }),
        [candidate({ due: { fee: 0, interest: 0, principal: 19000 } })],
        policy({ minNetPayAmount: 15000, maxTotalDeductionPercentOfNet: 30 }),
        'FINAL_SETTLEMENT',
      );
      expect(plan.totalRecovered).toBe(19000);
    });
  });

  // ── §6 multiple loans ────────────────────────────────────────────────────
  describe('§6 multiple loans competing for a limited net', () => {
    it('funds the lower priority value first', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 7000 }),
        [
          candidate({ requestId: 'low', priority: 50, due: { fee: 0, interest: 0, principal: 5000 } }),
          candidate({ requestId: 'high', priority: 10, due: { fee: 0, interest: 0, principal: 5000 } }),
        ],
        policy({ maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.lines.map((l) => [l.requestId, l.amount])).toEqual([
        ['high', 5000],
        ['low', 2000],
      ]);
    });

    it('recovers ADVANCE before LOAN at equal priority (employer cash already out)', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 5000 }),
        [
          candidate({ requestId: 'loan', type: 'LOAN' }),
          candidate({ requestId: 'adv', type: 'ADVANCE' }),
        ],
        policy({ maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.lines[0].requestId).toBe('adv');
    });

    it('is deterministic at identical priority regardless of input order', () => {
      const a = candidate({ requestId: 'aaa', createdAt: new Date(Date.UTC(2026, 0, 1)) });
      const b = candidate({ requestId: 'bbb', createdAt: new Date(Date.UTC(2026, 0, 1)) });
      const p = policy({ maxTotalDeductionPercentOfNet: 100 });
      const one = LoanRecoveryService.allocateForEmployee(ctx(), [a, b], p, 'REGULAR');
      const two = LoanRecoveryService.allocateForEmployee(ctx(), [b, a], p, 'REGULAR');
      expect(one.lines.map((l) => l.requestId)).toEqual(two.lines.map((l) => l.requestId));
    });

    it('sweeps the oldest arrear first', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 5000 }),
        [
          candidate({ requestId: 'new', oldestDueCycleKey: 24318 }),
          candidate({ requestId: 'old', oldestDueCycleKey: 24316 }),
        ],
        policy({ maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.lines[0].requestId).toBe('old');
    });

    it('never allocates more than the pool across several loans', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ netPreRecovery: 6000 }),
        [candidate(), candidate(), candidate()],
        policy({ maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(6000);
    });
  });

  // ── §12 leave interaction ────────────────────────────────────────────────
  describe('§12 leave interaction', () => {
    it('PAUSE skips the instalment and records the reason', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ unpaidLeaveDays: 10 }),
        [candidate()],
        policy({ unpaidLeavePolicy: 'PAUSE' }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(0);
      expect(plan.lines[0]).toMatchObject({ outcome: 'SKIP', reason: 'UNPAID_LEAVE' });
    });

    it('EXTEND defers the instalment rather than skipping it', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ unpaidLeaveDays: 10 }),
        [candidate()],
        policy({ unpaidLeavePolicy: 'EXTEND' }),
        'REGULAR',
      );
      expect(plan.lines[0]).toMatchObject({ outcome: 'DEFER', reason: 'UNPAID_LEAVE' });
    });

    it('CONTINUE recovers normally despite unpaid leave', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ unpaidLeaveDays: 10 }),
        [candidate()],
        policy({ unpaidLeavePolicy: 'CONTINUE', maxTotalDeductionPercentOfNet: 100 }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(5000);
    });

    it('the STRICTEST per-leave-type policy wins when a cycle spans several types', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ unpaidLeaveDays: 10, leavePolicies: ['CONTINUE', 'PAUSE', 'EXTEND'] }),
        [candidate()],
        policy({ unpaidLeavePolicy: 'CONTINUE' }),
        'REGULAR',
      );
      expect(plan.lines[0].outcome).toBe('SKIP');
    });

    it('a single unpaid day does not pause when the threshold is higher', () => {
      const plan = LoanRecoveryService.allocateForEmployee(
        ctx({ unpaidLeaveDays: 1 }),
        [candidate()],
        policy({
          unpaidLeavePolicy: 'PAUSE',
          unpaidLeaveMinDays: 5,
          maxTotalDeductionPercentOfNet: 100,
        }),
        'REGULAR',
      );
      expect(plan.totalRecovered).toBe(5000);
    });
  });

  // ── payment waterfall ────────────────────────────────────────────────────
  it('applies a partial payment fee -> interest -> principal, never principal first', () => {
    const plan = LoanRecoveryService.allocateForEmployee(
      ctx({ netPreRecovery: 700 }),
      [candidate({ due: { fee: 100, interest: 400, principal: 5000 } })],
      policy({ maxTotalDeductionPercentOfNet: 100 }),
      'REGULAR',
    );
    expect(plan.lines[0]).toMatchObject({
      feeComponent: 100,
      interestComponent: 400,
      principalComponent: 200,
    });
  });

  it('returns an empty plan when there is nothing to collect', () => {
    const plan = LoanRecoveryService.allocateForEmployee(ctx(), [], policy(), 'REGULAR');
    expect(plan).toMatchObject({ totalRecovered: 0, lines: [], noteLines: [] });
  });
});
