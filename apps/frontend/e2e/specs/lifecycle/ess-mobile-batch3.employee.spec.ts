import { test } from '../../fixtures';
import { PHONE, auditPhoneScreen } from '../../mobile-audit';

/**
 * Batch 3 — money: claims, loans, travel and the gratuity figure.
 *
 * Reimbursements and advance-loans are the two heaviest ESS screens (tabs, a
 * pager, and three overlays each). Their overlays were not re-parented into
 * `components/common/Sheet.tsx`: they carry live forms that the finance
 * lifecycle specs drive by testid, and re-parenting is a DOM change those specs
 * can see. They were made bottom sheets in place instead — the same
 * `items-end … md:items-center` mechanic Sheet uses, applied as classes.
 */

test.use(PHONE);

const isEmployee = () => test.info().project.name === 'employee';

const SCREENS = [
  { id: 'B3-01', path: '/dashboard/reimbursements', ready: 'ess-reimbursements', label: 'reimbursements' },
  { id: 'B3-02', path: '/dashboard/advance-loans', ready: 'ess-advance-loans', label: 'advances and loans' },
  { id: 'B3-03', path: '/dashboard/my-loan-statement', ready: 'ess-loan-statement', label: 'my loan statement' },
  { id: 'B3-04', path: '/dashboard/my-travel', ready: 'ess-my-travel', label: 'my travel' },
  { id: 'B3-05', path: '/dashboard/my-payroll/gratuity', ready: 'ess-gratuity', label: 'gratuity' },
] as const;

test.describe('Batch 3 on a phone', () => {
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
