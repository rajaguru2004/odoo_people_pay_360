import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChartFrame from './ChartFrame';

vi.mock('@/utils/chartAxis', async () => {
  const actual = await vi.importActual<typeof import('@/utils/chartAxis')>(
    '@/utils/chartAxis',
  );
  return { ...actual, downloadCsv: vi.fn() };
});

import { downloadCsv } from '@/utils/chartAxis';

interface Row {
  name: string;
  net: number;
}

const rows: Row[] = [
  { name: 'Finance', net: 1200 },
  { name: 'Engineering', net: 3400 },
];

const table = {
  caption: 'Net pay by department',
  rows,
  columns: [
    { key: 'name', label: 'Department', value: (r: Row) => r.name },
    {
      key: 'net',
      label: 'Net',
      value: (r: Row) => String(r.net),
      numeric: true,
    },
  ],
  rowKey: (r: Row) => r.name,
};

const renderFrame = (props: Partial<Parameters<typeof ChartFrame<Row>>[0]> = {}) =>
  render(
    <ChartFrame
      title="Cost by department"
      exportName="cost-by-department"
      table={table}
      {...props}
    >
      <div data-testid="plot">the chart</div>
    </ChartFrame>,
  );

describe('ChartFrame states', () => {
  it('shows a skeleton and no plot while loading', () => {
    renderFrame({ loading: true });
    expect(screen.queryByTestId('plot')).not.toBeInTheDocument();
    expect(screen.queryByText('the chart')).not.toBeInTheDocument();
  });

  it('writes a sentence rather than drawing an empty chart', () => {
    // The rule: a chart of zeros claims the values WERE zero, which is a
    // different statement from having nothing to show.
    renderFrame({
      empty: true,
      emptyLabel: 'No payroll was approved for August 2026.',
    });
    expect(
      screen.getByText('No payroll was approved for August 2026.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('plot')).not.toBeInTheDocument();
  });

  it('renders loading, empty and data as three distinct trees', () => {
    const { unmount } = renderFrame({ loading: true });
    expect(screen.queryByTestId('plot')).not.toBeInTheDocument();
    unmount();

    const second = renderFrame({ empty: true });
    expect(screen.queryByTestId('plot')).not.toBeInTheDocument();
    second.unmount();

    renderFrame();
    expect(screen.getByTestId('plot')).toBeInTheDocument();
  });

  it('holds the previous render at reduced opacity while refetching', () => {
    // Re-skeletoning on every filter change makes the grid jump and loses the
    // comparison the reader was in the middle of making.
    renderFrame({ refetching: true });
    const plot = screen.getByTestId('plot');
    expect(plot).toBeInTheDocument();
    expect(plot.parentElement).toHaveClass('opacity-50');
  });
});

describe('ChartFrame table twin', () => {
  it('swaps the chart for the same rows as a table', async () => {
    const user = userEvent.setup();
    renderFrame();

    await user.click(screen.getByRole('button', { name: /as a table/i }));

    expect(screen.queryByTestId('plot')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });

  it('exports exactly the columns the table shows', async () => {
    const user = userEvent.setup();
    renderFrame();

    await user.click(screen.getByRole('button', { name: /download/i }));

    // One source for the chart, the table and the file. A CSV assembled
    // separately drifts the moment either side gains a column.
    expect(downloadCsv).toHaveBeenCalledWith(
      'cost-by-department.csv',
      ['Department', 'Net'],
      [
        ['Finance', '1200'],
        ['Engineering', '3400'],
      ],
    );
  });

  it('offers neither affordance when there is nothing to show', () => {
    renderFrame({ empty: true });
    expect(screen.getByRole('button', { name: /as a table/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
  });
});
