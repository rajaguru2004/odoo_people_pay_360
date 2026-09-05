import { test } from '../../fixtures';
import { PHONE, auditPhoneScreen } from '../../mobile-audit';

/**
 * Batch 1 — the four screens the phone tab bar points at.
 *
 * One file rather than four, deliberately: every one of these is the same
 * fifteen-line audit call, and the suite pays a full Next production build per
 * Playwright invocation. Four files would quadruple that for no extra coverage.
 * A screen that grows cases of its own (a sheet to open, a form to submit) gets
 * its own file at that point — see `ess-mobile-dashboard` for the shape.
 *
 * The dashboard itself is verified in `ess-mobile-dashboard.employee.spec.ts`.
 */

test.use(PHONE);

const isEmployee = () => test.info().project.name === 'employee';

test.describe('Batch 1 on a phone', () => {
  test.beforeEach(() => {
    test.skip(!isEmployee(), 'the phone layout is the ESS portal');
  });

  test('ESS-MOB-B1-01 my attendance', async ({ page, problems }) => {
    await auditPhoneScreen(page, '/dashboard/my-attendance', {
      problems,
      ready: 'ess-my-attendance',
      label: 'my attendance',
      shot: 'ess-my-attendance',
      // The punch card polls and the timeline animates in.
      settleMs: 1200,
    });
  });

  test('ESS-MOB-B1-02 my leaves', async ({ page, problems }) => {
    await auditPhoneScreen(page, '/dashboard/my-leaves', {
      problems,
      ready: 'ess-my-leaves',
      label: 'my leaves',
      shot: 'ess-my-leaves',
    });
  });

  test('ESS-MOB-B1-03 my payslips', async ({ page, problems }) => {
    await auditPhoneScreen(page, '/dashboard/payroll', {
      problems,
      ready: 'ess-payroll',
      label: 'my payslips',
      shot: 'ess-payroll',
    });
  });

  test('ESS-MOB-B1-04 a payslip', async ({ page, problems }) => {
    // The detail route needs a real record, so it is reached the way an
    // employee reaches it — through the list — rather than by a guessed id.
    await page.goto('/dashboard/payroll');
    const firstCard = page.getByTestId("payslip-card-open").first();
    const count = await firstCard.count();
    test.skip(count === 0, 'no payslip in this database to open');

    await firstCard.click();
    await page.waitForURL('**/dashboard/my-payroll/**');

    await auditPhoneScreen(page, page.url(), {
      problems,
      ready: 'ess-payslip',
      label: 'a payslip',
      shot: 'ess-payslip',
    });
  });
});
