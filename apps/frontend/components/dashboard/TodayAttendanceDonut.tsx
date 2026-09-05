'use client';

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import ChartFrame from '@/components/charts/ChartFrame';
import { ChartTooltip } from '@/components/charts/tooltips';
import { ATTENDANCE_COLORS, SERIES_OTHER } from '@/theme/chartColors';
import { formatPercent } from '@/utils/formatters';
import { shareOf } from '@/components/charts/chartFormat';
import type { DashboardAttendance } from '@/types/dashboardOverview';

/**
 * Where everybody stands today.
 *
 * **The unsettled day is the whole reason this component is careful.**
 * `settled` is false until the branch's office end has passed, and before that
 * moment "absent" is a PREDICTION: somebody who has not walked in at 09:30 may
 * still walk in at 10:00. A panel that printed "4 absent" at breakfast would be
 * reporting a figure it knows will be wrong by the afternoon, and a manager who
 * acted on it would be chasing people who were merely on a delayed train. So
 * while `settled` is false the segment is labelled *Absent so far*, the panel
 * writes a sentence saying the number is provisional, and the count of people
 * still expected is printed beside it — that is the number that will move.
 *
 * **`attendanceRate` is `null` when nobody was expected**, and prints an em
 * dash through `formatPercent`. A closed branch and a branch where nobody
 * turned up are different claims; "0.0%" makes them the same one, and the one
 * it makes is the accusation.
 *
 * A donut rather than a pie, because the hole is where the total goes and the
 * total is the first thing anybody asks of a proportion.
 *
 * This is the ONE place a status colour is correct for a series: the segments
 * ARE the status — a present day is good and an absent one is not. The
 * exception stops at `notCheckedIn`, which is not a status at all but the
 * absence of one, so it takes the neutral rather than borrowing a hue that
 * would judge it.
 *
 * **The neutral is drawn BACK, not drawn differently.** On a small team early
 * in the day `notCheckedIn` is most of the ring, and at full strength it reads
 * as the finding — a panel that appears to be reporting "six grey" when what it
 * is reporting is "we have not heard yet". Lowering its fill (and its legend
 * dot with it, off one constant, so the two cannot part company) makes the
 * statuses the figure and the not-yet-known the ground, which is the true
 * reading of the day. It stays the same neutral token: receding is a matter of
 * emphasis, and giving it a hue would be the judgement the rule above forbids.
 *
 * **The legend sits at the inline END of the donut, and the panel measures
 * ITSELF to decide.** This chart lives in a `lg:col-span-4` column, so its
 * width does not track the viewport monotonically — it is full-bleed on a
 * phone, narrowest at `lg` where the twelve-column grid first hands it a third
 * of the row, and roomy again on a wide desktop. A viewport breakpoint would
 * therefore turn the side-by-side ON at a width where the panel has least room
 * for it. A container query asks the only question that matters, which is how
 * much room this box actually has.
 */

/**
 * How far the neutral segment steps back. One constant, read by the arc and by
 * its legend dot, because a legend that disagrees with the ring it explains is
 * worse than no legend at all.
 */
const NEUTRAL_FILL_OPACITY = 0.55;

interface Segment {
  key: keyof Pick<
    DashboardAttendance,
    'present' | 'late' | 'absent' | 'onLeave' | 'notCheckedIn'
  >;
  label: string;
  /** A getter, so the colour is read from the live theme at render time. */
  color: () => string;
  /** True for the not-a-status row, which is drawn back rather than recoloured. */
  recede?: boolean;
  count: number;
}

