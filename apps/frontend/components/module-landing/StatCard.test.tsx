import { describe, expect, it } from 'vitest';
import { Clock } from 'lucide-react';
import { renderWithProviders, screen } from '@/test/utils';
import { KpiRow, StatCard, type KpiStat } from './StatCard';

const stat = (overrides: Partial<KpiStat> = {}): KpiStat => ({
  key: 'k',
  label: 'Open contracts',
  value: 3,
  ...overrides,
});

describe('StatCard', () => {
  it('prints an em dash rather than a zero when the figure is unknown', () => {
    // A failed or role-gated request must not be reported as "0 open contracts",
    // which is a claim the data does not support.
    renderWithProviders(<StatCard stat={stat({ value: null })} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('prints the figure when there is one', () => {
    renderWithProviders(<StatCard stat={stat({ value: 12 })} />);
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('drills down through a real link rather than a click handler', () => {
    // Middle-click and open-in-new-tab both depend on this being an anchor.
    const { container } = renderWithProviders(
      <StatCard stat={stat({ href: '/dashboard/contracts' })} />,
    );
    expect(container.querySelector('a[href="/dashboard/contracts"]')).toBeTruthy();
  });

  it('colours the delta by the direction the caller wanted', () => {
    // Overtime rising is not the same news as headcount rising, so the colour
    // comes from `goodDirection`, not from the arrow.
    const good = renderWithProviders(
      <StatCard stat={stat({ delta: { value: 4.2, direction: 'up', goodDirection: 'up' } })} />,
    );
    expect(good.container.querySelector('.text-status-success')).toBeTruthy();
    good.unmount();

    const bad = renderWithProviders(
      <StatCard stat={stat({ delta: { value: 4.2, direction: 'up', goodDirection: 'down' } })} />,
    );
    expect(bad.container.querySelector('.text-status-error')).toBeTruthy();
  });

  it('prints an absolute change in place of the percentage when given one', () => {
    renderWithProviders(
      <StatCard stat={stat({ delta: { value: 4, direction: 'up', display: 'OMR 3,120' } })} />,
    );
    expect(screen.getByText('OMR 3,120')).toBeInTheDocument();
  });

  it('draws a sparkline only when the series has a shape', () => {
    const single = renderWithProviders(<StatCard stat={stat({ trend: [4] })} />);
    expect(single.container.querySelector('svg.sparkline-mask')).toBeNull();
    single.unmount();

    // All zeros would draw a flat line, which reads as "steady" — a claim about
    // a shape that is not in the data.
    const flat = renderWithProviders(<StatCard stat={stat({ trend: [0, 0, 0, 0] })} />);
    expect(flat.container.querySelector('svg.sparkline-mask')).toBeNull();
    flat.unmount();

    const real = renderWithProviders(<StatCard stat={stat({ trend: [1, 4, 2, 6] })} />);
    expect(real.container.querySelector('svg.sparkline-mask')).toBeTruthy();
  });

  it('keeps the hero figure in the heading colour whatever the tone', () => {
    // Only the icon chip and the delta carry colour; five cards each shouting in
    // a different hue is a traffic light, not a dashboard.
    const { container } = renderWithProviders(
      <StatCard stat={stat({ tone: 'danger', icon: Clock, value: 9 })} />,
    );
    expect(screen.getByText('9').className).toContain('text-text-heading');
    expect(container.querySelector('.text-status-error')).toBeTruthy();
  });

  it('dashes a sub-stat with no answer instead of zeroing it', () => {
    renderWithProviders(
      <StatCard
        stat={stat({
          subStats: [
            { key: 'a', label: 'Expiring', value: 2 },
            { key: 'b', label: 'Unassigned', value: null },
          ],
        })}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('keeps the footnote alongside a delta rather than replacing it', () => {
    renderWithProviders(
      <StatCard
        stat={stat({
          delta: { value: 12, direction: 'up', goodDirection: 'down', label: 'vs last week' },
          footnote: 'month average 8.0%',
        })}
      />,
    );
    expect(screen.getByText('vs last week')).toBeInTheDocument();
    expect(screen.getByText('month average 8.0%')).toBeInTheDocument();
  });
});

describe('KpiRow', () => {
  it('renders one card per stat', () => {
    renderWithProviders(
      <KpiRow
        stats={[
          stat({ key: 'a', label: 'A' }),
          stat({ key: 'b', label: 'B' }),
          stat({ key: 'c', label: 'C' }),
        ]}
      />,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('draws one skeleton per card it is about to render', () => {
    // A fixed count leaves a five-card hub loading into a grid with a hole in it.
    const { container } = renderWithProviders(
      <KpiRow stats={[stat({ key: 'a' }), stat({ key: 'b' }), stat({ key: 'c' })]} loading />,
    );
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(3);
  });

  it('renders nothing when there is no data and nothing pending', () => {
    const { container } = renderWithProviders(<KpiRow stats={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
