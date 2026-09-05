import { test } from '../../fixtures';
import { PHONE, auditPhoneScreen } from '../../mobile-audit';

/**
 * Batch 5 — time: the calendar, timesheets and work logs.
 *
 * `my-calendar` is the one screen in the portal that genuinely cannot be a
 * single responsive tree: FullCalendar takes its view and its toolbar as props,
 * not as classes. It is now two instances behind the same `md:hidden` /
 * `hidden md:block` split as everything else, with no `useIsMobile()` and no
 * remount — see D-02 in docs/ESS-MOBILE-UI-TRACKER.md.
 */

test.use(PHONE);

const isEmployee = () => test.info().project.name === 'employee';

const SCREENS: ReadonlyArray<{
  id: string;
  path: string;
  ready: string;
  label: string;
  /** FullCalendar mounts, measures, then paints; 700ms is not enough for it. */
  settleMs?: number;
}> = [
  { id: 'B5-01', path: '/dashboard/my-calendar', ready: 'ess-my-calendar', label: 'my calendar', settleMs: 1500 },
  { id: 'B5-02', path: '/dashboard/my-timesheets', ready: 'ess-my-timesheets', label: 'my timesheets' },
  { id: 'B5-03', path: '/dashboard/timesheets', ready: 'ess-timesheets', label: 'timesheets' },
  { id: 'B5-04', path: '/dashboard/timesheets/new', ready: 'ess-timesheet-new', label: 'a new timesheet' },
  { id: 'B5-05', path: '/dashboard/work-logs', ready: 'ess-work-logs', label: 'work logs' },
];

test.describe('Batch 5 on a phone', () => {
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
        settleMs: screen.settleMs,
      });
    });
  }
});
