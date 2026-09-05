import { describe, expect, it } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import { BarOverviewChart, type BarOverviewItem } from './primitives';

/**
 * The stacked mode on `BarOverviewChart`.
 *
 * The chart has always drawn a "2-tone" body on the ACTIVE bar — a fixed 32%
 * cap over a primary body. That is decoration: the split means nothing, and it
 * disappears the moment the pointer moves. Both new module hubs need bands that
 * carry a number the reader can compare across bars — Scheduled against
 * Unassigned, the four leave statuses — so `segments` draws real ones.
 *
 * Proportions come from `flexGrow`, the same trick `SegmentedBar` uses, rather
 * than from percentage arithmetic: percentages that round to 99.7% leave a
 * hairline of page background showing through the top of every stack.
 *
 * The single-value path must be untouched — the Time & Attendance hub is the
 * finalized template and still uses it.
 */

const bars = (over: Partial<BarOverviewItem> = {}): BarOverviewItem[] => [
  {
    key: 'mon',
    label: 'Mon',
    value: 10,
    ...over,
  },
];

const stacked = (segments: BarOverviewItem['segments'], value = 10) =>
  bars({ segments, value });

describe('BarOverviewChart — stacked segments', () => {
  it('sizes each band by its value, so bands are comparable across bars', () => {
    renderWithProviders(
      <BarOverviewChart
        items={[
          {
            key: 'mon',
            label: 'Mon',
            value: 10,
            segments: [
              { key: 'scheduled', label: 'Scheduled', value: 8, color: '#0a0' },
              { key: 'unassigned', label: 'Unassigned', value: 2, color: '#a00' },
            ],
          },
        ]}
      />,
    );
    const scheduled = document.querySelector('[title="Scheduled: 8"]') as HTMLElement;
    const unassigned = document.querySelector('[title="Unassigned: 2"]') as HTMLElement;
    expect(scheduled).toBeTruthy();
    expect(unassigned).toBeTruthy();
    // flexGrow carries the value itself — no percentages, no rounding drift.
    expect(scheduled.style.flexGrow).toBe('8');
    expect(unassigned.style.flexGrow).toBe('2');
    expect(scheduled.style.flexBasis).toBe('0px');
  });

  it('draws the bands bottom-first, in the order they were given', () => {
    renderWithProviders(
      <BarOverviewChart
        items={stacked([
          { key: 'a', label: 'First', value: 3, color: '#0a0' },
          { key: 'b', label: 'Second', value: 7, color: '#a00' },
        ])}
      />,
    );
    // `flex-col-reverse` puts array-index 0 at the BOTTOM, which is where a
    // reader expects the primary band of a stacked bar to sit.
    const stack = document.querySelector('.flex-col-reverse') as HTMLElement;
    expect(stack).toBeTruthy();
    const order = [...stack.children].map((c) => c.getAttribute('title'));
    expect(order).toEqual(['First: 3', 'Second: 7']);
  });

  it('drops a zero band rather than drawing it as a sliver', () => {
    renderWithProviders(
      <BarOverviewChart
        items={stacked([
          { key: 'a', label: 'Approved', value: 5, color: '#0a0' },
          { key: 'b', label: 'Cancelled', value: 0, color: '#a00' },
        ])}
      />,
    );
    // A `minHeight: 2` band with no value is a coloured line that means
    // nothing, and on a donut-adjacent legend it invites the reader to look
    // for a slice that is not there.
    expect(document.querySelector('[title="Approved: 5"]')).toBeTruthy();
    expect(document.querySelector('[title="Cancelled: 0"]')).toBeNull();
  });

  it('lists every band in the tooltip, with the total under a rule', () => {
    renderWithProviders(
      <BarOverviewChart
        items={stacked([
          { key: 'a', label: 'Scheduled', value: 8, color: '#0a0' },
          { key: 'b', label: 'Unassigned', value: 2, color: '#a00' },
        ]).map((b) => ({ ...b, highlight: true }))}
      />,
    );
    // The bands are the story; the caller does not have to hand-build
    // `tooltipRows` for the common case.
    expect(screen.getByText('Scheduled')).toBeTruthy();
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('Total')).toBeTruthy();
  });

  it('lets an explicit tooltipRows win over the bands', () => {
    renderWithProviders(
      <BarOverviewChart
        items={stacked([
          { key: 'a', label: 'Scheduled', value: 8, color: '#0a0' },
        ]).map((b) => ({
          ...b,
          highlight: true,
          tooltipRows: [{ label: 'Coverage', value: '93%', emphasis: true }],
        }))}
      />,
    );
    expect(screen.getByText('Coverage')).toBeTruthy();
    expect(screen.queryByText('Scheduled')).toBeNull();
  });

  it('opens the highlighted bar tooltip at rest by default', () => {
    // The Time & Attendance hub relies on this: the chart arrives with one card
    // showing, which is the sentence it is drawing.
    renderWithProviders(
      <BarOverviewChart
        items={stacked([{ key: 'a', label: 'Scheduled', value: 8, color: '#0a0' }]).map((b) => ({
          ...b,
          highlight: true,
        }))}
      />,
    );
    expect(screen.getByText('Total')).toBeTruthy();
  });

  it('honours openHighlightTooltip={false} on first render, not just on hover', () => {
    // The regression this pins: `hoveredIdx` was SEEDED from the highlight
    // index, so `isHovered` was true before the pointer had gone anywhere and
    // the card opened regardless of the flag. The opt-out looked applied, the
    // tests passed, and the screenshot still showed a tooltip over the bars.
    renderWithProviders(
      <BarOverviewChart
        openHighlightTooltip={false}
        items={stacked([{ key: 'a', label: 'Scheduled', value: 8, color: '#0a0' }]).map((b) => ({
          ...b,
          highlight: true,
        }))}
      />,
    );
    expect(screen.queryByText('Total')).toBeNull();
    // The bar itself is still drawn — only the card is withheld.
    expect(document.querySelector('[title="Scheduled: 8"]')).toBeTruthy();
  });

  it('leaves the single-value bar exactly as it was', () => {
    // The Time & Attendance hub is the finalized template and passes no
    // segments. Its bar must keep the old body.
    renderWithProviders(<BarOverviewChart items={bars({ highlight: true })} />);
    expect(document.querySelector('.flex-col-reverse')).toBeNull();
    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
  });

  it('still prints the x-axis label for a stacked bar', () => {
    renderWithProviders(
      <BarOverviewChart
        items={stacked([{ key: 'a', label: 'Scheduled', value: 8, color: '#0a0' }])}
      />,
    );
    expect(screen.getByText('Mon')).toBeTruthy();
  });
});
