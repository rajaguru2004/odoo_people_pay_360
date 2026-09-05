import type { ApiClient } from './fixtures';

/**
 * Date allocation for the Leave & Overtime browser specs.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Leave's overlap rule (`leave-requests.service.ts`, per employee, over
 * `PENDING | APPROVED`) makes a contiguous date RANGE the scarcest resource in
 * this module. Overtime adds a second axis: one request per employee per date,
 * plus daily / monthly / yearly hour caps that accumulate across a whole run
 * and are never reset.
 *
 * The existing specs use `RUN_NUDGE = Date.now() % 180`, evaluated at module
 * load — so it is a different value in every spec file and, in CI with two
 * workers, in every worker. That is a random spread, not an allocation: it
 * works most of the time and cannot be reasoned about. It exists only because
 * people ran without resetting the database, which `scripts/e2e-db.sh` already
 * guarantees (`CREATE DATABASE ess_e2e TEMPLATE ess_baseline`).
 *
 * New specs use deterministic absolute offsets instead:
 *
 *     day   0 – 120   attendance, schedules, holidays, payroll  (do not enter)
 *     day 121 – 479   LEGACY band — the untouched nudge specs:
 *                       leave.spec.ts     max = 179 + 282 + 2 = 463
 *                       overtime.spec.ts  max =  59 + 120     = 179
 *     day 480 +       the Leave & Overtime sandbox — this file
 *
 * ── Lanes ───────────────────────────────────────────────────────────────────
 *
 * 40 days each, slot width 4 (a 3-day request plus one clear day, so an
 * off-by-one in `getWorkDaysBetween` can never bridge two slots):
 *
 *     L1  480–519  leave-request.spec.ts     employee1
 *     L2  520–559  leave-approval.spec.ts    employee1 (API) + manager
 *     L3  560–599  leave-balances.spec.ts    employee1 (API)
 *     L4  600–639  approval-chain.spec.ts    employee2 (API)
 *     L5  640–679  spare — the first place to grow
 *
 * ── Overtime is allocated by MONTH, not by day ──────────────────────────────
 *
 * The monthly cap (default 30h) and the yearly cap (200h) are the real
 * constraint, and they are cumulative for the whole run:
 *
 *   | Lane   | Month        | Owner                        | Budget (employee1) |
 *   |--------|--------------|------------------------------|--------------------|
 *   | OT-A   | today + 13mo | overtime-request (happy path)| ≤ 12h over ≤ 5 dates |
 *   | OT-B   | today + 14mo | overtime-request (cap cases) | seeded to 28h, then one 4h claim proves the refusal |
 *   | OT-C   | today + 15mo | overtime-approval            | ≤ 12h over ≤ 5 dates |
 *   | OT-D   | today + 16mo | approval-chain (employee2)   | ≤ 6h |
 *
 * Rules that follow:
 *
 *   - **OT-B is a burn month.** Its seeded hours are deliberately unusable by
 *     anything else; nothing else may file there.
 *   - Total for `employee1` across a run stays around 45h, well inside the
 *     200h yearly cap. A spec that changes its budget edits this table.
 *   - `overtime.spec.ts` files 3 × 3h inside days 0–180 (months 0–6) — in the
 *     legacy band, out of every lane above.
 *   - OT-D uses `employee2` and could safely reuse OT-A's month. It does not,
 *     deliberately, so a reader never has to hold both axes at once.
 *
 * ── Ordering constraint ─────────────────────────────────────────────────────
 *
 * `leave-balances.spec.ts` drives `runAccrual()` and `setBulkDefaultBalances()`,
 * which mutate EVERY employee's balance company-wide. It must be the last leave
 * file to run, with those two cases last within it, and every balance assertion
 * elsewhere must be written as a delta rather than an absolute.
 */

export type Lane = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9';

