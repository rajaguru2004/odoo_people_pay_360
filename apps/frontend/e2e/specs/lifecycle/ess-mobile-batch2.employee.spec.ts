import { test, expect, ApiClient } from '../../fixtures';
import { PHONE, auditPhoneScreen } from '../../mobile-audit';
import { leaveWindow, otDay } from '../../windows';

/**
 * Batch 2 — the screens an employee writes on: filing leave and overtime,
 * reading the decision, and asking for an attendance correction.
 *
 * The two detail routes are reached the way an employee reaches them — through
 * their list — rather than by a guessed id. A spec that invents an id tests the
 * 404 page.
 *
 * They used to SKIP when the list was empty, which is what happens on a freshly
 * cloned database — so the two heaviest screens in this batch were implemented
 * and never actually audited. `beforeAll` now files one of each as the employee,
 * so the detail routes always have something real to open. It tolerates a
 * duplicate: the windows helper hands out a fixed calendar slot, and a re-run
 * against a database that was not reset would otherwise fail on an overlap
 * rather than on anything this spec is about.
 */

test.use(PHONE);

const isEmployee = () => test.info().project.name === 'employee';

test.describe('Batch 2 on a phone', () => {
  test.beforeEach(() => {
    test.skip(!isEmployee(), 'the phone layout is the ESS portal');
  });

  test.beforeAll(async () => {
    if (test.info().project.name !== 'employee') return;
    // The `api` fixture is admin-authenticated; these records must belong to
    // the employee whose screens are being audited, so it is their session.
    const self = await ApiClient.as('employee');
    // L5 — `e2e/windows.ts` documents it as the spare lane. This spec runs in
    // ONE project, so one lane is enough, and it must not share a lane with a
    // spec that files into the same fixed calendar slots.
    const { start, end } = leaveWindow('L5', 0);

    await self
      .post('/leave-requests', {
        leaveType: 'ANNUAL',
        startDate: start,
        endDate: end,
        reason: 'Phone audit fixture — a request the detail screen can open',
      })
      .catch(() => undefined);

    await self
      .post('/overtime', (() => {
        const date = otDay('L5', 1);
        return {
          date,
          // Full instants, the shape the API takes — not bare wall-clock times.
          startTime: `${date}T18:00:00.000Z`,
          endTime: `${date}T20:00:00.000Z`,
          hours: 2,
          reason: 'Phone audit fixture — a claim the detail screen can open',
        };
      })())
      .catch(() => undefined);
  });

  test('ESS-MOB-B2-01 filing leave', async ({ page, problems }) => {
    await auditPhoneScreen(page, '/dashboard/leaves/new', {
      problems,
      ready: 'ess-leave-new',
      label: 'the leave form',
      shot: 'ess-leave-new',
    });
  });

  test('ESS-MOB-B2-02 a leave request', async ({ page, problems }) => {
    await page.goto('/dashboard/my-leaves');
    const open = page.getByTestId('my-leave-card').first();
    await expect(open, 'the beforeAll fixture did not create a leave request').toHaveCount(1);

    await open.click();
    await page.waitForURL('**/dashboard/leaves/**');

    await auditPhoneScreen(page, page.url(), {
      problems,
      ready: 'ess-leave-detail',
      label: 'a leave request',
      shot: 'ess-leave-detail',
    });
  });

  test('ESS-MOB-B2-03 my overtime', async ({ page, problems }) => {
    await auditPhoneScreen(page, '/dashboard/my-overtime', {
      problems,
      ready: 'ess-my-overtime',
      label: 'my overtime',
      shot: 'ess-my-overtime',
    });
  });

  test('ESS-MOB-B2-04 logging overtime', async ({ page, problems }) => {
    await auditPhoneScreen(page, '/dashboard/overtime/new', {
      problems,
      ready: 'ess-overtime-new',
      label: 'the overtime form',
      shot: 'ess-overtime-new',
    });
  });

  test('ESS-MOB-B2-05 an overtime claim', async ({ page, problems }) => {
    await page.goto('/dashboard/my-overtime');
    const open = page.getByTestId('my-ot-card-details').first();
    await expect(open, 'the beforeAll fixture did not create an overtime claim').toHaveCount(1);

    await open.click();
    await page.waitForURL('**/dashboard/overtime/**');

    await auditPhoneScreen(page, page.url(), {
      problems,
      ready: 'ess-overtime-detail',
      label: 'an overtime claim',
      shot: 'ess-overtime-detail',
    });
  });

  test('ESS-MOB-B2-06 attendance corrections', async ({ page, problems }) => {
    await auditPhoneScreen(page, '/dashboard/attendance/corrections', {
      problems,
      ready: 'ess-corrections',
      label: 'attendance corrections',
      shot: 'ess-corrections',
    });
  });
});
