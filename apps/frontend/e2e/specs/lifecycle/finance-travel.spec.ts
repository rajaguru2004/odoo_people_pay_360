import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import { ReimbursementsPage, ToastArea, selectBranch } from '../../pages';
import { MyTravelPage, TravelPage } from '../../pages/travel';

/**
 * A business trip, from the request to the money it moves.
 *
 * The step that carries the money is APPROVAL, not submission. Approving a trip
 * raises a per-diem claim that the next payroll run pays, disburses any cash
 * advance as a real loan in the repayment ledger, and commits the estimated cost
 * against the branch's budget. Three irreversible-ish side effects, all fired by
 * one button, none of them visible on the screen that fires them — which is
 * exactly the shape of change that a per-screen test watches happen and still
 * reports green.
 *
 * ── The product change this file exists to hold ─────────────────────────────
 *
 * Until recently a trip filed where no approval chain governs TRAVEL was
 * approved ON SUBMIT. The engine answers `engaged: false` for "no chain governs
 * this", and travel read that as "nobody needs to approve it" — so an employee
 * pressing Submit raised their own per-diem claim, disbursed their own advance
 * and spent their own department's budget. Deactivating a workflow did not fall
 * back to manual approval; it fell back to no approval.
 *
 * It now matches Advances & Loans, which always read the same answer as "a human
 * still decides": **the request stays PENDING and waits for an approver**.
 * `TRV-UI-02` is the case that pins it, and it asserts the absence of the side
 * effects rather than only the status — a trip that says PENDING while a claim
 * for it already exists would pass a status check and still be the bug.
 *
 * ── Two authorization facts, both easy to break from either side ────────────
 *
 *   • Who may decide comes from the `travel_approver_roles` SETTING
 *     (`HR_MANAGER,ADMIN`), not from RBAC. `@Roles` on the approve route admits
 *     EMPLOYEE deliberately, because a configured chain can route a step to a
 *     supervisor who carries no approver role — so the decorator is not the
 *     gate, and a matrix written from it is wrong by construction.
 *   • `/dashboard/travel` is guarded for ADMIN, HR_MANAGER **and MANAGER**,
 *     while the screen draws its decision controls for ADMIN and HR_MANAGER
 *     only. A manager therefore reaches the queue and can decide nothing in it,
 *     which is the intended shape and is asserted as such.
 *
 * Everything created here is withdrawn in `afterAll`, which releases the budget
 * commitment and the claims along with it — a suite that leaves approved trips
 * behind slowly consumes the seeded budget and the employee's loan allowance.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Distinct per run and visible on screen, so leftovers are identifiable. */
const marker = `pw-travel-${Date.now().toString(36)}`;

/** A trip that has not yet finished is one this file still has to clean up. */
const OPEN_STATUSES = ['PENDING', 'APPROVED'];

interface TravelRecord {
  id: string;
  status: string;
  employeeId: string;
  /** Carries this run's marker, which is how a record is found without a count. */
  purpose: string;
  travelType: string;
  destination: string;
  country: string | null;
  perDiemRate: string | null;
  perDiemDays: number | null;
  estimatedCost: string;
  advanceAmount: string | null;
  advanceLoanId: string | null;
  approverId: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  employee?: { id: string; branchId: string; departmentId: string | null };
  /** Only on the detail endpoint: the reimbursement rows this trip spawned. */
  claims?: Array<{ id: string; type: string; amount: string; status: string }>;
}

interface DestinationItem {
  id: string;
  label: string;
  perDiemRate: string | number | null;
}