const LANE_BASE: Record<Lane, number> = {
  L1: 480,
  L2: 520,
  L3: 560,
  L4: 600,
  L5: 640,
  // L6–L9 exist because a spec that runs in ALL FOUR Playwright projects needs
  // a lane PER PROJECT: they share one employee and one database, and leave
  // refuses an overlapping range, so two projects filing into one lane collide
  // and the second reports an overlap that reads exactly like a broken rule.
  L6: 680,
  L7: 720,
  L8: 760,
  L9: 800,
};

/** One lane per Playwright project, for the specs that run in all of them. */
export function laneForProject(projectName: string): Lane {
  const byProject: Record<string, Lane> = {
    admin: 'L6',
    hr: 'L7',
    manager: 'L8',
    employee: 'L9',
  };
  return byProject[projectName] ?? 'L6';
}

/** Slot width: a 3-day request plus one clear day between slots. */
const SLOT_DAYS = 4;

const iso = (d: Date) => d.toISOString().slice(0, 10);

function dayFromToday(offset: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

/**
 * A leave window inside `lane`, `slot` slots in. Slots never overlap, and a
 * window never crosses into the next slot.
 */
export function leaveWindow(
  lane: Lane,
  slot: number,
  lengthDays = 3,
): { start: string; end: string } {
  if (lengthDays > SLOT_DAYS - 1) {
    throw new Error(
      `windows.ts: a ${lengthDays}-day request does not fit a ${SLOT_DAYS}-day slot — widen SLOT_DAYS or split the case`,
    );
  }
  const start = dayFromToday(LANE_BASE[lane] + slot * SLOT_DAYS);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + lengthDays - 1);
  return { start: iso(start), end: iso(end) };
}

/** A single free day inside a lane — for the one-request-per-date OT rule. */
export function otDay(lane: Lane, slot: number): string {
  return iso(dayFromToday(LANE_BASE[lane] + slot * SLOT_DAYS));
}

/** The month this lane's overtime lives in. See the budget table above. */
export function otMonth(lane: Lane): { year: number; month: number } {
  const monthsAhead: Record<Lane, number> = {
    L1: 13,
    L2: 14,
    L3: 15,
    L4: 16,
    L5: 17,
    L6: 18,
    L7: 19,
    L8: 20,
    L9: 21,
  };
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + monthsAhead[lane]);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** A date inside this lane's overtime month, `index` working days in. */
export function otMonthDay(lane: Lane, index: number): string {
  const { year, month } = otMonth(lane);
  const d = new Date(Date.UTC(year, month - 1, 1));
  let found = 0;
  for (let i = 0; i < 31; i++) {
    const day = new Date(Date.UTC(year, month - 1, 1 + i));
    if (day.getUTCMonth() !== month - 1) break;
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue; // the seeded branch rests Sat+Sun
    if (found === index) return iso(day);
    found++;
  }
  return iso(d);
}

/**
 * Fails loudly when the lane already holds requests for this employee.
 *
 * Without it, a stale database produces "Leave request overlaps with existing
 * request (…)" — a message that reads exactly like a broken product rule. This
 * is the only way the scheme can fail, so it is worth naming.
 */
export async function assertLaneClean(
  api: ApiClient,
  lane: Lane,
  ownMarker?: string,
): Promise<void> {
  // `/my-requests`, not `/employee/:id`: the latter is ADMIN/HR/MANAGER only, so
  // the employee whose lane this is could not check their own.
  const from = leaveWindow(lane, 0).start;
  const to = leaveWindow(lane, 9, 3).end;
  const existing = await api.get<Array<{ id: string; startDate: string; reason?: string }>>(
    `/leave-requests/my-requests?startDate=${from}&endDate=${to}`,
  );
  // Rows this very run filed are not staleness — Playwright re-runs `beforeAll`
  // for a retried test, so without this a single retry would report the
  // database dirty because of the attempt that is being retried.
  const rows = (Array.isArray(existing) ? existing : []).filter(
    (r) => !ownMarker || !(r.reason ?? '').includes(ownMarker),
  );
  if (rows.length > 0) {
    throw new Error(
      `windows.ts: lane ${lane} already holds ${rows.length} leave request(s). ` +
        'The database is stale — run `npm run e2e:db reset` before this suite.',
    );
  }
}
