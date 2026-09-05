import { hasOpenSession, latestPunchAt } from './attendance-punch.util';

/**
 * The reported bug, in one line: a check-in at 14:32 was confirmed as "14:24".
 *
 * `attendance.checkIn` is the first check-in of the DAY and never moves, so
 * with multiple check-ins enabled the confirmation quoted the morning instead
 * of the punch just made.
 */

const MORNING = '2026-08-10T08:54:13.308Z';
const NOON_OUT = '2026-08-10T09:01:54.953Z';
const SECOND_IN = '2026-08-10T09:02:56.579Z';

/** The exact row shape that produced the wrong confirmation. */
const REAL_ROW = {
  checkIn: MORNING,
  checkOut: null,
  sessions: [
    { checkIn: MORNING, checkOut: NOON_OUT },
    { checkIn: SECOND_IN, checkOut: null },
  ],
};

describe('latestPunchAt', () => {
  it('returns the LATEST check-in, not the day-opening one', () => {
    expect(latestPunchAt(REAL_ROW, 'in')).toBe(SECOND_IN);
  });

  it('returns the latest check-out', () => {
    expect(latestPunchAt(REAL_ROW, 'out')).toBe(NOON_OUT);
  });

  it('falls back to the column when there are no sessions', () => {
    // Rows written before sessions existed, and any path that skips them.
    expect(latestPunchAt({ checkIn: MORNING, checkOut: NOON_OUT }, 'in')).toBe(MORNING);
    expect(latestPunchAt({ checkIn: MORNING, checkOut: NOON_OUT }, 'out')).toBe(NOON_OUT);
  });

  it('ignores lunch sessions', () => {
    // Confirming a check-out with the moment lunch began is a different lie.
    const row = {
      checkIn: MORNING,
      sessions: [
        { checkIn: MORNING, checkOut: NOON_OUT },
        { type: 'LUNCH', checkIn: NOON_OUT, checkOut: SECOND_IN },
      ],
    };
    expect(latestPunchAt(row, 'in')).toBe(MORNING);
    expect(latestPunchAt(row, 'out')).toBe(NOON_OUT);
  });

  it('skips an open session when looking for a check-out', () => {
    // The newest session has checkOut: null; the answer is the one before it.
    expect(latestPunchAt(REAL_ROW, 'out')).toBe(NOON_OUT);
  });

  it.each([
    ['{ success, data }', { success: true, data: REAL_ROW }],
    ['{ data: { attendance } }', { data: { attendance: REAL_ROW } }],
    ['bare row', REAL_ROW],
  ])('unwraps the %s envelope', (_label, payload) => {
    expect(latestPunchAt(payload, 'in')).toBe(SECOND_IN);
  });

  it.each([null, undefined, 'nonsense', 42, {}, { sessions: 'not-an-array' }])(
    'yields null for %p rather than an Invalid Date',
    (payload) => {
      expect(latestPunchAt(payload, 'in')).toBeNull();
    },
  );

  it('ignores an unparseable timestamp inside a session', () => {
    const row = { checkIn: MORNING, sessions: [{ checkIn: 'not a date' }] };
    expect(latestPunchAt(row, 'in')).toBe(MORNING);
  });

  it('accepts Date objects as well as ISO strings', () => {
    const row = { sessions: [{ checkIn: new Date(SECOND_IN) }] };
    expect(latestPunchAt(row, 'in')).toBe(SECOND_IN);
  });
});

describe('hasOpenSession', () => {
  it('is TRUE mid-shift after an earlier check-out', () => {
    // The columns both say something here — checkIn 08:54, checkOut 09:01 —
    // so the naive `checkIn && checkOut` test declared "already checked out"
    // at somebody who was standing in the office, checked in.
    expect(hasOpenSession(REAL_ROW)).toBe(true);
  });

  it('is FALSE once every session is closed', () => {
    expect(
      hasOpenSession({
        checkIn: MORNING,
        checkOut: NOON_OUT,
        sessions: [{ checkIn: MORNING, checkOut: NOON_OUT }],
      }),
    ).toBe(false);
  });

  it('ignores an open LUNCH session', () => {
    // On a lunch break you are not checked in for work purposes.
    expect(
      hasOpenSession({
        sessions: [
          { checkIn: MORNING, checkOut: NOON_OUT },
          { type: 'LUNCH', checkIn: NOON_OUT, checkOut: null },
        ],
      }),
    ).toBe(false);
  });

  it('falls back to the columns without sessions', () => {
    expect(hasOpenSession({ checkIn: MORNING, checkOut: null })).toBe(true);
    expect(hasOpenSession({ checkIn: MORNING, checkOut: NOON_OUT })).toBe(false);
    expect(hasOpenSession({ status: 'NOT_CHECKED_IN' })).toBe(false);
  });

  it.each([null, undefined, 'nonsense', {}])('is false for %p', (payload) => {
    expect(hasOpenSession(payload)).toBe(false);
  });
});
