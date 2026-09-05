import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TodayAttendanceDonut from './TodayAttendanceDonut';
import type { DashboardAttendance } from '@/types/dashboardOverview';

/**
 * `ResponsiveContainer` is mocked once in `test/setup.ts`, so the donut renders
 * inside a 400×300 box and its arcs, legend and labels are all really in the
 * DOM. Nothing here re-mocks it.
 */

const attendance = (
  overrides: Partial<DashboardAttendance> = {},
): DashboardAttendance => ({
  present: 18,
  late: 3,
  absent: 2,
  onLeave: 4,
  notCheckedIn: 1,
  expected: 24,
  attendanceRate: 87.5,
  settled: true,
  ...overrides,
});

describe('TodayAttendanceDonut', () => {
  it('reads normally once the day has settled', () => {
    render(<TodayAttendanceDonut attendance={attendance()} />);

    expect(screen.getByText('Absent')).toBeInTheDocument();
    expect(screen.queryByText(/provisional/i)).not.toBeInTheDocument();
    expect(screen.getByText('87.5%')).toBeInTheDocument();
    // The hole carries the total of everybody accounted for today.
    expect(screen.getByText('28')).toBeInTheDocument();
  });

  it('says absent is provisional while the office day is still open', () => {
    // The rule this component exists for. Before the office end, somebody who
    // has not arrived may still arrive, so "2 absent" is a prediction. A panel
    // that stated it as fact would send a manager chasing people who are on a
    // late train.
    render(
      <TodayAttendanceDonut
        attendance={attendance({ settled: false, notCheckedIn: 5 })}
      />,
    );

    expect(
      screen.getByText(/absent is provisional until the office day closes/i),
    ).toBeInTheDocument();
    // And not only in the sentence: the legend entry itself is hedged, for the
    // reader who scans the labels and leaves.
    expect(screen.getByText('Absent so far')).toBeInTheDocument();
    expect(screen.queryByText('Absent')).not.toBeInTheDocument();
  });

  it('names the people still expected in, because that is the number that moves', () => {
    render(
      <TodayAttendanceDonut
        attendance={attendance({ settled: false, notCheckedIn: 5 })}
      />,
    );

    expect(
      screen.getByText(/5 people are still expected in/i),
    ).toBeInTheDocument();
  });

  it('prints an em dash for a null rate and never 0.0%', () => {
    // `attendanceRate` is null when nobody was expected — a whole team on
    // approved leave, say. A closed day and a day nobody turned up for are
    // different claims, and 0.0% makes them the same one.
    render(
      <TodayAttendanceDonut
        attendance={attendance({
          present: 0,
          late: 0,
          absent: 0,
          onLeave: 4,
          notCheckedIn: 0,
          expected: 0,
          attendanceRate: null,
        })}
      />,
    );

    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    // The day it does have is still shown: one unknown does not blank the rest.
    expect(screen.getByText('On leave')).toBeInTheDocument();
  });

  it('writes a sentence rather than drawing a donut of zeros', () => {
    render(<TodayAttendanceDonut attendance={attendance({
      present: 0,
      late: 0,
      absent: 0,
      onLeave: 0,
      notCheckedIn: 0,
      expected: 0,
      attendanceRate: null,
    })} />);

    expect(
      screen.getByText(
        'Nobody was expected in today, so there is no attendance to show.',
      ),
    ).toBeInTheDocument();
    // A ring of zero-width arcs would claim the statuses were measured and
    // found empty. No plot is mounted at all — the frame swapped it for the
    // sentence rather than handing the chart a set of noughts.
    expect(document.querySelector('.recharts-wrapper')).toBeNull();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('says the same thing when the block never arrived', () => {
    // An unentitled caller gets no `attendance` key at all. Absent and empty
    // are different claims, and neither is a reading of zero.
    render(<TodayAttendanceDonut />);

    expect(
      screen.getByText(
        'Nobody was expected in today, so there is no attendance to show.',
      ),
    ).toBeInTheDocument();
  });

  it('carries the provisional label into its table twin', async () => {
    // The chart, the table and the CSV are the same rows, so the caveat cannot
    // be lost by switching view or exporting.
    const user = userEvent.setup();
    render(<TodayAttendanceDonut attendance={attendance({ settled: false })} />);

    await user.click(screen.getByRole('button', { name: /as a table/i }));

    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('Absent so far');
    expect(table).toHaveTextContent('Not checked in');
  });
});
