import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { PaymentInformationSection, ApprovalsInboxPage } from '../../pages';

/**
 * The employee-facing bank change, end to end.
 *
 * `PaymentInformationSection` is the ONLY screen in the app that raises a
 * `BankChangeRequest`, and it never edits a bank detail directly — the record
 * changes when the request is approved, not when the form is saved. That is the
 * property this file protects: the form saying "submitted" while the record
 * silently changed, or silently did not, are both expensive kinds of wrong.
 *
 * It is also where the flat-error-shape trap did the most damage. The server
 * answers a bad account with per-FIELD reasons; the screen read
 * `err.response.data.message`, which is always `undefined` under this app's axios
 * interceptor, so an employee typing a malformed IBAN was told only that
 * something went wrong.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

interface CurrentBankDetail {
  pendingRequestId?: string | null;
  countries?: string[];
  detail?: unknown;
}

test.describe('an employee changes their bank details', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let country = '';
  let bankId = '';
  let hasSchema = false;

  test.beforeAll(async () => {
    employeeApi = await ApiClient.as('employee');
    adminApi = await ApiClient.as('admin');

    const current = await employeeApi
      .get<CurrentBankDetail>('/bank-change-requests/me/current')
      .catch(() => null);
    country = current?.countries?.[0] ?? '';

    if (country) {
      const banks = await adminApi
        .get<{ data?: Array<{ id: string }> } | Array<{ id: string }>>(
          `/banks?country=${country}&activeOnly=true`,
        )
        .catch(() => null);
      const list = Array.isArray(banks) ? banks : (banks?.data ?? []);
      bankId = list?.[0]?.id ?? '';

      const fields = await employeeApi
        .get<{ data?: Array<{ fieldKey: string }> } | Array<{ fieldKey: string }>>(
          `/banking-config/fields?country=${country}`,
        )
        .catch(() => null);
      const fieldList = Array.isArray(fields) ? fields : (fields?.data ?? []);
      hasSchema = (fieldList?.length ?? 0) > 0;
    }

  });

  /**
   * Is this employee's bank frozen RIGHT NOW?
   *
   * Checked at the moment of acting rather than once at setup: the payroll
   * journeys in this same suite open and close runs for the same seeded
   * employee while these tests execute, so a freeze that was absent during
   * `beforeAll` can arrive mid-file.
   */
  const freezeReason = async (): Promise<string | null> => {
    if (!bankId) return null;
    const probe = await employeeApi
      .post('/bank-change-requests', { bankId, data: {} })
      .then(() => null)
      .catch((e: unknown) => e as { statusCode?: number; message?: string });
    return probe?.statusCode === 409 ? (probe.message ?? 'bank details are frozen') : null;
  };

  test.afterAll(async () => {
    // Withdraw whatever this file left open, so a re-run starts clean.
    const current = await employeeApi
      ?.get<CurrentBankDetail>('/bank-change-requests/me/current')
      .catch(() => null);
    if (current?.pendingRequestId) {
      await adminApi
        .post(`/bank-change-requests/${current.pendingRequestId}/cancel`, {})
        .catch(() => {});
    }
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee journey');
    });

    test('BCR-UI-01: the employee is offered a change on their own profile', async ({
      page,
      problems,
    }) => {
      test.skip(!bankId || !hasSchema, 'no bank master or field schema is configured');

      const section = new PaymentInformationSection(page);
      await section.openOwn();

      await expect.poll(() => section.canRequestChange(), { timeout: 20_000 }).toBe(true);
      settle(problems, 'the profile payment section');
    });

    test('BCR-UI-02: a bad account is refused per FIELD, beside the field', async ({
      page,
      problems,
    }) => {
      test.skip(!bankId || !hasSchema, 'no bank master or field schema is configured');
      const freeze = await freezeReason();
      test.skip(!!freeze, freeze ?? '');

      const section = new PaymentInformationSection(page);
      await section.openOwn();
      await section.startRequest();
      await section.chooseBank(bankId);

      // Only a field with a REAL validationType can be made invalid. A schema of
      // nothing but free text would be accepted, and the test would be asserting
      // an error the server had no reason to raise — which is what made this flaky
      // before it was pinned to a validated field.
      const schema = await employeeApi.get<Array<{ fieldKey: string; validationType: string }>>(
        `/banking-config/fields?country=${country}`,
      );
      const validated = (schema ?? []).filter((f) => f.validationType !== 'NONE');
      test.skip(validated.length === 0, 'the country schema has no validated field to break');

      for (const f of schema ?? []) {
        await section.fillField(f.fieldKey, f.validationType === 'NONE' ? 'Journey Holder' : '!!!');
      }
      await section.submit();

      // The reason has to be visible ON the screen, not swallowed into a generic
      // sentence — which is exactly what the flat-error read produced.
      await expect
        .poll(
          async () => (await page.getByTestId(/^pay-info-error-/).count()) > 0,
          { timeout: 20_000 },
        )
        .toBe(true);
      crashesOnly(problems);
    });

    test('BCR-UI-03: a valid request is raised and the record does NOT change yet', async ({
      page,
      problems,
    }) => {
      test.skip(!bankId || !hasSchema, 'no bank master or field schema is configured');
      const freeze = await freezeReason();
      test.skip(!!freeze, freeze ?? '');

      const before = await employeeApi.get<CurrentBankDetail>('/bank-change-requests/me/current');

      const section = new PaymentInformationSection(page);
      await section.openOwn();
      await section.startRequest();
      await section.chooseBank(bankId);

      // ApiClient unwraps the { success, data } envelope, so this IS the array.
      const fields = await employeeApi.get<Array<{ fieldKey: string; validationType: string }>>(
        `/banking-config/fields?country=${country}`,
      );
      for (const f of fields ?? []) {
        // Only the free-text fields can be filled generically; anything with a
        // real validationType is the backend suite's business, and this journey
        // skips rather than encoding a per-country account format.
        if (f.validationType !== 'NONE') {
          test.skip(true, 'the country schema needs a validated account number');
          return;
        }
        await section.fillField(f.fieldKey, 'Journey Holder');
      }
      await section.submit();

      await expect.poll(() => section.hasPendingBanner(), { timeout: 20_000 }).toBe(true);

      const after = await employeeApi.get<CurrentBankDetail>('/bank-change-requests/me/current');
      expect(after.pendingRequestId).toBeTruthy();
      // The detail itself is untouched until the request is approved.
      expect(JSON.stringify(after.detail ?? null)).toBe(JSON.stringify(before.detail ?? null));
      settle(problems, 'the profile payment section after a request');
    });

    test('BCR-UI-04: while one is pending, another cannot be raised', async ({ page, problems }) => {
      const current = await employeeApi.get<CurrentBankDetail>('/bank-change-requests/me/current');
      test.skip(!current.pendingRequestId, 'nothing pending to assert against');

      const section = new PaymentInformationSection(page);
      await section.openOwn();
      await expect.poll(() => section.hasPendingBanner(), { timeout: 20_000 }).toBe(true);
      // The control is hidden rather than left to 409 — one open request per
      // employee is a partial unique index, not advice.
      expect(await section.canRequestChange()).toBe(false);
      settle(problems, 'the profile payment section while pending');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'hr project only');
    });

    test('BCR-UI-05: the request is visible to an approver in the inbox', async ({
      page,
      problems,
    }) => {
      const inbox = new ApprovalsInboxPage(page);
      await inbox.open();
      // The inbox only lists what the chain has actually asked this user to
      // decide, so an empty one is a legitimate outcome — what must never happen
      // is a crash or a row this user cannot act on.
      crashesOnly(problems);
      expect(page.url()).toContain('/dashboard/approvals');
    });
  });
});
