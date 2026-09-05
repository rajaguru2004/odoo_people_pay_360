import { crashesOnly, expect, test } from '../../fixtures';

/**
 * The refusal half of the document templates screen.
 *
 * Its own file because the role segment in a filename is what tells Playwright
 * which role projects load it: `manager-employee` runs exactly the two roles
 * that must NOT reach the gallery.
 *
 * `crashesOnly` rather than `settle`: a role opening a screen it may not have
 * legitimately produces a console error when the guard turns it away, and that
 * is the system working. An uncaught render exception or a 5xx stays fatal.
 */
test.describe('Settings — document templates are refused', () => {
  test('SDT-04 a manager or employee never reaches the gallery', async ({ page, problems }) => {
    crashesOnly(problems);

    await page.goto('/dashboard/settings/documents');
    // networkidle can simply never arrive here (notification poll, chat
    // widget). The deterministic signal IS the refusal: ProtectedRoute sends
    // an unauthorised role to /403 from an effect after render.
    await page.waitForURL(/\/403/, { timeout: 20_000 });

    // Belt and braces: the guard fired before the gallery ever mounted.
    await expect(page.getByTestId('document-templates-gallery')).toHaveCount(0);
  });
});
