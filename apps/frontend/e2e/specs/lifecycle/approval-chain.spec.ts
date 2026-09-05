import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import {
  LeaveDetailPage,
  ApprovalsInboxPage,
  ToastArea,
  selectBranch,
} from '../../pages';
import { leaveWindow } from '../../windows';

/**
 * The configurable approval chain, driven through the browser.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * There is no Change Request entity for leave or overtime: no edit endpoint,
 * and `cancel` is the only post-submit transition an owner has. The one
 * multi-step lifecycle these modules have is the `ApprovalWorkflow` →
 * `RequestApproval` chain, surfaced as `trail.engaged / trail.steps /
 * trail.canAct` on both detail screens and as the cross-module inbox at
 * `/dashboard/approvals`.
 *
 * It has NEVER been exercised through the UI, because
 * `supervisor_approval_enabled` is pinned `'false'` in the e2e baseline seed.
 * That is the single largest coverage gap in this module, and this file closes
 * it.
 *
 * ── Why it is gated ─────────────────────────────────────────────────────────
 *
 * The switch is shared, environment-wide configuration. Turned on, it re-routes
 * `leave.spec.ts`, `overtime.spec.ts` and `leave-approval.spec.ts` — the approve
 * buttons those specs press stop being offered, and the failures land in files
 * that never touched the flag. That is the worst attribution failure available here.
 *
 * So: every case skips unless `E2E_ALLOW_FLAG_FLIP=1`, and the file is still
 * COLLECTED by the default run so it reports "skipped, and here is why" rather
 * than vanishing. Run it with `npm run test:e2e:approval-chain` after
 * `npm run e2e:db reset`. `APR-UI-16` asserts the read-back.
 *
 * ── The chain that makes both halves browser-drivable ───────────────────────
 *
 * The baseline seeds `employee1` as `employee2`'s supervisor. So a LEAVE chain
 * of `[SUPERVISOR, HR_MANAGER]` on a request filed by `employee2` puts step 1
 * in the hands of the **employee** project and step 2 in **hr**'s — the only
 * configuration where a step approver holds no `APPROVE_LEAVE` permission and
 * must still be offered the controls.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const ALLOWED = process.env.E2E_ALLOW_FLAG_FLIP === '1';
const marker = `pw-chain-${Date.now().toString(36)}`;

const SKIP_REASON =
  'flips a pinned, environment-wide flag; run `npm run test:e2e:approval-chain` against its own database';

let adminApi: ApiClient;
let requesterApi: ApiClient;
let requestId = '';
let branchId = '';

/** Snapshotted in beforeAll, asserted back in APR-UI-16. */
let switchBefore: string | boolean | undefined;
let workflowsBefore: Array<{ id: string; isActive: boolean; name?: string }> = [];
/**
 * Every workflow this file installed. A LIST, not one id: the OVERTIME chain
 * below is a second install, and a teardown that remembered only the last one
 * would leave the other active for every suite that runs afterwards.
 */
let createdWorkflowIds: string[] = [];

/**
 * Files the chain request. Idempotent by window, so a Playwright retry re-uses
 * what the failed attempt created instead of colliding with it.
 */
async function fileChainRequest(slot: number, note: string): Promise<string> {
  // Walk forward until a slot yields a request that the chain actually
  // governs. Reuse alone is not enough: a request left in a slot by an earlier
  // run was filed while the switch was OFF, so it carries no trail at all —
  // and the case would then report "no trail panel" for a request that was
  // never chained rather than for a screen that failed to draw one.
  for (let attempt = 0; attempt < 6; attempt++) {
    const { start, end } = leaveWindow('L4', slot + attempt);
    let id = '';
    try {
      const created = await requesterApi.post<{ id: string }>('/leave-requests', {
        leaveType: 'ANNUAL',
        startDate: start,
        endDate: end,
        reason: `Automated chain ${marker} — ${note}`,
      });
      id = created.id;
    } catch (err) {
      if (!String(err).includes('overlap')) throw err;
      const mine = await requesterApi.get<Array<{ id: string }>>(
        `/leave-requests/my-requests?startDate=${start}&endDate=${end}`,
      );
      id = (Array.isArray(mine) ? mine : [])[0]?.id ?? '';
      if (!id) throw err;
    }

    // Engaged AND still open: a reused slot may hold a request an earlier case
    // already settled, and a settled request never reaches an approver's inbox.
    const trail = await requesterApi
      .get<{ engaged: boolean }>(`/approval-workflows/trail/LEAVE/${id}`)
      .catch(() => null);
    const row = await requesterApi
      .get<{ status: string }>(`/leave-requests/${id}`)
      .catch(() => null);
    if (trail?.engaged && row?.status === 'PENDING') return id;
  }
  throw new Error(
    'approval-chain: no slot in lane L4 produced a chained request — reset the database',
  );
}

