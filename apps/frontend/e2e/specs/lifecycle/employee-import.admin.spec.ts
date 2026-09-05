import * as XLSX from 'xlsx';
import { request } from '@playwright/test';
import { test, expect, settle, ApiClient } from '../../fixtures';
import { EmployeeImportModal } from '../../pages';
import { API_URL } from '../../playwright.config';

/**
 * Bulk employee import, which is two phases on purpose.
 *
 * Preview parses and validates and writes NOTHING; confirm creates people. That
 * split is the whole safety property — a spreadsheet with a mistyped department
 * in row 40 must be reported before any of the other 39 rows become employees,
 * and an operator has to be able to look at what will happen before it does.
 *
 * ## The defect this file was written against, now fixed
 *
 * `POST /employees/import/preview` used to return a bare `{ summary, rows }` —
 * one of the few endpoints NOT using the `{ success, data }` envelope. The axios
 * interceptor hands the whole body back, `ImportModal.handleUpload` reads
 * `res.data`, and that was `undefined`: the modal advanced to the preview step
 * with an empty table and a permanently disabled "Import 0 staff" button, so no
 * spreadsheet could be imported through the UI at all. `confirm` was unaffected
 * because `bulkImport` already wrapped its result, which is why only half the
 * flow was broken and nobody noticed.
 *
 * The service now wraps it like everything else. These tests are what stop it
 * regressing — they were written as `test.fail()` against the live bug and
 * flipped to passing the moment the envelope was added.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Unique per run: emails and ID cards are checked for duplicates on preview. */
const runId = `pwimp${Date.now().toString(36)}`;

/**
 * The fixed column block of the import sheet, in order.
 *
 * `previewImport()` reads these by POSITION, not by header text (only the
 * profile-template columns after them are matched by label), so the order here
 * is the contract. It mirrors `FIXED_IMPORT_COLUMNS` in
 * `apps/backend/src/employees/import-columns.ts`, which is append-only for
 * exactly that reason.
 */
const HEADERS = [
  'Full Name *',
  'Email *',
  'Phone',
  'Date of Birth (YYYY-MM-DD) *',
  'Gender (MALE/FEMALE/OTHER)',
  'ID Card *',
  'Address',
  'Department (Code or Name) *',
  'Position *',
  'Start Date (YYYY-MM-DD) *',
  'Base Salary *',
  'Pay Basis (MONTHLY/DAILY)',
  'Timezone',
  'Phone Country (ISO code, e.g. OM)',
];

const today = new Date().toISOString().slice(0, 10);

/** The row that should import cleanly. */
const GOOD_ROW = [
  `Imported ${runId}`,
  `${runId}@e2e.local`,
  '',
  '1990-01-01',
  'MALE',
  `IDCARD-${runId}`,
  '',
  'HRD',
  'Imported Tester',
  today,
  '1500',
  'MONTHLY',
  'UTC',
  '',
];

/**
 * The row that must NOT. Blank in every required field, so the errors it
 * collects are the validator's own rather than something contrived.
 */
const BAD_ROW = ['', '', '', '', '', '', '', 'HRD', 'Imported Tester', today, '1500', '', '', ''];

/** Builds the workbook in memory — no fixture file on disk to drift from the code. */
function sheet(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, GOOD_ROW, BAD_ROW]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * The raw body of `POST /employees/import/preview`.
 *
 * Read straight off the response here rather than through `ApiClient`, so the
 * `{ success, data }` envelope is visible — which is the whole point: this
 * endpoint used to omit it, and that omission is what broke the modal.
 */
interface PreviewResponse {
  success: boolean;
  data: {
    summary: { totalRows: number; validRows: number; invalidRows: number };
    rows: Array<{ rowNumber: number; valid: boolean; errors: string[]; data: Record<string, unknown> }>;
  };
}

