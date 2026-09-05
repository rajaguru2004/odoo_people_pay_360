import { test, expect, ApiClient } from '../../fixtures';
import {
  clearPayrollLane,
  dateIn,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  itemsOf,
  marker,
  runEdgePayroll,
  seedOvertime,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * The overtime engine, as payroll sees it.
 *
 * ## What is asserted, and what deliberately is not
 *
 * Not asserted: what an hour of overtime is worth. That is a function of the
 * hourly rate, the tier and the policy, it has unit coverage already
 * (`payrolls-overtime.spec.ts`, `overtime-cycle.spec.ts`,
 * `overtimeCalc.test.ts`), and re-deriving it here would only pin this
 * environment's configuration.
 *
 * Asserted instead: that the RIGHT TIER was chosen, and that the tier's
 * multiplier is the one the policy states. Both are expressed as ratios — a
 * weekend claim against an identical weekday claim, compared with
 * `rules.sunday.regularRate / rules.regularRate` read from the policy itself. So
 * if someone changes the company default from 2.0/1.5 to 2.5/1.25, this file
 * still passes; if someone breaks day classification, it fails.
 *
 * ## The tiers, as the shipped default policy defines them
 *
 *   weekday evening  → `dayType: WEEKDAY`, hours land in `regularHours`, rate 1.5
 *   weekend          → `dayType: SUNDAY`,  hours land in `doubleHours`,  rate 2.0
 *
 * Measured on the seeded Company Default: 3 hours on a Wednesday paid 38.35, the
 * same 3 hours on a Saturday paid 51.14 — a ratio of 1.334, which is 2.0/1.5.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-ot-';
const MARK = marker(MARKER_PREFIX);

/** Rates the assertions are derived from, read from the policy under test. */
interface OtRules {
  regularRate: number;
  doubleRate: number;
  sunday?: { regularRate?: number };
  maxHoursPerDay?: number;
  eligible?: boolean;
}

/** The first weekday (Mon–Fri) and the first weekend day in a period. */
function firstWeekdayAndWeekend(p: Period): { weekday: number; weekend: number } {
  let weekday = 0;
  let weekend = 0;
  const last = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(p.year, p.month - 1, d)).getUTCDay();
    if (!weekday && dow >= 1 && dow <= 5) weekday = d;
    if (!weekend && (dow === 0 || dow === 6)) weekend = d;
    if (weekday && weekend) break;
  }
  return { weekday, weekend };
}

