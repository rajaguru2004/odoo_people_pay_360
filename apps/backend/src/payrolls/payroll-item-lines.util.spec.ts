import {
  BUCKET_CATEGORY,
  LINE_BUCKETS,
  absorbResidual,
  buildItemLines,
  describeMismatch,
  humanise,
  reconcileLines,
  type ComponentInput,
  type LineSpec,
} from './payroll-item-lines.util';

const comp = (over: Partial<ComponentInput> = {}): ComponentInput => ({
  code: 'BASIC',
  amount: 1000,
  bucket: 'baseSalary',
  ...over,
});

const line = (over: Partial<LineSpec> = {}): LineSpec => ({
  code: 'X',
  label: 'X',
  category: 'EARNING',
  bucket: 'allowances',
  amount: 100,
  sourceType: 'SALARY_COMPONENT',
  sourceId: null,
  displayOrder: 0,
  ...over,
});

describe('payslip item lines', () => {
  describe('the bucket-to-side mapping is fixed', () => {
    it('puts every deduction column on the deduction side', () => {
      // If a caller could declare PF an EARNING, it could invert a payslip.
      for (const b of [
        'deduction',
        'otherRecovery',
        'insurance',
        'tax',
      ] as const) {
        expect(BUCKET_CATEGORY[b]).toBe('DEDUCTION');
      }
    });

    it('names every bucket exactly once', () => {
      expect(new Set(LINE_BUCKETS).size).toBe(LINE_BUCKETS.length);
    });
  });

  describe('building lines from components', () => {
    it('emits one line per component, in input order', () => {
      const lines = buildItemLines({
        components: [
          comp({ code: 'BASIC', amount: 800 }),
          comp({ code: 'HOUSING', amount: 200, bucket: 'allowances' }),
          comp({ code: 'TRANSPORT', amount: 80, bucket: 'allowances' }),
        ],
        figures: {},
        totals: { baseSalary: 800, allowances: 280 },
      });
      expect(lines.map((l) => l.code)).toEqual([
        'BASIC',
        'HOUSING',
        'TRANSPORT',
      ]);
      expect(lines.map((l) => l.displayOrder)).toEqual([0, 1, 2]);
    });

    it('is the answer to "what is my 280 allowance made of"', () => {
      const lines = buildItemLines({
        components: [
          comp({ code: 'HOUSING', amount: 200, bucket: 'allowances' }),
          comp({ code: 'TRANSPORT', amount: 80, bucket: 'allowances' }),
        ],
        figures: {},
        totals: { allowances: 280 },
      });
      expect(lines.map((l) => [l.label, l.amount])).toEqual([
        ['Housing', 200],
        ['Transport', 80],
      ]);
    });

    it('drops a zero component rather than printing "Transport 0.00"', () => {
      const lines = buildItemLines({
        components: [
          comp({ code: 'HOUSING', amount: 200, bucket: 'allowances' }),
          comp({ code: 'TRANSPORT', amount: 0, bucket: 'allowances' }),
        ],
        figures: {},
        totals: { allowances: 200 },
      });
      expect(lines.map((l) => l.code)).toEqual(['HOUSING']);
    });

    it('never emits a negative amount — the sign lives in the category', () => {
      const lines = buildItemLines({
        components: [comp({ amount: 1000 })],
        figures: {
          tax: [
            {
              code: 'INCOME_TAX',
              label: 'Income tax',
              amount: 120,
              sourceType: 'STATUTORY',
            },
          ],
        },
        totals: { baseSalary: 1000, tax: 120 },
      });
      expect(lines.every((l) => l.amount >= 0)).toBe(true);
      expect(lines.find((l) => l.code === 'INCOME_TAX')!.category).toBe(
        'DEDUCTION',
      );
    });
  });

  describe('the statutory columns finally split', () => {
    it('shows PF and ESI separately though both live in `insurance`', () => {
      // The engine sums them at calculateSalaryOptimized; the column cannot say
      // which is which, and today the split exists only in a free-text note.
      const lines = buildItemLines({
        components: [comp({ amount: 1000 })],
        figures: {
          insurance: [
            { code: 'PF', label: 'Provident Fund', amount: 120, sourceType: 'STATUTORY' },
            { code: 'ESI', label: 'ESI', amount: 7.5, sourceType: 'STATUTORY' },
          ],
        },
        totals: { baseSalary: 1000, insurance: 127.5 },
      });
      const ins = lines.filter((l) => l.bucket === 'insurance');
      expect(ins.map((l) => [l.code, l.amount])).toEqual([
        ['PF', 120],
        ['ESI', 7.5],
      ]);
    });

    it('shows income tax and professional tax separately', () => {
      const lines = buildItemLines({
        components: [comp({ amount: 1000 })],
        figures: {
          tax: [
            { code: 'INCOME_TAX', label: 'Income tax', amount: 90, sourceType: 'STATUTORY' },
            { code: 'PROFESSIONAL_TAX', label: 'Professional tax', amount: 200, sourceType: 'STATUTORY' },
          ],
        },
        totals: { baseSalary: 1000, tax: 290 },
      });
      expect(lines.filter((l) => l.bucket === 'tax')).toHaveLength(2);
    });

    it('surfaces loss of pay, which today is folded into earned salary', () => {
      // An employee who lost three days sees a smaller basic and no line
      // explaining it. This is that line.
      const lines = buildItemLines({
        components: [comp({ amount: 900 })],
        figures: {
          deduction: [
            { code: 'LOP', label: 'Loss of pay (3 days)', amount: 100, sourceType: 'LOP' },
          ],
        },
        totals: { baseSalary: 900, deduction: 100 },
      });
      expect(lines.find((l) => l.code === 'LOP')).toMatchObject({
        category: 'DEDUCTION',
        bucket: 'deduction',
        amount: 100,
      });
    });
  });

  describe('rounding: Σ round(xᵢ) ≠ round(Σ xᵢ)', () => {
    it('absorbs a one-cent shortfall into the largest line', () => {
      // Three components prorated by 1/3 each round down; the column does not.
      const lines = absorbResidual(
        [
          line({ code: 'A', amount: 33.33 }),
          line({ code: 'B', amount: 33.33 }),
          line({ code: 'C', amount: 33.33 }),
        ],
        100,
      );
      expect(lines.map((l) => l.amount)).toEqual([33.34, 33.33, 33.33]);
      expect(lines.reduce((a, l) => a + l.amount, 0)).toBeCloseTo(100, 10);
    });

    it('picks the largest line, not the first', () => {
      const lines = absorbResidual(
        [line({ code: 'SMALL', amount: 50 }), line({ code: 'BIG', amount: 500 })],
        550.01,
      );
      expect(lines.find((l) => l.code === 'BIG')!.amount).toBe(500.01);
      expect(lines.find((l) => l.code === 'SMALL')!.amount).toBe(50);
    });

    it('leaves an exact bucket completely alone', () => {
      const original = [line({ amount: 200 }), line({ amount: 80 })];
      expect(absorbResidual(original, 280)).toEqual(original);
    });

    it('refuses a gap too large to be rounding', () => {
      // Two lines can be at most 0.02 out through rounding. 5.00 is a bug, and
      // quietly moving it onto a line would hide a calculation mismatch behind
      // a payslip that adds up.
      expect(() =>
        absorbResidual([line({ amount: 100 }), line({ amount: 100 })], 205),
      ).toThrow(/calculation mismatch, not rounding/);
    });

    it('leaves a bucket alone rather than driving a line negative', () => {
      // Two one-cent lines against a zero column: the residual is -0.02, which
      // is within tolerance for two lines, but applying it would make a line
      // -0.01. A negative line would invert its own category, so the bucket is
      // left to fail reconciliation loudly instead.
      const original = [line({ amount: 0.01 }), line({ amount: 0.01 })];
      expect(absorbResidual(original, 0)).toEqual(original);
    });

    it('handles an empty bucket without inventing a line', () => {
      expect(absorbResidual([], 100)).toEqual([]);
    });
  });

  describe('reconciliation is the invariant, per bucket', () => {
    it('passes when every bucket adds up', () => {
      const r = reconcileLines(
        { baseSalary: 800, allowances: 280, tax: 90 },
        [
          line({ bucket: 'baseSalary', amount: 800 }),
          line({ bucket: 'allowances', amount: 200 }),
          line({ bucket: 'allowances', amount: 80 }),
          line({ bucket: 'tax', amount: 90 }),
        ],
      );
      expect(r.ok).toBe(true);
      expect(r.mismatches).toEqual([]);
    });

    it('catches a bucket whose lines are short', () => {
      const r = reconcileLines({ allowances: 280 }, [
        line({ bucket: 'allowances', amount: 200 }),
      ]);
      expect(r.ok).toBe(false);
      expect(r.mismatches).toHaveLength(1);
      expect(r.mismatches[0]).toMatchObject({
        bucket: 'allowances',
        lines: 200,
        column: 280,
        delta: 80,
      });
    });

    it('does NOT let one bucket cover for another', () => {
      // The reason `bucket` exists. Category-level reconciliation would pass
      // here: total deductions are 300 either way, but the payslip would be
      // claiming 300 of tax the employee never paid.
      const r = reconcileLines({ insurance: 300, tax: 0 }, [
        line({ bucket: 'tax', amount: 300, category: 'DEDUCTION' }),
      ]);
      expect(r.ok).toBe(false);
      expect(r.mismatches.map((m) => m.bucket).sort()).toEqual([
        'insurance',
        'tax',
      ]);
    });

    it('ignores a bucket that has neither a column nor lines', () => {
      const r = reconcileLines({ baseSalary: 100 }, [
        line({ bucket: 'baseSalary', amount: 100 }),
      ]);
      expect(r.deltas.map((d) => d.bucket)).toEqual(['baseSalary']);
    });

    it('treats no lines at all as reconciling, so the feature can be off', () => {
      // With itemisation disabled nothing is written, and that must not read as
      // a failed invariant on every payslip in the system.
      expect(reconcileLines({}, []).ok).toBe(true);
    });

    it('accepts a half-cent, which is float noise, not a discrepancy', () => {
      expect(
        reconcileLines({ allowances: 100 }, [
          line({ bucket: 'allowances', amount: 100.004 }),
        ]).ok,
      ).toBe(true);
    });

    it('names the bucket and both figures when it fails', () => {
      const r = reconcileLines({ tax: 90 }, [line({ bucket: 'tax', amount: 70 })]);
      expect(describeMismatch(r)).toBe(
        'tax: lines total 70 but the payslip says 90 (off by 20)',
      );
    });
  });

  describe('built lines reconcile to the totals they were built from', () => {
    it('holds for a realistic payslip', () => {
      const totals = {
        baseSalary: 1000,
        allowances: 280,
        bonus: 50,
        overtimePay: 75.5,
        deduction: 100,
        insurance: 127.5,
        tax: 290,
      };
      const lines = buildItemLines({
        components: [
          comp({ code: 'BASIC', amount: 1000 }),
          comp({ code: 'HOUSING', amount: 200, bucket: 'allowances' }),
          comp({ code: 'TRANSPORT', amount: 80, bucket: 'allowances' }),
        ],
        figures: {
          bonus: [{ code: 'REWARD', label: 'Reward', amount: 50, sourceType: 'REWARD' }],
          overtimePay: [{ code: 'OVERTIME', label: 'Overtime', amount: 75.5, sourceType: 'OVERTIME' }],
          deduction: [{ code: 'LOP', label: 'Loss of pay', amount: 100, sourceType: 'LOP' }],
          insurance: [
            { code: 'PF', label: 'Provident Fund', amount: 120, sourceType: 'STATUTORY' },
            { code: 'ESI', label: 'ESI', amount: 7.5, sourceType: 'STATUTORY' },
          ],
          tax: [
            { code: 'INCOME_TAX', label: 'Income tax', amount: 90, sourceType: 'STATUTORY' },
            { code: 'PROFESSIONAL_TAX', label: 'Professional tax', amount: 200, sourceType: 'STATUTORY' },
          ],
        },
        totals,
      });
      expect(reconcileLines(totals, lines).ok).toBe(true);
    });

    it('holds when proration makes every component fractional', () => {
      // 22 nominal days, 19 worked: each component scales by 19/22 and rounds.
      const scale = 19 / 22;
      const raw = [1000, 200, 80, 55];
      const totalAllow = Math.round((raw[1] + raw[2] + raw[3]) * scale * 100) / 100;
      const totals = {
        baseSalary: Math.round(raw[0] * scale * 100) / 100,
        allowances: totalAllow,
      };
      const lines = buildItemLines({
        components: [
          comp({ code: 'BASIC', amount: raw[0] * scale }),
          comp({ code: 'HOUSING', amount: raw[1] * scale, bucket: 'allowances' }),
          comp({ code: 'TRANSPORT', amount: raw[2] * scale, bucket: 'allowances' }),
          comp({ code: 'PHONE', amount: raw[3] * scale, bucket: 'allowances' }),
        ],
        figures: {},
        totals,
      });
      expect(reconcileLines(totals, lines).ok).toBe(true);
    });
  });

  describe('humanise', () => {
    it('turns a slug into something an employee can read', () => {
      expect(humanise('HOUSING_ALLOWANCE')).toBe('Housing Allowance');
      expect(humanise('BASIC')).toBe('Basic');
    });
  });
});
