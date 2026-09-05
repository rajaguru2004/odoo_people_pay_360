import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import type { PayslipLine } from '@/types/payslip';
import PayslipLines, { linesOfType } from './PayslipLines';

/**
 * A payslip is a legal record of what was paid.
 *
 * Two things follow from that, and both are asserted here. The sign in front of
 * an amount says which total the line belongs to — `+` for an earning, `−` for
 * a deduction, and NOTHING for an employer contribution, which belongs to none
 * of them. And the label is the one the payslip was issued with: a column on
 * the line, never a lookup through `componentId`, so renaming or retiring a
 * catalogue row cannot change what a payslip already handed to somebody says.
 */
const line = (overrides: Partial<PayslipLine> = {}): PayslipLine => ({
  id: 'l-1',
  code: 'BASIC',
  label: 'Basic salary',
  type: 'EARNING',
  amount: '1250.500',
  sequence: 1,
  componentId: 'cmp-basic',
  ...overrides,
});

/**
 * `Intl` separates the currency code from the number with a NON-BREAKING space,
 * so raw `textContent` never equals a string typed with an ordinary one. Every
 * comparison below goes through the same normaliser Testing Library uses.
 */
const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

const amountOf = (code: string) =>
  norm(
    screen
      .getByTestId(`payslip-row-${code}`)
      .querySelector(':scope > span:last-child')?.textContent,
  );

describe('PayslipLines', () => {
  it('puts a plus in front of an earning', () => {
    renderWithProviders(
      <PayslipLines lines={[line()]} tone="success" currency="OMR" sign="plus" />,
    );
    expect(amountOf('BASIC')).toBe('+ OMR 1,250.500');
  });

  it('puts a minus in front of a deduction', () => {
    // A real minus sign (U+2212), which is what the component prints — a
    // hyphen here would pass a sloppier assertion.
    renderWithProviders(
      <PayslipLines
        lines={[line({ id: 'l-2', code: 'SOCIAL_EE', label: 'Social security', type: 'DEDUCTION', amount: '87.535' })]}
        tone="error"
        currency="OMR"
        sign="minus"
      />,
    );
    expect(amountOf('SOCIAL_EE')).toBe('− OMR 87.535');
  });

  it('puts NEITHER sign on an employer contribution', () => {
    // It is in no total: not added to what the employee was paid, not taken
    // off it. A sign would put it in one.
    renderWithProviders(
      <PayslipLines
        lines={[
          line({
            id: 'l-3',
            code: 'SOCIAL_ER',
            label: 'Social security — employer',
            type: 'EMPLOYER_CONTRIBUTION',
            amount: '131.250',
          }),
        ]}
        tone="brand"
        currency="OMR"
        sign="none"
      />,
    );
    const amount = amountOf('SOCIAL_ER');
    expect(amount).toBe('OMR 131.250');
    expect(amount).not.toContain('+');
    expect(amount).not.toContain('−');
  });

  it('defaults to no sign rather than guessing one from the line type', () => {
    // The caller owns the sign; the renderer knows nothing about the rule.
    renderWithProviders(<PayslipLines lines={[line()]} tone="success" currency="OMR" />);
    expect(amountOf('BASIC')).toBe('OMR 1,250.500');
  });

  it('prints the label the line carries, not the component behind it', () => {
    renderWithProviders(
      <PayslipLines
        lines={[
          line({
            code: 'HRA',
            // Frozen at issue: the catalogue row has since been renamed to
            // "Accommodation allowance", and this payslip must not follow it.
            label: 'House rent allowance',
            componentId: 'cmp-renamed-since',
          }),
        ]}
        tone="success"
        currency="OMR"
        sign="plus"
      />,
    );
    expect(screen.getByText('House rent allowance')).toBeInTheDocument();
    // The code beside it is what a report joins on, and it is the line's own.
    expect(screen.getByTestId('payslip-row-HRA')).toHaveAttribute('data-code', 'HRA');
    expect(screen.getByTestId('payslip-row-HRA').textContent).not.toContain('cmp-renamed-since');
  });

  it('still renders a line whose catalogue row is gone', () => {
    // `componentId: null` is the ordinary case for an old payslip. Nothing is
    // resolved through it, so the row reads exactly the same.
    renderWithProviders(
      <PayslipLines
        lines={[line({ code: 'LOP', label: 'Loss of pay', type: 'DEDUCTION', componentId: null })]}
        tone="error"
        currency="OMR"
        sign="minus"
      />,
    );
    expect(screen.getByText('Loss of pay')).toBeInTheDocument();
    expect(amountOf('LOP')).toBe('− OMR 1,250.500');
  });

  it('takes its decimal places from the run currency', () => {
    // OMR/KWD/BHD are thousandths. Two decimals here rounds 1,250.500 to
    // 1,250.50 and the payslip stops reconciling against the bank.
    const omr = renderWithProviders(
      <PayslipLines lines={[line()]} tone="success" currency="OMR" sign="plus" />,
    );
    expect(amountOf('BASIC')).toBe('+ OMR 1,250.500');
    omr.unmount();

    renderWithProviders(
      <PayslipLines lines={[line()]} tone="success" currency="AED" sign="plus" />,
    );
    expect(amountOf('BASIC')).toBe('+ AED 1,250.50');
  });

  it('says a section is empty only when it was given something to say', () => {
    const silent = renderWithProviders(
      <PayslipLines lines={[]} tone="success" currency="OMR" sign="plus" />,
    );
    expect(silent.container).toBeEmptyDOMElement();
    silent.unmount();

    renderWithProviders(
      <PayslipLines
        lines={[]}
        tone="error"
        currency="OMR"
        sign="minus"
        emptyLabel="Nothing was deducted."
      />,
    );
    expect(screen.getByText('Nothing was deducted.')).toBeInTheDocument();
  });
});

describe('linesOfType', () => {
  it('keeps only its own type, in the order the payslip prints them', () => {
    const lines = [
      line({ id: 'a', code: 'HRA', type: 'EARNING', sequence: 4 }),
      line({ id: 'b', code: 'SOCIAL_EE', type: 'DEDUCTION', sequence: 1 }),
      line({ id: 'c', code: 'BASIC', type: 'EARNING', sequence: 2 }),
      line({ id: 'd', code: 'SOCIAL_ER', type: 'EMPLOYER_CONTRIBUTION', sequence: 3 }),
    ];

    expect(linesOfType(lines, 'EARNING').map((l) => l.code)).toEqual(['BASIC', 'HRA']);
    expect(linesOfType(lines, 'DEDUCTION').map((l) => l.code)).toEqual(['SOCIAL_EE']);
    expect(linesOfType(lines, 'EMPLOYER_CONTRIBUTION').map((l) => l.code)).toEqual(['SOCIAL_ER']);
    expect(linesOfType(undefined, 'EARNING')).toEqual([]);
  });
});
