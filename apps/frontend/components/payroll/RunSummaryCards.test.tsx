import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import { formatCurrency } from '@/utils/formatters';
import { runTotals } from '@/utils/payrollTotals';
import type { Payslip } from '@/types/payslip';
import RunSummaryCards from './RunSummaryCards';

/**
 * The one claim these cards exist to make: employer contributions are recorded
 * and never paid.
 *
 * Folded into gross they would inflate what people were paid by the company's
 * own cost; folded into deductions they would take money off a payslip nobody
 * took money off. The card row is where somebody checks a run before approving
 * it, so a contribution appearing inside any of the other four figures is a
 * wrong number in front of the person signing it off.
 *
 * The cards read `runTotals` — the SAME helper the payslip table under them
 * reads — so every assertion here compares the rendered figure against that
 * helper's answer for the same payslips as well as against the literal string.
 * A card that added up the response itself would pass the literal and fail the
 * comparison.
 */
const slip = (overrides: Partial<Payslip> = {}): Payslip => ({
  id: 'ps-1',
  payrollRunId: 'run-1',
  employeeId: 'emp-1',
  payslipNumber: 'PS-0001',
  workDays: 22,
  paidDays: 22,
  lopDays: 0,
  grossPay: '1000.000',
  totalDeductions: '70.000',
  netPay: '930.000',
  totalEmployerCost: '105.000',
  ...overrides,
});

/** Three payslips, each with an employer contribution on top of its own net. */
const payslips: Payslip[] = [
  slip({ id: 'ps-1', grossPay: '1000.000', totalDeductions: '70.000', netPay: '930.000', totalEmployerCost: '105.000' }),
  slip({ id: 'ps-2', employeeId: 'emp-2', grossPay: '1250.500', totalDeductions: '87.500', netPay: '1163.000', totalEmployerCost: '131.250' }),
  slip({ id: 'ps-3', employeeId: 'emp-3', grossPay: '749.500', totalDeductions: '52.500', netPay: '697.000', totalEmployerCost: '78.750' }),
];

/**
 * `Intl` separates the currency code from the number with a NON-BREAKING space,
 * so raw `textContent` never equals a string typed with an ordinary one.
 */
const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

const cardText = (key: string) => norm(screen.getByTestId(`payroll-run-card-${key}`).textContent);

describe('RunSummaryCards', () => {
  it('keeps employer contributions on their own card and out of net', () => {
    const totals = runTotals(payslips);
    renderWithProviders(<RunSummaryCards totals={totals} currency="OMR" />);

    // gross 3,000.000 · deductions 210.000 · net 2,790.000 · employer 315.000
    expect(cardText('gross')).toContain('OMR 3,000.000');
    expect(cardText('deductions')).toContain('OMR 210.000');
    expect(cardText('employerCost')).toContain('OMR 315.000');
    expect(cardText('net')).toContain('OMR 2,790.000');

    // The identity that says the contribution was not folded in anywhere:
    // net is gross minus deductions, with the 315.000 nowhere in it.
    expect(totals.net).toBe(totals.gross - totals.deductions);
    expect(totals.employerCost).toBeGreaterThan(0);

    // And the wrong answers, named so a regression cannot pass by coincidence:
    // gross+employer = 3,315.000, net−employer = 2,475.000.
    expect(cardText('gross')).not.toContain('3,315');
    expect(cardText('net')).not.toContain('2,475');
    expect(cardText('deductions')).not.toContain('525');
  });

  it('prints exactly what the shared helper answers for the same payslips', () => {
    // The cards and the table beneath them read one function. A card summing
    // the response while a row totals its own lines is how a page ends up
    // showing two different nets for one run.
    const totals = runTotals(payslips);
    renderWithProviders(<RunSummaryCards totals={totals} currency="OMR" />);

    const formatted = (value: number) => norm(formatCurrency(value, 'OMR'));

    expect(cardText('gross')).toContain(formatted(totals.gross));
    expect(cardText('deductions')).toContain(formatted(totals.deductions));
    expect(cardText('employerCost')).toContain(formatted(totals.employerCost));
    expect(cardText('net')).toContain(formatted(totals.net));
    expect(cardText('employees')).toContain(String(totals.employeeCount));
    expect(totals.employeeCount).toBe(3);
  });

  it('takes its decimal places from the run currency', () => {
    // OMR is thousandths. A card hardcoding two decimals rounds 1,250.500 to
    // 1,250.50 and the run stops reconciling against the bank.
    const omr = renderWithProviders(
      <RunSummaryCards totals={runTotals([payslips[1]])} currency="OMR" />,
    );
    expect(cardText('gross')).toContain('OMR 1,250.500');
    omr.unmount();

    renderWithProviders(<RunSummaryCards totals={runTotals([payslips[1]])} currency="AED" />);
    expect(cardText('gross')).toContain('AED 1,250.50');
  });

  it('says so when the run records a different net from its own payslips', () => {
    // Two numbers from two places — one stamped at calculation, one added up
    // here — and nothing else in the product compares them.
    renderWithProviders(
      <RunSummaryCards
        totals={runTotals(payslips)}
        currency="OMR"
        storedGross="3000.000"
        storedNet="2700.000"
      />,
    );
    expect(norm(screen.getByTestId('payroll-run-drift').textContent)).toContain('OMR 2,700.000');
    expect(norm(screen.getByTestId('payroll-run-drift').textContent)).toContain('OMR 90.000');
  });

  it('names GROSS when it is the gross that drifted, not the net', () => {
    // The banner used to quote the stored NET whichever total disagreed. With
    // the net correct, it printed the figure already on the card beside a
    // difference that appeared to come from nowhere.
    renderWithProviders(
      <RunSummaryCards
        totals={runTotals(payslips)}
        currency="OMR"
        storedGross="2900.000"
        storedNet="2790.000"
      />,
    );
    const banner = norm(screen.getByTestId('payroll-run-drift').textContent);
    expect(banner).toContain('gross');
    expect(banner).toContain('OMR 2,900.000');
    expect(banner).toContain('OMR 100.000');
    expect(banner).not.toContain('OMR 2,790.000');
  });

  it('never reports a drift against a total the run does not carry', () => {
    // With no stored net at all, the old banner printed "records OMR 0.000".
    renderWithProviders(
      <RunSummaryCards totals={runTotals(payslips)} currency="OMR" storedGross="2900.000" />,
    );
    const banner = norm(screen.getByTestId('payroll-run-drift').textContent);
    expect(banner).toContain('OMR 2,900.000');
    expect(banner).not.toContain('OMR 0.000');
  });

  it('stays quiet when the stored totals agree with the payslips', () => {
    renderWithProviders(
      <RunSummaryCards
        totals={runTotals(payslips)}
        currency="OMR"
        storedGross="3000.000"
        storedNet="2790.000"
      />,
    );
    expect(screen.queryByTestId('payroll-run-drift')).not.toBeInTheDocument();
  });

  it('flags an uncalculated run rather than reporting a zero payroll', () => {
    renderWithProviders(<RunSummaryCards totals={runTotals([])} currency="OMR" />);
    expect(cardText('employees')).toContain('Nothing has been calculated yet.');
  });

  it('drills into the payslips the cards are a total of', () => {
    const { container } = renderWithProviders(
      <RunSummaryCards totals={runTotals(payslips)} currency="OMR" runId="run-1" />,
    );
    expect(
      container.querySelector('a[href="/dashboard/payroll/payslips?runId=run-1"]'),
    ).toBeTruthy();
  });
});
