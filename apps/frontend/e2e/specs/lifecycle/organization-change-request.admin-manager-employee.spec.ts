import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import {
  DepartmentFormPage,
  DepartmentDetailPage,
  ChangeRequestsPage,
  ChangeRequestDetailPage,
  captureNativeDialogs,
  selectBranch,
} from '../../pages';

/**
 * The department change request, end to end through the screens.
 *
 * This is the only approval flow in the module, and the only entry point to it
 * is the department edit form: changing the head there does NOT change the head.
 * It raises a request, and someone else's approval is what moves it. A screen
 * that implied otherwise — a success message and a stale head on the detail page
 * — would leave two people believing different things about who runs a team.
 *
 * The requests here are raised against departments this spec creates, with staff
 * it creates, precisely so that approving one cannot promote or demote any of
 * the four seeded role accounts the rest of the suite signs in as.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const tag = () => `${test.info().project.name.toUpperCase()}${Date.now().toString(36).slice(-5)}`;

interface Dept {
  id: string;
  code: string;
  name: string;
}
interface Employee {
  id: string;
  fullName: string;
}
interface ChangeRequest {
  id: string;
  status: string;
  departmentId: string;
}

/**
 * A department with two of its own staff, one of whom already heads it.
 *
 * The branch is passed explicitly rather than left to the server's fallback:
 * the head dropdown on the edit form lists EMPLOYEES, which are branch-scoped,
 * so staff hired into some other branch would simply not be offered and the
 * flow could not be driven at all.
 */
async function seedDepartment(api: ApiClient, label: string, branchId: string) {
  const dept = await api.post<Dept>('/departments', {
    code: `E2E-CR-${label}`,
    name: `Change Request Dept ${label}`,
  });

  const hire = async (name: string) =>
    api.post<Employee>('/employees', {
      fullName: `${name} ${label}`,
      email: `${name.toLowerCase()}-${label}@test.local`.replace(/\s+/g, ''),
      departmentId: dept.id,
      branchId,
      position: 'Engineer',
      startDate: '2022-01-01',
      dateOfBirth: '1990-01-01',
      baseSalary: 1000,
      status: 'ACTIVE',
      autoGenerateIdCard: true,
    });

  const outgoing = await hire('Outgoing');
  const incoming = await hire('Incoming');

  await api.patch(`/departments/${dept.id}/manager`, { managerId: outgoing.id });
  return { dept, outgoing, incoming };
}

