import { ShiftType } from '@prisma/client';
import {
  parseWallClock,
  round2,
} from '../attendances/attendance-calendar.util';

/**
 * The arithmetic every roster decision rests on.
 *
 * Deliberately free of Prisma and Nest, like `attendance-calendar.util.ts`
 * beside it: these are the rules, and rules that can only be exercised through
 * a database and an injector do not get exercised.
 *
 * Shift times in this schema are WALL CLOCK — `"22:00"`, not an instant — so
 * everything here is minute arithmetic on a 24-hour dial rather than date maths.
 * A window that ends at or before it starts has crossed midnight; that single
 * fact is what separates a correct night shift from one that reports minus
 * sixteen hours and drops out of every total it touches.
 */

const MINUTES_PER_DAY = 24 * 60;

/** The order a scheduler reads the shift types in — earliest start first. */
export const SHIFT_ORDER: ShiftType[] = [
  'MORNING',
  'AFTERNOON',
  'FULL_DAY',
  'NIGHT',
  'FLEXIBLE',
];

export const SHIFT_LABELS: Record<ShiftType, string> = {
  MORNING: 'Morning',
  AFTERNOON: 'Afternoon',
  FULL_DAY: 'Full day',
  NIGHT: 'Night',
  FLEXIBLE: 'Flexible',
};

/** The three fields the overlap rule reads, and nothing else. */
export interface ShiftWindow {
  /** A `ShiftType`, widened so a caller holding a raw string need not cast. */
  shiftType: string;
  /** Wall clock, "HH:MM". Null when the row never carried one. */
  startTime: string | null;
  endTime: string | null;
}

/** A shift placed on the dial: minutes past midnight, and how long it runs. */
export interface ResolvedWindow {
  startMinutes: number;
  /** Always positive. Larger than `startMinutes` + 1440 is impossible. */
  durationMinutes: number;
  /** True when the window runs past midnight into the following day. */
  crossesMidnight: boolean;
}

/**
 * Where a shift sits on the 24-hour dial, or null when it has no window at all.
 *
 * FLEXIBLE rows are null BY DEFINITION rather than by accident: the type means
 * "some hours, whenever", so it has no start to place and no span to draw. A
 * fixed-window type missing one of its two clocks is null for the same practical
 * reason — half a window cannot be positioned — and callers treat both the same.
 */
export function resolveWindow(shift: ShiftWindow): ResolvedWindow | null {
  if (shift.shiftType === 'FLEXIBLE') return null;

  const start = parseWallClock(shift.startTime);
  const end = parseWallClock(shift.endTime);
  if (start === null || end === null) return null;

  // Equal clocks are a zero-length window, not a round-the-clock shift: an
  // unconfigured pair is far likelier than a genuine 24-hour rota, and zero is
  // the answer a caller can detect and fall back from.
  const duration = end > start ? end - start : end + MINUTES_PER_DAY - start;

  return {
    startMinutes: start,
    durationMinutes: end === start ? 0 : duration,
    crossesMidnight: end <= start && end !== start,
  };
}

/**
 * How long a shift asks for, in hours.
 *
 * A FLEXIBLE row's length is the `requiredHours` it was written with, because
 * that is the only thing it stores — the type exists precisely to say "eight
 * hours, arrange them yourself". Everything else measures its own window.
 */
export function shiftHours(
  shift: ShiftWindow & { requiredHours?: number | null },
): number {
  if (shift.shiftType === 'FLEXIBLE') {
    return shift.requiredHours != null ? round2(shift.requiredHours) : 0;
  }
  const window = resolveWindow(shift);
  if (!window) {
    return shift.requiredHours != null ? round2(shift.requiredHours) : 0;
  }
  return round2(window.durationMinutes / 60);
}

/**
 * Do two shifts on the SAME date collide?
 *
 * One definition, read by the create path, the bulk path, the conflicts
 * endpoint and the hub's window sweep. Two definitions of "overlap" is how one
 * screen refuses a shift the other reports as fine.
 *
 * Intervals are HALF-OPEN — an end equal to the next start is a split day, not
 * an overlap — and a FLEXIBLE shift is date-level exclusive in both directions
 * because it has no window for anything to fit around.
 *
 * A shift that crosses midnight is compared on the dial by splitting it at
 * midnight rather than by extending it past 1440: the second half belongs to the
 * following DATE, and rows are only ever compared within one date here, so
 * folding it back is what keeps a 22:00–06:00 night shift from colliding with
 * its own next occurrence.
 */
