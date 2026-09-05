import { test } from '../../fixtures';
import { PHONE, auditPhoneScreen } from '../../mobile-audit';

/**
 * Batch 4 — the records an employee reads rather than writes.
 *
 * These seven were the app's worst offenders for hardcoded colour: they were
 * written against the raw Tailwind palette (`bg-white`, `slate-*`), which this
 * portal cannot use because `theme/provider.tsx` writes every colour at runtime
 * from the active preset. The audit cannot see a wrong colour, so that part is
 * held by `components/common/ess-mobile-standard.test.ts`; what these cases
 * check is the geometry.
 */

test.use(PHONE);

const isEmployee = () => test.info().project.name === 'employee';

const SCREENS = [
  { id: 'B4-01', path: '/dashboard/my-documents', ready: 'ess-my-documents', label: 'my documents' },
  { id: 'B4-02', path: '/dashboard/my-letters', ready: 'ess-my-letters', label: 'my letters' },
  { id: 'B4-03', path: '/dashboard/my-assets', ready: 'ess-my-assets', label: 'my assets' },
  { id: 'B4-04', path: '/dashboard/my-training', ready: 'ess-my-training', label: 'my training' },
  { id: 'B4-05', path: '/dashboard/my-grievances', ready: 'ess-my-grievances', label: 'my grievances' },
  { id: 'B4-06', path: '/dashboard/notifications', ready: 'ess-notifications', label: 'notifications' },
  { id: 'B4-07', path: '/dashboard/my-team', ready: 'ess-my-team', label: 'my team' },
] as const;

test.describe('Batch 4 on a phone', () => {
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