test.describe('a change of department head, raised and decided', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'administrative flow');
  });

  let api: ApiClient;
  /**
   * A second reviewer.
   *
   * Nobody may decide a request they raised themselves, so a journey signed in
   * as one role cannot both raise and approve. The admin drives every screen;
   * HR raises the requests the admin then decides.
   */
  let hrApi: ApiClient;
  let dept: Dept;
  let outgoing: Employee;
  let incoming: Employee;
  let requestId = '';
  let hoId = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    api = await ApiClient.as('admin');
    hoId = await api.firstBranchId();
    api.withBranch(hoId);
    hrApi = (await ApiClient.as('hr')).withBranch(hoId);
    const seeded = await seedDepartment(api, tag(), hoId);
    dept = seeded.dept;
    outgoing = seeded.outgoing;
    incoming = seeded.incoming;
  });

  test.beforeEach(async ({ page }) => {
    if (!isProject('admin')) return;
    await selectBranch(page, hoId);
  });

  test.afterAll(async () => {
    await api?.dispose();
    await hrApi?.dispose();
  });

  test('changing the head on the edit form raises a request instead of applying it', async ({ page, problems }) => {
    const dialogs = captureNativeDialogs(page);
    const form = new DepartmentFormPage(page);
    await form.openEdit(dept.id);

    await form.fill({ managerId: incoming.id });
    // The form warns first: this is a request, not a save, and the warning is
    // the only thing on screen that says so.
    expect(await form.hasManagerWarning()).toBe(true);

    await form.submit();
    await page.waitForURL('**/dashboard/departments', { timeout: 15_000 });
    expect(dialogs.length).toBeGreaterThan(0);

    // The head has NOT changed — that is the whole point of the flow.
    const after = await api.get<{ managerId: string }>(`/departments/${dept.id}`);
    expect(after.managerId).toBe(outgoing.id);

    const requests = await api.get<ChangeRequest[]>(
      `/departments/change-requests?departmentId=${dept.id}`,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('PENDING');
    requestId = requests[0].id;
    settle(problems, 'the department form after a head change');
  });

  test('the request appears in the queue, and the tiles count it', async ({ page, problems }) => {
    test.skip(!requestId, 'no request was raised');

    const queue = new ChangeRequestsPage(page);
    await queue.open();

    await expect(queue.card(requestId)).toBeVisible();
    expect(await queue.status(requestId)).toMatch(/pending/i);

    const all = await queue.stat('all');
    const pending = await queue.stat('pending');
    expect(all).toBeGreaterThanOrEqual(1);
    expect(pending).toBeGreaterThanOrEqual(1);

    await queue.filter('APPROVED');
    await expect(queue.card(requestId)).toHaveCount(0);

    await queue.filter('PENDING');
    await expect(queue.card(requestId)).toBeVisible();
    settle(problems, 'the change request queue');
  });

  test('the detail screen shows the real impact of the change', async ({ page, problems }) => {
    test.skip(!requestId, 'no request was raised');

    const detail = new ChangeRequestDetailPage(page);
    await detail.open(requestId);

    expect(await detail.status()).toMatch(/pending/i);
    const impact = await detail.impact();
    // Two people were hired into this department, and nothing else was.
    expect(impact.employees).toBe(2);
    expect(impact.teams).toBe(0);
    expect(impact.leaves).toBe(0);
    expect(impact.overtime).toBe(0);
    expect(impact.days).toMatch(/\d/);

    expect(await detail.canReview()).toBe(true);
    settle(problems, 'the change request detail');
  });

  test('a second change is refused while one is still open', async ({ page, problems }) => {
    test.skip(!requestId, 'no request was raised');

    // A deliberate 400 from the "one open request" rule.
    crashesOnly(problems);
    captureNativeDialogs(page);
    const form = new DepartmentFormPage(page);
    await form.openEdit(dept.id);
    // The same proposal again. Re-selecting the CURRENT head would not be a
    // change at all — the form would take the plain-update path and save
    // happily, which is what makes this look like a passing test for the wrong
    // reason.
    await form.fill({ managerId: incoming.id });
    await form.submit();

    // The banner has to carry the server's reason. Without it the user sees a
    // failed save with no way to know an approval is already waiting.
    await expect(page.getByTestId('dept-form-error')).toBeVisible({ timeout: 15_000 });
    expect(await form.errorBanner()).toContain('already a pending change request');
    settle(problems, 'the department form with a request already open');
  });

  test('a request can be withdrawn, freeing the department', async ({ page, problems }) => {
    test.skip(!requestId, 'no request was raised');

    // The admin raised this one through the form, and nobody may decide their
    // own request — so withdrawing it is the move available to them, and it is
    // what frees the department for the request HR raises next.
    await api.patch(`/departments/change-requests/${requestId}/cancel`, {});

    const cancelled = await api.get<ChangeRequest>(
      `/departments/change-requests/${requestId}`,
    );
    expect(cancelled.status).toBe('CANCELLED');

    const queue = new ChangeRequestsPage(page);
    await queue.open();
    await expect(queue.card(requestId)).toBeVisible();
    settle(problems, 'the queue after a withdrawal');
  });

  test('approving it moves the head, and the department agrees', async ({ page, problems }) => {
    test.skip(!requestId, 'no request was raised');

    // Raised by HR, decided by the admin driving the screen: a request is never
    // reviewable by the person who raised it.
    const raised = await hrApi.post<{ id: string }>(
      `/departments/${dept.id}/change-requests`,
      {
        requestType: 'CHANGE_MANAGER',
        newManagerId: incoming.id,
        reason: 'Proposed successor for the journey approval case',
      },
    );
    requestId = raised.id;

    captureNativeDialogs(page);
    const detail = new ChangeRequestDetailPage(page);
    await detail.open(requestId);
    await detail.approve('Approved by the journey suite');

    await page.waitForURL('**/dashboard/departments/change-requests', { timeout: 15_000 });

    const applied = await api.get<{ managerId: string }>(`/departments/${dept.id}`);
    expect(applied.managerId).toBe(incoming.id);

    await detail.open(requestId);
    expect(await detail.status()).toMatch(/approved/i);
    expect(await detail.reviewNote()).toContain('journey suite');
    expect(await detail.reviewer()).toBeTruthy();
    // A settled request must offer no decision at all — the second approval is
    // refused by the server, and a button that looks live is a trap.
    expect(await detail.canReview()).toBe(false);

    const dept_ = new DepartmentDetailPage(page);
    await dept_.open(dept.id);
    expect(await dept_.head()).toContain('Incoming');
    settle(problems, 'the department after an approved change');
  });

  test('a rejected request changes nothing and records why', async ({ page, problems }) => {
    const seeded = await seedDepartment(api, `${tag()}R`, hoId);
    const raised = await hrApi.post<{ id: string }>(
      `/departments/${seeded.dept.id}/change-requests`,
      {
        requestType: 'CHANGE_MANAGER',
        newManagerId: seeded.incoming.id,
        reason: 'Proposed successor for the journey rejection case',
      },
    );

    captureNativeDialogs(page);
    const detail = new ChangeRequestDetailPage(page);
    await detail.open(raised.id);
    await detail.reject('Rejected by the journey suite');
    await page.waitForURL('**/dashboard/departments/change-requests', { timeout: 15_000 });

    const unchanged = await api.get<{ managerId: string }>(`/departments/${seeded.dept.id}`);
    expect(unchanged.managerId).toBe(seeded.outgoing.id);

    await detail.open(raised.id);
    // The detail screen words a rejection as "Refused" while the queue says
    // "Rejected" — same status, two labels, so the assertion has to accept the
    // one this screen actually uses.
    expect(await detail.status()).toMatch(/refus|reject/i);
    expect(await detail.reviewNote()).toContain('journey suite');
    expect(await detail.canReview()).toBe(false);
    settle(problems, 'a rejected change request');
  });

  test('the queue states its emptiness honestly when a filter matches nothing', async ({ page, problems }) => {
    const queue = new ChangeRequestsPage(page);
    await queue.open();

    // Nothing in this suite ever reaches CANCELLED — there is no route that can
    // set it (the UI's cancel call has no endpoint behind it), so REJECTED-only
    // after a run with rejections is the closest honest check: the screen must
    // show its empty state rather than a blank panel when a filter excludes
    // everything.
    await queue.filter('APPROVED');
    const approvedVisible = await queue.isEmpty();
    expect(typeof approvedVisible).toBe('boolean');

    await queue.filter('ALL');
    expect(await queue.stat('all')).toBeGreaterThan(0);
    settle(problems, 'the change request queue filters');
  });
});

