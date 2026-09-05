import { DateTime } from 'luxon';
import type {
  MonthlyAttendanceCell,
  MonthlyAttendanceEntry,
  MonthlyCalendarDay,
} from '@/types/attendance';

/**
 * The arithmetic and the vocabulary the attendance log grid is built from.
 *
 * Pure on purpose. A month grid is a page of small decisions — which cell is a
 * rest day, which is merely empty, which month the ‹ › arrows land on — and
 * every one of them is a rule two screens will eventually have to agree about.
 * Nothing here touches React or the network, so the rules can be exercised
 * without either.
 */

export interface MonthCursor {
  /** 1–12. Human numbering, because it is what the API and the label both use. */
  month: number;
  year: number;
}

/** The month a date falls in, read in a named zone. */
export function monthOf(date: Date, zone = 'Asia/Muscat'): MonthCursor {
  const dt = DateTime.fromJSDate(date, { zone });
  return { month: dt.month, year: dt.year };
}

/**
 * Walk the cursor by whole months.
 *
 * Through luxon rather than `month + delta`, so December steps to January of
 * the next year without a wrap-around branch at every call site.
 */
export function stepMonth(cursor: MonthCursor, delta: number): MonthCursor {
  const moved = DateTime.fromObject(
    { year: cursor.year, month: cursor.month, day: 1 },
    { zone: 'utc' },
  ).plus({ months: delta });
  return { month: moved.month, year: moved.year };
}

/** "September 2026". */
export function monthLabel(cursor: MonthCursor): string {
  const dt = DateTime.fromObject(
    { year: cursor.year, month: cursor.month, day: 1 },
    { zone: 'utc' },
  );
  return dt.isValid ? dt.toFormat('LLLL yyyy') : '—';
}

/** Ordering key, so two cursors can be compared without a pair of ifs. */
export function monthOrdinal(cursor: MonthCursor): number {
  return cursor.year * 12 + cursor.month;
}

/**
 * Is the cursor already at the newest month worth showing?
 *
 * The stepper must not walk into a month that has not happened: every cell in
 * it would be blank, and a page of blanks is indistinguishable from a page that
 * failed to load.
 */
export function isAtLatestMonth(
  cursor: MonthCursor,
  now: Date = new Date(),
  zone = 'Asia/Muscat',
): boolean {
  return monthOrdinal(cursor) >= monthOrdinal(monthOf(now, zone));
}

/**
 * "Mon". ISO weekday, 1 = Monday … 7 = Sunday.
 *
 * Walked forward from a known Monday rather than built with luxon's weekday
 * field, which is typed to a literal union the API's plain `number` cannot
 * satisfy without a cast that would also let 9 through.
 */
const ISO_WEEK_ANCHOR = DateTime.fromISO('2024-01-01', { zone: 'utc' });

export function weekdayLabel(weekday: number): string {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return '';
  return ISO_WEEK_ANCHOR.plus({ days: weekday - 1 }).toFormat('ccc');
}

/** "01 Sep" — the two lines a day column heads itself with. */
export function dayColumnLabel(day: MonthlyCalendarDay): string {
  const dt = DateTime.fromISO(day.date, { zone: 'utc' });
  return dt.isValid ? dt.toFormat('dd LLL') : day.date;
}

/**
 * What a cell IS, before anything is drawn.
 *
 * Ordered by what beats what. A holiday outranks the weekly rest because the
 * holiday has a name the reader can act on and "Rest" does not; a punch
 * outranks both, because somebody who came in on a public holiday worked that
 * day whatever the calendar says.
 */
export type CellKind =
  | 'worked'
  | 'leave'
  | 'holiday'
  | 'rest'
  | 'absent'
  | 'future'
  | 'blank';

export function cellKind(cell: MonthlyAttendanceCell): CellKind {
  if (cell.checkIn) return 'worked';
  if (cell.status === 'ON_LEAVE') return 'leave';
  if (cell.holiday) return 'holiday';
  if (cell.isWeeklyOff || !cell.isWorkingDay) return 'rest';
  if (cell.isFuture) return 'future';
  // Until the shift closes, a missing punch is somebody still on their way.
  // Calling that an absence is how a dashboard marks people absent at 09:05.
  if (cell.status === 'ABSENT' && (cell.hasRecord || cell.settled)) return 'absent';
  return 'blank';
}

/**
 * The words a non-working cell prints in place of two times.
 *
 * A holiday prints its NAME. "Holiday" tells the reader a fact they can already
 * see from the shading; "National Day" tells them why.
 */
export function cellLabel(cell: MonthlyAttendanceCell, kind: CellKind): string {
  switch (kind) {
    case 'leave':
      return 'Leave';
    case 'holiday':
      return cell.holiday?.name ?? 'Holiday';
    case 'rest':
      return 'Rest';
    case 'absent':
      return 'Absent';
    case 'blank':
      return '—';
    default:
      return '';
  }
}

/** The full sentence behind a cell, for the title a hover reveals. */
export function cellTitle(cell: MonthlyAttendanceCell, kind: CellKind): string {
  const parts: string[] = [cell.date];
  if (kind === 'worked') {
    if (cell.isLate) parts.push(`${cell.lateMinutes} min late`);
    if (cell.isEarlyIn) parts.push('Arrived before the shift');
    if (cell.isEarlyLeave) parts.push('Left short of the hours owed');
    if (cell.isLateOut) parts.push('Stayed past the shift');
    if (!cell.checkOut) parts.push('No check-out recorded');
  } else {
    parts.push(cellLabel(cell, kind) || 'Nothing recorded');
  }
  if (cell.notes) parts.push(cell.notes);
  return parts.join(' · ');
}

/**
 * A month's worth of rows, narrowed to what the reader typed.
 *
 * Kept here rather than in the page so the rule — code, name OR department —
 * is the same one the server applies when the same text is sent to it.
 */
export function matchesSearch(
  entry: MonthlyAttendanceEntry,
  term: string,
): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    entry.employee.firstName,
    entry.employee.lastName,
    entry.employee.employeeCode,
    entry.employee.department?.name,
    entry.employee.branch?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}
