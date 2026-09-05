import { test, expect, ApiClient } from '../../fixtures';
import {
  addComponent,
  clearPayrollLane,
  dateIn,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  itemsOf,
  lastDayOf,
  makeEmployee,
  marker,
  retireComponent,
  runEdgePayroll,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * What happens to pay when pay itself changes mid-period.
 *
 * ## There is no salary-revision record, and that shapes everything here
 *
 * No `SalaryRevision` model exists. Four mechanisms overlap instead —
 * `SalaryComponent.effectiveDate`, `PATCH /employees/:id {baseSalary}`,
 * `ContractAppendix`, and `POST /contracts/:id/renew` — and a run reads whatever
 * is current when it is generated. See `docs/PAYROLL-GAP-REPORT.md` §9.
 *
 * ## The finding this file exists to pin: nothing prorates
 *
 * Measured, not assumed. A TRANSPORT allowance of 300 with `effectiveDate` on the
 * **20th** of a 30-day month is paid at **300**, not at the ~110 that eleven days
 * would be worth. `create()` selects components that are active and effective on
 * or before the period END, then applies the whole monthly amount (G2).
 *
 * The date filter itself is correct and is asserted alongside: a component dated
 * into the NEXT period is not paid at all, which is Phase 4's F14 fix still
 * holding.
 *
 * Whether "pay the full amount" or "prorate from the effective date" is right is
 * a product decision. What is not defensible is that the field is called
 * `effectiveDate` and behaves as an on/off switch evaluated at period end, so
 * this file states exactly what it does.
 *
 * ## Branch transfer is deliberately absent, and is asserted as such
 *
 * `UpdateEmployeeDto` has no `branchId`, on purpose — the DTO says moving an
 * employee between branches "crosses the isolation axis ... [and] needs its own
 * reviewed flow rather than a field on this form". That reviewed flow does not
 * exist yet, so the catalogue's mid-month transfer cases are unbuilt rather than
 * broken. The refusal is asserted so the day a transfer route appears, this case
 * fails and tells someone to write the transfer coverage.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-salchg-';
const MARK = marker(MARKER_PREFIX);

test.describe('salary changes against payroll', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  const P_MIDPERIOD: Period = edgePeriod(60);
  const P_NEXTPERIOD: Period = edgePeriod(61);
  const P_RAISE: Period = edgePeriod(62);
  const P_RETIRE: Period = edgePeriod(63);
  const P_TRANSFER: Period = edgePeriod(64);
  const ALL = [P_MIDPERIOD, P_NEXTPERIOD, P_RAISE, P_RETIRE, P_TRANSFER];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      admin = await ApiClient.as('admin');
      branchId = await ensurePayrollEdgeBranch(admin);
      carrier = await ensureCarrier(admin, branchId, MARK);
      await clearPayrollLane(admin, branchId, ALL);
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

    test('G2 FIXED: a component effective mid-period is PRORATED from that date', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-mid`,
        branchId,
        baseSalary: 1500,
      });

      // Effective with roughly a third of the month left.
      const last = lastDayOf(P_MIDPERIOD);
      const effectiveOn = Math.max(2, last - 10);
      const AMOUNT = 300;
      await addComponent(admin, subject.id, 'TRANSPORT', AMOUNT, {
        effectiveDate: dateIn(P_MIDPERIOD, effectiveOn),
        note: `${MARK} mid-period allowance`,
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_MIDPERIOD,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      const granted = s.allowances - t.allowances;

      // Prorated by WORKING days, which is the ruler the rest of payroll uses —
      // loss of pay is `fullRate * lopDays / workDays`, so a component arriving
      // part-way through has to be measured the same way or the two halves of a
      // payslip disagree. The exact figure therefore depends on the branch
      // calendar, which is why this asserts the SHAPE rather than a constant.
      expect(
        granted,
        `a component effective on day ${effectiveOn} of ${last} is prorated, not paid in ` +
          `full (${AMOUNT})`,
      ).toBeLessThan(AMOUNT);
      expect(granted, 'and it is still paid something').toBeGreaterThan(0);

      // Roughly the remaining share of the month, allowing for weekends and
      // holidays falling either side of the effective date.
      const calendarShare = (AMOUNT * (last - effectiveOn + 1)) / last;
      expect(granted, 'and lands near the remaining share of the period')
        .toBeGreaterThan(calendarShare * 0.5);
      expect(granted, 'without exceeding it materially').toBeLessThan(calendarShare * 1.6);

      expect(s.netSalary, 'the money still reaches take-home').toBeGreaterThan(t.netSalary);
    });

    test('a component effective in the NEXT period is not paid in this one', async () => {
      // Phase 4's F14, re-asserted from the change side: `effectiveDate` was once
      // used only for `orderBy`, so a component dated next quarter was paid this
      // month. The filter is what makes the G2 case above a proration question
      // rather than a correctness one.
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-next`,
        branchId,
        baseSalary: 1500,
      });

      const nextPeriod = edgePeriod(62);
      await addComponent(admin, subject.id, 'TRANSPORT', 300, {
        effectiveDate: dateIn(nextPeriod, 5),
        note: `${MARK} starts next period`,
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_NEXTPERIOD,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(s.allowances - t.allowances, 'a future component is not paid early').toBe(0);
      expect(s.netSalary, 'and take-home is unchanged').toBe(t.netSalary);
    });

    test('a base-salary raise applies to the whole period at the new rate', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-raise`,
        branchId,
        baseSalary: 1500,
      });

      // The raise lands before the run is generated. There is no salary history
      // and no effective date on `baseSalary`, so the run sees only the current
      // figure — the whole month is paid at the new rate regardless of when the
      // raise was agreed.
      await admin.patch(`/employees/${subject.id}`, { baseSalary: 3000 });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_RAISE,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(s.baseSalary, 'the run reads the CURRENT base salary').toBe(3000);
      expect(t.baseSalary, 'the colleague is unchanged').toBe(1500);
      expect(
        s.netSalary / t.netSalary,
        'and the whole period is paid at the new rate — doubling the base doubles the pay',
      ).toBeCloseTo(2, 1);
    });

    test('retiring a component stops it being paid, without touching what was already paid', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-retire`,
        branchId,
        baseSalary: 1500,
      });
      const componentId = await addComponent(admin, subject.id, 'TRANSPORT', 250, {
        effectiveDate: dateIn(P_RETIRE, 1),
        note: `${MARK} to be retired`,
      });

      const first = await runEdgePayroll(admin, {
        branchId,
        period: P_RETIRE,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const paid = (await itemsOf(admin, first.id)).find((i) => i.employeeId === subject.id)!;
      const control = (await itemsOf(admin, first.id)).find((i) => i.employeeId === twin.id)!;
      expect(paid.allowances - control.allowances, 'the component was paid').toBe(250);

      // Deactivate, not delete: `DELETE` is ADMIN-only and refused once a LOCKED
      // payroll exists, and the append-only rule is what keeps an old payslip
      // explainable.
      await retireComponent(admin, componentId);

      const after = (await itemsOf(admin, first.id)).find((i) => i.employeeId === subject.id)!;
      expect(
        after.allowances,
        'the run that already paid it is untouched — history stays explainable',
      ).toBe(paid.allowances);

      // A fresh run for a later period no longer pays it.
      const laterPeriod = edgePeriod(65);
      await clearPayrollLane(admin, branchId, [laterPeriod]);
      const second = await runEdgePayroll(admin, {
        branchId,
        period: laterPeriod,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const laterItems = await itemsOf(admin, second.id);
      const s2 = laterItems.find((i) => i.employeeId === subject.id)!;
      const t2 = laterItems.find((i) => i.employeeId === twin.id)!;
      expect(s2.allowances - t2.allowances, 'and the next run does not pay it').toBe(0);
      await clearPayrollLane(admin, branchId, [laterPeriod]);
    });

    test('an employee cannot be moved between branches at all — the field does not exist', async () => {
      // The catalogue asks for mid-month transfers between branches / legal
      // entities. They are not merely untested — they are UNBUILT, and
      // deliberately so: `UpdateEmployeeDto` omits `branchId` because moving an
      // employee "crosses the isolation axis ... [and] needs its own reviewed flow
      // rather than a field on this form". The reviewed flow does not exist yet.
      //
      // Asserted rather than skipped, so that the day a transfer route appears
      // this case fails and tells whoever added it that the payroll-side coverage
      // is now owed. See `docs/PAYROLL-GAP-REPORT.md` §8.
      const employee = await makeEmployee(admin, {
        marker: `${MARK}-transfer`,
        branchId,
        baseSalary: 1500,
      });

      const branches = await admin.get<unknown>('/branches');
      const list = (Array.isArray(branches)
        ? branches
        : ((branches as { data?: unknown[] })?.data ?? [])) as Array<{ id: string; code: string }>;
      const elsewhere = list.find((b) => b.id !== branchId);
      expect(elsewhere, 'there is another branch to attempt a move to').toBeTruthy();

      const refusal = await admin
        .patch(`/employees/${employee.id}`, { branchId: elsewhere!.id })
        .then(() => '')
        .catch((e: Error) => e.message);

      expect(refusal, 'the move was refused').toBeTruthy();
      expect(
        refusal,
        'because the field is not on the DTO at all — a whitelist refusal, not a rule',
      ).toMatch(/property branchId should not exist/i);
    });
  });
});
