import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ApprovalsQueue from './ApprovalsQueue';
import type {
  DashboardApprovalItem,
  DashboardApprovals,
} from '@/types/dashboardOverview';

const item = (
  overrides: Partial<DashboardApprovalItem> = {},
): DashboardApprovalItem => ({
  key: 'leave',
  label: 'Leave requests',
  count: 8,
  href: '/dashboard/leaves/pending',
  severity: 'WARNING',
  oldestDays: 5,
  ...overrides,
});

const approvals = (
  overrides: Partial<DashboardApprovals> = {},
): DashboardApprovals => ({
  total: 8,
  items: [item()],
  ...overrides,
});

describe('ApprovalsQueue', () => {
  it('lists each queue with its count and a link to it', () => {
    render(<ApprovalsQueue approvals={approvals()} />);

    expect(screen.getByText('Leave requests')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Leave requests/ }),
    ).toHaveAttribute('href', '/dashboard/leaves/pending');
  });

  it('writes a sentence when nothing is waiting, rather than an empty box', () => {
    // A blank panel is indistinguishable from a panel that failed to load, and
    // the reader goes hunting for work that is not there.
    render(<ApprovalsQueue approvals={{ total: 0, items: [] }} />);

    expect(
      screen.getByText('Nothing is waiting on a decision.'),
    ).toBeInTheDocument();
  });

  it('says nothing about age when there is no oldest item', () => {
    // `oldestDays` is null for a queue with nothing in it. "0 days old" would
    // invent an item that arrived this morning.
    render(
      <ApprovalsQueue
        approvals={approvals({
          total: 3,
          items: [item({ count: 3, oldestDays: null })],
        })}
      />,
    );

    expect(screen.getByText('Leave requests')).toBeInTheDocument();
    expect(screen.queryByText(/0 days/)).not.toBeInTheDocument();
    expect(screen.queryByText(/old/i)).not.toBeInTheDocument();
  });

  it('drops a settled queue instead of drawing it as a zero row', () => {
    render(
      <ApprovalsQueue
        approvals={approvals({
          total: 4,
          items: [
            item({ key: 'overtime', label: 'Overtime requests', count: 0, oldestDays: null }),
            item({ count: 4 }),
          ],
        })}
      />,
    );

    expect(screen.queryByText('Overtime requests')).not.toBeInTheDocument();
    expect(screen.getByText('Leave requests')).toBeInTheDocument();
  });

  it('carries severity in words, not in colour alone', () => {
    // Roughly one man in twelve cannot read a red/amber distinction, and a
    // printed or projected copy loses it entirely.
    render(
      <ApprovalsQueue
        approvals={approvals({
          total: 9,
          items: [
            item({ key: 'terminations', label: 'Terminations', count: 1, severity: 'CRITICAL' }),
            item({ count: 8, severity: 'WARNING' }),
          ],
        })}
      />,
    );

    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('Needs action')).toBeInTheDocument();
  });

  it('ranks the worst queue first, whatever order the payload arrived in', () => {
    render(
      <ApprovalsQueue
        approvals={approvals({
          total: 60,
          items: [
            item({ key: 'notes', label: 'Notices', count: 50, severity: 'INFO' }),
            item({ key: 'terminations', label: 'Terminations', count: 1, severity: 'CRITICAL' }),
          ],
        })}
      />,
    );

    const labels = screen
      .getAllByRole('link')
      .map((link) => link.textContent ?? '');
    // The header's "open the top queue" link comes first in the DOM; the rows
    // follow it, worst-first.
    expect(labels[1]).toContain('Terminations');
    expect(labels[2]).toContain('Notices');
  });

  it('renders skeletons instead of an empty sentence while loading', () => {
    render(<ApprovalsQueue loading />);

    expect(
      screen.queryByText('Nothing is waiting on a decision.'),
    ).not.toBeInTheDocument();
  });
});
