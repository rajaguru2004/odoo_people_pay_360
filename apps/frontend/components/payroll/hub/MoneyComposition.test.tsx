import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import type { PayrollHubMoney } from '@/types/payrollHub';
import MoneyComposition from './MoneyComposition';

/**
 * What the period's pay was made of — and, just as importantly, when the panel
 * has nothing to say.
 *
 * "The composition could not be read" and "nothing has been approved yet" are
 * DIFFERENT claims about the period, and a panel that answered both with a row
 * of zeroes would have told the reader something false about one of them. The
 * same rule runs through the figures: an amount that is not there prints an em
 * dash, never `OMR 0.000`.
 *
 * Employer contributions are drawn beside the other three and never inside
 * them: a bar that added them to gross would claim the company had handed
 * people its own cost.
 */
const money = (overrides: Partial<PayrollHubMoney> = {}): PayrollHubMoney => ({
  currency: 'OMR',
  gross: 3000,
  deductions: 210,
  net: 2790,
  employerCost: 315,
  previousNet: 2500,
  changePct: 11.6,
  ...overrides,
});

/** `Intl` uses a non-breaking space between the code and the number. */
const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

describe('MoneyComposition', () => {
  it('draws each part of the pay against the currency it was paid in', () => {
    // OMR is thousandths. Two decimals here rounds 1,250.500 to 1,250.50 and
    // the panel stops agreeing with the register it summarises.
    renderWithProviders(
      <MoneyComposition money={money({ gross: 1250.5, deductions: 87.535, net: 1162.965 })} />,
    );

    expect(screen.getAllByText('OMR 1,250.500').length).toBeGreaterThan(0);
    expect(screen.getAllByText('OMR 87.535').length).toBeGreaterThan(0);
    expect(screen.getAllByText('OMR 1,162.965').length).toBeGreaterThan(0);
  });

  it('takes the decimals from the currency it was given, not from a default', () => {
    renderWithProviders(<MoneyComposition money={money({ currency: 'AED' })} />);
    expect(screen.getAllByText('AED 3,000.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('AED 3,000.000')).not.toBeInTheDocument();
  });

  it('keeps employer contributions beside the other three, never inside them', () => {
    renderWithProviders(<MoneyComposition money={money()} />);

    expect(screen.getByText('Employer contributions')).toBeInTheDocument();
    expect(screen.getAllByText('OMR 315.000').length).toBeGreaterThan(0);
    // gross + employer = 3,315.000 · net − employer = 2,475.000. Neither is a
    // figure this panel may print.
    expect(screen.queryByText('OMR 3,315.000')).not.toBeInTheDocument();
    expect(screen.queryByText('OMR 2,475.000')).not.toBeInTheDocument();
    expect(screen.getAllByText('OMR 2,790.000').length).toBeGreaterThan(0);
  });

  it('prints an em dash for a figure that is not there rather than a zero', () => {
    // The wire can answer `null` for an amount the aggregate could not work
    // out. `OMR 0.000` would be a claim that nothing was paid, which is a
    // different statement from "this is not known".
    const { container } = renderWithProviders(
      <MoneyComposition money={money({ net: null as unknown as number })} />,
    );

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(norm(container.textContent)).not.toContain('OMR 0.000');
  });

  it('says a figure could not be read, which is not the same as zero pay', () => {
    const { container } = renderWithProviders(<MoneyComposition failed />);

    expect(screen.getByText('The composition could not be read.')).toBeInTheDocument();
    expect(norm(container.textContent)).not.toContain('OMR 0.000');
    expect(screen.queryByText('Nothing has been approved for this period yet.')).toBeNull();
  });

  it('says nothing has been approved, which is not the same as unreadable', () => {
    const { container } = renderWithProviders(
      <MoneyComposition money={money({ gross: 0, deductions: 0, net: 0, employerCost: 0 })} />,
    );

    expect(screen.getByText('Nothing has been approved for this period yet.')).toBeInTheDocument();
    expect(screen.queryByText('The composition could not be read.')).toBeNull();
    expect(norm(container.textContent)).not.toContain('OMR 0.000');
  });

  it('reports a gross-less-deductions that misses the net instead of rounding it away', () => {
    // Gross minus deductions is net, always. A panel that quietly absorbed the
    // difference would be the reason nobody ever found out.
    renderWithProviders(<MoneyComposition money={money({ net: 2700 })} />);
    expect(screen.getByText(/Check the register before reporting on it\./)).toBeInTheDocument();
  });

  it('stays quiet when the three figures reconcile', () => {
    renderWithProviders(<MoneyComposition money={money()} />);
    expect(screen.queryByText(/Check the register before reporting on it\./)).toBeNull();
  });

  it('names the period the money belongs to, as the server worded it', () => {
    renderWithProviders(<MoneyComposition money={money()} periodLabel="Aug 2026" />);
    expect(
      screen.getByText(
        'Approved and paid runs for Aug 2026. A draft total is an intention, not a payroll.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a skeleton while the aggregate is still in flight', () => {
    const { container } = renderWithProviders(<MoneyComposition loading />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('The composition could not be read.')).toBeNull();
  });
});
