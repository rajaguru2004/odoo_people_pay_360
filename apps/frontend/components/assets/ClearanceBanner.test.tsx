import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import ClearanceBanner from './ClearanceBanner';
import type {
  ClearanceStatus,
  OpenAssetSummary,
  OutstandingLoanSummary,
} from '@/types/asset';

/**
 * The banner an approver reads before signing off an exit.
 *
 * `TerminationApprovalPanel` mounts it above the Approve button and disables
 * that button from `onStatus`. The server enforces the block on all three
 * offboarding paths regardless — so what this component is actually for is
 * telling the approver *why* the approval is about to fail, and which items to
 * chase. A banner that renders "blocked" without naming a reason is worse than
 * no banner: the approver clicks Approve, gets a 400, and has nowhere to go.
 *
 * Three states, one testid: `data-clearance-state` is loading | cleared |
 * blocked, and `data-open-assets` / `data-outstanding-loans` carry the two
 * counts the copy is built from.
 *
 * There are TWO obligations, not one. `ClearanceService.getClearanceStatus`
 * blocks on an asset whose `returnedAt` is null AND on an advance/loan sitting
 * in APPROVED | DISBURSED | ACTIVE | ON_HOLD with money still out. Both reach
 * the client, and both are rendered — see the loan block at the bottom of this
 * file for why that took a change to the type before it could take one to the
 * markup.
 */

vi.mock('@/services/assetService', () => ({
  default: {
    getClearance: vi.fn(),
    getAll: vi.fn(),
    getOutstanding: vi.fn(),
  },
}));

import assetService from '@/services/assetService';

const getClearance = vi.mocked(assetService.getClearance);

const asset = (n: number): OpenAssetSummary => ({
  assignmentId: `as-${n}`,
  assetId: `a-${n}`,
  assetTag: `LAP-00${n}`,
  name: `ThinkPad ${n}`,
  category: 'LAPTOP',
  assignedAt: '2026-01-0{n}T09:00:00.000Z'.replace('{n}', String(n)),
});

const loan = (n: number): OutstandingLoanSummary => ({
  loanId: `l-${n}`,
  type: 'SALARY_ADVANCE',
  referenceNo: `ADV-00${n}`,
  outstanding: 1500 * n,
});

/**
 * The full server shape, derived the way `ClearanceService` derives it — so a
 * test can never accidentally describe a state the server cannot produce (a
 * `cleared: true` with an open asset, say).
 */
const clearance = (
  openAssets: OpenAssetSummary[] = [],
  outstandingLoans: OutstandingLoanSummary[] = [],
): ClearanceStatus => ({
  cleared: openAssets.length === 0 && outstandingLoans.length === 0,
  assetCleared: openAssets.length === 0,
  loanCleared: outstandingLoans.length === 0,
  openAssets,
  outstandingLoans,
});

const settle = (status: ClearanceStatus) =>
  getClearance.mockResolvedValue({ success: true, data: status } as never);

const banner = () => screen.getByTestId('clearance-banner');
const state = () => banner().getAttribute('data-clearance-state');

beforeEach(() => {
  getClearance.mockReset();
});

describe('the three states', () => {
  it('says it is still checking while the read is in flight', async () => {
    // Not cosmetic: the alternative — rendering nothing — is indistinguishable
    // from "cleared, nothing to see", and an approver would read the silence as
    // permission.
    getClearance.mockReturnValue(new Promise(() => {}) as never);

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    expect(state()).toBe('loading');
    expect(screen.queryByTestId('clearance-status')).not.toBeInTheDocument();
  });

  it('reports a clean employee as cleared', async () => {
    settle(clearance());

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('cleared'));
    expect(screen.getByTestId('clearance-status')).toHaveAttribute('data-cleared', 'true');
    expect(screen.queryByTestId('clearance-open-asset-as-1')).not.toBeInTheDocument();
  });

  it('blocks on a single outstanding asset, in the singular', async () => {
    settle(clearance([asset(1)]));

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('blocked'));
    const status = screen.getByTestId('clearance-status');
    expect(status).toHaveAttribute('data-cleared', 'false');
    expect(status).toHaveAttribute('data-open-assets', '1');
    expect(status).toHaveTextContent('1 company asset not returned');
  });

  it('blocks on several outstanding assets, in the plural', async () => {
    settle(clearance([asset(1), asset(2), asset(3)]));

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('blocked'));
    const status = screen.getByTestId('clearance-status');
    expect(status).toHaveAttribute('data-open-assets', '3');
    expect(status).toHaveTextContent('3 company assets not returned');
  });

  it('lists one row per open assignment, tag and name and category', async () => {
    // The count alone does not tell HR what to chase; the rows do.
    settle(clearance([asset(1), asset(2)]));

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('blocked'));
    const first = screen.getByTestId('clearance-open-asset-as-1');
    expect(first).toHaveTextContent('LAP-001');
    expect(first).toHaveTextContent('ThinkPad 1');
    expect(first).toHaveTextContent('LAPTOP');
    expect(screen.getByTestId('clearance-open-asset-as-2')).toBeInTheDocument();
    expect(screen.queryByTestId('clearance-open-asset-as-3')).not.toBeInTheDocument();
  });

  it('hands the status up so the parent can disable Approve', async () => {
    const onStatus = vi.fn();
    settle(clearance([asset(1)]));

    renderWithProviders(<ClearanceBanner employeeId="e-1" onStatus={onStatus} />, {
      role: 'HR_MANAGER',
    });

    await waitFor(() => expect(onStatus).toHaveBeenCalledTimes(1));
    expect(onStatus).toHaveBeenCalledWith(clearance([asset(1)]));
  });

  it('renders nothing at all when the read fails', async () => {
    // Deliberate: the server still blocks, and a scary banner raised by a
    // transient read failure would be worse than silence. Pinned so the
    // decision is visible rather than incidental.
    getClearance.mockRejectedValue(new Error('Network Error'));

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(screen.queryByTestId('clearance-banner')).not.toBeInTheDocument());
  });
});

