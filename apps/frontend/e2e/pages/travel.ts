import { Page, Locator, expect } from '@playwright/test';

/**
 * The two travel screens: the approver's list and the employee's own.
 *
 * Same selector policy as `./index` — `data-testid` first, structural second,
 * `href` for navigation, never visible text. Both screens render plain English
 * strings today rather than next-intl keys, which makes a text selector look
 * safe; it is not, and the moment either screen is translated every such
 * selector becomes a language assertion.
 *
 * The two screens are deliberately modelled apart rather than as one class with
 * a prefix. They are not the same screen with different data: `/dashboard/travel`
 * carries the decision controls and the status filter and lists the whole
 * branch, while `/dashboard/my-travel` carries neither and lists one person. A
 * shared base would have to make approve/reject conditionally present, which is
 * exactly the fact the specs are trying to assert.
 */

/** The dashboard decides auth client-side, so a bare goto proves nothing. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * The panel of the shared `ConfirmModal`, reached from the one testid it has.
 *
 * `components/common/ConfirmModal.tsx` marks only its confirm button, and the
 * warning a spec needs to read lives in the body above it. Walking two ancestors
 * up (button → footer → panel) is the least brittle way there that does not
 * involve matching the message by its own text — which is the thing under test.
 */
function confirmPanel(page: Page): Locator {
  return page.getByTestId('confirm-modal-confirm').locator('xpath=ancestor::div[2]');
}

/** What the trip form can be given. Every field is optional so a spec can omit one deliberately. */
export interface TravelFormInput {
  purpose?: string;
  travelType?: 'DOMESTIC' | 'INTERNATIONAL';
  /** The library label, which is also the option's value. */
  destination?: string;
  country?: string;
  departureDate?: string;
  returnDate?: string;
  estimatedCost?: number;
  advanceAmount?: number;
}

/** `''` is the "All statuses" option, not a status. */
export type TravelStatusFilter =
  | ''
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'COMPLETED';

/**
 * `/dashboard/travel` — the approver's list.
 *
 * Reachable by ADMIN, HR_MANAGER and MANAGER (`ProtectedRoute`), but the
 * decision controls are drawn only for ADMIN and HR_MANAGER, so "can open the
 * screen" and "can decide" are two different questions and both have a method.
 */
