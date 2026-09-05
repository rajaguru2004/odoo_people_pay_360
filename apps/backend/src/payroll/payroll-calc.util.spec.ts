import {
  calculatePayslip,
  isPayable,
  LOP_CODE,
  roundMoney,
  type StructureLineInput,
} from './payroll-calc.util';

const line = (
  code: string,
  type: StructureLineInput['type'],
  amount: number,
  sequence = 100,
): StructureLineInput => ({
  code,
  label: code,
  type,
  amount,
  sequence,
  componentId: `component-${code.toLowerCase()}`,
});

/** 1000 gross, 70 contracted deduction, 105 employer contribution. */
const structure = (): StructureLineInput[] => [
  line('BASIC', 'EARNING', 600, 10),
  line('HRA', 'EARNING', 250, 20),
  line('TRANSPORT', 'EARNING', 100, 30),
  line('OTHER_ALLOW', 'EARNING', 50, 40),
  line('SOCIAL_SEC_EE', 'DEDUCTION', 70, 200),
  line('SOCIAL_SEC_ER', 'EMPLOYER_CONTRIBUTION', 105, 300),
];

describe('calculatePayslip — a full month', () => {
  const result = calculatePayslip({
    lines: structure(),
    workDays: 22,
    paidDays: 22,
  });

  it('sums every earning into gross', () => {
    expect(result.grossPay).toBe(1000);
  });

  it('adds no loss-of-pay line when nothing was lost', () => {
    expect(result.lines.find((l) => l.code === LOP_CODE)).toBeUndefined();
    expect(result.lopDays).toBe(0);
  });

  it('takes only the contracted deduction', () => {
    expect(result.totalDeductions).toBe(70);
    expect(result.netPay).toBe(930);
  });

  it('records the employer contribution outside gross, deductions and net', () => {
    expect(result.totalEmployerCost).toBe(105);
    expect(result.grossPay).toBe(1000);
    expect(result.totalDeductions).toBe(70);
    expect(result.netPay).toBe(930);
  });

  it('keeps the employer line on the payslip', () => {
    const employer = result.lines.find((l) => l.code === 'SOCIAL_SEC_ER');
    expect(employer).toMatchObject({
      type: 'EMPLOYER_CONTRIBUTION',
      amount: 105,
    });
  });
});

describe('calculatePayslip — loss of pay', () => {
  it('prorates the WHOLE earning set, allowances included', () => {
    // Two absent days out of 22: 1000 × 2 / 22, not 600 × 2 / 22.
    const result = calculatePayslip({
      lines: structure(),
      workDays: 22,
      paidDays: 20,
    });
    const lop = result.lines.find((l) => l.code === LOP_CODE);
    expect(lop?.amount).toBe(roundMoney((1000 * 2) / 22));
    expect(lop?.type).toBe('DEDUCTION');
    expect(lop?.componentId).toBeNull();
  });

  it('adds the loss of pay to the contracted deductions', () => {
    const result = calculatePayslip({
      lines: structure(),
      workDays: 20,
      paidDays: 10,
    });
    expect(result.lopDays).toBe(10);
    expect(result.totalDeductions).toBe(roundMoney(70 + 500));
    expect(result.netPay).toBe(roundMoney(1000 - 570));
  });

  it('yields no loss of pay when the branch had no working days', () => {
    // The division-by-zero case. A month the branch never opens is not a month
    // everybody was absent.
    const result = calculatePayslip({
      lines: structure(),
      workDays: 0,
      paidDays: 0,
    });
    expect(result.lines.find((l) => l.code === LOP_CODE)).toBeUndefined();
    expect(result.lopDays).toBe(0);
    expect(result.netPay).toBe(930);
  });

  it('caps the loss of pay at gross and floors net at zero', () => {
    const result = calculatePayslip({
      lines: [line('BASIC', 'EARNING', 100), line('FINE', 'DEDUCTION', 400)],
      workDays: 20,
      paidDays: 0,
    });
    expect(result.lines.find((l) => l.code === LOP_CODE)?.amount).toBe(100);
    expect(result.netPay).toBe(0);
    expect(result.netPay).toBeGreaterThanOrEqual(0);
  });

  it('never treats more paid days than working days as negative loss', () => {
    const result = calculatePayslip({
      lines: structure(),
      workDays: 20,
      paidDays: 26,
    });
    expect(result.paidDays).toBe(20);
    expect(result.lopDays).toBe(0);
  });
});

describe('calculatePayslip — the sums the payslip prints', () => {
  it('rounds every figure to three decimals', () => {
    const result = calculatePayslip({
      lines: [
        line('BASIC', 'EARNING', 333.3333),
        line('HRA', 'EARNING', 333.3333),
        line('TRANSPORT', 'EARNING', 333.3333),
      ],
      workDays: 22,
      paidDays: 21,
    });
    for (const l of result.lines) {
      expect(l.amount).toBe(roundMoney(l.amount));
    }
    expect(result.grossPay).toBe(roundMoney(result.grossPay));
  });

  it('makes the lines add up to the totals exactly', () => {
    const result = calculatePayslip({
      lines: [
        line('BASIC', 'EARNING', 1000 / 3),
        line('HRA', 'EARNING', 1000 / 3),
        line('TRANSPORT', 'EARNING', 1000 / 3),
        line('PF', 'DEDUCTION', 100 / 3, 200),
        line('PF_ER', 'EMPLOYER_CONTRIBUTION', 100 / 3, 300),
      ],
      workDays: 22,
      paidDays: 19,
    });
    const sum = (type: string) =>
      roundMoney(
        result.lines
          .filter((l) => l.type === type)
          .reduce((a, l) => a + l.amount, 0),
      );
    expect(sum('EARNING')).toBe(result.grossPay);
    expect(sum('DEDUCTION')).toBe(result.totalDeductions);
    expect(sum('EMPLOYER_CONTRIBUTION')).toBe(result.totalEmployerCost);
    expect(result.netPay).toBe(
      roundMoney(result.grossPay - result.totalDeductions),
    );
  });

  it('orders lines by sequence, then by code, identically on every run', () => {
    const input = {
      lines: [
        line('ZED', 'EARNING', 10, 10),
        line('ALPHA', 'EARNING', 10, 10),
        line('MID', 'EARNING', 10, 5),
      ],
      workDays: 20,
      paidDays: 20,
    };
    const first = calculatePayslip(input);
    const second = calculatePayslip(input);
    expect(first.lines.map((l) => l.code)).toEqual(['MID', 'ALPHA', 'ZED']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('normalises the line code to upper case', () => {
    const result = calculatePayslip({
      lines: [line('basic', 'EARNING', 100)],
      workDays: 20,
      paidDays: 20,
    });
    expect(result.lines[0].code).toBe('BASIC');
  });
});

describe('isPayable', () => {
  it('refuses an employee with no structure', () => {
    expect(isPayable(null)).toBe(false);
    expect(isPayable([])).toBe(false);
  });

  it('refuses a structure whose only lines take money away', () => {
    // Never a zero payslip: "paid nothing" and "nobody said what to pay them"
    // are different claims.
    expect(isPayable([line('FINE', 'DEDUCTION', 50)])).toBe(false);
    expect(isPayable([line('BASIC', 'EARNING', 0)])).toBe(false);
  });

  it('accepts a structure with a paying earning line', () => {
    expect(isPayable([line('BASIC', 'EARNING', 1)])).toBe(true);
  });
});