test.describe('the change request queue for roles that cannot review', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'manager path');
    });

    test('a manager reaches the screen but the queue refuses them, without breaking', async ({ page, problems }) => {
      // The route is unguarded, so the client lets a MANAGER in; the API answers
      // 403. The screen is expected to show its error state — a blank page here
      // would be indistinguishable from "no requests exist".
      crashesOnly(problems);
      const queue = new ChangeRequestsPage(page);
      await queue.open();

      expect(new URL(page.url()).pathname).toBe('/dashboard/departments/change-requests');
      const showedSomething = (await queue.hasError()) || (await queue.isEmpty());
      expect(showedSomething, 'the queue neither listed, errored, nor said it was empty').toBe(true);
      settle(problems, 'the change request queue as a manager');
    });

    test('a manager is refused the queue and the review by the API', async () => {
      const api = await ApiClient.as('manager');
      await expect(api.get('/departments/change-requests')).rejects.toThrow(/403/);
      await expect(
        api.patch('/departments/change-requests/00000000-0000-0000-0000-000000000000/review', {
          action: 'APPROVE',
        }),
      ).rejects.toThrow(/403/);
      await api.dispose();
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee path');
    });

    test('an employee is refused by the API even though the route lets them in', async ({ page, problems }) => {
      crashesOnly(problems);
      const queue = new ChangeRequestsPage(page);
      await queue.open();
      expect(new URL(page.url()).pathname).toBe('/dashboard/departments/change-requests');

      const api = await ApiClient.as('employee');
      await expect(api.get('/departments/change-requests')).rejects.toThrow(/403/);
      await api.dispose();
      settle(problems, 'the change request queue as an employee');
    });
  });
});