export class TravelPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/travel');
  }

  row(travelId: string): Locator {
    return this.page.locator(`[data-testid="travel-row"][data-travel-id="${travelId}"]`);
  }

  async hasRow(travelId: string): Promise<boolean> {
    return (await this.row(travelId).count()) > 0;
  }

  /**
   * The machine-readable status on a row, never the rendered badge.
   *
   * `null` when the row is not on screen at all rather than a ten-second
   * timeout: callers poll this while a list is still loading, and an absent row
   * is an answer.
   */
  async rowStatus(travelId: string): Promise<string | null> {
    const row = this.row(travelId);
    if ((await row.count()) === 0) return null;
    return row.getAttribute('data-status');
  }

  async expectRowStatus(travelId: string, expected: string): Promise<void> {
    await expect.poll(() => this.rowStatus(travelId), { timeout: 15_000 }).toBe(expected);
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('travel-row').count();
  }

  /** Every row currently rendered, as ids and statuses — for filter assertions. */
  async rows(): Promise<Array<{ id: string; status: string }>> {
    return this.page.getByTestId('travel-row').evaluateAll((els) =>
      els.map((e) => ({
        id: e.getAttribute('data-travel-id') ?? '',
        status: e.getAttribute('data-status') ?? '',
      })),
    );
  }

  /** The "no travel requests" panel — a different fact from "still loading". */
  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('travel-empty').isVisible().catch(() => false);
  }

  /** Narrows by status. `''` restores "All statuses". */
  async filterByStatus(status: TravelStatusFilter): Promise<void> {
    await this.page.getByTestId('travel-filter-status').selectOption(status);
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** The statuses the filter offers — the declared set, which F12 says is wider than the reachable one. */
  async statusFilterOptions(): Promise<string[]> {
    return this.page
      .getByTestId('travel-filter-status')
      .locator('option')
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  }

  // ── The form ──────────────────────────────────────────────────────────────

  async openForm(): Promise<void> {
    await this.page.getByTestId('travel-new').click();
    await expect(this.page.getByTestId('travel-purpose')).toBeVisible();
  }

  /** Open means the submit control is on screen; a refused submit leaves it there. */
  async formIsOpen(): Promise<boolean> {
    return this.page.getByTestId('travel-submit').isVisible().catch(() => false);
  }

  /**
   * The destinations the picker offers, placeholder excluded.
   *
   * They come from the `PER_DIEM_DESTINATION` library, so a spec compares them
   * with what the server returns rather than naming any of them.
   */
  async destinationOptions(): Promise<string[]> {
    return this.page
      .getByTestId('travel-destination')
      .locator('option')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLOptionElement).value).filter(Boolean),
      );
  }

  /** With no destinations configured the picker is disabled rather than empty-and-clickable. */
  async destinationPickerDisabled(): Promise<boolean> {
    return this.page.getByTestId('travel-destination').isDisabled();
  }

  /**
   * The `MasterEmptyHint` shown when the destination library is empty.
   *
   * The component carries no testid of its own and is not this task's to
   * change, so it is identified by the one thing about it that is stable and
   * not language — the link it offers to the screen that fixes the problem.
   */
  masterHint(): Locator {
    return this.page.locator('a[href="/dashboard/settings?tab=libraries"]');
  }

  async fill(input: TravelFormInput): Promise<void> {
    if (input.purpose !== undefined) {
      await this.page.getByTestId('travel-purpose').fill(input.purpose);
    }
    // Before the destination: switching to INTERNATIONAL is what renders the
    // country field at all.
    if (input.travelType !== undefined) {
      await this.page.getByTestId('travel-type').selectOption(input.travelType);
    }
    if (input.destination !== undefined) {
      await this.page.getByTestId('travel-destination').selectOption(input.destination);
    }
    if (input.country !== undefined) {
      await this.page.getByTestId('travel-country').fill(input.country);
    }
    if (input.departureDate !== undefined) {
      await this.page.getByTestId('travel-departure').fill(input.departureDate);
    }
    if (input.returnDate !== undefined) {
      await this.page.getByTestId('travel-return').fill(input.returnDate);
    }
    if (input.estimatedCost !== undefined) {
      await this.page.getByTestId('travel-cost').fill(String(input.estimatedCost));
    }
    if (input.advanceAmount !== undefined) {
      await this.page.getByTestId('travel-advance').fill(String(input.advanceAmount));
    }
  }

  /** Presses Submit and nothing else — for the cases that assert a refusal. */
  async submitOnly(): Promise<void> {
    await this.page.getByTestId('travel-submit').click();
  }

  /** Fills and submits, then waits for the list behind the form to reload. */
  async submitRequest(input: TravelFormInput): Promise<void> {
    await this.openForm();
    await this.fill(input);
    await this.submitOnly();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  // ── Decisions ─────────────────────────────────────────────────────────────

  /** Whether this role is offered the approval control on that row at all. */
  async canApprove(travelId: string): Promise<boolean> {
    return this.row(travelId).getByTestId('travel-approve').isVisible().catch(() => false);
  }

  async canReject(travelId: string): Promise<boolean> {
    return this.row(travelId).getByTestId('travel-reject').isVisible().catch(() => false);
  }

  async canCancel(travelId: string): Promise<boolean> {
    return this.row(travelId).getByTestId('travel-cancel').isVisible().catch(() => false);
  }

  /**
   * Approves in one click — there is no review modal on this screen.
   *
   * Returns once the network has gone quiet; the caller still has to assert the
   * outcome against the server, because the button reacting proves only that it
   * was pressed.
   */
  async approve(travelId: string): Promise<void> {
    await this.row(travelId).getByTestId('travel-approve').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** Reject opens an inline reason panel inside the row, not a modal. */
  async reject(travelId: string, reason: string): Promise<void> {
    const row = this.row(travelId);
    await row.getByTestId('travel-reject').click();
    await row.getByTestId('travel-reject-reason').fill(reason);
    await row.getByTestId('travel-reject-confirm').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  // ── Cancellation ──────────────────────────────────────────────────────────

  /** Opens the confirm dialog without answering it, so a spec can read the warning. */
  async openCancel(travelId: string): Promise<void> {
    await this.row(travelId).getByTestId('travel-cancel').click();
    await expect(this.page.getByTestId('confirm-modal-confirm')).toBeVisible();
  }

  /** The whole confirm panel's text — title, warning and buttons. */
  async cancelWarning(): Promise<string> {
    return confirmPanel(this.page).innerText();
  }

  /**
   * Answers the dialog — and leaves it on screen.
   *
   * `useConfirm().handleConfirm` deliberately does not close: it hands the
   * caller a `closeModal()` to call when the work is done, which the
   * advance-loans screen does and this one does not. So the panel stays up
   * showing "Processing…" over the reloaded list, and anything a caller does
   * next has to be after a fresh navigation or it will be clicking through a
   * modal backdrop.
   */
  async confirmCancel(): Promise<void> {
    await this.page.getByTestId('confirm-modal-confirm').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async cancel(travelId: string): Promise<void> {
    await this.openCancel(travelId);
    await this.confirmCancel();
  }
}

/**
 * `/dashboard/my-travel` — the employee's own trips.
 *
 * No route guard at all: every role reaches it, and the list is narrowed by the
 * server to `user.employeeId`. It offers no decision control by construction,
 * which is what makes "an employee cannot approve their own trip" a fact about
 * the screen as well as about the API.
 */
export class MyTravelPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/my-travel');
  }

  row(travelId: string): Locator {
    return this.page.locator(`[data-testid="mytravel-row"][data-travel-id="${travelId}"]`);
  }

  async hasRow(travelId: string): Promise<boolean> {
    return (await this.row(travelId).count()) > 0;
  }

  async rowStatus(travelId: string): Promise<string | null> {
    const row = this.row(travelId);
    if ((await row.count()) === 0) return null;
    return row.getAttribute('data-status');
  }

  async expectRowStatus(travelId: string, expected: string): Promise<void> {
    await expect.poll(() => this.rowStatus(travelId), { timeout: 15_000 }).toBe(expected);
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('mytravel-row').count();
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('mytravel-empty').isVisible().catch(() => false);
  }

  // ── The form ──────────────────────────────────────────────────────────────

  async openForm(): Promise<void> {
    await this.page.getByTestId('mytravel-new').click();
    await expect(this.page.getByTestId('mytravel-purpose')).toBeVisible();
  }

  async formIsOpen(): Promise<boolean> {
    return this.page.getByTestId('mytravel-submit').isVisible().catch(() => false);
  }

  async destinationOptions(): Promise<string[]> {
    return this.page
      .getByTestId('mytravel-destination')
      .locator('option')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLOptionElement).value).filter(Boolean),
      );
  }

  async destinationPickerDisabled(): Promise<boolean> {
    return this.page.getByTestId('mytravel-destination').isDisabled();
  }

  /** See `TravelPage.masterHint` — identified by its link, not its sentence. */
  masterHint(): Locator {
    return this.page.locator('a[href="/dashboard/settings?tab=libraries"]');
  }

  async fill(input: TravelFormInput): Promise<void> {
    if (input.purpose !== undefined) {
      await this.page.getByTestId('mytravel-purpose').fill(input.purpose);
    }
    if (input.travelType !== undefined) {
      await this.page.getByTestId('mytravel-type').selectOption(input.travelType);
    }
    if (input.destination !== undefined) {
      await this.page.getByTestId('mytravel-destination').selectOption(input.destination);
    }
    if (input.country !== undefined) {
      await this.page.getByTestId('mytravel-country').fill(input.country);
    }
    if (input.departureDate !== undefined) {
      await this.page.getByTestId('mytravel-departure').fill(input.departureDate);
    }
    if (input.returnDate !== undefined) {
      await this.page.getByTestId('mytravel-return').fill(input.returnDate);
    }
    if (input.estimatedCost !== undefined) {
      await this.page.getByTestId('mytravel-cost').fill(String(input.estimatedCost));
    }
    if (input.advanceAmount !== undefined) {
      await this.page.getByTestId('mytravel-advance').fill(String(input.advanceAmount));
    }
  }

  async submitOnly(): Promise<void> {
    await this.page.getByTestId('mytravel-submit').click();
  }

  async submitRequest(input: TravelFormInput): Promise<void> {
    await this.openForm();
    await this.fill(input);
    await this.submitOnly();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  // ── Cancellation ──────────────────────────────────────────────────────────

  async canCancel(travelId: string): Promise<boolean> {
    return this.row(travelId).getByTestId('mytravel-cancel').isVisible().catch(() => false);
  }

  async openCancel(travelId: string): Promise<void> {
    await this.row(travelId).getByTestId('mytravel-cancel').click();
    await expect(this.page.getByTestId('confirm-modal-confirm')).toBeVisible();
  }

  async cancelWarning(): Promise<string> {
    return confirmPanel(this.page).innerText();
  }

  /** Leaves the dialog on screen — see `TravelPage.confirmCancel`. */
  async confirmCancel(): Promise<void> {
    await this.page.getByTestId('confirm-modal-confirm').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async cancel(travelId: string): Promise<void> {
    await this.openCancel(travelId);
    await this.confirmCancel();
  }

  /**
   * Nothing on this screen decides anything — asserted as the absence of the
   * approver screen's controls anywhere on the page, not just on one row.
   */
  async offersAnyDecision(): Promise<boolean> {
    const approve = await this.page.getByTestId('travel-approve').count();
    const reject = await this.page.getByTestId('travel-reject').count();
    return approve + reject > 0;
  }
}
