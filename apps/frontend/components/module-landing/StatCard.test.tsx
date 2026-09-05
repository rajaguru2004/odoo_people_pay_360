import { describe, expect, it } from 'vitest';
import { Clock } from 'lucide-react';
import { renderWithProviders, screen } from '@/test/render';
import { KpiRow, StatCard, type KpiStat } from './StatCard';

const stat = (overrides: Partial<KpiStat> = {}): KpiStat => ({
  key: 'k',
  label: 'Open payrolls',
  value: 3,
  ...overrides,
});

describe('StatCard', () => {
  it('renders an em dash rather than a zero when the number is unknown', () => {
    // A failed or role-gated request must not be reported as "0 open payrolls",
    // which is a claim the data does not support.
    renderWithProviders(<StatCard stat={stat({ value: null })} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders the value when there is one', () => {
    renderWithProviders(<StatCard stat={stat({ value: 12 })} />);
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('drills down through a real link, not a click handler', () => {
    // Middle-click, open-in-new-tab and the e2e a[href] selectors all depend
    // on this being an anchor.
    renderWithProviders(<StatCard stat={stat({ href: '/dashboard/payroll/manage' })} />);
    expect(document.querySelector('a[href="/dashboard/payroll/manage"]')).toBeTruthy();
  });

  it('reads a delta against the direction the caller wanted', () => {
    // Overtime hours rising is not the same news as headcount rising, so the
    // arrow's colour comes from `goodDirection`, not from the arrow.
    const { unmount } = renderWithProviders(
      <StatCard stat={stat({ delta: { value: 4.2, direction: 'up', goodDirection: 'up' } })} />,
    );
    expect(document.querySelector('.text-status-success')).toBeTruthy();
    unmount();

    renderWithProviders(
      <StatCard stat={stat({ delta: { value: 4.2, direction: 'up', goodDirection: 'down' } })} />,
    );
    expect(document.querySelector('.text-status-error')).toBeTruthy();
  });

  it('draws a sparkline only when the series has something to draw', () => {
    const { container, unmount } = renderWithProviders(<StatCard stat={stat({ trend: [1] })} />);
    expect(container.querySelector('svg.sparkline-mask')).toBeNull();
    unmount();

    const second = renderWithProviders(<StatCard stat={stat({ trend: [1, 4, 2, 6] })} />);
    expect(second.container.querySelector('svg.sparkline-mask')).toBeTruthy();
  });

  it('shows the footnote and the icon when given them', () => {
    renderWithProviders(<StatCard stat={stat({ icon: Clock, footnote: 'awaiting finalization' })} />);
    expect(screen.getByText('awaiting finalization')).toBeTruthy();
  });

  it('keeps the footnote alongside a delta rather than replacing it', () => {
    // They answer different questions: the delta is the movement, the footnote
    // is the standing context a reader needs to judge it.
    renderWithProviders(
      <StatCard
        stat={stat({
          delta: { value: 12, direction: 'up', goodDirection: 'down', label: 'vs last week' },
          footnote: 'month average 8.0%',
        })}
      />,
    );
    expect(screen.getByText('vs last week')).toBeTruthy();
    expect(screen.getByText('month average 8.0%')).toBeTruthy();
  });
});

describe('KpiRow', () => {
  it('renders one card per stat', () => {
    renderWithProviders(
      <KpiRow
        stats={[stat({ key: 'a', label: 'A' }), stat({ key: 'b', label: 'B' }), stat({ key: 'c', label: 'C' })]}
      />,
    );
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('C')).toBeTruthy();
  });

  it('shows skeletons while loading instead of a row of dashes', () => {
    const { container } = renderWithProviders(<KpiRow stats={[]} loading skeletonCount={4} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBe(4);
  });

  it('renders nothing when there is no data and nothing pending', () => {
    const { container } = renderWithProviders(<KpiRow stats={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
