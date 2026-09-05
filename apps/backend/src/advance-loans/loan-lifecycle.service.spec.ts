import { BadRequestException } from '@nestjs/common';
import { LoanLifecycleService } from './loan-lifecycle.service';
import { DEFAULT_LOAN_POLICY } from './loan-policy.service';
import { LoanScheduleService } from './loan-schedule.service';

/**
 * Money behaviour of the post-approval lifecycle, against a real
 * LoanScheduleService and a real amortization engine over an in-memory store.
 *
 * A mocked schedule service would have proved nothing here: every defect these
 * cases cover is an argument passed BETWEEN the two services (which interest
 * figure the waterfall runs against, how many instalments a rebuild is asked
 * for), so the seam is exactly what has to stay real. Only Prisma is faked.
 *
 * Covers, from docs/LOAN-ADVANCES-BUG-REPORT.md:
 *   §1  prepaying an interest-bearing loan made it MORE expensive
 *   §4  `skip EXTEND` collapsed the schedule and tripled the instalment
 *   §9  the audit trail was split across two resourceType values
 *   §14 prepayments were accepted on an ON_HOLD loan
 *   §16 close / reinstate / skipInstallment notified nobody
 *   §17 every notification linked to the list, not to the loan
 */

// ── the in-memory Prisma double ───────────────────────────────────────────────

const minor = (n: number) => Math.round((n + Number.EPSILON) * 100);
const sumMinor = (xs: number[]) => xs.reduce((a, b) => a + minor(b), 0);

/** Supports exactly the operators these two services use. */
function matches(row: any, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return (cond.in as any[]).includes(value);
      if ('notIn' in cond) return !(cond.notIn as any[]).includes(value);
      if ('lte' in cond) return value <= cond.lte;
      if ('lt' in cond) return value < cond.lt;
      if ('gte' in cond) return value >= cond.gte;
      return true;
    }
    return value === cond;
  });
}

function applyData(row: any, data: Record<string, any>) {
  for (const [key, next] of Object.entries(data)) {
    if (
      next &&
      typeof next === 'object' &&
      !(next instanceof Date) &&
      ('increment' in next || 'decrement' in next)
    ) {
      const delta = next as any;
      row[key] =
        Number(row[key] ?? 0) +
        Number(delta.increment ?? 0) -
        Number(delta.decrement ?? 0);
    } else {
      row[key] = next;
    }
  }
}

function makePrisma() {
  const loans: any[] = [];
  const schedules: any[] = [];
  const transactions: any[] = [];
  let scheduleSeq = 0;

  const db: any = {
    _loans: loans,
    _schedules: schedules,
    _transactions: transactions,

    // Read only to find the loan's branch, so the branch-level authority list
    // can be consulted on top of the company-wide one.
    employee: {
      findUnique: jest.fn(async () => ({ branchId: null })),
    },

    advanceLoanRequest: {
      findUnique: async ({ where }: any) => {
        const row = loans.find((l) => matches(l, where));
        return row ? { ...row } : null;
      },
      findMany: async ({ where }: any = {}) =>
        loans.filter((l) => matches(l, where)).map((l) => ({ ...l })),
      updateMany: async ({ where, data }: any) => {
        const hits = loans.filter((l) => matches(l, where));
        hits.forEach((l) => applyData(l, data));
        return { count: hits.length };
      },
      update: async ({ where, data }: any) => {
        const row = loans.find((l) => matches(l, where));
        applyData(row, data);
        return { ...row };
      },
    },

    loanSchedule: {
      createMany: async ({ data }: any) => {
        for (const d of data) {
          schedules.push({
            id: `sch-${++scheduleSeq}`,
            status: 'SCHEDULED',
            paidAmount: 0,
            paidPrincipal: 0,
            paidInterest: 0,
            carryForwardAmount: 0,
            settledAt: null,
            supersededAt: null,
            note: null,
            ...d,
          });
        }
        return { count: data.length };
      },
      findMany: async ({ where, orderBy }: any = {}) => {
        const rows = schedules.filter((s) => matches(s, where));
        if (orderBy?.installmentNo) {
          rows.sort((a, b) =>
            orderBy.installmentNo === 'desc'
              ? b.installmentNo - a.installmentNo
              : a.installmentNo - b.installmentNo,
          );
        }
        return rows.map((s) => ({ ...s }));
      },
      findFirst: async ({ where }: any) => {
        const row = schedules.find((s) => matches(s, where));
        return row ? { ...row } : null;
      },
      count: async ({ where }: any = {}) =>
        schedules.filter((s) => matches(s, where)).length,
      update: async ({ where, data }: any) => {
        const row = schedules.find((s) => matches(s, where));
        applyData(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        const hits = schedules.filter((s) => matches(s, where));
        hits.forEach((s) => applyData(s, data));
        return { count: hits.length };
      },
    },

    loanTransaction: {
      create: async ({ data }: any) => {
        transactions.push({ ...data });
        return { ...data };
      },
      findUnique: async ({ where }: any) =>
        transactions.find((t) => matches(t, where)) ?? null,
    },

    // No payroll ever in flight in these cases; the guard has its own coverage.
    advanceLoanDeduction: { findFirst: async () => null },
    user: { findFirst: async () => ({ id: 'user-of-employee' }) },

    $transaction: async (cb: any) => cb(db),
  };

  return db;
}

/**
 * The clock these cases run on.
 *
 * Pinned because "has this instalment fallen due yet" is the whole subject: on
 * a real clock, a case seeded one month back would flip its answer on the 31st.
 * Only Date is faked — nothing here waits on a timer.
 */
const TODAY = new Date('2026-08-18T09:00:00.000Z');
const DO_NOT_FAKE = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback',
  'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
] as const;

