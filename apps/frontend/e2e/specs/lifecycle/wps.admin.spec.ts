import { test, expect, settle, ApiClient } from '../../fixtures';
import { WpsPage, selectBranch } from '../../pages';

/**
 * The salary payment file, from pre-flight to bytes on disk.
 *
 * This is the only screen in the app that produces an artifact a bank acts on,
 * and the failure that matters is not a broken button — it is a file that comes
 * out of figures which could still change. So the gate is the subject of the
 * test: pre-flight must REFUSE a payroll that is not properly locked, and must
 * change its mind once it is.
 *
 * The journey therefore runs deliberately out of order relative to a happy path:
 * the run is created and left in DRAFT, the screen is asked for a report, and
 * the blocking finding is asserted. Only then is the run taken through submit →
 * approve → lock, and Re-check — which writes nothing and is safe to hammer —
 * has to report a different answer. A spec that locked first would prove the
 * button works and nothing about the gate.
 *
 * The download is a real download. The bytes are fetched by an authenticated
 * XHR and handed over as an object URL, because the token lives in localStorage
 * and a plain link would arrive without it; asserting only that the button
 * exists would miss a 401 entirely.
 *
 * ## Everything a wage file needs before it can exist
 *
 * All of it is set up over the API here, because none of it is what is under
 * test and reaching it by clicking would take six screens:
 *
 *   • a per-country banking field schema (the seeded defaults),
 *   • a Bank Master row, and an active bank detail per employee,
 *   • a WPS employer profile carrying the format's required employer fields,
 *   • a WPS configuration attaching that profile to the branch,
 *   • a per-branch payroll with attendance behind it and a POSITIVE net for
 *     every employee on it — a wage file cannot carry a zero payment.
 *
 * `generic-csv-v1` is used rather than one of the Oman formats: it is the
 * country-neutral adapter that exists precisely so the whole flow is exercisable
 * without a market's legal layout, and it asks for no legal identifiers.
 *
 * ## Why this journey owns a branch
 *
 * A wage file is ALL-OR-NOTHING: one employee on the run without an account, or
 * with a zero net, and no file is produced for anyone. A payroll picks up every
 * active employee in its branch, so a spec running beside this one that creates
 * an employee — `employee-import.spec.ts` does exactly that — would land a
 * bankless person on the run and block the file, as a failure pointing at WPS.
 *
 * Payroll is per-branch, so the branch IS the isolation the domain already
 * offers. This file takes the non-head-office branch (the one
 * `ApiClient.firstBranchId()` does not return, and so no other journey uses) and
 * staffs it itself.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const FORMAT = 'generic-csv-v1';
/**
 * The country the bank details are written in, resolved from the BRANCH at
 * setup rather than hardcoded.
 *
 * A branch only accepts bank details from the countries it banks in
 * (`Branch.bankingCountries`, falling back to `Branch.country`), and the seed
 * ships its branches as Oman. Pinning this to India meant every migration below
 * was refused — and because those calls are best-effort `.catch()`es, the
 * refusal was silent: the run simply arrived at pre-flight with
 * `NO_ACTIVE_BANK_DETAIL` for every employee, which reads as a WPS defect rather
 * than a setup one.
 */
let bankCountry = 'OM';
const marker = `pw-wps-${Date.now().toString(36)}`;

/**
 * A period this run has to itself, and one no other journey uses.
 *
 * `payroll.spec.ts` takes 1–24 months forward; this file takes 25–48, so the two
 * can never contend for the same run. Far-future periods are legal because the
 * attendance that makes them legal is seeded below.
 */
function targetPeriod(): { month: number; year: number } {
  const monthsForward = 25 + (Date.now() % 24);
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + monthsForward);
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

interface PayrollRecord {
  id: string;
  status: string;
  month: number;
  year: number;
}

interface EmployeeRecord {
  id: string;
  employeeCode: string;
  fullName: string;
  baseSalary: string;
}

/** Employees the caller's branch header scopes it to. */
async function branchEmployees(api: ApiClient): Promise<EmployeeRecord[]> {
  const res = await api.get<EmployeeRecord[] | { data?: EmployeeRecord[] }>('/employees?limit=200');
  return Array.isArray(res) ? res : (res?.data ?? []);
}