/** A date `days` from now, in the form an `<input type="date">` holds. */
function isoDay(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function destinations(api: ApiClient): Promise<DestinationItem[]> {
  return api.get<DestinationItem[]>(
    '/library-items?type=PER_DIEM_DESTINATION&activeOnly=true',
  );
}

/**
 * A destination the library rates ABOVE zero.
 *
 * Not hardcoded, because the destination list is admin-configured and naming one
 * would make this file fail the day a client renames their destinations. Above
 * zero specifically: the baseline deliberately carries a destination rated 0,
 * and approving a trip to it raises no claim at all — correct behaviour, and a
 * silent no-op for every assertion here that expects one.
 */
async function ratedDestination(api: ApiClient): Promise<DestinationItem> {
  const rated = (await destinations(api)).find((d) => Number(d.perDiemRate ?? 0) > 0);
  if (!rated) {
    throw new Error(
      'No PER_DIEM_DESTINATION carries a rate above zero — the baseline seed did not run',
    );
  }
  return rated;
}

/**
 * Withdraws one trip this file created.
 *
 * Cancelling is the operation that undoes the whole approval: it abandons any
 * approval trail, cancels the claims the trip raised (never one already in a
 * payroll) and releases the budget commitment. Deliberately targeted at a known
 * id rather than sweeping the employee's trips — the halves of this journey run
 * in different Playwright projects, which are different workers, so a blanket
 * tidy-up in one could cancel the trip another is halfway through approving.
 */
async function retire(travelId: string, api: ApiClient): Promise<void> {
  const trip = await api.get<TravelRecord>(`/travel-requests/${travelId}`).catch(() => null);
  if (!trip || !OPEN_STATUSES.includes(trip.status)) return;
  await api.delete(`/travel-requests/${travelId}`).catch(() => undefined);
}

/**
 * The last toast, whichever toaster raised it.
 *
 * These screens call `sonner` directly rather than the app's own `lib/toast`,
 * so `ToastArea.waitFor()` — which watches the app's component — never sees
 * them. `latest()` reads both, hence the poll.
 */
async function lastToast(toasts: ToastArea): Promise<{ type: string; text: string }> {
  await expect
    .poll(async () => (await toasts.latest())?.text ?? '', { timeout: 15_000 })
    .not.toBe('');
  return (await toasts.latest())!;
}

// ── The requester ───────────────────────────────────────────────────────────

test.describe('an employee raises a trip', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let destination = '';
  let travelId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    employeeApi = await ApiClient.as('employee');
    adminApi = await ApiClient.as('admin');
    try {
      branchId = await adminApi.firstBranchId();
      destination = (await ratedDestination(employeeApi)).label;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('employee') && travelId) await retire(travelId, employeeApi);
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the requesting role');
    });

    test('TRV-UI-01 the trip form offers exactly the destinations the library holds', async ({
      page,
      problems,
    }) => {
      expect(destination, `setup failed: ${setupError}`).toBeTruthy();

      await selectBranch(page, branchId);
      const mine = new MyTravelPage(page);
      await mine.open();
      await mine.openForm();

      // Compared with the server's list rather than a hardcoded one: the picker
      // is only correct if it shows what an admin configured, whatever that is.
      const configured = (await destinations(employeeApi)).map((d) => d.label);
      expect(await mine.destinationOptions()).toEqual(configured);

      // Destinations exist, so the picker is usable and the "nothing is
      // configured" hint must NOT be on screen — see TRV-UI-14 for its twin.
      expect(await mine.destinationPickerDisabled()).toBe(false);
      expect(await mine.masterHint().count()).toBe(0);

      settle(problems, 'the trip request form');
    });

    test('TRV-UI-02 a filed trip lands PENDING and has spent nothing yet', async ({
      page,
      problems,
    }) => {
      expect(destination, `setup failed: ${setupError}`).toBeTruthy();

      await selectBranch(page, branchId);
      const mine = new MyTravelPage(page);
      await mine.open();

      // Found by its purpose, not by a change in the list's length: the budget
      // journey files trips for this same employee from another project, and a
      // count would be a race against it.
      const purpose = `Automated journey ${marker} — client visit`;

      await mine.submitRequest({
        purpose,
        travelType: 'DOMESTIC',
        destination,
        departureDate: isoDay(90),
        returnDate: isoDay(92),
        estimatedCost: 400,
        // Deliberate: an advance is the loudest of the three side effects, so a
        // trip that carries one is the sharpest way to prove submission fires none.
        advanceAmount: 50,
      });

      await expect
        .poll(
          async () =>
            (await employeeApi.get<TravelRecord[]>('/travel-requests/my-requests')).filter(
              (t) => t.purpose === purpose,
            ).length,
          { timeout: 15_000 },
        )
        .toBe(1);

      const created = (
        await employeeApi.get<TravelRecord[]>('/travel-requests/my-requests')
      ).find((t) => t.purpose === purpose);
      expect(created, "the submitted trip is not in the employee's own list").toBeTruthy();
      travelId = created!.id;

      // The claim this whole file is built around: with no chain governing
      // TRAVEL, submitting asks for a decision — it does not make one.
      expect(created!.status, 'a trip approved itself on submit').toBe('PENDING');
      expect(created!.approverId, 'a PENDING trip carries an approver').toBeFalsy();
      expect(created!.approvedAt, 'a PENDING trip carries an approval time').toBeFalsy();

      const detail = await employeeApi.get<TravelRecord>(`/travel-requests/${travelId}`);
      expect(
        detail.claims ?? [],
        'a per-diem claim was raised before anyone approved the trip',
      ).toHaveLength(0);
      expect(
        detail.advanceLoanId,
        'a cash advance was disbursed before anyone approved the trip',
      ).toBeFalsy();

      await mine.open();
      await mine.expectRowStatus(travelId, 'PENDING');

      settle(problems, 'filing a trip request');
    });

    test('TRV-UI-03 international travel with no country is refused, in words', async ({
      page,
      problems,
    }) => {
      expect(destination, `setup failed: ${setupError}`).toBeTruthy();

      await selectBranch(page, branchId);
      const mine = new MyTravelPage(page);
      await mine.open();

      const purpose = `Automated journey ${marker} — conference`;

      await mine.openForm();
      await mine.fill({
        purpose,
        travelType: 'INTERNATIONAL',
        destination,
        departureDate: isoDay(120),
        returnDate: isoDay(124),
        estimatedCost: 900,
      });
      await mine.submitOnly();

      // The country is what the visa check runs against, so a trip filed without
      // one is not a smaller trip — it is one nobody can check anyone into.
      const toast = await lastToast(new ToastArea(page));
      expect(toast.text).toContain('Country is required for international travel');
      expect(toast.type).toBe('warning');

      // Refused before the request was made, so the form is still there to fix
      // and nothing reached the server.
      expect(await mine.formIsOpen(), 'the form closed on a refused submit').toBe(true);
      expect(
        (await employeeApi.get<TravelRecord[]>('/travel-requests/my-requests')).some(
          (t) => t.purpose === purpose,
        ),
        'a refused international trip was filed anyway',
      ).toBe(false);

      settle(problems, 'the international-without-a-country refusal');
    });

    test('TRV-UI-04 the requester is offered no decision, and the API refuses one', async ({
      page,
      problems,
    }) => {
      test.skip(!travelId, 'nothing was filed');

      await selectBranch(page, branchId);
      const mine = new MyTravelPage(page);
      await mine.open();

      expect(await mine.hasRow(travelId), 'the trip vanished from the requester list').toBe(
        true,
      );
      expect(
        await mine.offersAnyDecision(),
        'the ESS travel screen offered a decision control',
      ).toBe(false);

      // A missing button is a UI decision; this is the rule. An EMPLOYEE is not in
      // `travel_approver_roles`, which is what makes self-approval impossible —
      // there is no separate "not your own trip" rule to lean on.
      await expect(
        employeeApi.post(`/travel-requests/${travelId}/approve`, { remarks: 'me' }),
      ).rejects.toThrow();
      expect((await employeeApi.get<TravelRecord>(`/travel-requests/${travelId}`)).status).toBe(
        'PENDING',
      );

      settle(problems, 'the requester view of a pending trip');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the denied role');
    });

    test('TRV-UI-05 an employee is redirected to /403 from the approver screen', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/travel', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/403/, { timeout: 15_000 });

      // Being refused is the correct outcome, so only a crash counts against it.
      crashesOnly(problems);
      settle(problems, 'the employee denial on /dashboard/travel');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the requesting role');
    });

    test('TRV-UI-06 cancelling warns that claims already in a payroll are untouched', async ({
      page,
      problems,
    }) => {
      test.skip(!travelId, 'nothing was filed');

      await selectBranch(page, branchId);
      const mine = new MyTravelPage(page);
      await mine.open();

      await mine.openCancel(travelId);
      // Cancelling a trip withdraws the money it raised — except the part that is
      // already in a payroll run, which payroll owns. Somebody cancelling a trip
      // on the assumption that everything unwinds is the reason this sentence has
      // to be in front of them BEFORE they confirm, not in a toast afterwards.
      const warning = await mine.cancelWarning();
      expect(
        warning,
        'the cancel dialog never says what happens to claims already in a payroll',
      ).toMatch(/payroll/i);

      await mine.confirmCancel();

      await expect
        .poll(
          async () =>
            (await employeeApi.get<TravelRecord>(`/travel-requests/${travelId}`)).status,
          { timeout: 15_000 },
        )
        .toBe('CANCELLED');
      await mine.open();
      await mine.expectRowStatus(travelId, 'CANCELLED');

      settle(problems, 'cancelling a trip');
    });
  });
});

