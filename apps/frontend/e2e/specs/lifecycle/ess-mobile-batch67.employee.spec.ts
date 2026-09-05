import { test } from '../../fixtures';
import { PHONE, auditPhoneScreen } from '../../mobile-audit';

/**
 * Batches 6 and 7 — the long tail.
 *
 * `settings` is in scope for the three tabs an employee can actually reach
 * (general, notifications, security) plus the tab rail they reach them
 * through; the thirteen admin-only tabs keep their current layout, because a
 * phone pass on a screen no employee can open is unverifiable.
 */

test.use(PHONE);

const isEmployee = () => test.info().project.name === 'employee';

const SCREENS = [
  { id: 'B6-02', path: '/dashboard/approvals', ready: 'ess-approvals', label: 'approvals' },
  { id: 'B7-01', path: '/dashboard/profile', ready: 'ess-profile', label: 'my profile' },
  { id: 'B7-02', path: '/dashboard/settings', ready: 'ess-settings', label: 'settings' },
  { id: 'B7-03', path: '/dashboard/face-recognition', ready: 'ess-face-recognition', label: 'face recognition' },
  { id: 'B7-04', path: '/dashboard/my-department', ready: 'ess-my-department', label: 'my department' },
  { id: 'B7-05', path: '/dashboard/my-department/team-balances', ready: 'ess-team-balances', label: 'team balances' },
] as const;

test.describe('Batches 6 and 7 on a phone', () => {
  test.beforeEach(() => {
    test.skip(!isEmployee(), 'the phone layout is the ESS portal');
  });

  for (const screen of SCREENS) {
    test(`ESS-MOB-${screen.id} ${screen.label}`, async ({ page, problems }) => {
      await auditPhoneScreen(page, screen.path, {
        problems,
        ready: screen.ready,
        label: screen.label,
        shot: screen.ready,
      });
    });
  }
});
