import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Bar, BarChart, ResponsiveContainer, XAxis } from 'recharts';

/**
 * A guard on the `ResponsiveContainer` mock in `test/setup.ts`.
 *
 * Recharts measures its container, and jsdom has no layout engine — so under
 * test the real container reports 0×0 and every chart draws nothing at all.
 * The mock exists to fix that, and it works only because it CLONES its child
 * with explicit `width` and `height`; a mock that merely wraps the chart in a
 * sized `<div>` leaves the chart itself at zero and it still renders no marks.
 *
 * That distinction is invisible: a chart test asserting on the panel, the
 * legend or the table twin passes either way. So without this file, somebody
 * "simplifying" the mock back to a plain wrapper would hollow out every chart
 * test in the repo and nothing would go red.
 *
 * This is the only test that asserts on Recharts' own internals. It is testing
 * the harness, not a component.
 *
 * What the harness does NOT give, so nobody wastes an afternoon on it: a `<Bar>`
 * with `<Cell>` children renders as an empty `recharts-inactive-bar` group with
 * no `<path>` under jsdom, so per-mark FILL cannot be asserted. Colour rules are
 * covered where they actually live — `createSeriesScale` in
 * `theme/chartColors.test.ts` — rather than through the DOM.
 */
describe('the jsdom chart harness', () => {
  it('draws one mark per datum, rather than an empty SVG', () => {
    const { container } = render(
      <ResponsiveContainer width="100%" height={280}>
        <BarChart
          data={[
            { name: 'Finance', value: 10 },
            { name: 'Engineering', value: 20 },
            { name: 'Support', value: 5 },
          ]}
        >
          <XAxis dataKey="name" />
          <Bar dataKey="value" />
        </BarChart>
      </ResponsiveContainer>,
    );

    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(3);
  });

  it('renders axis tick labels', () => {
    const { container } = render(
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={[{ name: 'Finance', value: 10 }]}>
          <XAxis dataKey="name" />
          <Bar dataKey="value" />
        </BarChart>
      </ResponsiveContainer>,
    );

    expect(container.textContent).toContain('Finance');
  });
});