/**
 * The branch this journey runs in: anything but Head Office, which
 * `firstBranchId()` hands to every other journey. Falls back to whatever exists
 * rather than failing outright — a single-branch install is a legitimate setup,
 * it just means this file shares.
 */
async function isolatedBranchId(api: ApiClient): Promise<string> {
  const branches = await api.get<Array<{ id: string; code: string; isActive?: boolean }>>('/branches');
  const list = Array.isArray(branches) ? branches : [];
  const own = list.find((b) => b.code !== 'HO' && b.isActive !== false);
  return own?.id ?? (await api.firstBranchId());
}

/**
 * Guarantees the branch has someone to pay.
 *
 * Created once and reused: the second run finds the employee from the first,
 * which matters because a generated wage file freezes their bank details and a
 * fresh account could no longer be attached.
 */
async function ensureStaffed(api: ApiClient, branchId: string): Promise<EmployeeRecord[]> {
  const existing = await branchEmployees(api);
  if (existing.length > 0) return existing;

  const departments = await api.get<Array<{ id: string }> | { data?: Array<{ id: string }> }>('/departments');
  const deptList = Array.isArray(departments) ? departments : (departments?.data ?? []);
  if (!deptList.length) throw new Error('no department exists to hire into');

  const id = `wps${Date.now().toString(36)}`;
  await api.post('/employees', {
    fullName: `WPS Journey ${id}`,
    email: `${id}@e2e.local`,
    dateOfBirth: '1990-01-01',
    gender: 'MALE',
    idCard: `IDWPS-${id}`,
    departmentId: deptList[0].id,
    position: 'Wage File Tester',
    startDate: new Date().toISOString().slice(0, 10),
    baseSalary: 1200,
    salaryType: 'MONTHLY',
    timezone: 'UTC',
    branchId,
  });

  return branchEmployees(api);
}

/**
 * Everything the file needs that is not the payroll itself.
 *
 * Idempotent throughout, because this file has to work against a database that
 * was not reset. Bank details are the one part that can legitimately refuse:
 * once a generated wage file references an employee their account is frozen, so
 * a 409 here means the detail is already there and correct.
 */
