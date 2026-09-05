import { ApiClient, expect, settle, test } from '../../fixtures';

/**
 * The document template gallery and builder, in a real browser.
 *
 * Admin and HR only — the role segment in the filename is what selects those
 * projects. The denial path for MANAGER and EMPLOYEE lives in its own file, per
 * CLAUDE.md §2's requirement to cover every role that can reach the route
 * INCLUDING the refusal.
 *
 * `settle(problems, …)` judges the page for console errors, pageerrors, failed
 * first-party requests and 5xx responses, and stops the fixture judging it
 * again at teardown. That is asserted here as much as any text is: a broken
 * image or an SSR warning is invisible to an assertion about content, and is
 * exactly the class of defect this suite exists to catch.
 *
 * The engine ships OFF and the e2e baseline pins it off, so this file flips
 * `document_engine_enabled` ON through the settings API and restores it in
 * afterAll — the same flip/restore the employee-template spec performs. The
 * first run of this file tried to SKIP when the flag was off by probing the
 * gallery testid; that guard was wrong twice over: the gallery shell renders
 * with the flag off (so nothing skipped), and a suite that silently skips in
 * the shipped configuration never runs anywhere.
 */
test.describe('Settings — document templates', () => {
  test.describe.configure({ mode: 'serial' });

  const FLAG = 'document_engine_enabled';

  let api: ApiClient;
  /** `null` = row absent before this file touched it (≠ 'false'). */
  let flagBefore: string | null = null;
  let setupError = '';

  test.beforeAll(async () => {
    try {
      api = await ApiClient.as('admin');
      const rows = await api.get<{ key: string; value: string }[]>('/system-settings');
      flagBefore = (Array.isArray(rows) ? rows : []).find((r) => r.key === FLAG)?.value ?? null;
      await api.post('/system-settings', { settings: { [FLAG]: 'true' } });
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
    }
  });

  test.afterAll(async () => {
    if (!api) return;
    // A row cannot be deleted through the API, so an absent-before flag goes
    // back to its shipped default: 'false'.
    await api.post('/system-settings', { settings: { [FLAG]: flagBefore ?? 'false' } });
  });

  const openGallery = async (page: any) => {
    await page.goto('/dashboard/settings/documents');
    // networkidle is a TRAP on this app: the notification poll and the chat
    // widget keep the wire warm, so the state may simply never arrive.
    // Element-driven waits are the reliable signal.
    await page.waitForLoadState('networkidle').catch(() => {});
    const gallery = page.getByTestId('document-templates-gallery');
    await expect(gallery).toBeVisible({ timeout: 20_000 });
    return gallery;
  };

  test('SDT-01 the gallery lists the shipped templates', async ({ page, problems }) => {
    test.skip(Boolean(setupError), `flag setup failed: ${setupError}`);
    await openGallery(page);

    await expect(page.getByRole('heading', { name: /document templates/i })).toBeVisible();
    // The shipped set seeds on boot, so an empty gallery here means seeding
    // failed rather than that nothing has been created yet.
    await expect(page.getByTestId(/^template-card-/).first()).toBeVisible();
    settle(problems, 'the template gallery');
  });

  test('SDT-02 search narrows the list, and an empty result says so', async ({ page, problems }) => {
    test.skip(Boolean(setupError), `flag setup failed: ${setupError}`);
    await openGallery(page);

    const search = page.getByLabel('Search templates');
    await search.fill('salary');
    await expect(page.getByTestId('template-card-SALARY_CERTIFICATE-en')).toBeVisible();

    await search.fill('zzzzzzzz');
    await expect(page.getByText(/No template matches that search/i)).toBeVisible();
    settle(problems, 'the template search');
  });

  test('SDT-03 opening a published template offers to start a draft', async ({ page, problems }) => {
    test.skip(Boolean(setupError), `flag setup failed: ${setupError}`);
    await openGallery(page);

    await page.getByTestId('template-card-SALARY_CERTIFICATE-en').click();
    await page.waitForLoadState('networkidle').catch(() => {});

    await expect(page.getByTestId('document-template-editor')).toBeVisible();
    // A published version is immutable; editing forks a draft. Saying so here
    // is what stops somebody expecting their edit to go live immediately.
    await expect(page.getByText(/published and locked/i)).toBeVisible();
    settle(problems, 'the template editor');
  });
});