export function windowsConflict(a: ShiftWindow, b: ShiftWindow): boolean {
  if (a.shiftType === 'FLEXIBLE' || b.shiftType === 'FLEXIBLE') return true;

  const first = resolveWindow(a);
  const second = resolveWindow(b);
  // A row with no readable window cannot be proven to collide with anything.
  // Refusing it would block every legal edit of a half-configured legacy row.
  if (!first || !second) return false;
  if (first.durationMinutes === 0 || second.durationMinutes === 0) return false;

  return segmentsOf(first).some((x) =>
    segmentsOf(second).some((y) => x.from < y.to && y.from < x.to),
  );
}

/** One window as the one or two same-day spans it actually occupies. */
function segmentsOf(
  window: ResolvedWindow,
): Array<{ from: number; to: number }> {
  const end = window.startMinutes + window.durationMinutes;
  if (end <= MINUTES_PER_DAY) return [{ from: window.startMinutes, to: end }];
  return [
    { from: window.startMinutes, to: MINUTES_PER_DAY },
    { from: 0, to: end - MINUTES_PER_DAY },
  ];
}

/**
 * Add one shift to a 24-slot hourly tally.
 *
 * A NIGHT shift running 22:00→06:00 covers hours on both sides of midnight and
 * is counted in both, because a scheduler asking "who is on at 2 AM" means it
 * literally.
 *
 * Returns false when the row has no window to place — FLEXIBLE, or a fixed type
 * missing a clock. The caller counts those separately so a panel can say
 * "12 flexible not shown" rather than quietly under-drawing the morning.
 */
export function addToHourlyTally(
  shift: ShiftWindow,
  perHour: number[],
): boolean {
  const window = resolveWindow(shift);
  if (!window || window.durationMinutes === 0) return false;

  const startHour = Math.floor(window.startMinutes / 60);
  // A shift ending at 06:30 occupies the 6 o'clock hour, so partial hours round
  // up. Rounding down would report an empty hour somebody is standing in.
  const spanHours = Math.min(24, Math.ceil(window.durationMinutes / 60));

  for (let i = 0; i < spanHours; i += 1) {
    perHour[(startHour + i) % 24] += 1;
  }
  return true;
}

/** "12 AM", "1 PM" — the label under a 24-hour bucket. */
export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${hour % 12 === 0 ? 12 : hour % 12} ${suffix}`;
}

/** "08:00" → "8:00 AM". Empty string for anything that is not a wall clock. */
export function formatWallClock12h(value?: string | null): string {
  const minutes = parseWallClock(value);
  if (minutes === null) return '';
  const hour = Math.floor(minutes / 60);
  const minute = String(minutes % 60).padStart(2, '0');
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${suffix}`;
}

/** The middle value — a window's own normal, whatever its size. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Scheduled against expected, reconciled so a rate can never exceed 100%.
 *
 * Two facts collide here. The working week is a BRANCH property — one branch
 * rests Friday, another Sunday — so `expected` for a day counts only the
 * branches that were open. But the roster is company-wide, and somebody from a
 * closed branch can legitimately be rostered on that day. Divide one by the
 * other and a Saturday with three people on it against two expected reports
 * 150% covered.
 *
 * Taking `max(expected, scheduled)` can only ever RAISE the denominator, so it
 * never hides an unassigned person — it only stops a rate claiming more than
 * everybody. The same shape as `reconcileExpected` in the attendance hub, which
 * exists for the same reason.
 *
 * A day the calendar expects NOBODY has no coverage rate at all: 100% would say
 * the day was fully staffed and 0% that it was abandoned, and neither is a claim
 * about a day the branch was shut.
 */
export function coverageRate(
  scheduled: number,
  expected: number,
): number | null {
  if (expected <= 0) return null;
  const denominator = Math.max(expected, scheduled);
  return Math.round((scheduled / denominator) * 1000) / 10;
}
