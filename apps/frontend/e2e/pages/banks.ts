import { Page, expect } from '@playwright/test';
import { selectBranch } from './index';

/**
 * The banks cluster: master, per-branch countries, the field schema, migration.
 *
 * Four screens rather than one because they are four halves of a single rule —
 * *which* bank an employee may be paid into. `BranchCountriesPage` decides which
 * countries a branch may bank in, `BankConfigPage` decides which fields those
 * countries demand, `BankMasterPage` decides which banks exist inside them, and
 * `BankMigratePage` is where all three land on one employee at once. A page
 * object per screen keeps that chain visible in a spec instead of hiding it
 * behind one god-object.
 *
 * Selector policy is the one stated at the top of `./index`: `data-testid`
 * first, structural (`option`, `input[type="checkbox"]`) where the shape is
 * stable, never visible text. These four screens are the strongest case for it —
 * every label on them is a country name, and country names are localised.
 *
 * `selectBranch` is re-exported so a spec can pull the branch helper and these
 * page objects from one module. `X-Branch-Id` matters here more than on most
 * screens: `Bank` and `CountryBankingField` are deliberately global, but
 * migration candidates are branch-scoped, so a spec pointed at the wrong branch
 * sees an empty migration screen rather than an error.
 */
export { selectBranch };

/**
 * Navigate and wait.
 *
 * Deliberately a local copy of the private helper in `./index` rather than an
 * import: that one is not exported, and exporting it would mean editing a file
 * every other page object in the suite depends on. Six lines is the cheaper
 * side of that trade.
 */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * The banks screens report every outcome through `sonner`, not through the
 * app's own `lib/toast` — so `ToastArea.waitFor()` in `./index`, which keys on
 * `[data-testid="toast"]`, never sees them.
 *
 * This is the only place the server's sentence survives: a refused migration
 * answers 400 with `{ message, errors: { iban: '…' } }`, and the screen joins
 * `errors` into one toast. Asserting on that text is the whole point of the
 * "was the user told why" half of the plan — the backend suite already proves
 * the server refused.
 */
export class BankToasts {
  constructor(private readonly page: Page) {}

  private get all() {
    return this.page.locator('[data-sonner-toast]');
  }

  /** Waits for a toast of `type` (`error` | `success` | `warning`) and returns its text. */
  async waitFor(type: 'error' | 'success' | 'warning' | 'info', timeout = 15_000): Promise<string> {
    const el = this.page.locator(`[data-sonner-toast][data-type="${type}"]`);
    await el.first().waitFor({ state: 'visible', timeout });
    return el.first().innerText();
  }

  /** The most recent toast of any type, or null when none is on screen. */
  async latest(): Promise<{ type: string; text: string } | null> {
    if (!(await this.all.count())) return null;
    const el = this.all.last();
    return {
      type: (await el.getAttribute('data-type')) ?? '',
      text: await el.innerText(),
    };
  }

  async count(): Promise<number> {
    return this.all.count();
  }
}

// ── Bank master ─────────────────────────────────────────────────────────────

/**
 * `/dashboard/banks` — the bank master, ADMIN only.
 *
 * The list is filtered by ONE country at a time and the filter is a custom
 * searchable dropdown, not a `<select>`: three interactions, not one. Reading a
 * bank back after a write therefore has to happen with the picker on the right
 * country, or the row is simply not in the DOM and the spec concludes the write
 * failed.
 *
 * `activeOnly` is not exposed here on purpose — the master screen always shows
 * deactivated banks (greyed), which is what makes `isActive()` assertable after
 * a toggle instead of the row merely vanishing.
 */