async function ensureWpsSetup(
  api: ApiClient,
  branchId: string,
  employees: EmployeeRecord[],
): Promise<void> {
  await api.post('/banking-config/seed', {}).catch(() => undefined);

  // Whatever this branch is actually allowed to bank in.
  const branchCountries = await api
    .get<Array<{ id: string; countries?: string[]; bankingCountries?: string[] }>>(
      '/banks/branch-countries',
    )
    .catch(() => []);
  const mine = (branchCountries ?? []).find((b) => b.id === branchId);
  bankCountry = (mine?.countries ?? mine?.bankingCountries ?? [])[0] ?? bankCountry;

  // The country's field schema decides what a bank detail must contain, so read
  // it rather than assuming: an IBAN country additionally cross-checks the bank
  // code embedded in the IBAN against the Bank Master row, which a fixed
  // account-number/IFSC pair cannot satisfy.
  const fields = await api
    .get<Array<{ fieldKey: string; validationType: string }>>(
      `/banking-config/fields?country=${bankCountry}`,
    )
    .catch(() => []);
  const needsIban = (fields ?? []).some((f) => f.validationType === 'IBAN');

  // A genuinely valid Oman IBAN; positions 5-7 are the bank code "018", so the
  // Bank Master row this is attached to has to carry that same code.
  const IBAN = 'OM810180000001299123456';
  const IBAN_BANK_CODE = '018';

  const banks = await api.get<Array<{ id: string; name: string; isActive: boolean; bankCode?: string }>>(
    `/banks?country=${bankCountry}`,
  );
  const active = (Array.isArray(banks) ? banks : []).filter((b) => b.isActive);
  const existingBank = needsIban
    ? active.find((b) => b.bankCode === IBAN_BANK_CODE)
    : active[0];
  const bankId =
    existingBank?.id ??
    (
      await api.post<{ id: string }>('/banks', {
        country: bankCountry,
        name: `E2E Journey Bank ${bankCountry}${needsIban ? ` ${IBAN_BANK_CODE}` : ''}`,
        ...(needsIban ? { bankCode: IBAN_BANK_CODE } : {}),
      })
    ).id;

  /** A value the country's schema will accept for one field. */
  const valueFor = (field: { fieldKey: string; validationType: string }, name: string): string => {
    switch (field.validationType) {
      case 'IBAN':
        return IBAN;
      case 'IFSC':
        return 'HDFC0001234';
      case 'SWIFT':
        return 'HDFCINBB';
      case 'NUMBER':
        return '1234567890';
      default:
        // Deliberately the employee's own name where the field is free text: a
        // beneficiary-name mismatch is a WARNING the operator would then have to
        // acknowledge, which is a different test.
        return field.fieldKey.toLowerCase().includes('name') ? name : '1234567890';
    }
  };

  for (const employee of employees) {
    // A base rate of zero produces a zero net, and a wage file cannot carry a
    // zero payment — the baseline seed ships everyone on 0.
    if (Number(employee.baseSalary) <= 0) {
      await api.patch(`/employees/${employee.id}`, { baseSalary: 1200 }).catch(() => undefined);
    }

    // Only when there is nothing on file. A generated wage file freezes the
    // accounts it referenced, so re-attaching one is refused with a 409 — which
    // is correct, and not something to paper over by retrying.
    const current = await api
      .get<{ id?: string } | null>(`/bank-change-requests/employee/${employee.id}/current`)
      .catch(() => null);
    if (current?.id) continue;

    await api
      .post('/bank-change-requests/migration', {
        employeeId: employee.id,
        bankId,
        data: Object.fromEntries(
          (fields ?? []).map((f) => [f.fieldKey, valueFor(f, employee.fullName)]),
        ),
      })
      .catch(() => undefined);
  }

  const profile = await api.post<{ id: string }>('/wps/employer-profiles', {
    name: `E2E employer ${marker}`,
    legalName: 'E2E Journey Holdings LLC',
    country: bankCountry,
    format: FORMAT,
    data: { employerReference: 'E2EWPS', employerAccount: '1234567890' },
  });

  // Upserts on branchId, so re-running repoints the branch at the new profile.
  await api.post('/wps/config', {
    branchId,
    employerProfileId: profile.id,
    format: FORMAT,
    enabled: true,
  });
}

/** One present day per employee, enough to clear the "no attendance" guard. */
async function seedAttendance(
  api: ApiClient,
  employees: EmployeeRecord[],
  period: { month: number; year: number },
): Promise<void> {
  const day = `${period.year}-${String(period.month).padStart(2, '0')}-02`;
  for (const employee of employees) {
    await api
      .post('/attendances/manual', {
        employeeId: employee.id,
        date: day,
        checkIn: `${day}T09:00:00.000Z`,
        checkOut: `${day}T18:00:00.000Z`,
        status: 'PRESENT',
        notes: `Seeded by ${marker}`,
      })
      .catch(() => undefined);
  }
}

