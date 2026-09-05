import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CoverageGauges from './CoverageGauges';
import type { DashboardCoverage } from '@/types/payrollDashboard';

const coverage = (
  overrides: Partial<DashboardCoverage> = {},
): DashboardCoverage => ({
  present: 380,
  late: 12,
  absent: 8,
  halfDay: 0,
  onLeave: 14,
  expected: 414,
  attendanceRate: 94.7,
  payrollCompletion: 90.9,
  activeEmployees: 22,
  ...overrides,
});

describe('CoverageGauges', () => {
  it('renders both rates', () => {
    render(<CoverageGauges coverage={coverage()} payslipCount={20} />);
    expect(screen.getByText('94.7%')).toBeInTheDocument();
    expect(screen.getByText('90.9%')).toBeInTheDocument();
  });

  it('prints an em dash for a null rate, never 0.0%, and keeps the known one', () => {
    // The rule the whole page rests on. A rate with no denominator is a
    // question that cannot be answered, and 0.0% would answer it falsely —
    // "nobody was paid" rather than "there was nobody to pay".
    render(
      <CoverageGauges
        coverage={coverage({ payrollCompletion: null })}
        payslipCount={0}
      />,
    );
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(1);
    // One unknown does not blank the other: a panel that hid both would lose a
    // figure it had.
    expect(screen.getByText('94.7%')).toBeInTheDocument();
  });

  it('writes a sentence when there is nothing to measure at all', () => {
    render(
      <CoverageGauges
        coverage={coverage({
          attendanceRate: null,
          payrollCompletion: null,
          expected: 0,
          activeEmployees: 0,
        })}
        payslipCount={0}
      />,
    );
    expect(
      screen.getByText('There is nothing to measure for this period.'),
    ).toBeInTheDocument();
  });

  it('carries the same rates into its table twin', async () => {
    // The chart and the table are the same rows, so a reader who cannot judge
    // an arc can read the number instead — which is what makes the low-contrast
    // slots in the series ramp defensible.
    const user = userEvent.setup();
    render(<CoverageGauges coverage={coverage()} payslipCount={20} />);

    await user.click(screen.getByRole('button', { name: /as a table/i }));

    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('Attendance health');
    expect(table).toHaveTextContent('94.7%');
    expect(table).toHaveTextContent('20 of 22 active employees paid');
  });
});