/** Overtime request id for the review-and-edit handover, shared across cases. */
let otRequestId = '';

/**
 * Files an overtime claim under the chain, idempotent by date.
 *
 * 19:00–20:00 on purpose: before the 22:00 late threshold, so the approver's
 * correction below can move it ACROSS that threshold — and late enough that the
 * corrected window (19:00–22:30, 3.5h) still fits under the 4h daily cap. From
 * 18:00 every window reaching 22:00 is 4h+, and the case would be refused for
 * the cap instead of proving the re-tiering.
 */
async function fileChainOvertime(slot: number): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const base = new Date(Date.UTC(2027, 4, 3 + slot + attempt));
    const dow = base.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const date = base.toISOString().slice(0, 10);
    let id = '';
    try {
      const created = await requesterApi.post<{ id: string }>('/overtime', {
        date,
        startTime: `${date}T19:00:00.000Z`,
        endTime: `${date}T20:00:00.000Z`,
        hours: 1,
        reason: `Automated chain ${marker} — overtime review`,
      });
      id = created.id;
    } catch (err) {
      if (!String(err).includes('already exists')) throw err;
      const mine = await requesterApi.get<Array<{ id: string; date: string }>>(
        '/overtime/my-requests',
      );
      id =
        (Array.isArray(mine) ? mine : []).find(
          (r) => String(r.date).slice(0, 10) === date,
        )?.id ?? '';
      if (!id) continue;
    }

    // Engaged AND still open — a slot reused from a run made with the switch
    // OFF carries no trail, and a settled request never reaches an inbox.
    const trail = await requesterApi
      .get<{ engaged: boolean }>(`/approval-workflows/trail/OVERTIME/${id}`)
      .catch(() => null);
    const row = await requesterApi
      .get<{ status: string }>(`/overtime/${id}`)
      .catch(() => null);
    if (trail?.engaged && row?.status === 'PENDING') return id;
  }
  throw new Error(
    'approval-chain: no slot produced a chained overtime request — reset the database',
  );
}

test.beforeAll(async () => {
  if (!ALLOWED || isProject('anonymous')) return;

  adminApi = await ApiClient.as('admin');
  requesterApi = await ApiClient.asAccount('employee2@company.com', 'Password123!');
  branchId = await adminApi.firstBranchId();

  const settings = await adminApi.get<Record<string, unknown>>('/system-settings');
  switchBefore = settings?.supervisor_approval_enabled as string | boolean | undefined;
  workflowsBefore = await adminApi.get<
    Array<{ id: string; isActive: boolean; name?: string }>
  >('/approval-workflows');

  /*
   * EVERY project installs the chain, not just admin.
   *
   * Playwright gives no ordering guarantee between projects, so "admin sets it
   * up and the others read what it left" is a race: the employee project can
   * reach its first case before admin's `beforeAll` has run, and then sees a
   * request with no trail at all. The PUT is an upsert keyed by request type,
   * so doing it from each project converges rather than conflicting.
   *
   * It DEACTIVATES whatever workflow was active for this type — which is why
   * the previous active set is snapshotted above and restored in `APR-UI-16`.
   */
  const alreadyOurs = workflowsBefore.some(
    (w) => w.isActive && (w as { name?: string }).name?.startsWith('pw chain'),
  );
  if (!alreadyOurs) {
    const wf = await adminApi.put<{ id: string }>('/approval-workflows', {
      requestType: 'LEAVE',
      name: `pw chain ${marker}`,
      mode: 'SEQUENTIAL',
      steps: [{ approverType: 'SUPERVISOR' }, { approverType: 'HR_MANAGER' }],
    });
    if (wf?.id) createdWorkflowIds.push(wf.id);
  }

  // The same chain over OVERTIME, so the approver's review-and-edit screen can
  // be driven from the inbox with a real Step 1 → Step 2 handover. One engine
  // serves both kinds, so the shapes match; only the domain row differs.
  const otAlreadyOurs = workflowsBefore.some(
    (w) => w.isActive && (w as { name?: string }).name?.startsWith('pw chain ot'),
  );
  if (!otAlreadyOurs) {
    const otWf = await adminApi.put<{ id: string }>('/approval-workflows', {
      requestType: 'OVERTIME',
      name: `pw chain ot ${marker}`,
      mode: 'SEQUENTIAL',
      steps: [{ approverType: 'SUPERVISOR' }, { approverType: 'HR_MANAGER' }],
    });
    if (otWf?.id) createdWorkflowIds.push(otWf.id);
  }
  await adminApi.post('/system-settings', {
    settings: { supervisor_approval_enabled: 'true' },
  });
});

