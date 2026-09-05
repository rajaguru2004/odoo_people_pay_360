import {
  composeSettlement,
  effectiveAmount,
  totalsFor,
  type ComposeInput,
} from './settlement-composer';

const input = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  variant: 'RESIGNATION',
  pendingSalary: 1000,
  gratuity: 2700,
  leaveEncashment: 450,
  noticePay: 0,
  otherEarnings: [],
  garnishment: 0,
  recoveries: [],
  carryForward: 0,
  otherDeductions: [],
  ...over,
});

describe('settlement composer', () => {
  describe('what appears, and in what order', () => {
    it('lists earnings before deductions, each in its own fixed order', () => {
      // Fixed so two compositions of the same data produce the same document,
      // which is what lets a regenerated settlement be compared with the one it
      // replaced.
      const r = composeSettlement(
        input({ noticePay: 900, garnishment: 100, carryForward: 50 }),
      );
      expect(r.lines.map((l) => l.code)).toEqual([
        'PENDING_SALARY',
        'GRATUITY',
        'LEAVE_ENCASHMENT',
        'NOTICE_PAY',
        'GARNISHMENT',
        'CARRY_FORWARD',
      ]);
    });

    it('puts the court order ahead of the carried-forward balance, as payroll does', () => {
      const r = composeSettlement(input({ carryForward: 300, garnishment: 100 }));
      const codes = r.lines.filter((l) => l.category === 'DEDUCTION').map((l) => l.code);
      expect(codes.indexOf('GARNISHMENT')).toBeLessThan(codes.indexOf('CARRY_FORWARD'));
    });

    it('drops a zero line rather than printing "Notice pay 0.00"', () => {
      const r = composeSettlement(input({ noticePay: 0, garnishment: 0 }));
      expect(r.lines.map((l) => l.code)).not.toContain('NOTICE_PAY');
      expect(r.lines.map((l) => l.code)).not.toContain('GARNISHMENT');
    });

    it('numbers lines consecutively from zero', () => {
      const r = composeSettlement(input({ garnishment: 300 }));
      expect(r.lines.map((l) => l.displayOrder)).toEqual([0, 1, 2, 3]);
    });

    it('never emits a negative amount — the sign lives in the category', () => {
      const r = composeSettlement(input({ garnishment: 300 }));
      expect(r.lines.every((l) => l.computedAmount >= 0)).toBe(true);
      expect(r.lines.find((l) => l.code === 'GARNISHMENT')!.category).toBe('DEDUCTION');
    });

    it('carries named recoveries through with their own labels', () => {
      const r = composeSettlement(
        input({
          recoveries: [
            { code: 'ASSET_LOSS', label: 'Unreturned laptop', amount: 400, sourceId: 'a-1' },
          ],
        }),
      );
      const line = r.lines.find((l) => l.code === 'ASSET_LOSS')!;
      expect(line.label).toBe('Unreturned laptop');
      expect(line.sourceId).toBe('a-1');
      expect(line.category).toBe('DEDUCTION');
    });
  });

  describe('totals', () => {
    it('sums each side and nets them', () => {
      const r = composeSettlement(input({ carryForward: 500 }));
      expect(r.totalEarnings).toBe(4150);
      expect(r.totalDeductions).toBe(500);
      expect(r.netPayable).toBe(3650);
      expect(r.isReceivable).toBe(false);
    });

    it('goes NEGATIVE when the employee owes more than they are due', () => {
      // Deliberately unlike a payslip, which floors at zero because you do not
      // collect money through one. A leaver can genuinely owe money, and the
      // document has to be able to say so.
      const r = composeSettlement(
        input({ pendingSalary: 100, gratuity: 0, leaveEncashment: 0, carryForward: 900 }),
      );
      expect(r.netPayable).toBe(-800);
      expect(r.isReceivable).toBe(true);
      expect(r.workingLines.join(' ')).toMatch(/RECEIVABLE from the employee/);
    });

    it('reports a zero net as payable, not receivable', () => {
      const r = composeSettlement(
        input({ pendingSalary: 500, gratuity: 0, leaveEncashment: 0, carryForward: 500 }),
      );
      expect(r.netPayable).toBe(0);
      expect(r.isReceivable).toBe(false);
    });
  });

  describe('adjustments', () => {
    it('uses the computed amount when nothing was overridden', () => {
      expect(effectiveAmount({ computedAmount: 500 })).toBe(500);
      expect(effectiveAmount({ computedAmount: 500, adjustedAmount: null })).toBe(500);
      expect(effectiveAmount({ computedAmount: 500, adjustedAmount: undefined })).toBe(500);
    });

    it('treats an adjustment of ZERO as a real decision', () => {
      // "This line is not payable" is a thing HR says, and reading it as
      // "no adjustment" would quietly pay the original figure.
      expect(effectiveAmount({ computedAmount: 500, adjustedAmount: 0 })).toBe(0);
    });

    it('recomputes totals from the adjusted figures', () => {
      const t = totalsFor([
        { category: 'EARNING', computedAmount: 1000, adjustedAmount: 800 },
        { category: 'EARNING', computedAmount: 200 },
        { category: 'DEDUCTION', computedAmount: 300, adjustedAmount: 0 },
      ]);
      expect(t.totalEarnings).toBe(1000);
      expect(t.totalDeductions).toBe(0);
      expect(t.netPayable).toBe(1000);
    });

    it('can turn a payable settlement into a receivable one', () => {
      const t = totalsFor([
        { category: 'EARNING', computedAmount: 1000, adjustedAmount: 0 },
        { category: 'DEDUCTION', computedAmount: 400 },
      ]);
      expect(t.netPayable).toBe(-400);
      expect(t.isReceivable).toBe(true);
    });
  });

  describe('the working', () => {
    it('names the variant and every line', () => {
      const r = composeSettlement(input({ variant: 'RETIREMENT', carryForward: 200 }));
      expect(r.workingLines[0]).toBe('Settlement variant: RETIREMENT.');
      expect(r.workingLines.some((l) => l.startsWith('+ End-of-service gratuity: 2700'))).toBe(true);
      expect(r.workingLines.some((l) => l.startsWith('− Deductions carried from earlier payslips: 200'))).toBe(true);
    });

    it('ends with the three figures the document is judged on', () => {
      const r = composeSettlement(input());
      expect(r.workingLines[r.workingLines.length - 1]).toBe(
        'Total earnings 4150, total deductions 0, net 4150.',
      );
    });
  });
});