/**
 * R20 — FIXED. The loan half of clearance now reaches the screen.
 *
 * `ClearanceService.getClearanceStatus` blocks on two things: an asset whose
 * `returnedAt` is null, and a loan sitting in APPROVED | DISBURSED | ACTIVE |
 * ON_HOLD (gated by `loan_clearance_blocking_enabled`). It has always returned
 * `assetCleared`, `loanCleared` and `outstandingLoans` alongside `cleared`;
 * `ClearanceStatus` in `types/asset.ts` declared only `{ cleared, openAssets }`,
 * so the loan arm arrived as `cleared: false` with an EMPTY `openAssets`.
 *
 * What the approver read was "Blocked: 0 company assets not returned", followed
 * by advice to record a return in the Asset Register — for an employee with no
 * asset out. The one screen whose entire job is to name the blocker named the
 * wrong one, and the remedy it offered could not work.
 *
 * The fix started at the type, which is why these cases could not have been
 * satisfied by markup alone.
 */
describe('an employee blocked by an outstanding LOAN', () => {
  /** What the server sends when only the loan arm is blocking. */
  const LOAN_BLOCKED = clearance([], [loan(1)]);

  it('names the loan as the blocker, counts no assets, and lists the balance to chase', async () => {
    settle(LOAN_BLOCKED);

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('blocked'));
    const status = screen.getByTestId('clearance-status');

    // Both counts are published, so a reader — and a test — can tell the two
    // obligations apart without parsing the sentence.
    expect(status).toHaveAttribute('data-open-assets', '0');
    expect(status).toHaveAttribute('data-outstanding-loans', '1');

    // The copy names the real blocker and does not claim an asset count.
    expect(status.textContent?.toLowerCase()).toContain('loan');
    expect(status).not.toHaveTextContent('0 company assets not returned');

    // One row per outstanding balance, carrying the reference an HR user would
    // quote to Finance.
    const row = screen.getByTestId('clearance-outstanding-loan-l-1');
    expect(row).toHaveTextContent('ADV-001');
    expect(row).toHaveTextContent('SALARY ADVANCE');

    // And no asset rows, because no asset is out.
    expect(banner().querySelectorAll('[data-testid^="clearance-open-asset-"]')).toHaveLength(0);
  });

  it('never advises a remedy that cannot apply', async () => {
    // The second half of the harm. With no asset out, "Record the return in the
    // Asset Register" sends HR to a screen that will show them nothing. The
    // remedy offered has to be the one that fits the obligation — and the
    // override, which IS correct here, is offered as the escape hatch rather
    // than as an afterthought to an instruction nobody can follow.
    settle(LOAN_BLOCKED);

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('blocked'));
    expect(banner().textContent).not.toContain('Record the return in the Asset Register');
    expect(banner().textContent).toContain('Advances & Loans');
    expect(banner().textContent).toContain('override');
  });

  it('reports BOTH obligations when both are outstanding', async () => {
    // The common case at an exit, and the one the old banner handled worst: HR
    // returns the laptop, the banner flips to "0 assets not returned", and the
    // termination still fails at the server on the loan. Every blocker is named
    // at once, so nothing is discovered one refusal at a time.
    settle(clearance([asset(1)], [loan(1), loan(2)]));

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('blocked'));
    const status = screen.getByTestId('clearance-status');
    expect(status).toHaveAttribute('data-open-assets', '1');
    expect(status).toHaveAttribute('data-outstanding-loans', '2');
    expect(status).toHaveTextContent('1 company asset not returned');
    expect(status).toHaveTextContent('2 outstanding loan balances');

    // A row per item on both sides, and both remedies.
    expect(screen.getByTestId('clearance-open-asset-as-1')).toBeInTheDocument();
    expect(screen.getByTestId('clearance-outstanding-loan-l-1')).toBeInTheDocument();
    expect(screen.getByTestId('clearance-outstanding-loan-l-2')).toBeInTheDocument();
    expect(banner().textContent).toContain('Record the return in the Asset Register');
    expect(banner().textContent).toContain('Advances & Loans');
  });

  it('says nothing about loans when only an asset is out', async () => {
    // The reverse guard: naming an obligation that does not exist is the same
    // class of mistake in the other direction.
    settle(clearance([asset(1)]));

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('blocked'));
    const status = screen.getByTestId('clearance-status');
    expect(status).toHaveAttribute('data-outstanding-loans', '0');
    expect(status.textContent?.toLowerCase()).not.toContain('loan');
    expect(banner().textContent).not.toContain('Advances & Loans');
  });

  it('survives a payload with no loan half at all', async () => {
    // A backend older than the type, or a fixture written by hand. The banner
    // under-reports rather than throwing, which is the only acceptable failure
    // mode for a screen an approver reads before signing off an exit.
    settle({ cleared: false, openAssets: [asset(1)] } as ClearanceStatus);

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('blocked'));
    expect(screen.getByTestId('clearance-status')).toHaveAttribute('data-outstanding-loans', '0');
    expect(screen.getByTestId('clearance-open-asset-as-1')).toBeInTheDocument();
  });
});
