import {
  generateSchedule,
  regenerateFromBalance,
  splitPayment,
  allocateRecovery,
  validateAffordability,
  periodsPerYear,
  addPeriods,
  LoanAmortizationError,
  AmortizationInput,
} from './loan-amortization.util';

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

const base = (over: Partial<AmortizationInput> = {}): AmortizationInput => ({
  principal: 120000,
  annualRatePercent: 12,
  method: 'REDUCING_BALANCE',
  installments: 12,
  frequency: 'MONTHLY',
  firstDueDate: D('2026-09-30'),
  ...over,
});

describe('loan amortization engine', () => {
  // ── doc §3 EMI Calculation ────────────────────────────────────────────────
  describe('§3 EMI calculation', () => {
    it('equal EMI (reducing balance) matches the golden fixture and reconciles exactly', () => {
      const r = generateSchedule(base());

      expect(r.rows).toHaveLength(12);
      expect(r.levelEmi).toBe(10661.85);
      expect(sum(r.rows.map((x) => x.principalComponent))).toBe(120000);
      expect(r.rows[11].closingBalance).toBe(0);
      expect(r.totalPrincipal).toBe(120000);
    });

    it('reducing-balance interest declines monotonically', () => {
      const r = generateSchedule(base());
      for (let k = 1; k < r.rows.length; k++) {
        expect(r.rows[k].interestComponent).toBeLessThan(
          r.rows[k - 1].interestComponent,
        );
      }
    });

    it('flat interest charges the same interest every period', () => {
      const r = generateSchedule(base({ method: 'FLAT' }));
      expect(r.totalInterest).toBe(14400);
      for (const row of r.rows) {
        expect(row.interestComponent).toBe(1200);
        expect(row.principalComponent).toBe(10000);
        expect(row.emiAmount).toBe(11200);
      }
    });

    it('no interest splits principal exactly — the bug the old Math.round(amount/n) had', () => {
      const r = generateSchedule(
        base({
          principal: 100000,
          installments: 7,
          method: 'NONE',
          annualRatePercent: 0,
        }),
      );
      // Legacy code produced 14286 x 7 = 100002, over-recovering by 2.
      expect(sum(r.rows.map((x) => x.principalComponent))).toBe(100000);
      expect(r.rows.every((x) => x.interestComponent === 0)).toBe(true);
      expect(r.rows[6].closingBalance).toBe(0);
    });

    it('weekly deduction uses a per-week rate and 7-day gaps', () => {
      expect(periodsPerYear('WEEKLY')).toBe(52);
      const r = generateSchedule(
        base({ installments: 52, frequency: 'WEEKLY' }),
      );
      expect(sum(r.rows.map((x) => x.principalComponent))).toBe(120000);
      const gap =
        (r.rows[1].dueDate.getTime() - r.rows[0].dueDate.getTime()) / 86400000;
      expect(gap).toBe(7);
    });

    it('monthly due dates anchor on the original day and do not drift after February', () => {
      const r = generateSchedule(
        base({
          firstDueDate: D('2027-01-31'),
          installments: 3,
          method: 'NONE',
          annualRatePercent: 0,
        }),
      );
      expect(r.rows.map((x) => x.dueDate.toISOString().slice(0, 10))).toEqual([
        '2027-01-31',
        '2027-02-28',
        '2027-03-31', // NOT 2027-03-28
      ]);
    });

    it('quarterly deduction uses a per-quarter rate and 3-month gaps', () => {
      expect(periodsPerYear('QUARTERLY')).toBe(4);
      const r = generateSchedule(
        base({ installments: 4, frequency: 'QUARTERLY' }),
      );
      expect(sum(r.rows.map((x) => x.principalComponent))).toBe(120000);
      expect(r.rows[1].dueDate.getUTCMonth()).toBe(
        (r.rows[0].dueDate.getUTCMonth() + 3) % 12,
      );
    });

    it('EMI > salary is rejected', () => {
      expect(
        validateAffordability({ emi: 50000, otherActiveEmis: 0, monthlyNet: 40000 }),
      ).toEqual({ ok: false, code: 'EMI_EXCEEDS_NET', message: expect.any(String) });
    });

    it('EMI < minimum allowed is rejected', () => {
      expect(
        validateAffordability({
          emi: 50,
          otherActiveEmis: 0,
          monthlyNet: 40000,
          minEmi: 500,
        }),
      ).toMatchObject({ ok: false, code: 'EMI_BELOW_MIN' });
    });

    it('every component is an exact 2dp value', () => {
      const r = generateSchedule(
        base({ principal: 10000, annualRatePercent: 7.5, installments: 3 }),
      );
      for (const row of r.rows) {
        for (const v of [
          row.principalComponent,
          row.interestComponent,
          row.emiAmount,
          row.closingBalance,
        ]) {
          expect(v * 100).toBe(Math.round(v * 100));
        }
      }
    });

    it('PROPERTY: principal always reconciles and the balance always lands on zero', () => {
      const principals = [1, 7, 99, 100000, 999999];
      const counts = [1, 2, 3, 5, 7, 12, 13, 24, 36];
      const rates = [0, 0.1, 7.35, 100];
      const methods: AmortizationInput['method'][] = [
        'NONE',
        'FLAT',
        'REDUCING_BALANCE',
      ];

      for (const principal of principals) {
        for (const installments of counts) {
          for (const annualRatePercent of rates) {
            for (const method of methods) {
              let r;
              try {
                r = generateSchedule(
                  base({ principal, installments, annualRatePercent, method }),
                );
              } catch (e) {
                // The only legitimate refusal is a loan that can never
                // amortize (interest per period >= level EMI).
                expect(e).toBeInstanceOf(LoanAmortizationError);
                continue;
              }
              const label = `P=${principal} n=${installments} r=${annualRatePercent} ${method}`;
              expect(`${label}:${sum(r.rows.map((x) => x.principalComponent))}`).toBe(
                `${label}:${principal}`,
              );
              expect(`${label}:${r.rows[r.rows.length - 1].closingBalance}`).toBe(
                `${label}:0`,
              );
            }
          }
        }
      }
    });

    it('the last EMI differs from the level EMI when the split is not exact, and stays within one rounding step', () => {
      const r = generateSchedule(
        base({ principal: 100000, installments: 7, method: 'NONE', annualRatePercent: 0 }),
      );
      expect(r.lastEmi).not.toBe(r.levelEmi);
      expect(Math.abs(r.lastEmi - r.levelEmi)).toBeLessThan(r.rows.length * 0.01);
    });

    it('regeneration after part-payment preserves total principal', () => {
      const original = generateSchedule(base());
      const paidPrincipal = sum(
        original.rows.slice(0, 3).map((x) => x.principalComponent),
      );
      const outstanding = Math.round((120000 - paidPrincipal) * 100) / 100;

      const re = regenerateFromBalance({
        ...base({ installments: 9 }),
        outstandingPrincipal: outstanding,
        startInstallmentNo: 4,
      });

      expect(re.rows[0].installmentNo).toBe(4);
      expect(
        sum([paidPrincipal, sum(re.rows.map((x) => x.principalComponent))]),
      ).toBe(120000);
      // Interest now accrues on the smaller balance.
      expect(re.rows[0].interestComponent).toBeLessThan(
        original.rows[0].interestComponent,
      );
    });
  });

  /**
   * The named regression from the bug report: 1200.00 @ 12% reducing over 12,
   * with a 200.00 prepayment made before the first instalment falls due.
   *
   * This is the ENGINE half of the proof — the arithmetic that shows the two
   * outcomes are genuinely different money. The service half (which balance the
   * engine is actually handed) is in loan-lifecycle.service.spec.ts.
   */
  describe('§1 regression: a prepayment must make the loan cheaper, not dearer', () => {
    const LOAN = base({ principal: 1200, installments: 12 });

    it('the loan this case is built on: EMI 106.62, lifetime interest 79.42', () => {
      const r = generateSchedule(LOAN);
      expect(r.levelEmi).toBe(106.62);
      expect(r.totalInterest).toBe(79.42);
      expect(r.totalPayable).toBe(1279.42);
      // The first period earns 12.00 and NOT the whole 79.42 — which is the
      // entire point: eleven of these twelve months have earned nothing yet.
      expect(r.rows[0].interestComponent).toBe(12);
    });

    it('OLD behaviour, priced out: paying 200 raised the total outlay to 1350.85', () => {
      // The waterfall ran against the lifetime figure, so 79.42 of the 200.00
      // was taken as "interest" and only 120.58 reached the principal...
      const eaten = splitPayment(200, { fee: 0, interest: 79.42, principal: 1200 });
      expect(eaten).toEqual({ fee: 0, interest: 79.42, principal: 120.58 });

      // ...and the rebuild then charged the same twelve months a second time.
      const rebuilt = regenerateFromBalance({
        ...LOAN,
        outstandingPrincipal: 1079.42,
        startInstallmentNo: 1,
      });
      expect(rebuilt.totalInterest).toBe(71.43);

      const totalInterest = sum([79.42, 71.43]);
      expect(totalInterest).toBe(150.85);
      expect(sum([200, 1079.42, 71.43])).toBe(1350.85);
      // Strictly worse than never having prepaid at all.
      expect(1350.85).toBeGreaterThan(generateSchedule(LOAN).totalPayable);
    });

    it('NEW behaviour: nothing has accrued, so all 200 is principal and the loan gets cheaper', () => {
      // Nothing is due yet => interest due is 0 => the whole payment is principal.
      const split = splitPayment(200, { fee: 0, interest: 0, principal: 1200 });
      expect(split).toEqual({ fee: 0, interest: 0, principal: 200 });

      const rebuilt = regenerateFromBalance({
        ...LOAN,
        outstandingPrincipal: 1000,
        startInstallmentNo: 1,
      });
      expect(rebuilt.totalInterest).toBe(66.19);
      expect(rebuilt.levelEmi).toBe(88.85);
      // The invariant that must survive any money fix.
      expect(sum(rebuilt.rows.map((r) => r.principalComponent))).toBe(1000);
      expect(rebuilt.rows[rebuilt.rows.length - 1].closingBalance).toBe(0);

      const totalOutlay = sum([200, 1000, 66.19]);
      expect(totalOutlay).toBe(1266.19);
      // 13.23 cheaper than not prepaying, and 84.66 cheaper than the old path.
      expect(totalOutlay).toBeLessThan(generateSchedule(LOAN).totalPayable);
      expect(sum([1350.85, -totalOutlay])).toBe(84.66);
    });

    it('interest-free loans (the default) are untouched by any of this', () => {
      // loan_interest_enabled is false out of the box, so this is what almost
      // every real loan looks like: no interest to accrue, no waterfall to get
      // wrong, and a prepayment that is 100% principal before and after the fix.
      const free = generateSchedule(
        base({ principal: 600, installments: 6, annualRatePercent: 0, method: 'NONE' }),
      );
      expect(free.totalInterest).toBe(0);
      expect(free.levelEmi).toBe(100);

      expect(splitPayment(200, { fee: 0, interest: 0, principal: 600 })).toEqual({
        fee: 0,
        interest: 0,
        principal: 200,
      });

      const rebuilt = regenerateFromBalance({
        ...base({ installments: 6, annualRatePercent: 0, method: 'NONE' }),
        outstandingPrincipal: 400,
        startInstallmentNo: 1,
      });
      expect(rebuilt.totalInterest).toBe(0);
      expect(sum(rebuilt.rows.map((r) => r.principalComponent))).toBe(400);
    });
  });

  /**
   * §4: `skip EXTEND` must LENGTHEN the plan. The count is decided by the
   * service (loan-lifecycle.service.spec.ts proves it); what the engine
   * guarantees is that the right count preserves the instalment exactly.
   */
  describe('§4 regression: an extended plan keeps the instalment where it was', () => {
    const remaining = (installments: number) =>
      regenerateFromBalance({
        ...base({ principal: 600, installments, annualRatePercent: 0, method: 'NONE' }),
        outstandingPrincipal: 600,
        startInstallmentNo: 5,
      });

    it('600 over the 5 still-open instalments PLUS one is 6 x 100, not 2 x 300', () => {
      const extended = remaining(6);
      expect(extended.rows).toHaveLength(6);
      expect(extended.rows.map((r) => r.installmentNo)).toEqual([5, 6, 7, 8, 9, 10]);
      expect(extended.rows.map((r) => r.emiAmount)).toEqual([
        100, 100, 100, 100, 100, 100,
      ]);
      expect(sum(extended.rows.map((r) => r.principalComponent))).toBe(600);
    });

    it('the old `installments - highestSettledNo` count is what tripled the deduction', () => {
      const collapsed = remaining(2); // 6 - 4
      expect(collapsed.rows).toHaveLength(2);
      expect(collapsed.rows.map((r) => r.emiAmount)).toEqual([300, 300]);
    });
  });

  // ── doc §13 Interest Calculations ─────────────────────────────────────────
  describe('§13 interest calculations', () => {
    it('monthly interest uses annual/12', () => {
      expect(periodsPerYear('MONTHLY')).toBe(12);
      const r = generateSchedule(base({ installments: 1 }));
      expect(r.rows[0].interestComponent).toBe(1200); // 120000 * 12% / 12
    });

    it('daily interest is explicitly out of scope rather than silently mispriced', () => {
      expect(() => periodsPerYear('DAILY' as never)).toThrow(LoanAmortizationError);
    });

    it('a mid-loan rate change re-amortizes without losing principal', () => {
      const original = generateSchedule(base());
      const paid = sum(original.rows.slice(0, 4).map((x) => x.principalComponent));
      const re = regenerateFromBalance({
        ...base({ installments: 8, annualRatePercent: 18 }),
        outstandingPrincipal: Math.round((120000 - paid) * 100) / 100,
        startInstallmentNo: 5,
      });
      expect(sum([paid, sum(re.rows.map((x) => x.principalComponent))])).toBe(120000);
    });

    it('floating rate: two successive regenerations chain without principal loss', () => {
      const first = regenerateFromBalance({
        ...base({ installments: 10, annualRatePercent: 14 }),
        outstandingPrincipal: 100000,
        startInstallmentNo: 3,
      });
      const paid = sum(first.rows.slice(0, 2).map((x) => x.principalComponent));
      const second = regenerateFromBalance({
        ...base({ installments: 8, annualRatePercent: 9 }),
        outstandingPrincipal: Math.round((100000 - paid) * 100) / 100,
        startInstallmentNo: 5,
      });
      expect(sum([paid, sum(second.rows.map((x) => x.principalComponent))])).toBe(
        100000,
      );
    });

    it('zero interest under FLAT and REDUCING is identical to NONE', () => {
      const none = generateSchedule(
        base({ annualRatePercent: 0, method: 'NONE' }),
      );
      for (const method of ['FLAT', 'REDUCING_BALANCE'] as const) {
        const r = generateSchedule(base({ annualRatePercent: 0, method }));
        expect(r.rows.map((x) => x.emiAmount)).toEqual(
          none.rows.map((x) => x.emiAmount),
        );
      }
    });

    it('100% interest amortizes without overflow or negative principal', () => {
      const r = generateSchedule(base({ annualRatePercent: 100 }));
      expect(sum(r.rows.map((x) => x.principalComponent))).toBe(120000);
      expect(r.rows.every((x) => x.principalComponent > 0)).toBe(true);
      expect(Number.isFinite(r.totalInterest)).toBe(true);
    });

    it('negative interest is rejected', () => {
      expect(() => generateSchedule(base({ annualRatePercent: -5 }))).toThrow(
        LoanAmortizationError,
      );
    });
  });

  // ── fees, subsidy, edge inputs ────────────────────────────────────────────
  describe('fees, employer subsidy and invalid inputs', () => {
    it('DEDUCT_FROM_DISBURSEMENT leaves principal alone and reduces the payout', () => {
      const r = generateSchedule(
        base({ processingFee: 1200, processingFeeMode: 'DEDUCT_FROM_DISBURSEMENT' }),
      );
      expect(r.netDisbursement).toBe(118800);
      expect(r.upfrontFee).toBe(1200);
      expect(r.rows.every((x) => x.feeComponent === 0)).toBe(true);
      expect(sum(r.rows.map((x) => x.principalComponent))).toBe(120000);
    });

    it('ADD_TO_FIRST_EMI loads the fee onto installment 1 only', () => {
      const plain = generateSchedule(base());
      const r = generateSchedule(
        base({ processingFee: 1200, processingFeeMode: 'ADD_TO_FIRST_EMI' }),
      );
      expect(r.rows[0].emiAmount).toBe(
        Math.round((plain.rows[0].emiAmount + 1200) * 100) / 100,
      );
      expect(r.rows[1].emiAmount).toBe(plain.rows[1].emiAmount);
      expect(sum(r.rows.map((x) => x.principalComponent))).toBe(120000);
    });

    it('CAPITALIZE folds the fee into principal so it bears interest', () => {
      const r = generateSchedule(
        base({ processingFee: 1200, processingFeeMode: 'CAPITALIZE' }),
      );
      expect(sum(r.rows.map((x) => x.principalComponent))).toBe(121200);
      expect(r.netDisbursement).toBe(120000);
    });

    it('a 50% employer subsidy halves the interest the employee pays but not the balances', () => {
      const plain = generateSchedule(base());
      const r = generateSchedule(base({ employerSubsidyPercent: 50 }));

      expect(r.rows.map((x) => x.closingBalance)).toEqual(
        plain.rows.map((x) => x.closingBalance),
      );
      expect(r.totalEmployerSubsidy).toBeCloseTo(plain.totalInterest / 2, 1);
      expect(r.totalPayable).toBeLessThan(plain.totalPayable);
    });

    it('a 100% employer subsidy makes every EMI pure principal', () => {
      const r = generateSchedule(base({ employerSubsidyPercent: 100 }));
      for (const row of r.rows) {
        expect(row.emiAmount).toBe(row.principalComponent);
      }
      expect(r.totalPayable).toBe(120000);
    });

    it('a single installment repays everything at once', () => {
      const r = generateSchedule(base({ installments: 1 }));
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].principalComponent).toBe(120000);
      expect(r.rows[0].closingBalance).toBe(0);
    });

    it('rejects zero, negative, NaN and Infinite principals and bad installment counts', () => {
      for (const principal of [0, -1, NaN, Infinity]) {
        expect(() => generateSchedule(base({ principal }))).toThrow(
          LoanAmortizationError,
        );
      }
      for (const installments of [0, -3, 2.5]) {
        expect(() => generateSchedule(base({ installments }))).toThrow(
          LoanAmortizationError,
        );
      }
      expect(() =>
        generateSchedule(base({ employerSubsidyPercent: 150 })),
      ).toThrow(LoanAmortizationError);
    });

    it('handles a very large principal without precision loss', () => {
      const r = generateSchedule(base({ principal: 1e10 }));
      expect(sum(r.rows.map((x) => x.principalComponent))).toBe(1e10);
    });

    it('addPeriods refuses a fractional period count', () => {
      expect(() => addPeriods(D('2026-01-01'), 'MONTHLY', 1.5)).toThrow(
        LoanAmortizationError,
      );
    });
  });

  // ── payment application and multi-loan allocation ─────────────────────────
  describe('payment application', () => {
    const due = { fee: 100, interest: 400, principal: 1000 };

    it('applies fee, then interest, then principal — never principal first', () => {
      expect(splitPayment(300, due)).toEqual({
        fee: 100,
        interest: 200,
        principal: 0,
      });
    });

    it('clamps an overpayment to what is due; the surplus is the caller problem', () => {
      expect(splitPayment(5000, due)).toEqual({
        fee: 100,
        interest: 400,
        principal: 1000,
      });
    });
  });

  describe('§5/§6 multi-loan allocation against a limited net', () => {
    const candidate = (id: string, priority: number, principal: number) => ({
      scheduleId: `sch-${id}`,
      requestId: `req-${id}`,
      priority,
      due: { fee: 0, interest: 0, principal },
    });

    it('funds the lower priority value first and gives the remainder to the next', () => {
      const r = allocateRecovery(
        [candidate('a', 1, 5000), candidate('b', 2, 5000)],
        7000,
        { partialPolicy: 'PARTIAL' },
      );
      expect(r.rows.map((x) => [x.requestId, x.amount])).toEqual([
        ['req-a', 5000],
        ['req-b', 2000],
      ]);
      expect(r.totalDeducted).toBe(7000);
      expect(r.rows[1].shortfallAmount).toBe(3000);
    });

    it('a zero pool (LWP / zero-salary month) writes no allocation at all', () => {
      const r = allocateRecovery([candidate('a', 1, 5000)], 0, {
        partialPolicy: 'PARTIAL',
      });
      expect(r.rows).toHaveLength(0);
      expect(r.totalDeducted).toBe(0);
    });

    it('ALL_OR_NOTHING skips an underfunded row but still funds a smaller later one', () => {
      const r = allocateRecovery(
        [candidate('big', 1, 5000), candidate('small', 2, 1500)],
        2000,
        { partialPolicy: 'ALL_OR_NOTHING' },
      );
      expect(r.rows.map((x) => x.requestId)).toEqual(['req-small']);
      expect(r.totalDeducted).toBe(1500);
    });

    it('never allocates more than the pool', () => {
      const r = allocateRecovery(
        [candidate('a', 1, 5000), candidate('b', 1, 5000), candidate('c', 1, 5000)],
        6000,
        { partialPolicy: 'PARTIAL' },
      );
      expect(r.totalDeducted).toBe(6000);
    });
  });

  describe('§23 affordability gates', () => {
    it('rejects an EMI above the configured share of net', () => {
      expect(
        validateAffordability({
          emi: 30000,
          otherActiveEmis: 0,
          monthlyNet: 50000,
          maxEmiPercentOfNet: 50,
        }),
      ).toMatchObject({ ok: false, code: 'EMI_EXCEEDS_CAP' });
    });

    it('rejects when the combined EMIs of several loans exceed net', () => {
      expect(
        validateAffordability({
          emi: 20000,
          otherActiveEmis: 25000,
          monthlyNet: 40000,
        }),
      ).toMatchObject({ ok: false, code: 'TOTAL_EMI_EXCEEDS_NET' });
    });

    it('rejects when take-home would fall below the statutory floor', () => {
      expect(
        validateAffordability({
          emi: 20000,
          otherActiveEmis: 0,
          monthlyNet: 30000,
          minNetAfterEmi: 15000,
        }),
      ).toMatchObject({ ok: false, code: 'NET_BELOW_FLOOR' });
    });

    it('passes an affordable instalment', () => {
      expect(
        validateAffordability({
          emi: 5000,
          otherActiveEmis: 2000,
          monthlyNet: 50000,
          minEmi: 500,
          maxEmiPercentOfNet: 50,
          minNetAfterEmi: 15000,
        }),
      ).toEqual({ ok: true });
    });
  });
});