// ── The approver ────────────────────────────────────────────────────────────

/**
 * HR's half.
 *
 * Seeds its own trips over the API rather than depending on the employee project
 * having run first — Playwright projects share no state, so a cross-project
 * dependency would make this file order-sensitive.
 */
test.describe('HR decides a trip', () => {
  test.describe.configure({ mode: 'serial' });

  let employeeApi: ApiClient;
  let hrApi: ApiClient;
  let branchId = '';
  let destination: DestinationItem | null = null;
  let approveId = '';
  let rejectId = '';
  let claimId = '';
  let setupError = '';

  const DEPARTURE_IN = 100;
  const RETURN_IN = 102;
  const ESTIMATED_COST = 350;

  test.beforeAll(async () => {
    if (!isProject('hr')) return;
    employeeApi = await ApiClient.as('employee');
    hrApi = await ApiClient.as('hr');

    try {
      const adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
      await adminApi.dispose();

      destination = await ratedDestination(employeeApi);

      const file = async (tag: string): Promise<string> => {
        const created = await employeeApi.post<TravelRecord>('/travel-requests', {
          purpose: `Automated journey ${marker} — ${tag}`,
          travelType: 'DOMESTIC',
          destination: destination!.label,
          departureDate: isoDay(DEPARTURE_IN),
          returnDate: isoDay(RETURN_IN),
          estimatedCost: ESTIMATED_COST,
          // No advance: approving one mints a real loan against the employee's
          // live-loan allowance, which the loans journey also spends from.
        });
        return created.id;
      };

      approveId = await file('approval half');
      rejectId = await file('rejection half');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('hr')) {
      if (approveId) await retire(approveId, hrApi);
      if (rejectId) await retire(rejectId, hrApi);
    }
    await employeeApi?.dispose();
    await hrApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'the deciding role');
    });

    test('TRV-UI-07 the trip is waiting in HR\'s list, with the decision controls', async ({
      page,
      problems,
    }) => {
      expect(approveId, `no trip to decide: ${setupError}`).toBeTruthy();

      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();
      // The queue, not the archive. Also keeps the row on the first page: the
      // list is 25 per page ordered by departure date, and every run of this
      // suite leaves its settled trips behind.
      await travel.filterByStatus('PENDING');

      await travel.expectRowStatus(approveId, 'PENDING');
      expect(
        await travel.canApprove(approveId),
        'HR was offered no approval control on a pending trip',
      ).toBe(true);
      expect(await travel.canReject(approveId)).toBe(true);

      settle(problems, "the approver's travel list");
    });

    test('TRV-UI-08 approving raises the per-diem claim the trip was owed', async ({
      page,
      problems,
    }) => {
      test.skip(!approveId, 'no trip to decide');

      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();
      await travel.filterByStatus('PENDING');
      await expect.poll(() => travel.hasRow(approveId), { timeout: 15_000 }).toBe(true);

      await travel.approve(approveId);

      await expect
        .poll(
          async () => (await hrApi.get<TravelRecord>(`/travel-requests/${approveId}`)).status,
          { timeout: 20_000 },
        )
        .toBe('APPROVED');

      const record = await hrApi.get<TravelRecord>(`/travel-requests/${approveId}`);
      const claims = record.claims ?? [];

      // The trip having a status is not the outcome anyone cares about. The
      // outcome is that a claim exists, for the rate snapshotted at submit times
      // the inclusive day count — a claim raised at the WRONG amount is money,
      // and it is invisible on this screen.
      expect(claims, 'approving the trip raised no per-diem claim').toHaveLength(1);
      expect(Number(claims[0].amount)).toBeCloseTo(
        Number(record.perDiemRate) * (record.perDiemDays ?? 0),
        2,
      );
      expect(claims[0].status, 'the per-diem claim needs approving a second time').toBe(
        'APPROVED',
      );
      claimId = claims[0].id;

      settle(problems, 'approving a trip');
    });

    test('TRV-UI-09 the per-diem claim appears in the reimbursements queue', async ({
      page,
      problems,
    }) => {
      test.skip(!claimId, 'the approval raised no claim');

      await selectBranch(page, branchId);
      // The point of feeding travel into the existing expense module rather than
      // building a second payout path: the claim is an ordinary reimbursement and
      // is paid by the machinery that already works. If it were invisible here,
      // it would never be reconciled by the person who reconciles claims.
      const reimbursements = new ReimbursementsPage(page);
      await reimbursements.open();
      await reimbursements.openTab('all');

      await expect
        .poll(() => reimbursements.hasRow(claimId), { timeout: 15_000 })
        .toBe(true);
      expect(await reimbursements.rowStatus(claimId)).toBe('APPROVED');

      settle(problems, 'the per-diem claim in the reimbursements list');
    });

    test('TRV-UI-10 an approved trip can no longer be decided', async ({ page, problems }) => {
      test.skip(!approveId, 'no trip to decide');

      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();
      await travel.filterByStatus('APPROVED');

      await travel.expectRowStatus(approveId, 'APPROVED');
      expect(
        await travel.canApprove(approveId),
        'a decided trip still offered an approval control',
      ).toBe(false);

      // Without the server's half of this, two approvers racing would each raise
      // their own per-diem claim against the same trip.
      await expect(
        hrApi.post(`/travel-requests/${approveId}/approve`, { remarks: 'again' }),
      ).rejects.toThrow(/Cannot decide/i);

      settle(problems, 'a settled trip');
    });

    test('TRV-UI-11 rejection stores its reason', async ({ page, problems }) => {
      test.skip(!rejectId, 'no trip to reject');

      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();
      await travel.filterByStatus('PENDING');
      await expect.poll(() => travel.hasRow(rejectId), { timeout: 15_000 }).toBe(true);

      await travel.reject(rejectId, `Rejected by the automated journey ${marker}`);

      await expect
        .poll(
          async () => (await hrApi.get<TravelRecord>(`/travel-requests/${rejectId}`)).status,
          { timeout: 20_000 },
        )
        .toBe('REJECTED');

      const record = await hrApi.get<TravelRecord>(`/travel-requests/${rejectId}`);
      expect(record.rejectedReason, 'the rejection reason was not stored').toContain(marker);
      expect(record.claims ?? [], 'a rejected trip raised a claim').toHaveLength(0);

      settle(problems, 'rejecting a trip');
    });

    test('TRV-UI-12 the status filter narrows the list to one status', async ({
      page,
      problems,
    }) => {
      test.skip(!approveId || !rejectId, 'nothing to filter');

      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();

      // Asserted over whatever is rendered rather than over a known set: the four
      // Playwright projects share one database, so another project's trips are
      // legitimately in this list and naming them would be a race.
      await travel.filterByStatus('APPROVED');
      await expect.poll(() => travel.hasRow(approveId), { timeout: 15_000 }).toBe(true);
      expect((await travel.rows()).every((r) => r.status === 'APPROVED')).toBe(true);
      expect(await travel.hasRow(rejectId), 'a REJECTED trip survived the APPROVED filter').toBe(
        false,
      );

      await travel.filterByStatus('REJECTED');
      await expect.poll(() => travel.hasRow(rejectId), { timeout: 15_000 }).toBe(true);
      expect((await travel.rows()).every((r) => r.status === 'REJECTED')).toBe(true);

      settle(problems, 'the travel status filter');
    });

    test('TRV-UI-13 the status filter offers exactly the statuses the server accepts', async ({
      page,
      problems,
    }) => {
      /**
       * FIXED. `COMPLETED` was a status nothing ever wrote — no completion cron,
       * no screen action — yet it sat in `TRAVEL_STATUSES` server-side and in the
       * screen's own badge map, which is a separate copy of the same enum.
       *
       * Removing it from the DTO alone made things WORSE for a moment: the filter
       * still offered it, so picking it answered 400 while the list silently kept
       * the previous filter's rows — which reads as "the filter did nothing".
       * Both copies are now in step, and `types/travel.ts` carries a note saying
       * they must stay that way.
       *
       * This case is the lock on that agreement: it asserts the two sets are
       * equal, so removing a status from one side without the other fails here
       * rather than in front of a user.
       */
      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();

      // Drop the "All statuses" entry — its value is the empty string, which is
      // the absence of a filter rather than a status.
      const offered = (await travel.statusFilterOptions()).filter(Boolean);
      expect(offered).not.toContain('COMPLETED');
      expect(offered.slice().sort()).toEqual(
        ['APPROVED', 'CANCELLED', 'PENDING', 'REJECTED'],
      );

      // Every option the screen offers is one the server will actually take.
      for (const status of offered) {
        await expect(
          hrApi.get(`/travel-requests?status=${status}`),
          `the filter offers ${status} but the server refuses it`,
        ).resolves.toBeDefined();
      }

      // ...and the one that was removed is genuinely gone from the server too, so
      // this is an agreement between two shrunken sets rather than one.
      await expect(hrApi.get('/travel-requests?status=COMPLETED')).rejects.toThrow();

      // The 4xx on that last probe is the subject of the assertion, not a defect.
      crashesOnly(problems);
      settle(problems, 'the travel status filter');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'asserted once');
    });

    test('TRV-UI-14 with no destinations configured the picker is disabled and says where to fix it', async ({
      page,
      problems,
    }) => {
      // Driven by intercepting the library call rather than by emptying the
      // library: the master is shared by every spec in the suite and a run that
      // crashed mid-test would leave travel unusable for all of them.
      await page.route(
        (url) =>
          url.href.startsWith(API_URL) &&
          url.href.includes('/library-items') &&
          url.href.includes('PER_DIEM_DESTINATION'),
        (route) => route.fulfill({ status: 200, json: { success: true, data: [] } }),
      );

      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();
      await travel.openForm();

      // A select whose options come from an empty master renders as a bare
      // placeholder: the form looks broken and gives no clue that the fix is one
      // screen away. Disabled + a link to that screen is the whole point.
      expect(await travel.destinationOptions()).toEqual([]);
      expect(await travel.destinationPickerDisabled()).toBe(true);
      await expect(travel.masterHint()).toBeVisible();

      settle(problems, 'the travel form with no destinations configured');
    });
  });
});