export class BankMasterPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/banks');
  }

  /** The ISO-2 the list is currently filtered to. */
  async country(): Promise<string | null> {
    return this.page.getByTestId('bank-country-picker').getAttribute('data-country');
  }

  /**
   * Picks a country in the searchable dropdown.
   *
   * The search box is filled first even though every country is rendered: the
   * option list is a 250-row scroller, and narrowing it is the difference
   * between a click that lands and one that races the virtual scroll.
   */
  async selectCountry(code: string): Promise<void> {
    await this.page.getByTestId('bank-country-picker').click();
    await this.page.getByTestId('bank-country-search').fill(code);
    await this.page.locator(`[data-testid="bank-country-option"][data-country="${code}"]`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  row(bankId: string) {
    return this.page.locator(`[data-testid="bank-row"][data-bank-id="${bankId}"]`);
  }

  async hasRow(bankId: string): Promise<boolean> {
    return (await this.row(bankId).count()) > 0;
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('bank-row').count();
  }

  async rowIds(): Promise<string[]> {
    return this.page
      .getByTestId('bank-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-bank-id') ?? ''));
  }

  /**
   * Whether the row is live, read from the attribute rather than the badge —
   * "Active"/"Inactive" is text, and text is the one thing this suite may not
   * select or assert on.
   */
  async isActive(bankId: string): Promise<boolean | null> {
    const row = this.row(bankId);
    if (!(await row.count())) return null;
    return (await row.getAttribute('data-bank-active')) === 'true';
  }

  async expectActive(bankId: string, expected: boolean): Promise<void> {
    await expect.poll(() => this.isActive(bankId), { timeout: 15_000 }).toBe(expected);
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('bank-empty').isVisible().catch(() => false);
  }

  /** True when this role is offered the write controls at all. */
  async canAdd(): Promise<boolean> {
    return this.page.getByTestId('bank-add').isVisible().catch(() => false);
  }

  /**
   * Files a new bank for the country currently selected in the picker.
   *
   * The country is NOT a parameter: the form has no country field of its own —
   * it inherits whatever the picker holds, which is exactly the coupling a spec
   * should be forced to make explicit by calling `selectCountry()` first.
   */
  /**
   * Adds a bank and waits for the write to have LANDED, not merely to have been
   * requested.
   *
   * The click fires a POST and the page reloads its list on success. Returning
   * on the click alone lets a caller read the server before the POST has been
   * handled — which fails as "the bank is not on the server after adding it",
   * describing a race as if it were a missing record.
   *
   * The wait is on the row count rather than on the new row's name, because the
   * selector policy forbids keying on visible text and the id is not known
   * until the server answers.
   */
  async add(opts: { name: string; bankCode?: string; swift?: string }): Promise<void> {
    const before = await this.rowCount();

    const form = this.page.getByTestId('bank-add-form');
    await form.getByTestId('bank-name').fill(opts.name);
    if (opts.bankCode !== undefined) await form.getByTestId('bank-code').fill(opts.bankCode);
    if (opts.swift !== undefined) await form.getByTestId('bank-swift').fill(opts.swift);
    await this.page.getByTestId('bank-add').click();

    await expect
      .poll(() => this.rowCount(), { timeout: 20_000 })
      .toBeGreaterThan(before);
  }

  /**
   * Edits in place. The row swaps its cells for inputs, so the same three ids
   * appear inside the row as in the add form — scoping to the row is what keeps
   * them apart.
   */
  async edit(
    bankId: string,
    opts: { name?: string; bankCode?: string; swift?: string },
  ): Promise<void> {
    const row = this.row(bankId);
    await row.getByTestId('bank-edit').click();
    if (opts.name !== undefined) await row.getByTestId('bank-name').fill(opts.name);
    if (opts.bankCode !== undefined) await row.getByTestId('bank-code').fill(opts.bankCode);
    if (opts.swift !== undefined) await row.getByTestId('bank-swift').fill(opts.swift);
    await row.getByTestId('bank-save').click();
  }

  /** One button for both directions — the screen decides from `isActive`. */
  async toggleActive(bankId: string): Promise<void> {
    await this.row(bankId).getByTestId('bank-toggle-active').click();
  }

  async openBranchCountries(): Promise<void> {
    await this.page.getByTestId('bank-branch-countries').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async openFieldConfig(): Promise<void> {
    await this.page.getByTestId('bank-field-config').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

// ── Branch banking countries ────────────────────────────────────────────────

/**
 * `/dashboard/banks/branch-countries` — which countries each branch may bank in.
 *
 * The screen everything else downstream depends on. An empty list is not "no
 * countries": it falls back to the branch's own location country, which is why
 * `countries()` reads the draft chips rather than inferring anything.
 *
 * Save is disabled until the draft differs from what is stored, so a spec that
 * clicks Save without changing anything is silently doing nothing — hence
 * `isDirty()`, which makes that state assertable instead of invisible.
 */
export class BranchCountriesPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/banks/branch-countries');
  }

  card(branchId: string) {
    return this.page.locator(`[data-testid="branch-country-card"][data-branch-id="${branchId}"]`);
  }

  async cardCount(): Promise<number> {
    return this.page.getByTestId('branch-country-card').count();
  }

  async branchIds(): Promise<string[]> {
    return this.page
      .getByTestId('branch-country-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-branch-id') ?? ''));
  }

  /** The ISO-2 codes currently on the branch's draft, in the order shown. */
  async countries(branchId: string): Promise<string[]> {
    return this.card(branchId)
      .getByTestId('branch-country-chip')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-country') ?? ''));
  }

  /** Unsaved changes are pending — the Save button is live only while true. */
  async isDirty(branchId: string): Promise<boolean> {
    return (await this.card(branchId).getAttribute('data-dirty')) === 'true';
  }

  async addCountry(branchId: string, code: string): Promise<void> {
    await this.card(branchId).getByTestId('branch-country-add').selectOption(code);
  }

  async removeCountry(branchId: string, code: string): Promise<void> {
    await this.card(branchId)
      .locator(`[data-testid="branch-country-chip"][data-country="${code}"]`)
      .getByTestId('branch-country-remove')
      .click();
  }

  async canSave(branchId: string): Promise<boolean> {
    return this.card(branchId).getByTestId('branch-country-save').isEnabled().catch(() => false);
  }

  /** Saves and waits for the reload the screen does afterwards. */
  async save(branchId: string): Promise<void> {
    await this.card(branchId).getByTestId('branch-country-save').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

// ── Banking field configuration ─────────────────────────────────────────────

/**
 * `/dashboard/banks/config` — the per-country field schema, ADMIN only.
 *
 * These rows are what turn a country into a form: `validationType: 'IBAN'` is
 * the entire reason the migration screen can refuse a mistyped account number.
 * Editing one therefore changes validation for every employee in that country,
 * which is why the delete here is the only destructive action in the cluster
 * guarded by a NATIVE `window.confirm` — callers must install
 * `acceptNativeDialogs(page)` from `./index` first or the click is a no-op.
 */
export class BankConfigPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/banks/config');
  }

  async selectCountry(code: string): Promise<void> {
    await this.page.getByTestId('bankfield-country').selectOption(code);
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  row(fieldId: string) {
    return this.page.locator(`[data-testid="bankfield-row"][data-field-id="${fieldId}"]`);
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('bankfield-row').count();
  }

  /** The `fieldKey`s the current country defines, in display order. */
  async fieldKeys(): Promise<string[]> {
    return this.page
      .getByTestId('bankfield-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-field-key') ?? ''));
  }

  /** The row id for a key, so a spec can act on a field it did not create. */
  async idForKey(fieldKey: string): Promise<string | null> {
    const row = this.page.locator(`[data-testid="bankfield-row"][data-field-key="${fieldKey}"]`);
    if (!(await row.count())) return null;
    return row.first().getAttribute('data-field-id');
  }

  async validationFor(fieldKey: string): Promise<string | null> {
    const row = this.page.locator(`[data-testid="bankfield-row"][data-field-key="${fieldKey}"]`);
    if (!(await row.count())) return null;
    return row.first().getAttribute('data-validation');
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('bankfield-empty').isVisible().catch(() => false);
  }

  /**
   * Fills the add/edit form and saves.
   *
   * `key` is read-only once a row exists — the screen fixes it deliberately,
   * because changing a key would orphan every stored value under the old one.
   * Passing `key` while editing is therefore a no-op, not an error, and the
   * spec that wants to prove that asserts on the input's `readOnly` instead.
   */
  async save(opts: {
    key?: string;
    label?: string;
    fieldType?: string;
    validation?: string;
    placeholder?: string;
    order?: number;
    regex?: string;
    required?: boolean;
    sensitive?: boolean;
  }): Promise<void> {
    if (opts.label !== undefined) await this.page.getByTestId('bankfield-label').fill(opts.label);
    if (opts.key !== undefined) {
      const key = this.page.getByTestId('bankfield-key');
      if (await key.isEditable()) await key.fill(opts.key);
    }
    if (opts.fieldType !== undefined) {
      await this.page.getByTestId('bankfield-type').selectOption(opts.fieldType);
    }
    // Selected before `regex` is touched: the regex input only exists while the
    // validation type is REGEX, so the order of these two is load-bearing.
    if (opts.validation !== undefined) {
      await this.page.getByTestId('bankfield-validation').selectOption(opts.validation);
    }
    if (opts.regex !== undefined) await this.page.getByTestId('bankfield-regex').fill(opts.regex);
    if (opts.placeholder !== undefined) {
      await this.page.getByTestId('bankfield-placeholder').fill(opts.placeholder);
    }
    if (opts.order !== undefined) {
      await this.page.getByTestId('bankfield-order').fill(String(opts.order));
    }
    if (opts.required !== undefined) {
      await this.page.getByTestId('bankfield-required').setChecked(opts.required);
    }
    if (opts.sensitive !== undefined) {
      await this.page.getByTestId('bankfield-sensitive').setChecked(opts.sensitive);
    }
    await this.page.getByTestId('bankfield-save').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** True when the key input refuses edits — i.e. a row is being edited. */
  async keyIsLocked(): Promise<boolean> {
    return !(await this.page.getByTestId('bankfield-key').isEditable());
  }

  async startEdit(fieldId: string): Promise<void> {
    await this.row(fieldId).getByTestId('bankfield-edit').click();
  }

  /** Guarded by a native `window.confirm` — see the class comment. */
  async delete(fieldId: string): Promise<void> {
    await this.row(fieldId).getByTestId('bankfield-delete').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async seedDefaults(): Promise<void> {
    await this.page.getByTestId('bankfield-seed').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

// ── Migration ───────────────────────────────────────────────────────────────

/**
 * `/dashboard/banks/migrate` — legacy free-text bank data, verified by a human.
 *
 * One card per candidate, where a candidate is an ACTIVE employee carrying a
 * legacy `profile.bankName` and holding NO active bank detail. Migrating one
 * removes it from that set, so a card is a one-way door: after a successful
 * migration the row is gone and there is no screen anywhere that can overwrite
 * it. That is the shape of the payroll lock as a user meets it.
 *
 * Two conditional controls a spec has to know about:
 *
 *   • The country `<select>` is rendered ONLY where the branch allows more than
 *     one banking country. With exactly one, the card pre-selects it and no
 *     picker exists — so `countries()` reads the card's own attribute rather
 *     than the options, and works in both shapes.
 *   • `Autofill (dev)` is gated on `process.env.NODE_ENV !== 'production'`, and
 *     the browser suite runs a PRODUCTION build (`e2e/start-frontend.sh` runs
 *     `next build`). It is dead-code-eliminated there, so a spec must generate
 *     its own IBAN — see `omIban()` in the migration spec — and
 *     `hasAutofill()` exists to assert the button's absence rather than to use
 *     it.
 */
export class BankMigratePage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/banks/migrate');
  }

  row(employeeId: string) {
    return this.page.locator(`[data-testid="migrate-row"][data-employee-id="${employeeId}"]`);
  }

  async hasRow(employeeId: string): Promise<boolean> {
    return (await this.row(employeeId).count()) > 0;
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('migrate-row').count();
  }

  async employeeIds(): Promise<string[]> {
    return this.page
      .getByTestId('migrate-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-employee-id') ?? ''));
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('migrate-empty').isVisible().catch(() => false);
  }

  /**
   * The banking countries this candidate's BRANCH allows.
   *
   * Read from the card, not from the picker, because the picker does not exist
   * when there is only one — which is the case the branch-countries journey
   * turns from one into two and back.
   */
  async countries(employeeId: string): Promise<string[]> {
    const raw = (await this.row(employeeId).getAttribute('data-countries')) ?? '';
    return raw ? raw.split(',') : [];
  }

  /** True only where the branch allows more than one country. */
  async hasCountryPicker(employeeId: string): Promise<boolean> {
    return (await this.row(employeeId).getByTestId('migrate-country').count()) > 0;
  }

  async selectCountry(employeeId: string, code: string): Promise<void> {
    await this.row(employeeId).getByTestId('migrate-country').selectOption(code);
  }

  /** The banks offered for the country currently chosen, as `[id, label]` pairs. */
  async bankOptions(employeeId: string): Promise<Array<{ value: string; label: string }>> {
    return this.row(employeeId)
      .getByTestId('migrate-bank')
      .locator('option')
      .evaluateAll((els) =>
        els
          .map((e) => ({
            value: (e as HTMLOptionElement).value,
            label: e.textContent?.trim() ?? '',
          }))
          .filter((o) => o.value !== ''),
      );
  }

  async selectBank(employeeId: string, bankId: string): Promise<void> {
    await this.row(employeeId).getByTestId('migrate-bank').selectOption(bankId);
  }

  /**
   * The dynamic field keys the country's schema produced, read from the testids
   * themselves — `migrate-field-<fieldKey>` is built from the key, so this is
   * the schema as the screen actually rendered it rather than as the spec hopes
   * it was configured.
   */
  async fieldKeys(employeeId: string): Promise<string[]> {
    return this.row(employeeId)
      .locator('[data-testid^="migrate-field-"]')
      .evaluateAll((els) =>
        els.map((e) => (e.getAttribute('data-testid') ?? '').replace('migrate-field-', '')),
      );
  }

  async fill(employeeId: string, values: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await this.row(employeeId).getByTestId(`migrate-field-${key}`).fill(value);
    }
  }

  /** Present only in a dev build — see the class comment. */
  async hasAutofill(employeeId: string): Promise<boolean> {
    return (await this.row(employeeId).getByTestId('migrate-autofill').count()) > 0;
  }

  async autofill(employeeId: string): Promise<void> {
    await this.row(employeeId).getByTestId('migrate-autofill').click();
  }

  /** Disabled until both a country and a bank are chosen. */
  async canSubmit(employeeId: string): Promise<boolean> {
    return this.row(employeeId).getByTestId('migrate-submit').isEnabled().catch(() => false);
  }

  async submit(employeeId: string): Promise<void> {
    await this.row(employeeId).getByTestId('migrate-submit').click();
  }

  /**
   * The card disappears on success and stays on refusal, so this is the
   * screen's own answer to "did it go through" — and the assertion a spec makes
   * BEFORE re-reading the server, not instead of it.
   */
  async expectMigrated(employeeId: string): Promise<void> {
    await expect(this.row(employeeId)).toHaveCount(0, { timeout: 20_000 });
  }
}