test.describe('a wage file is produced from a locked payroll', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'wage files are an administrative flow');
  });

  let api: ApiClient;
  let branchId = '';
  let payroll: PayrollRecord | null = null;
  let setupError = '';
  const period = targetPeriod();

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    api = await ApiClient.as('admin');

    try {
      branchId = await isolatedBranchId(api);
      api.withBranch(branchId);

      const employees = await ensureStaffed(api, branchId);
      await ensureWpsSetup(api, branchId, employees);
      await seedAttendance(api, employees, period);

      // Left in DRAFT on purpose — the first assertion is that the screen
      // refuses it.
      payroll = await api.post<PayrollRecord>('/payrolls', {
        month: period.month,
        year: period.year,
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('pre-flight refuses a payroll that is not properly locked', async ({ page, problems }) => {
    expect(payroll, `no payroll for ${period.month}/${period.year}: ${setupError}`).toBeTruthy();
    expect(payroll!.status).toBe('DRAFT');

    await selectBranch(page, branchId);
    const wps = new WpsPage(page);
    await wps.open(payroll!.id);

    // A setup problem (no configuration for the branch) comes back as a 400 and
    // is reported instead of the report — distinguishing the two is the point of
    // the separate banner, and confusing them would make this test lie.
    expect(
      await page.getByTestId('wps-setup-error').count(),
      'WPS is not configured for this branch, so pre-flight could not run at all',
    ).toBe(0);
    expect(await wps.preflightVisible(), 'the pre-flight report did not render').toBe(true);

    const report = await wps.report();
    expect(report.canGenerate, 'a DRAFT payroll was cleared to produce a wage file').toBe(false);
    expect(report.runBlockers, 'no run-level blocker was surfaced for an unlocked payroll').toBeGreaterThan(0);
    expect(await wps.generateEnabled(), 'the generate control was live while blocked').toBe(false);

    settle(problems, 'pre-flight on an unlocked payroll');
  });

  test('locking the run clears the blocker, and Re-check says so', async ({ page, problems }) => {
    test.skip(!payroll, 'no payroll to lock');

    // The real lifecycle, not a shortcut: `lockedAt` and `approvedAt` are both
    // required, so a run that reached LOCKED by an older path is still refused.
    await api.post(`/payrolls/${payroll!.id}/submit`, {});
    await api.post(`/payrolls/${payroll!.id}/approve`, { notes: `Automated journey ${marker}` });
    await api.post(`/payrolls/${payroll!.id}/lock`, {});

    const locked = await api.get<PayrollRecord>(`/payrolls/${payroll!.id}`);
    expect(locked.status).toBe('LOCKED');

    await selectBranch(page, branchId);
    const wps = new WpsPage(page);
    await wps.open(payroll!.id);
    await wps.recheck();

    const report = await wps.report();
    expect(report.runBlockers, 'the lock did not clear the run-level blocker').toBe(0);
    expect(
      report.blocked,
      `${report.blocked} of ${report.total} employees are still blocked — see the pre-flight report`,
    ).toBe(0);
    expect(report.total, 'the payroll carried no employee lines').toBeGreaterThan(0);
    expect(report.ready).toBe(report.total);
    expect(report.canGenerate, 'a properly locked, fully-ready run was still refused').toBe(true);
    expect(await wps.generateEnabled()).toBe(true);

    settle(problems, 'pre-flight after locking');
  });

  test('generating produces a file for every employee on the run', async ({ page, problems }) => {
    test.skip(!payroll, 'no payroll to generate from');

    await selectBranch(page, branchId);
    const wps = new WpsPage(page);
    await wps.open(payroll!.id);

    const before = await wps.report();
    test.skip(!before.canGenerate, 'pre-flight is still blocking; see the previous test');

    await wps.generate();

    const file = await wps.file();
    expect(file.status).toBe('GENERATED');
    expect(file.version).toBe('1');
    expect(file.fileName, 'the generated file has no name').not.toBe('');
    // All-or-nothing by design: half a wage file is worse than none, because the
    // bank rejects the whole submission and the employer is non-compliant anyway.
    expect(file.employeeCount).toBe(before.total);
    expect(await wps.fileRowCount()).toBe(before.total);

    // And the record agrees with the screen.
    const stored = await api.get<Array<{ id: string; status: string; employeeCount: number }>>(
      `/wps/files?payrollId=${payroll!.id}`,
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0].status).toBe('GENERATED');

    settle(problems, 'generating a wage file');
  });

  test('the file downloads, and the bytes are the instruction', async ({ page, problems }) => {
    test.skip(!payroll, 'no payroll to download from');

    await selectBranch(page, branchId);
    const wps = new WpsPage(page);
    await wps.open(payroll!.id);

    const file = await wps.file();
    test.skip(file.status !== 'GENERATED', 'no generated file to download');

    const bytes = await wps.download();

    // An empty or truncated file is the failure a "did the button click" test
    // cannot see, and it is the one that reaches the bank.
    expect(bytes.length, 'the downloaded wage file is empty').toBeGreaterThan(0);

    const text = bytes.toString('utf8');
    const lines = text.trim().split(/\r?\n/);
    // Header + one line per employee + the TOTAL trailer a validator recomputes.
    expect(lines[0]).toContain('employee_code');
    expect(lines.length).toBe(file.employeeCount + 2);
    expect(lines[lines.length - 1].startsWith('TOTAL,')).toBe(true);

    settle(problems, 'downloading a wage file');
  });
});
