import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import MyCornerPanel from './MyCornerPanel';
import type { DashboardMe } from '@/types/dashboardOverview';

const me = (overrides: Partial<DashboardMe> = {}): DashboardMe => ({
  employeeId: 'emp-1',
  todayStatus: 'PRESENT',
  leaveBalanceDays: 12,
  pendingOwnRequests: 2,
  latestPayslip: {
    id: 'slip-9',
    label: 'August 2026',
    net: 1234.5,
    currency: 'KWD',
  },
  ...overrides,
});

describe('MyCornerPanel', () => {
  it('renders nothing for an account with no employee record behind it', () => {
    // A bare admin has no shift, no balance and no payslip, and none of it is
    // coming. A row of em dashes would read as broken rather than as
    // inapplicable, so the strip is absent instead.
    const { container } = render(
      <MyCornerPanel
        me={me({
          employeeId: null,
          todayStatus: null,
          leaveBalanceDays: null,
          pendingOwnRequests: 0,
          latestPayslip: null,
        })}
        currency="OMR"
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('prints an em dash for an unknown leave balance, never a zero', () => {
    // "0 days of leave left" and "we could not ask" are different statements.
    render(<MyCornerPanel me={me({ leaveBalanceDays: null })} currency="OMR" />);

    const balance = screen.getByRole('link', { name: /Leave balance/ });
    expect(balance).toHaveTextContent('—');
    expect(balance).not.toHaveTextContent('0');
    // The unit is dropped with the figure: "— days" still claims a balance.
    expect(balance).not.toHaveTextContent('days');
  });

  it('links the latest payslip to its own record and formats it in its own currency', () => {
    // The company unit is `currency`; the payslip carries its own. KWD is a
    // three-decimal currency, and rounding 1,234.500 to 1,234.50 under a dollar
    // sign is a figure nobody can reconcile against the payslip itself.
    render(<MyCornerPanel me={me()} currency="USD" />);

    const payslip = screen.getByRole('link', { name: /Latest payslip/ });
    expect(payslip).toHaveAttribute('href', '/dashboard/my-payslips/slip-9');
    expect(payslip).toHaveTextContent('1,234.500');
    expect(payslip).toHaveTextContent('KWD');
    expect(payslip).toHaveTextContent('August 2026');
    expect(payslip.textContent).not.toContain('$');
  });

  it('draws skeletons and no figures while loading', () => {
    render(<MyCornerPanel currency="OMR" loading />);

    expect(screen.getByTestId('my-corner-skeleton')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('keeps the shell, with em dashes, when the block could not be read', () => {
    // Silently disappearing would read as "this account has nothing", which is
    // the one thing a failed read must not be mistaken for.
    render(<MyCornerPanel currency="OMR" failed />);

    expect(screen.getByTestId('my-corner-panel')).toBeInTheDocument();
    expect(
      screen.getByText('Your own figures could not be read.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });

  it('shows today as a formatted status badge, not the raw enum', () => {
    render(<MyCornerPanel me={me({ todayStatus: 'LEAVE' })} currency="OMR" />);

    expect(screen.getByText('Leave')).toBeInTheDocument();
    expect(screen.queryByText('LEAVE')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Today/ })).toHaveAttribute(
      'href',
      '/dashboard/my-attendance',
    );
  });
});
