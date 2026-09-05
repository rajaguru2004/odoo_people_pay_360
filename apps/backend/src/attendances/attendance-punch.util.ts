/**
 * When the punch that JUST happened actually happened.
 *
 * `attendance.checkIn` is the first check-in of the DAY and never moves once
 * set. With `allow_multiple_checkin` on, a second check-in only appends to the
 * `sessions` array — so reading the column to confirm a punch tells the
 * employee the time of their morning, not the time of the thing they just did.
 * That is exactly how a 14:32 check-in got confirmed as "14:24".
 *
 * The sessions array IS the record of individual punches, so the answer is the
 * last one. The column stays the fallback for rows written before sessions
 * existed, and for any service path that does not maintain them.
 *
 * Pure and defensive: these payloads cross a tool boundary and arrive as loose
 * JSON, so every shape that is not a usable instant yields null rather than an
 * "Invalid Date" on somebody's phone.
 */

export type PunchKind = 'in' | 'out';

interface SessionLike {
  checkIn?: unknown;
  checkOut?: unknown;
  type?: unknown;
}

/**
 * @param payload  An attendance row, or anything wrapping one.
 * @param kind     'in' for a check-in / end-of-lunch, 'out' for the reverse.
 */
export function latestPunchAt(payload: unknown, kind: PunchKind): string | null {
  const row = unwrapAttendance(payload);
  if (!row) return null;

  const sessions = Array.isArray(row.sessions) ? (row.sessions as SessionLike[]) : [];

  // Work sessions only. A lunch break is its own session, and confirming a
  // check-out with the moment lunch started would be a different lie.
  const work = sessions.filter((s) => s && typeof s === 'object' && s.type !== 'LUNCH');

  // Walk BACKWARDS: the punch we are confirming is the most recent one, and an
  // earlier session may legitimately carry the same field (every closed
  // session has a checkOut).
  for (let i = work.length - 1; i >= 0; i--) {
    const at = toIso(kind === 'in' ? work[i].checkIn : work[i].checkOut);
    if (at) return at;
  }

  return toIso(kind === 'in' ? row.checkIn : row.checkOut);
}

/** Services wrap results inconsistently, and some nest the row a second time. */
function unwrapAttendance(
  payload: unknown,
): { checkIn?: unknown; checkOut?: unknown; sessions?: unknown } | null {
  let node: any = payload;
  for (let depth = 0; node && typeof node === 'object' && depth < 4; depth++) {
    if ('sessions' in node || 'checkIn' in node || 'checkOut' in node) return node;
    node = node.data ?? node.attendance;
  }
  return null;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Is a work session open right now?
 *
 * The columns cannot answer this. `checkIn` is the day's first and never
 * moves; `checkOut` is overwritten by every check-out. So after
 * in -> out -> in, BOTH are set while the employee is very much checked in —
 * which made "already checked out" fire at somebody mid-shift.
 *
 * The sessions array is the only place the truth lives: an open session is one
 * with no checkOut. Falls back to the columns for rows that predate sessions.
 */
export function hasOpenSession(payload: unknown): boolean {
  const row = unwrapAttendance(payload);
  if (!row) return false;

  const sessions = Array.isArray(row.sessions) ? (row.sessions as SessionLike[]) : [];
  const work = sessions.filter((s) => s && typeof s === 'object' && s.type !== 'LUNCH');
  if (work.length) return work.some((s) => !s.checkOut);

  return Boolean(row.checkIn) && !row.checkOut;
}