test.describe('overtime against payroll', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let rules: OtRules | null = null;
  let policyName = '';
  let setupError = '';

  const P_TIERS: Period = edgePeriod(30);
  const P_LATE: Period = edgePeriod(31);
  const P_UNAPPROVED: Period = edgePeriod(32);
  const ALL = [P_TIERS, P_LATE, P_UNAPPROVED];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      admin = await ApiClient.as('admin');
      branchId = await ensurePayrollEdgeBranch(admin);
      carrier = await ensureCarrier(admin, branchId, MARK);
      await clearPayrollLane(admin, branchId, ALL);

      // Read the policy this run will actually be priced by, rather than
      // assuming the shipped defaults. Every rate assertion below derives from
      // this.
      const raw = await admin.get<unknown>('/overtime-policies');
      const list = (Array.isArray(raw) ? raw : ((raw as { data?: unknown[] })?.data ?? [])) as Array<{
        name: string;
        isDefault: boolean;
        isActive: boolean;
        rules: OtRules;
      }>;
      const active = list.find((p) => p.isDefault && p.isActive) ?? list[0];
      rules = active?.rules ?? null;
      policyName = active?.name ?? '';
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await clearPayrollLane(admin, branchId, ALL).catch(() => undefined);
    await admin?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'payroll is ADMIN/HR territory');
      expect(setupError, `setup failed: ${setupError}`).toBe('');
    });

    test('an employee’s effective policy is resolved, and says where it came from', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-resolve`,
        branchId,
        baseSalary: 1500,
      });

      const raw = await admin.get<unknown>(`/overtime-policies/resolve/${subject.id}`);
      const r = ((raw as { data?: Record<string, unknown> })?.data ?? raw) as Record<string, unknown>;

      // The chain is employee override → employmentType policy → company default
      // → legacy global settings, and `source` is how the screen explains which
      // one applied. An employee with no override and no employment type must
      // land on the company default; if this ever says EMPLOYEE or
      // EMPLOYMENT_TYPE for a plain new hire, the resolution order has moved.
      expect(r.source, 'a plain employee resolves to the company default').toBe('COMPANY_DEFAULT');
      expect(r.effectivePolicyId, 'and a concrete policy is named').toBeTruthy();
      expect(r.eligible, 'who is eligible for overtime at all').toBe(true);
      expect(r.overtimePolicyId, 'with no per-employee override in play').toBeFalsy();
    });

    test('a weekend claim is priced at the weekend tier, in the ratio the policy states', async () => {
      expect(rules, `no overtime policy found to test against (policy: ${policyName})`).toBeTruthy();
      const regularRate = Number(rules!.regularRate);
      const weekendRate = Number(rules!.sunday?.regularRate ?? rules!.doubleRate);
      expect(regularRate, 'the policy states a weekday rate').toBeGreaterThan(0);
      expect(weekendRate, 'and a weekend rate').toBeGreaterThan(0);

      const { subject: onWeekday, twin: onWeekend } = await twinPair(admin, {
        marker: `${MARK}-tiers`,
        branchId,
        baseSalary: 1500,
      });
      const { subject: noOvertime } = await twinPair(admin, {
        marker: `${MARK}-tiers-control`,
        branchId,
        baseSalary: 1500,
      });

      const { weekday, weekend } = firstWeekdayAndWeekend(P_TIERS);
      // Identical claims — same length, same clock hours, same employee salary.
      // The ONLY difference is which day of the week they fall on.
      const HOURS = 3;
      const wdDate = dateIn(P_TIERS, weekday);
      const weDate = dateIn(P_TIERS, weekend);
      await seedOvertime(admin, branchId, onWeekday.id, wdDate, `${wdDate}T18:00:00.000Z`, `${wdDate}T21:00:00.000Z`, HOURS);
      await seedOvertime(admin, branchId, onWeekend.id, weDate, `${weDate}T18:00:00.000Z`, `${weDate}T21:00:00.000Z`, HOURS);

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_TIERS,
        employeeIds: [onWeekday.id, onWeekend.id, noOvertime.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const wd = items.find((i) => i.employeeId === onWeekday.id)!;
      const we = items.find((i) => i.employeeId === onWeekend.id)!;
      const none = items.find((i) => i.employeeId === noOvertime.id)!;

      expect(none.overtimePay, 'the control claimed nothing and was paid nothing extra').toBe(0);
      expect(wd.overtimeHours, 'the weekday claim reached the run').toBe(HOURS);
      expect(we.overtimeHours, 'so did the weekend one').toBe(HOURS);
      expect(wd.overtimePay, 'and both were priced').toBeGreaterThan(0);
      expect(we.overtimePay, 'both were priced').toBeGreaterThan(0);

      // The assertion that matters: the SAME hours are worth more at the weekend,
      // by exactly the factor the policy declares.
      const observed = we.overtimePay / wd.overtimePay;
      const expected = weekendRate / regularRate;
      expect(
        observed,
        `weekend/weekday overtime should be ${expected.toFixed(3)} ` +
          `(policy "${policyName}": ${weekendRate} vs ${regularRate}), observed ${observed.toFixed(3)}`,
      ).toBeCloseTo(expected, 2);

      // And both raise take-home above the colleague who worked no overtime.
      expect(wd.netSalary, 'weekday overtime is paid').toBeGreaterThan(none.netSalary);
      expect(we.netSalary, 'weekend overtime is paid more').toBeGreaterThan(wd.netSalary);
    });

    test('an overtime claim approved AFTER the run does not change it', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-late`,
        branchId,
        baseSalary: 1500,
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_LATE,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const before = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      expect(before.overtimePay, 'nothing was claimed before the run').toBe(0);

      const { weekday } = firstWeekdayAndWeekend(P_LATE);
      const day = dateIn(P_LATE, weekday);
      await seedOvertime(admin, branchId, subject.id, day, `${day}T18:00:00.000Z`, `${day}T20:00:00.000Z`, 2);

      const after = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      // A run is a snapshot. Overtime approved behind it belongs to the next run
      // or to a revision — never retroactively to a figure already produced.
      expect(after.overtimePay, 'the existing run is not recomputed').toBe(before.overtimePay);
      expect(after.netSalary, 'and its net is unchanged').toBe(before.netSalary);
    });

    test('an UNAPPROVED claim is not paid', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-unapproved`,
        branchId,
        baseSalary: 1500,
      });

      const { weekday } = firstWeekdayAndWeekend(P_UNAPPROVED);
      const day = dateIn(P_UNAPPROVED, weekday);
      // Filed and deliberately left PENDING. This is the case that proves the run
      // filters on status rather than paying whatever it finds — and it is why
      // `seedOvertime` approves by default: a spec that forgot would assert that
      // overtime had no effect and be right for the wrong reason.
      await seedOvertime(
        admin,
        branchId,
        subject.id,
        day,
        `${day}T18:00:00.000Z`,
        `${day}T21:00:00.000Z`,
        3,
        { approve: false },
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_UNAPPROVED,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(s.overtimeHours, 'a pending claim contributes no hours').toBe(0);
      expect(s.overtimePay, 'and no money').toBe(0);
      expect(s.netSalary, 'so the claimant is paid exactly like the colleague who claimed nothing')
        .toBe(t.netSalary);
    });
  });
});