// ── Who reaches these screens ───────────────────────────────────────────────

test.describe('who reaches the travel screens', () => {
  test.describe.configure({ mode: 'serial' });

  let employeeApi: ApiClient;
  let managerApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let otherBranchId = '';
  let pendingId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (isProject('employee') || isProject('anonymous')) return;
    adminApi = await ApiClient.as('admin');

    try {
      branchId = await adminApi.firstBranchId();

      if (isProject('admin')) {
        const branches = await adminApi.get<Array<{ id: string; code: string }>>('/branches');
        otherBranchId = branches.find((b) => b.code === 'E2E-BR2')?.id ?? '';
      }

      if (isProject('manager')) {
        managerApi = await ApiClient.as('manager');
        employeeApi = await ApiClient.as('employee');
        const destination = await ratedDestination(employeeApi);
        // Filed by an employee of the department this manager heads, so it is
        // in their scoped list rather than filtered out of it.
        const created = await employeeApi.post<TravelRecord>('/travel-requests', {
          purpose: `Automated journey ${marker} — manager scope`,
          travelType: 'DOMESTIC',
          destination: destination.label,
          departureDate: isoDay(140),
          returnDate: isoDay(141),
          estimatedCost: 200,
        });
        pendingId = created.id;
      }
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('manager') && pendingId) await retire(pendingId, employeeApi);
    await employeeApi?.dispose();
    await managerApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the scoped role');
    });

    test('TRV-UI-15 a manager reaches the travel list and is offered no decision', async ({
      page,
      problems,
    }) => {
      expect(pendingId, `no trip to look at: ${setupError}`).toBeTruthy();

      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();
      await expect(page).not.toHaveURL(/\/403/);
      await travel.filterByStatus('PENDING');

      // Reaching the queue and being able to act on it are two different grants:
      // `ProtectedRoute` admits MANAGER, `travel_approver_roles` does not.
      await expect.poll(() => travel.hasRow(pendingId), { timeout: 15_000 }).toBe(true);
      expect(
        await travel.canApprove(pendingId),
        'a manager was offered an approval control travel_approver_roles does not grant',
      ).toBe(false);
      expect(await travel.canReject(pendingId)).toBe(false);

      // And the server agrees, so a hidden button is not the only thing stopping it.
      await expect(
        managerApi.post(`/travel-requests/${pendingId}/approve`, { remarks: 'mine now' }),
      ).rejects.toThrow();

      settle(problems, "the manager's travel list");
    });

    test('TRV-UI-16 a manager is not offered Cancel on a trip they may not cancel', async ({
      page,
      problems,
    }) => {
      test.skip(!pendingId, 'no trip to look at');

      /**
       * FIXED. The Cancel control used to be drawn for every role that could see
       * the row — the only condition on it was the trip's status — while the
       * server admits the trip's owner, ADMIN and HR_MANAGER and nobody else. A
       * manager pressed a button that could only fail, and a control that exists
       * only to be refused reads as a broken screen rather than as a boundary.
       *
       * The client guard now mirrors `TravelService.cancel`. It is a courtesy,
       * never the boundary: the second half of this case proves the server still
       * refuses on its own, so removing the guard would cost a round trip and
       * could never authorise anything.
       */
      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();
      await travel.filterByStatus('PENDING');

      await expect.poll(() => travel.hasRow(pendingId), { timeout: 15_000 }).toBe(true);
      expect(
        await travel.canCancel(pendingId),
        'a manager was offered Cancel on a trip they do not own',
      ).toBe(false);

      // The server is still the boundary. Going around the screen must fail.
      await expect(
        managerApi.delete(`/travel-requests/${pendingId}`),
        'the client guard is the only thing stopping a manager cancelling',
      ).rejects.toThrow();

      expect(
        (await adminApi.get<TravelRecord>(`/travel-requests/${pendingId}`)).status,
        'a manager cancelled a trip they do not own',
      ).toBe('PENDING');

      crashesOnly(problems);
      settle(problems, 'the manager cancel guard');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin or hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin') && !isProject('hr'), 'the admitted roles');
    });

    test('TRV-UI-17 admin and HR reach the travel list', async ({ page, problems }) => {
      await selectBranch(page, branchId);
      const travel = new TravelPage(page);
      await travel.open();

      await expect(page).not.toHaveURL(/\/403/);
      // The screen has loaded when it is showing either rows or its empty panel;
      // asserting on neither would pass against a spinner that never resolves.
      await expect
        .poll(async () => (await travel.rowCount()) > 0 || (await travel.isEmpty()), {
          timeout: 15_000,
        })
        .toBe(true);

      settle(problems, 'the admitted roles on /dashboard/travel');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the only globally-scoped role');
    });

    test('TRV-UI-18 a branch with no trips shows the empty panel, not another branch\'s list', async ({
      page,
      problems,
    }) => {
      test.skip(!otherBranchId, 'the second branch is not seeded');

      // `TravelRequest` is branch-scoped through its employee, so pointing the
      // picker at a branch with no travellers must empty the list. The failure
      // this guards against is the opposite one: a screen that ignores the branch
      // header and shows another branch's trips to someone who cannot see them.
      await selectBranch(page, otherBranchId);
      const travel = new TravelPage(page);
      await travel.open();

      await expect.poll(() => travel.isEmpty(), { timeout: 15_000 }).toBe(true);
      expect(await travel.rowCount()).toBe(0);

      settle(problems, 'the travel list in an empty branch');
    });
  });
});