/** First day of the month `offset` months from now, UTC. */
const monthStart = (offset: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
};

// ── harness ──────────────────────────────────────────────────────────────────

const ADMIN = { id: 'user-admin', role: 'ADMIN' };

describe('LoanLifecycleService — post-approval money operations', () => {
  let prisma: any;
  let schedules: LoanScheduleService;
  let service: LoanLifecycleService;
  let settingsMap: Record<string, string>;
  let audit: { log: jest.Mock };
  let notifications: { notifyUser: jest.Mock };

  const LOAN_ID = 'loan-1';

  const seedLoan = (over: Record<string, any> = {}) => {
    prisma._loans.push({
      id: LOAN_ID,
      employeeId: 'emp-1',
      type: 'LOAN',
      status: 'ACTIVE',
      amount: 1200,
      amountRepaid: 0,
      writtenOffAmount: 0,
      waivedAmount: 0,
      outstandingPrincipal: 1200,
      outstandingInterest: 0,
      interestAccrued: 0,
      interestPaid: 0,
      installments: 12,
      installmentAmount: 0,
      interestMethod: 'REDUCING_BALANCE',
      interestRate: 12,
      deductionFrequency: 'MONTHLY',
      processingFee: 0,
      processingFeeMode: 'DEDUCT_FROM_DISBURSEMENT',
      employerSubsidyPercent: 0,
      gracePeriods: 0,
      // Due at the END of next month => nothing has accrued today.
      firstDeductionDate: monthStart(1),
      disbursementDate: null,
      effectiveDate: null,
      scheduleVersion: 0,
      version: 0,
      currency: 'INR',
      createdAt: new Date(),
      employee: { id: 'emp-1', fullName: 'Raja Guru R', branchId: null, departmentId: null },
      ...over,
    });
  };

  const loanRow = () => prisma._loans.find((l: any) => l.id === LOAN_ID);
  const liveRows = () =>
    prisma._schedules
      .filter((s: any) => s.version === loanRow().scheduleVersion)
      .sort((a: any, b: any) => a.installmentNo - b.installmentNo);

  beforeEach(() => {
    jest.useFakeTimers({ now: TODAY, doNotFake: [...DO_NOT_FAKE] as any });
    prisma = makePrisma();
    settingsMap = {
      loan_interest_enabled: 'true',
      loan_rounding_unit: '0.01',
      loan_prepayment_mode: 'REDUCE_TENURE',
      loan_rounding_tolerance: '1.00',
      advance_loan_writeoff_roles: 'ADMIN',
      loan_waiver_roles: 'ADMIN,HR_MANAGER',
    };
    const settings: any = {
      getSetting: jest
        .fn()
        .mockImplementation((k: string, fb: string) =>
          Promise.resolve(settingsMap[k] ?? fb),
        ),
    };
    const access: any = { assertCanViewLoan: jest.fn().mockResolvedValue(undefined) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    notifications = { notifyUser: jest.fn().mockResolvedValue(undefined) };

    schedules = new LoanScheduleService(prisma, settings, access);
    service = new LoanLifecycleService(
      prisma,
      schedules,
      access,
      settings,
      audit as any,
      notifications as any,
      // The branch policy layer. Answering with the defaults means these unit
      // cases keep testing the company-wide gate; the per-branch narrowing is
      // covered over HTTP, where a real branch row can exist.
      { resolve: async () => ({ ...DEFAULT_LOAN_POLICY }) } as any,
      // Forwards the way the real log service does, so the §16/§17 cases keep
      // asserting the words and the deep link that reach the notifier.
      {
        notifyOnce: jest.fn(async (a: any) => {
          const rest = a.meta === undefined ? [] : [a.meta];
          await notifications.notifyUser(
            a.recipientUserId,
            a.title,
            a.message,
            a.type ?? 'INFO',
            a.link,
            ...rest,
          );
          return true;
        }),
      } as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const quote = async () => (await service.payoffQuote(LOAN_ID)).data;

  // ── §1 ─────────────────────────────────────────────────────────────────────

  describe('§1 prepaying an interest-bearing loan must make it cheaper', () => {
    it('a fresh plan books ZERO accrued interest, not the 79.42 lifetime total', async () => {
      seedLoan();
      const plan = await schedules.generate(LOAN_ID);

      expect(plan.totalInterest).toBe(79.42);
      expect(plan.levelEmi).toBe(106.62);
      // The lifetime figure lives in interestAccrued; outstandingInterest is
      // now "accrued and unpaid", and on day one nothing has been earned.
      expect(Number(loanRow().interestAccrued)).toBe(79.42);
      expect(Number(loanRow().outstandingInterest)).toBe(0);
    });

    it('the payoff quote is principal only until an instalment falls due', async () => {
      seedLoan();
      await schedules.generate(LOAN_ID);

      const q = await quote();
      expect(q.outstandingPrincipal).toBe(1200);
      expect(q.outstandingInterest).toBe(0);
      // NOT 1279.42, which is what it quoted when it added all future interest.
      expect(q.payoffAmount).toBe(1200);
    });

    it('REGRESSION 1200/200/79.42: the whole 200 reaches the principal', async () => {
      seedLoan();
      await schedules.generate(LOAN_ID);

      await service.prepay(LOAN_ID, ADMIN, {
        amount: 200,
        mode: 'CASH',
        recalc: 'REDUCE_EMI',
      });

      const tx = prisma._transactions.find((t: any) => t.type === 'PREPAYMENT');
      // Was 120.58 principal / 79.42 interest.
      expect(tx.principalComponent).toBe(200);
      expect(tx.interestComponent).toBe(0);
      expect(Number(loanRow().amountRepaid)).toBe(200);
      expect(Number(loanRow().outstandingPrincipal)).toBe(1000);

      const rows = liveRows();
      expect(rows).toHaveLength(12);
      // The invariant: components reconcile to the balance being amortized.
      expect(sumMinor(rows.map((r: any) => r.principalComponent))).toBe(minor(1000));
      expect(minor(rows[rows.length - 1].closingBalance)).toBe(0);
      // Was a SECOND 71.43 over the same twelve months.
      expect(sumMinor(rows.map((r: any) => r.interestComponent))).toBe(minor(66.19));

      const q = await quote();
      expect(q.outstandingPrincipal).toBe(1000);
      expect(q.outstandingInterest).toBe(0);
      expect(q.payoffAmount).toBe(1000);

      // Total outlay 200 + 1000 + 66.19 = 1266.19, against 1279.42 for never
      // prepaying and 1350.85 under the old behaviour.
      expect(minor(200) + minor(1000) + minor(66.19)).toBe(minor(1266.19));
    });

    it('the over-payment ceiling follows the corrected quote', async () => {
      seedLoan();
      await schedules.generate(LOAN_ID);

      // 1250 used to be accepted, because the ceiling was the inflated 1279.42.
      await expect(
        service.prepay(LOAN_ID, ADMIN, { amount: 1250, mode: 'CASH' }),
      ).rejects.toThrow(/exceeds the payoff amount of 1200/);
    });

    it('interest that HAS accrued is charged, credited to its instalment, and never charged twice', async () => {
      // First instalment fell due at the end of LAST month => one period has
      // elapsed and earned interest; #2 (end of this month) has not.
      seedLoan({ firstDeductionDate: monthStart(-1) });
      await schedules.generate(LOAN_ID);

      expect(liveRows()[0].dueDate.getTime()).toBeLessThan(TODAY.getTime());
      expect(liveRows()[1].dueDate.getTime()).toBeGreaterThan(TODAY.getTime());
      expect(Number(loanRow().outstandingInterest)).toBe(12);
      expect((await quote()).outstandingInterest).toBe(12);
      // One period, not twelve: the other eleven have earned nothing.
      expect((await quote()).payoffAmount).toBe(1212);

      await service.prepay(LOAN_ID, ADMIN, {
        amount: 50,
        mode: 'CASH',
        recalc: 'REDUCE_EMI',
      });

      const tx = prisma._transactions.find((t: any) => t.type === 'PREPAYMENT');
      expect(tx.interestComponent).toBe(12);
      expect(tx.principalComponent).toBe(38);

      // Stamped onto instalment #1, so the derivation cannot re-report it.
      const first = prisma._schedules.find(
        (s: any) => s.version === 1 && s.installmentNo === 1,
      );
      expect(Number(first.paidInterest)).toBe(12);

      const q = await quote();
      expect(q.outstandingInterest).toBe(0);
      expect(q.outstandingPrincipal).toBe(1162);
      expect(Number(loanRow().outstandingInterest)).toBe(0);
      // Never billed a second time by the rebuild.
      expect(Number(loanRow().interestPaid)).toBe(12);
    });

    it('a full prepayment closes the loan at the corrected payoff', async () => {
      seedLoan();
      await schedules.generate(LOAN_ID);

      await service.prepay(LOAN_ID, ADMIN, { amount: 1200, mode: 'BANK' });

      expect(loanRow().status).toBe('CLOSED');
      expect(loanRow().closureType).toBe('EARLY_CLOSURE');
      expect(
        prisma._schedules.every((s: any) => s.status === 'CLOSED_EARLY'),
      ).toBe(true);
    });

    describe('interest-free loans — the default — behave exactly as before', () => {
      beforeEach(() => {
        settingsMap.loan_interest_enabled = 'false';
      });

      it('600 over 6 stays 6 x 100 with no interest anywhere', async () => {
        seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
        const plan = await schedules.generate(LOAN_ID);

        expect(plan.totalInterest).toBe(0);
        expect(plan.levelEmi).toBe(100);
        expect(Number(loanRow().outstandingInterest)).toBe(0);
        expect((await quote()).payoffAmount).toBe(600);
      });

      it('a 200 prepayment is 100% principal and REDUCE_TENURE drops two instalments', async () => {
        seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
        await schedules.generate(LOAN_ID);

        await service.prepay(LOAN_ID, ADMIN, {
          amount: 200,
          mode: 'BANK',
          recalc: 'REDUCE_TENURE',
        });

        const tx = prisma._transactions.find((t: any) => t.type === 'PREPAYMENT');
        expect(tx.principalComponent).toBe(200);
        expect(tx.interestComponent).toBe(0);

        const rows = liveRows();
        expect(rows).toHaveLength(4);
        expect(rows.map((r: any) => r.emiAmount)).toEqual([100, 100, 100, 100]);
        expect((await quote()).payoffAmount).toBe(400);
      });

      it('REDUCE_EMI keeps the six instalments and lowers each one', async () => {
        seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
        await schedules.generate(LOAN_ID);

        await service.prepay(LOAN_ID, ADMIN, {
          amount: 200,
          mode: 'BANK',
          recalc: 'REDUCE_EMI',
        });

        const rows = liveRows();
        expect(rows).toHaveLength(6);
        expect(sumMinor(rows.map((r: any) => r.principalComponent))).toBe(minor(400));
        expect(Number(loanRow().installmentAmount)).toBeLessThan(100);
        expect((await quote()).outstandingInterest).toBe(0);
      });
    });
  });

  // ── §4 ─────────────────────────────────────────────────────────────────────

  describe('§4 skip EXTEND must lengthen the plan, not collapse it', () => {
    beforeEach(() => {
      settingsMap.loan_interest_enabled = 'false';
    });

    it('skipping #4 of 6 leaves SIX instalments of 100, not two of 300', async () => {
      seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
      await schedules.generate(LOAN_ID);

      await service.skipInstallment(LOAN_ID, ADMIN, {
        installmentNo: 4,
        mode: 'EXTEND',
        reason: 'deferred, still owed',
      });

      const rows = liveRows();
      expect(rows).toHaveLength(6);
      // Numbering continues past the skipped row so nothing collides with it.
      expect(rows.map((r: any) => r.installmentNo)).toEqual([5, 6, 7, 8, 9, 10]);
      // The whole point: the deduction is unchanged and the loan ends later.
      expect(rows.map((r: any) => Number(r.emiAmount))).toEqual([
        100, 100, 100, 100, 100, 100,
      ]);
      expect(sumMinor(rows.map((r: any) => r.principalComponent))).toBe(minor(600));
      expect(minor(rows[rows.length - 1].closingBalance)).toBe(0);
      expect(loanRow().scheduleVersion).toBe(2);
      // No arrear is folded in: 700 would be the double-charge.
      expect((await quote()).payoffAmount).toBe(600);
    });

    it('with three instalments already paid, the instalment is still preserved', async () => {
      seedLoan({ amount: 600, installments: 6, amountRepaid: 300, outstandingPrincipal: 300 });
      await schedules.generate(LOAN_ID);
      // Instalments 1-3 recovered by payroll.
      for (const s of prisma._schedules.filter((r: any) => r.installmentNo <= 3)) {
        Object.assign(s, { status: 'PAID', paidAmount: 100, paidPrincipal: 100 });
      }

      await service.skipInstallment(LOAN_ID, ADMIN, {
        installmentNo: 4,
        mode: 'EXTEND',
        reason: 'deferred, still owed',
      });

      const rows = liveRows();
      // Two were still open (#5, #6), plus one = three of 100.
      expect(rows.map((r: any) => Number(r.emiAmount))).toEqual([100, 100, 100]);
      expect(sumMinor(rows.map((r: any) => r.principalComponent))).toBe(minor(300));
    });

    it('FORGIVE waives the instalment and does NOT rebuild the plan', async () => {
      seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
      await schedules.generate(LOAN_ID);

      await service.skipInstallment(LOAN_ID, ADMIN, {
        installmentNo: 4,
        mode: 'FORGIVE',
        reason: 'hardship',
      });

      expect(loanRow().scheduleVersion).toBe(1);
      expect(Number(loanRow().waivedAmount)).toBe(100);
      expect((await quote()).payoffAmount).toBe(500);
      const row4 = prisma._schedules.find((s: any) => s.installmentNo === 4);
      expect(row4.status).toBe('WAIVED');
    });
  });

  // ── §14 ────────────────────────────────────────────────────────────────────

  describe('§14 an ON_HOLD loan refuses payments and schedule changes', () => {
    const HELD =
      'Recovery is paused on this loan. Resume it before recording payments or changing the schedule.';

    beforeEach(async () => {
      settingsMap.loan_interest_enabled = 'false';
      seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
      await schedules.generate(LOAN_ID);
      await service.hold(LOAN_ID, ADMIN, { reason: 'paused before the journey' });
      expect(loanRow().status).toBe('ON_HOLD');
    });

    it('refuses a prepayment with the exact sentence the client guard promises', async () => {
      await expect(
        service.prepay(LOAN_ID, ADMIN, { amount: 50, mode: 'CASH' }),
      ).rejects.toThrow(new BadRequestException(HELD));
      // And no money moved.
      expect(Number(loanRow().amountRepaid)).toBe(0);
      expect(prisma._transactions).toHaveLength(0);
    });

    it('refuses a schedule change with the same sentence', async () => {
      await expect(
        service.skipInstallment(LOAN_ID, ADMIN, {
          installmentNo: 2,
          mode: 'EXTEND',
          reason: 'not while paused',
        }),
      ).rejects.toThrow(HELD);
      expect(loanRow().scheduleVersion).toBe(1);
    });

    it('refuses a second hold rather than silently overwriting the first', async () => {
      await expect(
        service.hold(LOAN_ID, ADMIN, { reason: 'paused again' }),
      ).rejects.toThrow(HELD);
    });

    it('resume still works on a held loan — it is the way out', async () => {
      await service.resume(LOAN_ID, ADMIN, { reason: 'back at work' });
      expect(loanRow().status).toBe('ACTIVE');
      expect(loanRow().holdUntil).toBeNull();
      // And the prepayment it was refusing is now accepted.
      await service.prepay(LOAN_ID, ADMIN, { amount: 50, mode: 'CASH' });
      expect(Number(loanRow().amountRepaid)).toBe(50);
    });

    it('is NOT a blanket rejection: forgiving the debt is still allowed while paused', async () => {
      // A hold suspends recovery, not the employer's ability to write the
      // balance off — so this must not be swept up by the same guard.
      await service.writeOff(LOAN_ID, ADMIN, { amount: 100, reason: 'goodwill adjustment' });
      expect(Number(loanRow().writtenOffAmount)).toBe(100);

      await service.waive(LOAN_ID, ADMIN, { amount: 50, waiveType: 'PRINCIPAL', reason: 'goodwill' });
      expect(Number(loanRow().waivedAmount)).toBe(50);
    });
  });

  // ── §9 / §16 / §17 ─────────────────────────────────────────────────────────

  describe('§9 every audit row is written under one resourceType', () => {
    it("uses 'AdvanceLoan' — the value the controller interceptor also writes", async () => {
      settingsMap.loan_interest_enabled = 'false';
      seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
      await schedules.generate(LOAN_ID);

      await service.prepay(LOAN_ID, ADMIN, { amount: 100, mode: 'CASH' });
      await service.hold(LOAN_ID, ADMIN, { reason: 'pause' });
      await service.resume(LOAN_ID, ADMIN, { reason: 'resume' });
      await service.writeOff(LOAN_ID, ADMIN, { amount: 50, reason: 'goodwill adjustment' });

      expect(audit.log.mock.calls.length).toBeGreaterThanOrEqual(4);
      for (const [entry] of audit.log.mock.calls) {
        // Was 'AdvanceLoanRequest' here and 'AdvanceLoan' on the interceptor,
        // so neither query ever found the other's rows.
        expect(entry.resourceType).toBe('AdvanceLoan');
        expect(entry.resourceId).toBe(LOAN_ID);
      }
    });
  });

  describe('§16 the three silent money operations now notify', () => {
    beforeEach(() => {
      settingsMap.loan_interest_enabled = 'false';
    });

    it('close tells the borrower the loan is closed', async () => {
      seedLoan({ amount: 600, installments: 6, amountRepaid: 600, outstandingPrincipal: 0 });
      await schedules.generate(LOAN_ID);

      await service.close(LOAN_ID, ADMIN, { reason: 'final instalment recovered' });

      expect(notifications.notifyUser).toHaveBeenCalledWith(
        'user-of-employee',
        'Loan closed',
        expect.stringContaining('closed'),
        'INFO',
        expect.any(String),
        expect.objectContaining({ waTemplate: 'loan_lifecycle' }),
      );
    });

    it('reinstate says the money is owed again — the one that matters', async () => {
      seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
      await schedules.generate(LOAN_ID);
      await service.writeOff(LOAN_ID, ADMIN, { reason: 'uncollectable, employee absconded' });
      expect(loanRow().status).toBe('WRITTEN_OFF');
      notifications.notifyUser.mockClear();

      await service.reinstate(LOAN_ID, ADMIN, { reason: 'employee returned and agreed to repay' });

      expect(loanRow().status).toBe('ACTIVE');
      const [, title, message] = notifications.notifyUser.mock.calls[0];
      expect(title).toBe('Loan reinstated');
      expect(message).toMatch(/owed again/);
      expect(message).toContain('600');
    });

    it('skipInstallment warns that the next payslip changed', async () => {
      seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
      await schedules.generate(LOAN_ID);

      await service.skipInstallment(LOAN_ID, ADMIN, {
        installmentNo: 4,
        mode: 'EXTEND',
        reason: 'medical leave',
      });

      const [, title, message] = notifications.notifyUser.mock.calls[0];
      expect(title).toBe('Loan instalment skipped');
      expect(message).toMatch(/still owed/);
    });
  });

  describe('§17 every notification links to the loan, not to the list', () => {
    it('carries /dashboard/advance-loans/:id on every sender', async () => {
      settingsMap.loan_interest_enabled = 'false';
      seedLoan({ amount: 600, installments: 6, outstandingPrincipal: 600 });
      await schedules.generate(LOAN_ID);

      await service.prepay(LOAN_ID, ADMIN, { amount: 100, mode: 'CASH' });
      await service.skipInstallment(LOAN_ID, ADMIN, {
        installmentNo: 5,
        mode: 'EXTEND',
        reason: 'medical leave',
      });
      await service.hold(LOAN_ID, ADMIN, { reason: 'pause' });
      await service.resume(LOAN_ID, ADMIN, { reason: 'resume' });
      await service.waive(LOAN_ID, ADMIN, { amount: 25, waiveType: 'PRINCIPAL', reason: 'goodwill' });

      expect(notifications.notifyUser.mock.calls.length).toBeGreaterThanOrEqual(5);
      for (const call of notifications.notifyUser.mock.calls) {
        // Was the bare module constant, so a written-off notice handed the
        // employee a list of all their loans and no way to tell which.
        expect(call[4]).toBe(`/dashboard/advance-loans/${LOAN_ID}`);
      }
    });
  });
});