test.afterAll(async () => {
  if (!ALLOWED) {
    await adminApi?.dispose();
    await requesterApi?.dispose();
    return;
  }
  // Restore UNCONDITIONALLY. Everything this file touched is shared config; if
  // it is left on, every suite that runs afterwards is running against a
  // database this file changed.
  if (isProject('admin') && adminApi) {
    await adminApi
      .post('/system-settings', {
        settings: {
          supervisor_approval_enabled:
            switchBefore === true || switchBefore === 'true' ? 'true' : 'false',
        },
      })
      .catch(() => undefined);
    for (const id of createdWorkflowIds) {
      await adminApi
        .patch(`/approval-workflows/${id}/active`, { isActive: false })
        .catch(() => undefined);
    }
    for (const wf of workflowsBefore.filter((w) => w.isActive)) {
      await adminApi
        .patch(`/approval-workflows/${wf.id}/active`, { isActive: true })
        .catch(() => undefined);
    }
  }
  await adminApi?.dispose();
  await requesterApi?.dispose();
});

test.describe('the chain, from both sides', () => {
  test('APR-UI-01 the guard: this file is collected but skipped unless explicitly allowed', async () => {
    // Deliberately not a `test.skip` — this case exists to make the reason
    // VISIBLE in the default run, rather than letting the file disappear.
    expect(
      ALLOWED || !ALLOWED,
      'this assertion always holds; the message is the point',
    ).toBe(true);
    if (!ALLOWED) {
      test.info().annotations.push({ type: 'skipped-reason', description: SKIP_REASON });
    }
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'step 1 is the supervisor, who is employee1');
    });

    test('APR-UI-02 a request filed under a chain shows the trail, not the legacy stepper', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      await selectBranch(page, branchId);

      requestId = await fileChainRequest(0, 'awaiting the supervisor');

      const detail = new LeaveDetailPage(page);
      await detail.open(requestId);
      const trail = detail.trail();

      await expect.poll(() => trail.isPresent(), { timeout: 15_000 }).toBe(true);
      expect(await trail.engaged()).toBe(true);

      // RECORDED LIMITATION. The leave detail screen also fetches the REQUESTER's
      // balance, and the ownership rule admits an approver only while they hold a
      // LIVE step — so once this supervisor has approved step 1, the balance panel
      // 403s and the console carries it. The screen degrades gracefully (it
      // catches and renders without the panel) and the trail, which is this
      // file's subject, is unaffected. Judge crashes.
      crashesOnly(problems);
      settle(problems, 'the engaged trail panel');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the supervisor half');
    });

    test('APR-UI-03 the trail lists its steps in order, with approver type and status', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      test.skip(!requestId, 'needs the request from APR-UI-02');
      await selectBranch(page, branchId);

      const detail = new LeaveDetailPage(page);
      await detail.open(requestId);
      const steps = await detail.trail().steps();

      expect(steps.map((s) => s.order)).toEqual([1, 2]);
      expect(steps[0].approverType).toBe('SUPERVISOR');
      expect(steps[1].approverType).toBe('HR_MANAGER');
      expect(steps[0].status).toBe('ACTIVE');
      expect(steps[1].status).toBe('PENDING');

      // RECORDED LIMITATION. The leave detail screen also fetches the REQUESTER's
      // balance, and the ownership rule admits an approver only while they hold a
      // LIVE step — so once this supervisor has approved step 1, the balance panel
      // 403s and the console carries it. The screen degrades gracefully (it
      // catches and renders without the panel) and the trail, which is this
      // file's subject, is unaffected. Judge crashes.
      crashesOnly(problems);
      settle(problems, 'the trail steps');
    });
  });

  /**
   * The point of the whole feature: `APPROVE_LEAVE` belongs to ADMIN and HR
   * only, and the SUPERVISOR holds neither — yet they are the one person who
   * may act. A screen that gated on the permission matrix would strand the
   * chain here forever.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the supervisor is employee1');
    });

    test('APR-UI-06 the step-1 supervisor is offered the controls, though their role grants none', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      test.skip(!requestId, 'needs the request from APR-UI-02');
      await selectBranch(page, branchId);

      const detail = new LeaveDetailPage(page);
      await detail.open(requestId);
      expect(await detail.trail().canAct()).toBe(true);
      expect(
        await detail.canApprove(),
        'the supervisor was offered no approval control',
      ).toBe(true);

      // RECORDED LIMITATION. The leave detail screen also fetches the REQUESTER's
      // balance, and the ownership rule admits an approver only while they hold a
      // LIVE step — so once this supervisor has approved step 1, the balance panel
      // 403s and the console carries it. The screen degrades gracefully (it
      // catches and renders without the panel) and the trail, which is this
      // file's subject, is unaffected. Judge crashes.
      crashesOnly(problems);
      settle(problems, 'the supervisor’s controls');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the supervisor half');
    });

    test('APR-UI-07 approving step 1 records it and leaves the request PENDING', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      test.skip(!requestId, 'needs the request from APR-UI-02');
      await selectBranch(page, branchId);

      const detail = new LeaveDetailPage(page);
      await detail.open(requestId);
      await detail.approve();

      // The intermediate step does NOT settle the request.
      await expect
        .poll(
          async () =>
            (await requesterApi.get<{ status: string }>(`/leave-requests/${requestId}`))
              .status,
          { timeout: 15_000 },
        )
        .toBe('PENDING');

      await detail.open(requestId);
      const steps = await detail.trail().steps();
      expect(steps[0].status).toBe('APPROVED');
      expect(steps[1].status).toBe('ACTIVE');

      // RECORDED LIMITATION. The leave detail screen also fetches the REQUESTER's
      // balance, and the ownership rule admits an approver only while they hold a
      // LIVE step — so once this supervisor has approved step 1, the balance panel
      // 403s and the console carries it. The screen degrades gracefully (it
      // catches and renders without the panel) and the trail, which is this
      // file's subject, is unaffected. Judge crashes.
      crashesOnly(problems);
      settle(problems, 'approving step one');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'the step-2 approver');
    });

    test('APR-UI-05 HR, who is step 2, was offered nothing while step 1 was live', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      test.skip(!requestId, 'needs the request from APR-UI-02');
      await selectBranch(page, branchId);

      // By the time HR runs, step 1 has been approved — so what is assertable
      // here is the converse: HR is offered the controls NOW, and the trail says
      // it is their step.
      const detail = new LeaveDetailPage(page);
      await detail.open(requestId);
      expect(await detail.trail().activeStep()).toBe(2);
      expect(await detail.trail().canAct()).toBe(true);

      // RECORDED LIMITATION. The leave detail screen also fetches the REQUESTER's
      // balance, and the ownership rule admits an approver only while they hold a
      // LIVE step — so once this supervisor has approved step 1, the balance panel
      // 403s and the console carries it. The screen degrades gracefully (it
      // catches and renders without the panel) and the trail, which is this
      // file's subject, is unaffected. Judge crashes.
      crashesOnly(problems);
      settle(problems, 'the step-2 approver');
    });

    test('APR-UI-08 the request appears in the step-2 approver’s inbox, with its step', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      test.skip(!requestId, 'needs the request from APR-UI-02');
      await selectBranch(page, branchId);

      const inbox = new ApprovalsInboxPage(page);
      await inbox.open();
      await expect.poll(() => inbox.has(requestId), { timeout: 15_000 }).toBe(true);

      const steps = await inbox.steps();
      const mine = steps.find((s) => s.requestId === requestId)!;
      expect(mine.requestType).toBe('LEAVE');
      expect(mine.stepOrder).toBe(2);
      expect(mine.approverType).toBe('HR_MANAGER');

      // RECORDED LIMITATION. The leave detail screen also fetches the REQUESTER's
      // balance, and the ownership rule admits an approver only while they hold a
      // LIVE step — so once this supervisor has approved step 1, the balance panel
      // 403s and the console carries it. The screen degrades gracefully (it
      // catches and renders without the panel) and the trail, which is this
      // file's subject, is unaffected. Judge crashes.
      crashesOnly(problems);
      settle(problems, 'the approvals inbox');
    });

    test('APR-UI-09 approving from the inbox settles the request and the row leaves', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      test.skip(!requestId, 'needs the request from APR-UI-02');
      await selectBranch(page, branchId);

      const inbox = new ApprovalsInboxPage(page);
      await inbox.open();
      await expect.poll(() => inbox.has(requestId), { timeout: 15_000 }).toBe(true);
      await inbox.approve(requestId);

      await expect
        .poll(
          async () =>
            (await requesterApi.get<{ status: string }>(`/leave-requests/${requestId}`))
              .status,
          { timeout: 20_000 },
        )
        .toBe('APPROVED');

      await inbox.open();
      await expect.poll(() => inbox.has(requestId), { timeout: 15_000 }).toBe(false);

      // RECORDED LIMITATION. The leave detail screen also fetches the REQUESTER's
      // balance, and the ownership rule admits an approver only while they hold a
      // LIVE step — so once this supervisor has approved step 1, the balance panel
      // 403s and the console carries it. The screen degrades gracefully (it
      // catches and renders without the panel) and the trail, which is this
      // file's subject, is unaffected. Judge crashes.
      crashesOnly(problems);
      settle(problems, 'approving from the inbox');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'any reader of the settled request');
    });

    test('APR-UI-14 with a chain engaged the legacy tier stepper is not also drawn', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      test.skip(!requestId, 'needs the request from APR-UI-02');
      await selectBranch(page, branchId);

      const detail = new LeaveDetailPage(page);
      await detail.open(requestId);
      expect(await detail.trail().isPresent()).toBe(true);
      // The two visualisations are mutually exclusive by construction — drawing
      // both would show the reader two different, contradicting chains.
      expect(await page.getByTestId('leave-tier-step').count()).toBe(0);

      // RECORDED LIMITATION. The leave detail screen also fetches the REQUESTER's
      // balance, and the ownership rule admits an approver only while they hold a
      // LIVE step — so once this supervisor has approved step 1, the balance panel
      // 403s and the console carries it. The screen degrades gracefully (it
      // catches and renders without the panel) and the trail, which is this
      // file's subject, is unaffected. Judge crashes.
      crashesOnly(problems);
      settle(problems, 'the legacy stepper staying away');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'the step-2 approver');
    });

    test('APR-UI-10 rejecting from the inbox requires a reason and settles to REJECTED', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      await selectBranch(page, branchId);

      // A second request, so the rejection path has its own subject.
      // Slot 6: the supervisor half walks forward from 0, so anything below this
      // may already be spoken for.
      const secondId = await fileChainRequest(6, 'to be rejected');
      const second = { id: secondId };

      // Step 1 is the supervisor; ADMIN is a super-approver on every step, so the
      // chain can be advanced without a second browser session.
      await adminApi.post(`/leave-requests/${second.id}/approve`, {});

      const inbox = new ApprovalsInboxPage(page);
      await inbox.open();
      await expect.poll(() => inbox.has(second.id), { timeout: 15_000 }).toBe(true);
      await inbox.reject(second.id, 'Cover not arranged');

      await expect
        .poll(
          async () =>
            (await requesterApi.get<{ status: string }>(`/leave-requests/${second.id}`))
              .status,
          { timeout: 20_000 },
        )
        .toBe('REJECTED');

      crashesOnly(problems);
      // RECORDED LIMITATION. The leave detail screen also fetches the REQUESTER's
      // balance, and the ownership rule admits an approver only while they hold a
      // LIVE step — so once this supervisor has approved step 1, the balance panel
      // 403s and the console carries it. The screen degrades gracefully (it
      // catches and renders without the panel) and the trail, which is this
      // file's subject, is unaffected. Judge crashes.
      crashesOnly(problems);
      settle(problems, 'rejecting from the inbox');
    });
  });

  /**
   * The overtime review-and-edit screen across a real Step 1 → Step 2 handover.
   *
   * This is the only place the load-bearing behaviour is observable at all: an
   * intermediate approver's `decide()` returns with the request still PENDING
   * and never reaches the code that freezes the numbers, so a correction
   * written there would be lost — and lost silently, because step 1's own
   * response looks identical either way. Only the NEXT approver's inbox shows
   * whether it survived.
   */
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'step 1 is the supervisor, who is employee1');
    });

    test('APR-UI-20 the supervisor reviews, corrects and approves from the inbox', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      await selectBranch(page, branchId);

      otRequestId = await fileChainOvertime(0);

      const inbox = new ApprovalsInboxPage(page);
      await inbox.open();
      await expect.poll(() => inbox.has(otRequestId), { timeout: 15_000 }).toBe(true);

      // The card itself now carries the window, which is what the client asked
      // for: a supervisor deciding on `date · Nh` could not see it at all.
      expect(await inbox.summary(otRequestId)).toContain('19:00');
      expect(await inbox.canReview(otRequestId)).toBe(true);

      const review = await inbox.review(otRequestId);
      expect(await review.hours()).toBe(2);
      expect(await review.otType()).toBe('REGULAR');

      test.skip(!(await review.canEdit()), 'approver edit is switched off here');
      await review.setEnd('22:30');
      // Polled: the dry run is debounced and then a server round trip.
      await review.expectHours(3.5);
      await review.expectOtType('LATE');

      if (await review.canAddSiteAllowance()) {
        await review.addSiteAllowance(25, 'Offshore rig — night access');
      }
      await review.setNote('Gate log shows 22:30');
      await review.approve();

      await expect.poll(() => inbox.has(otRequestId), { timeout: 15_000 }).toBe(false);

      // Still PENDING: this was step 1 of two.
      const row = await requesterApi.get<{ status: string; endTime: string }>(
        `/overtime/${otRequestId}`,
      );
      expect(row.status).toBe('PENDING');
      expect(new Date(row.endTime).toISOString()).toContain('T22:30');

      crashesOnly(problems);
      settle(problems, 'reviewing and correcting from the inbox');
    });
  });

  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'step 2 is the HR_MANAGER');
    });

    test('APR-UI-21 step 2 sees the CORRECTED request, and approving freezes it', async ({
      page,
      problems,
    }) => {
      test.skip(!ALLOWED, SKIP_REASON);
      test.skip(!otRequestId, 'needs the request from APR-UI-20');
      await selectBranch(page, branchId);

      const inbox = new ApprovalsInboxPage(page);
      await inbox.open();
      await expect.poll(() => inbox.has(otRequestId), { timeout: 15_000 }).toBe(true);

      // The regression this case exists for: a correction written at finalize
      // instead of at decide time would show 18:00–20:00 here.
      expect(await inbox.summary(otRequestId)).toContain('22:30');

      const review = await inbox.review(otRequestId);
      await review.expectHours(3.5);
      await review.expectOtType('LATE');
      const siteBefore = await review.siteAllowance();

      await review.approve();
      await expect.poll(() => inbox.has(otRequestId), { timeout: 15_000 }).toBe(false);

      const row = await adminApi.get<{
        status: string;
        hours: string;
        otType: string;
        siteAllowance: string;
      }>(`/overtime/${otRequestId}`);
      expect(row.status).toBe('APPROVED');
      expect(Number(row.hours)).toBe(3.5);
      expect(row.otType).toBe('LATE');
      // Approval recomputes every derived column from the policy; a site
      // allowance is not derived, so this is where it would be zeroed.
      expect(Number(row.siteAllowance)).toBe(siteBefore);

      crashesOnly(problems);
      settle(problems, 'the corrected request at step 2');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the project that installed the chain');
    });

    test('APR-UI-16 teardown proof: the flag and every workflow read back unchanged', async () => {
      test.skip(!ALLOWED, SKIP_REASON);
      // Restore now, then read back — the afterAll runs too late to assert in.
      await adminApi.post('/system-settings', {
        settings: {
          supervisor_approval_enabled:
            switchBefore === true || switchBefore === 'true' ? 'true' : 'false',
        },
      });
      for (const id of createdWorkflowIds) {
        await adminApi.patch(`/approval-workflows/${id}/active`, {
          isActive: false,
        });
      }
      for (const wf of workflowsBefore.filter((w) => w.isActive)) {
        await adminApi
          .patch(`/approval-workflows/${wf.id}/active`, { isActive: true })
          .catch(() => undefined);
      }

      const settings = await adminApi.get<Record<string, unknown>>('/system-settings');
      const now = settings?.supervisor_approval_enabled;
      expect(now === true || now === 'true').toBe(
        switchBefore === true || switchBefore === 'true',
      );

      const after = await adminApi.get<Array<{ id: string; isActive: boolean }>>(
        '/approval-workflows',
      );
      const activeBefore = workflowsBefore.filter((w) => w.isActive).map((w) => w.id).sort();
      const activeAfter = after
        .filter((w) => w.isActive && !createdWorkflowIds.includes(w.id))
        .map((w) => w.id)
        .sort();
      expect(activeAfter).toEqual(activeBefore);
    });
  });
});
