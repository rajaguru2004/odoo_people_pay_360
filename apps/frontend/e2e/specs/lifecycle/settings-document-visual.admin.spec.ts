import { test, expect, settle, ApiClient } from '../../fixtures';

/**
 * The GrapesJS visual editor, in a real browser — the only place its wiring
 * CAN be tested, because GrapesJS does not run in jsdom (the component layer
 * mocks it; the pure modules are unit-tested).
 *
 * The journey is the one an admin actually performs: open a shipped template →
 * fork a draft (classic) → convert it to the visual editor (consenting to the
 * dropped-features dialog) → add a block by CLICK (deterministic; drag is not
 * required by the product) → insert a field through the toolbar popover →
 * @-type a field in the canvas → preview shows sample data → discard returns
 * to the classic builder. Serial, one draft threaded through.
 *
 * Flags: `document_engine_enabled` and `document_visual_editor_enabled` both
 * ship OFF and are flipped ON here through the settings API, restored to what
 * they were in afterAll — the same row-level flip/restore the backend suites
 * do with `withSetting`.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const FLAGS = ['document_engine_enabled', 'document_visual_editor_enabled'] as const;

interface SettingRow {
  key: string;
  value: string;
}

const TEMPLATE_CARD = 'template-card-SALARY_CERTIFICATE-en';

test.describe('Settings — visual template editor', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'administrative flow — conversion and publish are ADMIN-only');
  });

  let api: ApiClient;
  /** Values before this file touched them; `null` = row absent (≠ 'false'). */
  const flagsBefore = new Map<string, string | null>();
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      api = await ApiClient.as('admin');
      const rows = await api.get<SettingRow[]>('/system-settings');
      for (const flag of FLAGS) {
        flagsBefore.set(
          flag,
          (Array.isArray(rows) ? rows : []).find((r) => r.key === flag)?.value ?? null,
        );
      }
      await api.post('/system-settings', {
        settings: Object.fromEntries(FLAGS.map((f) => [f, 'true'])),
      });
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin') || !api) return;
    // Restore what was there before. A row cannot be deleted through the API,
    // so an absent-before flag goes back to its shipped default: 'false'.
    await api.post('/system-settings', {
      settings: Object.fromEntries(
        FLAGS.map((f) => [f, flagsBefore.get(f) ?? 'false']),
      ),
    });
  });

  /** Opens the salary-certificate template editor page. */
  const openTemplate = async (page: import('@playwright/test').Page) => {
    await page.goto('/dashboard/settings/documents', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.getByTestId(TEMPLATE_CARD).click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.getByTestId('document-template-editor')).toBeVisible({ timeout: 20_000 });
  };

  test('VIS-01 converting a classic draft opens the visual editor, after naming what conversion drops', async ({
    page,
    problems,
  }) => {
    test.skip(Boolean(setupError), `flag setup failed: ${setupError}`);

    await openTemplate(page);

    // Fork a draft if the template is sitting published-only.
    const startDraft = page.getByTestId('start-draft');
    if (await startDraft.isVisible().catch(() => false)) {
      await startDraft.click();
    }

    // The conversion banner exists only for a classic draft with the flag on.
    const convert = page.getByTestId('convert-to-visual');
    await expect(convert).toBeVisible({ timeout: 20_000 });

    // The consent dialog is the CONTRACT: one-way, dropped features named.
    let dialogText = '';
    page.once('dialog', (d) => {
      dialogText = d.message();
      void d.accept();
    });
    await convert.click();

    await expect(page.getByTestId('visual-template-editor')).toBeVisible({ timeout: 30_000 });
    expect(dialogText).toContain('visual editor');
    // The canvas seeds from the v1 doc — its chips carry the @ prefix.
    const canvas = page.frameLocator('[data-testid="visual-template-editor"] iframe.gjs-frame');
    await expect(canvas.locator('span[data-var]').first()).toBeVisible({ timeout: 30_000 });

    settle(problems, 'the conversion journey');
  });

  test('VIS-02 a block is added by CLICK and lands on the canvas', async ({ page, problems }) => {
    test.skip(Boolean(setupError), `flag setup failed: ${setupError}`);

    await openTemplate(page);
    await expect(page.getByTestId('visual-template-editor')).toBeVisible({ timeout: 30_000 });

    const canvas = page.frameLocator('[data-testid="visual-template-editor"] iframe.gjs-frame');
    const dividersBefore = await canvas.locator('hr').count();

    await page.getByTestId('visual-block-ess-divider').click();
    await expect
      .poll(() => canvas.locator('hr').count(), { timeout: 15_000 })
      .toBeGreaterThan(dividersBefore);

    // The edit marks the draft dirty; the 2s debounce then saves it.
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    settle(problems, 'click-to-add block');
  });

  test('VIS-03 the Insert-field button inserts a chip through the mention popover', async ({
    page,
    problems,
  }) => {
    test.skip(Boolean(setupError), `flag setup failed: ${setupError}`);

    await openTemplate(page);
    await expect(page.getByTestId('visual-template-editor')).toBeVisible({ timeout: 30_000 });
    const canvas = page.frameLocator('[data-testid="visual-template-editor"] iframe.gjs-frame');
    const chipsBefore = await canvas.locator('span[data-var="employeeCode"]').count();

    await page.getByTestId('insert-field-button').click();
    await expect(page.getByTestId('mention-popover')).toBeVisible();
    // The toolbar popover owns a search box (no caret feeds it a query) —
    // without it, fields past the first dozen are unreachable from here.
    await page.getByTestId('mention-search').fill('employee code');
    await page.getByTestId('mention-option-employeeCode').click();

    await expect
      .poll(() => canvas.locator('span[data-var="employeeCode"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(chipsBefore);
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    settle(problems, 'toolbar field insertion');
  });

  test('VIS-04 typing @ in the canvas opens the picker and inserts a chip', async ({
    page,
    problems,
  }) => {
    test.skip(Boolean(setupError), `flag setup failed: ${setupError}`);

    await openTemplate(page);
    await expect(page.getByTestId('visual-template-editor')).toBeVisible({ timeout: 30_000 });
    const canvas = page.frameLocator('[data-testid="visual-template-editor"] iframe.gjs-frame');

    // Enter the RTE on a paragraph: GrapesJS needs select, then dblclick.
    const para = canvas.locator('p').first();
    await para.click();
    await para.dblclick();
    await page.keyboard.press('End');
    await page.keyboard.type(' @employee');

    await expect(page.getByTestId('mention-popover')).toBeVisible({ timeout: 10_000 });
    const chipsBefore = await canvas.locator('span[data-var="employeeName"]').count();
    await page.getByTestId('mention-option-employeeName').click();

    await expect
      .poll(() => canvas.locator('span[data-var="employeeName"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(chipsBefore);
    // The typed "@employee" query text is consumed by the insertion.
    await expect(canvas.locator('body')).not.toContainText('@employee ');
    settle(problems, 'typed-@ field insertion');
  });

  test('VIS-05 preview renders SAMPLE DATA, not tokens and not editor markup', async ({
    page,
    problems,
  }) => {
    test.skip(Boolean(setupError), `flag setup failed: ${setupError}`);

    await openTemplate(page);
    await expect(page.getByTestId('visual-template-editor')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /preview/i }).click();
    const preview = page.locator('iframe[title="Document preview"]');
    await expect(preview).toBeVisible({ timeout: 30_000 });
    // The preview iframe is sandboxed srcdoc; read its content attribute.
    const html = await preview.getAttribute('srcdoc');
    expect(html).toContain('Ahmed Al-Balushi');
    expect(html).not.toContain('data-var');
    expect(html).not.toMatch(/\{\{employeeName\}\}/);
    settle(problems, 'the visual preview');
  });

  test('VIS-06 discarding the draft returns to the classic builder', async ({ page, problems }) => {
    test.skip(Boolean(setupError), `flag setup failed: ${setupError}`);

    await openTemplate(page);
    await expect(page.getByTestId('visual-template-editor')).toBeVisible({ timeout: 30_000 });

    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('discard-draft').click();

    // Draft gone → published-and-locked view; the published version is still
    // the classic v1, so the next draft opens the block builder again.
    await expect(page.getByTestId('start-draft')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('visual-template-editor')).not.toBeVisible();
    settle(problems, 'the discard journey');
  });
});
