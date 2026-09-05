import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { ApprovalsInboxPage } from '../../pages';
import { APPROVAL_KIND_UI } from '../../../lib/approvalKinds';

/**
 * The cross-module approvals inbox.
 *
 * Its blast radius is why it is here. Every row it draws is looked up in
 * `APPROVAL_KIND_UI`; a request type the backend can route but the frontend has
 * no entry for renders a row whose Approve button answers "Unsupported request
 * type" — a dead end that appears only when someone tries to use it, and only
 * for that one kind. The contract test below is the cheapest possible guard
 * against that, and it is the reason this spec exists at all.
 *
 * The inbox itself is empty in this environment on purpose:
 * `supervisor_approval_enabled` is pinned false in the baseline, so requests
 * take the legacy single-approver path and never enter the workflow engine.
 * That makes "renders its empty state without breaking" the honest assertion
 * here — anything more would need a second database with the flag flipped, the
 * way the template-flag journey does it.
 */

const isProject = (name: string) => test.info().project.name === name;

test.describe('the approvals inbox', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the kinds endpoint is ADMIN/HR only');
    });

    test('every request type the backend can route has a UI entry', async () => {
      /**
       * FIXED — the `test.fail()` annotation that used to sit here is gone,
       * which is what it existed for.
       *
       * The backend routed more kinds than `APPROVAL_KIND_UI` covered:
       * `TRAINING` had no entry, so configuring an approval chain for it drew a
       * row whose Approve button answered "Unsupported request type" and the
       * request could not be actioned from the inbox at all.
       *
       * The root cause was one line up the stack. `APPROVAL_KIND_UI` is a total
       * `Record<ApprovalRequestType, …>`, and `ApprovalRequestType` in
       * `services/approvalWorkflowService.ts` itself omitted the kind — so a
       * type that did not know about a kind could not be missing an entry for it,
       * and the compiler had nothing to complain about. Widening that union is
       * what makes this assertion enforceable rather than merely aspirational:
       * adding a governable kind without an inbox entry is now a build error, and
       * this case is the runtime backstop for the backend adding one first.
       */
      const api = await ApiClient.as('admin');
      try {
        const kinds = await api.get<Array<string | { value?: string; key?: string; type?: string }>>(
          '/approval-workflows/kinds',
        );
        const names = (Array.isArray(kinds) ? kinds : []).map((k) =>
          typeof k === 'string' ? k : (k.value ?? k.key ?? k.type ?? ''),
        );

        expect(names.length, 'the backend reported no approval kinds at all').toBeGreaterThan(0);

        const missing = names.filter((n) => n && !(n in APPROVAL_KIND_UI));
        expect(
          missing,
          'the backend can route these request types but the inbox has no UI for them — ' +
            'their rows would render with an Approve button that cannot work',
        ).toEqual([]);
      } finally {
        await api.dispose();
      }
    });
  });

  test('it loads for every role and shows an honest empty state', async ({ page, problems }) => {
    const inbox = new ApprovalsInboxPage(page);
    await inbox.open();

    const rows = await inbox.rowCount();
    if (rows === 0) {
      expect(await inbox.isEmpty(), 'no rows and no empty state — the inbox rendered nothing at all').toBe(true);
    } else {
      // If anything IS pending, every row must be a kind the UI knows.
      const kinds = await inbox.kinds();
      const unknown = kinds.filter((k) => k && !(k in APPROVAL_KIND_UI));
      expect(unknown, 'the inbox drew rows for request types it cannot action').toEqual([]);
    }

    settle(problems, 'the approvals inbox');
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee view');
    });

    test('an employee reaches their own inbox rather than a denial', async ({ page, problems }) => {
      // The inbox is open to every role by design — an employee can be an
      // approver through a supervisor chain. What must not happen is a crash or a
      // redirect to /403, which would hide legitimately assigned approvals.
      crashesOnly(problems);

      const inbox = new ApprovalsInboxPage(page);
      await inbox.open();

      expect(page.url(), 'an employee was refused their own approvals inbox').not.toContain('/403');

      settle(problems, 'an employee at the approvals inbox');
    });
  });
});