export default function TodayAttendanceDonut({
  attendance,
  loading,
  refetching,
}: {
  attendance?: DashboardAttendance;
  loading?: boolean;
  refetching?: boolean;
}) {
  // A missing block is not an empty one — an unentitled caller gets no
  // `attendance` at all, and the frame's sentence covers both without either
  // pretending to be a reading of zero.
  const settled = attendance?.settled ?? false;

  const segments: Segment[] = [
    {
      key: 'present',
      label: 'Present',
      color: () => ATTENDANCE_COLORS.present,
      count: attendance?.present ?? 0,
    },
    {
      key: 'late',
      label: 'Late',
      color: () => ATTENDANCE_COLORS.late,
      count: attendance?.late ?? 0,
    },
    {
      // The label carries the caveat, not just the hint: a reader who scans
      // the legend and leaves must still not walk away with a settled number.
      key: 'absent',
      label: settled ? 'Absent' : 'Absent so far',
      color: () => ATTENDANCE_COLORS.absent,
      count: attendance?.absent ?? 0,
    },
    {
      key: 'onLeave',
      label: 'On leave',
      color: () => ATTENDANCE_COLORS.onLeave,
      count: attendance?.onLeave ?? 0,
    },
    {
      key: 'notCheckedIn',
      label: 'Not checked in',
      color: () => SERIES_OTHER,
      recede: true,
      count: attendance?.notCheckedIn ?? 0,
    },
  ];

  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  // An arc of nothing is not drawable, but "Absent: 0" is a fact worth being
  // able to read — so the zeroes are dropped from the plot and kept in the
  // legend and the table. Dropping them is also what stops `paddingAngle` from
  // turning a nought into a visible hairline: a zero-width arc pushed apart
  // from its neighbours still paints, and a reader can only take that as a
  // sliver of something.
  const slices = segments.filter((segment) => segment.count > 0);
  const notCheckedIn = attendance?.notCheckedIn ?? 0;
  // The gap between arcs is a separator, and one arc has nothing to be
  // separated from. Carving two degrees out of a lone slice would draw a whole
  // day as slightly less than a whole ring.
  const paddingAngle = slices.length > 1 ? 2 : 0;

  return (
    <ChartFrame
      title="Attendance today"
      hint={
        settled
          ? 'The office day has closed, so these are final. The rate is measured against expected — the working calendar minus approved leave.'
          : 'The office day has not closed, so absent is provisional — somebody who has not arrived yet may still arrive.'
      }
      href="/dashboard/attendance/management"
      hrefLabel="Today in full"
      loading={loading}
      refetching={refetching}
      empty={total === 0}
      emptyLabel="Nobody was expected in today, so there is no attendance to show."
      exportName="dashboard-attendance-today"
      height={260}
      table={{
        caption: settled
          ? 'Attendance today, after the office day closed'
          : 'Attendance today, provisional until the office day closes',
        rows: segments,
        rowKey: (segment) => segment.key,
        columns: [
          { key: 'label', label: 'Status', value: (segment) => segment.label },
          {
            key: 'count',
            label: 'People',
            value: (segment) => String(segment.count),
            numeric: true,
          },
          {
            key: 'share',
            label: 'Share',
            value: (segment) => {
              // `null` prints an em dash: a day with nobody in it did not give
              // every status nought per cent, it gave them no denominator.
              const share = shareOf(segment.count, total);
              return share === null ? '—' : `${share}%`;
            },
            numeric: true,
          },
        ],
        totals: {
          label: 'Total',
          count: String(total),
          share: total > 0 ? '100%' : '—',
        },
      }}
    >
      {/* The panel is its own measuring stick — see the note above on why the
          viewport is the wrong thing to ask. Below 300px of usable width there
          is no honest way to fit a ring and five labelled rows abreast, so the
          legend goes back under the donut rather than squeezing both. */}
      <div className="@container">
        <div className="flex flex-col gap-5 @min-[300px]:flex-row @min-[300px]:items-center @min-[300px]:gap-4">
          {/* `flex-row` and not `flex-row-reverse`: row already follows the
              writing direction, so the legend lands at the inline end in LTR
              and mirrors to the inline start under `dir="rtl"` with nothing
              here to maintain. `aspect-square` keeps the box the ring needs
              while its width follows the room available, and the min/max pin
              it between "still a readable proportion" and "not a poster". */}
          <div className="relative mx-auto aspect-square w-[200px] max-w-full shrink-0 @min-[300px]:mx-0 @min-[300px]:w-[44%] @min-[300px]:min-w-[132px] @min-[300px]:max-w-[190px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip
                  content={
                    <ChartTooltip
                      format={(value) => String(Math.round(value))}
                      labels={{ count: 'People' }}
                    />
                  }
                />
                {/* Radii in per cent rather than pixels, because the box no
                    longer has one size. Fixed radii drawn into a box the
                    legend has narrowed would run off the edge of it. */}
                <Pie
                  data={slices}
                  dataKey="count"
                  nameKey="label"
                  innerRadius="56%"
                  outerRadius="92%"
                  paddingAngle={paddingAngle}
                  stroke="none"
                >
                  {slices.map((segment) => (
                    <Cell
                      key={segment.key}
                      fill={segment.color()}
                      fillOpacity={
                        segment.recede ? NEUTRAL_FILL_OPACITY : 1
                      }
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            {/* The hole carries the total. `pointer-events-none` so the label
                does not eat the hover it sits on top of. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[22px] font-bold leading-none text-text-heading @min-[380px]:text-[26px]">
                {total}
              </span>
              <span className="mt-1 text-[11px] text-text-muted">
                {total === 1 ? 'person' : 'people'}
              </span>
            </div>
          </div>

          {/* Five segments, so a legend rather than direct labels — arcs this
              thin cannot carry a word without overlapping their neighbours.
              Every row is listed including the noughts: a zero the reader can
              see is a measurement, a row that vanished is a question about
              whether it was ever counted. */}
          <div className="min-w-[140px] flex-1">
            <ul className="space-y-2">
              {segments.map((segment) => (
                <li key={segment.key} className="flex items-center gap-2.5">
                  {/* Dot and arc read the SAME getter and the same opacity, so
                      a theme change or a rethink of the neutral moves both at
                      once and the key can never explain a colour the ring is
                      not using. */}
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{
                      background: segment.color(),
                      opacity: segment.recede ? NEUTRAL_FILL_OPACITY : 1,
                    }}
                    aria-hidden
                  />
                  <span className="text-[12px] leading-tight text-text-body">
                    {segment.label}
                  </span>
                  <span className="ms-auto ps-1 text-end text-[12px] font-bold tabular-nums text-text-heading">
                    {segment.count}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-3 flex items-center gap-2 border-t border-surface-border pt-3">
              <span className="text-[11px] text-text-muted">Attendance rate</span>
              {/* `formatPercent(null)` is already the em dash. Nothing here
                  coerces the missing rate to a number on its way past. */}
              <span className="ms-auto text-end text-[13px] font-bold tabular-nums text-text-heading">
                {formatPercent(attendance?.attendanceRate ?? null)}
              </span>
            </div>

            {!settled && (
              // Said in words, not only in the label. The reader who takes one
              // number off this panel must take the caveat with it.
              <p className="mt-2 text-[11px] leading-snug text-status-warning">
                Absent is provisional until the office day closes
                {notCheckedIn > 0
                  ? ` — ${notCheckedIn} ${
                      notCheckedIn === 1 ? 'person is' : 'people are'
                    } still expected in.`
                  : '.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </ChartFrame>
  );
}
