import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/utils';
import type { PayrollHubEmployees } from '@/types/payrollHub';
import ProcessingCoverage from './ProcessingCoverage';

/**
 * How much of the expected payroll has actually been processed.
 *
 * Two claims are load-bearing. The share is only ever printed when there was
 * something to divide by — an unreadable aggregate and a workforce of nobody
 * are separate sentences, and neither is allowed to come out as `0%`, which
 * would be a statement about a payroll that does not exist. And the denominator
 * is the ACTIVE workforce rather than the sum of the buckets, because somebody
 * active and in none of them is exactly the gap this panel exists to show.
 *
 * The names beside "without a salary structure" are a capped SAMPLE while the
 * count is exact, so a short list must never read as the whole set.
 */
const employees = (overrides: Partial<PayrollHubEmployees> = {}): PayrollHubEmployees => ({
  paid: 6,
  inOpenRun: 3,
  active: 10,
  withoutStructure: 0,
  withoutStructureNames: [],
  ...overrides,
});

const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

describe('ProcessingCoverage', () => {
  it('prints a real share for every bucket it can divide', () => {
    // 6 paid, 3 in an open run and 1 in no run at all, of 10 active.
    renderWithProviders(<ProcessingCoverage employees={employees()} />);

    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
  });

  it('counts against the active workforce, not the sum of the buckets', () => {
    const { container } = renderWithProviders(
      <ProcessingCoverage employees={employees({ paid: 6, inOpenRun: 3, active: 10 })} />,
    );

    expect(norm(container.textContent)).toContain('6 / 10');
    // The one nobody has touched. Summing the buckets would make this 0 and
    // hide the person the panel exists to surface.
    expect(screen.getByText('In no run')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
  });

  it('never prints a percentage when there was nothing to divide by', () => {
    // Nobody active is a sentence, not a row of 0%.
    const { container } = renderWithProviders(
      <ProcessingCoverage employees={employees({ paid: 0, inOpenRun: 0, active: 0 })} />,
    );

    expect(
      screen.getByText('Nobody is active, so there is nothing to process.'),
    ).toBeInTheDocument();
    expect(norm(container.textContent)).not.toContain('%');
    expect(norm(container.textContent)).not.toContain('0%');
  });

  it('says the coverage could not be read rather than reporting none', () => {
    // An unreachable endpoint and an unprocessed payroll are different claims.
    const { container } = renderWithProviders(<ProcessingCoverage failed />);

    expect(screen.getByText('Coverage could not be read.')).toBeInTheDocument();
    expect(norm(container.textContent)).not.toContain('%');
    expect(screen.queryByText('Nobody is active, so there is nothing to process.')).toBeNull();
  });

  it('drops a bucket nobody is in instead of drawing it at zero', () => {
    renderWithProviders(
      <ProcessingCoverage employees={employees({ paid: 0, inOpenRun: 4, active: 10 })} />,
    );

    expect(screen.queryByText('Paid')).toBeNull();
    // No share of 0% anywhere — the bucket is dropped, not drawn empty. Read
    // off the elements rather than the concatenated text, in which "40%60%"
    // contains a "0%" that nobody rendered.
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.getByText('40%')).toBeInTheDocument();
    // 6 of the 10 are in no run at all, which is the finding here.
    expect(screen.getByText('60%')).toBeInTheDocument();
  });

  it('reads the count from the server and never from the sample of names', () => {
    renderWithProviders(
      <ProcessingCoverage
        employees={employees({
          withoutStructure: 5,
          withoutStructureNames: ['Aisha Al Balushi', 'Ahmed Al Habsi'],
        })}
      />,
    );

    expect(screen.getByText('5 without a salary structure')).toBeInTheDocument();
    expect(screen.getAllByTestId('coverage-missing-employee')).toHaveLength(2);
    expect(screen.getByText('and 3 more')).toBeInTheDocument();
  });

  it('offers no "more" link when the sample is the whole set', () => {
    renderWithProviders(
      <ProcessingCoverage
        employees={employees({
          withoutStructure: 2,
          withoutStructureNames: ['Aisha Al Balushi', 'Ahmed Al Habsi'],
        })}
      />,
    );

    expect(screen.getByText('2 without a salary structure')).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it('stays silent about structures when everybody has one', () => {
    renderWithProviders(<ProcessingCoverage employees={employees({ withoutStructure: 0 })} />);
    expect(screen.queryByText(/without a salary structure/)).toBeNull();
  });

  it('sends the people in no run to the screen that closes the gap', () => {
    const { container } = renderWithProviders(<ProcessingCoverage employees={employees()} />);
    // Not the same run list as the other two segments: a person in no run is
    // fixed by generating one, not by opening the ones that exist.
    expect(container.querySelector('a[href="/dashboard/payroll/runs/new"]')).toBeTruthy();
    expect(container.querySelector('a[href="/dashboard/payroll/runs?status=PAID"]')).toBeTruthy();
  });

  it('names the period the coverage is measured over, as the server worded it', () => {
    renderWithProviders(<ProcessingCoverage employees={employees()} periodLabel="Aug 2026" />);
    expect(screen.getByText('Against the active workforce, for Aug 2026.')).toBeInTheDocument();
  });

  it('shows a skeleton while the aggregate is still in flight', () => {
    const { container } = renderWithProviders(<ProcessingCoverage loading />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('Coverage could not be read.')).toBeNull();
  });
});