test.describe('the employee importer, through the modal', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'importing employees is an administrative flow');
  });

  test('choosing a sheet and pressing preview reaches the preview step', async ({ page, problems }) => {
    const modal = new EmployeeImportModal(page);
    await modal.open();
    expect(await modal.step()).toBe('UPLOAD');

    await modal.choose({ name: `${runId}.xlsx`, buffer: sheet() });
    await page.getByTestId('import-upload').click();

    // The step only advances once the preview request has come back, so this is
    // evidence the parse actually ran rather than that a button re-rendered.
    await expect
      .poll(() => modal.step(), { timeout: 30_000 })
      .toBe('PREVIEW');

    settle(problems, 'uploading a sheet for preview');
  });

  test('the preview reports what it parsed', async ({ page }) => {
    // The assertion the fix was verified against: before the envelope was
    // added, `handleUpload` read `res.data` from a response with no `data` key,
    // so this table and its counts never rendered at all.
    const modal = new EmployeeImportModal(page);
    await modal.open();
    await modal.choose({ name: `${runId}-b.xlsx`, buffer: sheet() });
    await page.getByTestId('import-upload').click();

    await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 15_000 });

    const summary = await modal.preview();
    expect(summary.total).toBe(2);
    expect(summary.valid).toBe(1);
    expect(summary.invalid).toBe(1);

    // The invalid row is shown WITH its reasons rather than silently dropped —
    // an operator has to be able to fix the sheet.
    expect(await page.locator('[data-testid="import-preview-row"][data-row-valid="false"]').count()).toBe(1);
    expect(await page.getByTestId('import-confirm').isEnabled()).toBe(true);
  });
});

/**
 * Phase two, over the API.
 *
 * Not a substitute for the modal — it is the half the modal cannot currently
 * reach, and it is what makes the `test.fail()` above a recorded UI defect
 * rather than an unknown. It asserts the property that matters about the split:
 * preview must have created nobody, and confirm must create exactly the rows
 * preview called valid.
 */
test.describe('preview writes nothing, confirm writes exactly the valid rows', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'importing employees is an administrative flow');
  });

  let api: ApiClient;
  const email = `${runId}-api@e2e.local`;

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    api = await ApiClient.as('admin');
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('a sheet previews, creates nobody, then confirms into one employee', async () => {
    const good = [...GOOD_ROW];
    good[1] = email;
    good[5] = `IDCARD-${runId}-api`;
    good[0] = `Imported ${runId} api`;

    const ws = XLSX.utils.aoa_to_sheet([HEADERS, good, BAD_ROW]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Employees');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const ctx = await request.newContext({ baseURL: API_URL });
    try {
      const res = await ctx.post('/employees/import/preview', {
        headers: { Authorization: `Bearer ${api.token}` },
        multipart: {
          file: {
            name: `${runId}.xlsx`,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer,
          },
        },
      });
      expect(res.ok(), `preview failed: ${res.status()} ${await res.text()}`).toBe(true);

      const preview = (await res.json()) as PreviewResponse;
      // The envelope itself is the regression guard: without it the modal reads
      // `res.data` and gets undefined.
      expect(preview.success, 'preview response lost its { success, data } envelope').toBe(true);
      expect(preview.data.summary.totalRows).toBe(2);
      expect(preview.data.summary.validRows).toBe(1);
      expect(preview.data.summary.invalidRows).toBe(1);
      // The reasons are the point of the phase — a count with no explanation is
      // not something an operator can act on.
      expect(preview.data.rows.find((r) => !r.valid)!.errors.length).toBeGreaterThan(0);

      // Nothing was created. This is the safety property of a two-phase import,
      // and it is the one that would be silently lost by "optimising" the
      // preview into the same call as the write.
      const afterPreview = await api.get<Array<{ email: string }> | { data?: Array<{ email: string }> }>(
        `/employees?search=${encodeURIComponent(email)}`,
      );
      const seen = Array.isArray(afterPreview) ? afterPreview : (afterPreview?.data ?? []);
      expect(seen.some((e) => e.email === email), 'preview created an employee').toBe(false);

      const confirmed = await api.post<Array<{ email: string; success: boolean; employeeCode?: string }>>(
        '/employees/import/confirm',
        preview.data.rows.filter((r) => r.valid).map((r) => r.data),
      );
      expect(confirmed.length).toBe(1);
      expect(confirmed[0].success, `import failed: ${JSON.stringify(confirmed[0])}`).toBe(true);
      expect(confirmed[0].employeeCode).toBeTruthy();

      const afterConfirm = await api.get<Array<{ email: string }> | { data?: Array<{ email: string }> }>(
        `/employees?search=${encodeURIComponent(email)}`,
      );
      const created = Array.isArray(afterConfirm) ? afterConfirm : (afterConfirm?.data ?? []);
      expect(created.some((e) => e.email === email), 'confirm did not create the employee').toBe(true);
    } finally {
      await ctx.dispose();
    }
  });
});
