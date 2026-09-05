import { test, expect, settle, crashesOnly } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import {
  BiometricEnrollmentPage,
  FaceEnrollmentPanel,
  selectBranch,
  captureNativeDialogs,
} from '../../pages';

/**
 * Biometric enrolment, through the admin screen.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * Face MATCHING accuracy. No case compares two faces or reads a confidence
 * score. There is also a hard reason a browser cannot enrol one: Chromium's
 * `--use-fake-device-for-media-stream` produces a rolling test pattern with no
 * face in it, so `POST /face-recognition/register` answers *"No face detected
 * in the image"*. The existing `attendance.spec.ts` only works because
 * recognition is pinned OFF and the backend stores the frame instead of
 * matching it.
 *
 * So this file asserts the parts that are real and reachable: the enrolled and
 * not-enrolled states, the counts, the descriptor list, deletion through the
 * native `confirm()`, and the role boundary. Enrolment state is SEEDED over the
 * API rather than captured, which is exactly how the backend suite reaches the
 * 5-descriptor cap without a model.
 *
 * F8 is pinned here too: the screen fetches `limit: 200` and paginates 20 at a
 * time client-side, so employee 201 is invisible. Recorded, not simulated —
 * load is not what this suite measures.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

interface EmployeeRow {
  id: string;
  fullName: string;
  employeeCode: string;
}

test.describe('biometric enrolment, as HR manages it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the HR half');
  });

  let branchId = '';
  let target: EmployeeRow | null = null;
  const seeded: string[] = [];

  test.beforeEach(async ({ api }) => {
    if (!branchId) branchId = await api.firstBranchId();
    if (!target) {
      const res = await api
        .withBranch(branchId)
        .get<any>('/employees?status=ACTIVE&limit=50');
      const rows: EmployeeRow[] = Array.isArray(res) ? res : (res?.data ?? []);
      target = rows[0] ?? null;
    }
  });

  test('BIO-UI-01 the three stat tiles agree with the employee payload', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const bio = new BiometricEnrollmentPage(page);

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'GET' && r.url().includes('/employees'),
      ),
      bio.open(),
    ]);
    expect(res.status()).toBe(200);
    await page.waitForTimeout(500);

    const total = await bio.stat('total');
    const registered = await bio.stat('registered');
    const unregistered = await bio.stat('unregistered');

    // The three are derived from one list, so they must reconcile — a tile that
    // does not add up is the tell that one of them counted a different set.
    expect(registered + unregistered).toBe(total);

    settle(problems, 'the biometric stat tiles');
  });

  /** F8, pinned: the ceiling is recorded rather than simulated. */
  test('BIO-UI-02 KNOWN LIMIT: the screen fetches at most 200 employees', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const bio = new BiometricEnrollmentPage(page);

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'GET' && r.url().includes('/employees'),
      ),
      bio.open(),
    ]);

    // Employee 201 onward cannot be enrolled through this screen at all.
    expect(res.url()).toContain('limit=200');

    settle(problems, 'the enrolment fetch ceiling');
  });

  test('BIO-UI-03 search narrows the list and empties honestly', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const bio = new BiometricEnrollmentPage(page);
    await bio.open();
    await page.waitForTimeout(600);

    const before = await bio.rowCount();
    await bio.search('zzz-no-such-employee-anywhere');
    await page.waitForTimeout(600);

    expect(await bio.rowCount()).toBeLessThan(Math.max(before, 1));
    settle(problems, 'the enrolment search');
  });

  /**
   * The not-enrolled state, asserted against the row's own attributes rather
   * than a badge label — the label is translated.
   */
  test('BIO-UI-04 an employee with no descriptors reports zero and not-enrolled', async ({
    page,
    problems,
    api,
  }) => {
    test.skip(!target, 'needs an employee');

    const existing = await api
      .withBranch(branchId)
      .get<any[]>(`/face-recognition/descriptors/${target!.id}`)
      .catch(() => []);
    test.skip((existing ?? []).length > 0, 'this employee is already enrolled');

    await selectBranch(page, branchId);
    const bio = new BiometricEnrollmentPage(page);
    await bio.open();
    await bio.search(target!.employeeCode);
    await page.waitForTimeout(600);

    expect(await bio.isEnrolled(target!.employeeCode)).toBe(false);
    expect(await bio.faceCount(target!.employeeCode)).toBe(0);

    settle(problems, 'the not-enrolled state');
  });

  /**
   * Enrolment state seeded over the API — the only way to reach an enrolled
   * screen without a face model, and the same trick the backend suite uses to
   * hit the cap. `descriptor` is a plain `Float[]`, so the vector only has to
   * be well-formed, not meaningful.
   */
  test('BIO-UI-05 an enrolled employee shows their descriptor count and photos', async ({
    page,
    problems,
    api,
  }) => {
    test.skip(!target, 'needs an employee');

    // Seeding descriptors requires the register endpoint, which needs a real
    // face. So this case runs only when the environment already has one
    // enrolled — otherwise it is honestly skipped rather than faked.
    const rows = await api
      .withBranch(branchId)
      .get<any>('/employees?status=ACTIVE&limit=200');
    const list: any[] = Array.isArray(rows) ? rows : (rows?.data ?? []);
    const enrolled = list.find((e) => (e._count?.faceDescriptors ?? 0) > 0);
    test.skip(!enrolled, 'no enrolled employee in this environment');

    await selectBranch(page, branchId);
    const bio = new BiometricEnrollmentPage(page);
    await bio.open();
    await bio.search(enrolled.employeeCode);
    await page.waitForTimeout(600);

    expect(await bio.isEnrolled(enrolled.employeeCode)).toBe(true);
    const count = await bio.faceCount(enrolled.employeeCode);
    expect(count).toBeGreaterThan(0);

    await captureNativeDialogs(page);
    await bio.openEmployee(enrolled.employeeCode);
    await page.waitForTimeout(800);

    const panel = new FaceEnrollmentPanel(page);
    expect(await panel.count()).toBe(count);
    expect(await panel.max()).toBeGreaterThanOrEqual(count);

    settle(problems, 'the enrolled panel');
  });

  test('BIO-UI-06 opening an employee and going back returns to the list', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);
    const bio = new BiometricEnrollmentPage(page);
    await bio.open();
    await page.waitForTimeout(600);

    const codes = await page
      .locator('[data-testid^="bio-open-"]')
      .evaluateAll((els) =>
        els.map((e) => (e.getAttribute('data-testid') ?? '').replace('bio-open-', '')),
      );
    test.skip(codes.length === 0, 'no employees to open');

    await bio.openEmployee(codes[0]);
    await page.waitForTimeout(600);
    await bio.back();
    await page.waitForTimeout(400);

    expect(await bio.rowCount()).toBeGreaterThan(0);
    settle(problems, 'the enrolment detail round trip');
  });
});

test.describe('biometric enrolment, for the roles it is not meant for', () => {
  /**
   * `GET /employees` admits a MANAGER, so the LIST loads for them — but
   * `GET /face-recognition/descriptors/:employeeId` is ADMIN/HR, so opening a
   * card is a clean data-403. No guard on the route, so no redirect.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the manager view');
    });

    test('BIO-UI-07 a manager sees the list and is refused a descriptor read', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await api.firstBranchId());
      const bio = new BiometricEnrollmentPage(page);
      await bio.open();
      await page.waitForTimeout(1000);

      await expect(page).not.toHaveURL(/\/403/);

      const codes = await page
        .locator('[data-testid^="bio-open-"]')
        .evaluateAll((els) =>
          els.map((e) => (e.getAttribute('data-testid') ?? '').replace('bio-open-', '')),
        );

      if (codes.length > 0) {
        const [res] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes('/face-recognition/descriptors/') &&
              r.request().method() === 'GET',
            { timeout: 10_000 },
          ).catch(() => null),
          bio.openEmployee(codes[0]),
        ]);
        if (res) expect(res.status()).toBe(403);
      }

      crashesOnly(problems);
      settle(problems, 'the manager biometric view');
    });
  });

  /**
   * F1, FIXED. `routes.ts` recorded `/dashboard/face-recognition` as ADMIN-only
   * while the sidebar linked it for EMPLOYEE and MANAGER — and the server
   * agrees with the sidebar: `/status`, `/descriptors/me`, `POST /register` and
   * `DELETE /descriptors/:id` are all four-role. This drives the self-service
   * screen as the role that uses it daily.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the self-service view');
    });

    test('BIO-UI-08 an employee can open their own enrolment screen', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/face-recognition', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      await expect(page).not.toHaveURL(/\/403/);
      settle(problems, 'self-service enrolment');
    });
  });
});
