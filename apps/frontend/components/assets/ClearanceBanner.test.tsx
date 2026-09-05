import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import ClearanceBanner from './ClearanceBanner';
import type { ClearanceStatus, OpenAssetSummary } from '@/types/asset';

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
 * blocked, and `data-open-assets` carries the count the copy is built from.
 *
 * `ClearanceService.getClearanceStatus` blocks on any asset whose `returnedAt`
 * is null, and every one of them is listed — a count alone does not tell HR
 * what to chase.
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

/**
 * The full server shape, derived the way `ClearanceService` derives it — so a
 * test can never accidentally describe a state the server cannot produce (a
 * `cleared: true` with an open asset, say).
 */
const clearance = (openAssets: OpenAssetSummary[] = []): ClearanceStatus => ({
  cleared: openAssets.length === 0,
  assetCleared: openAssets.length === 0,
  openAssets,
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

  it('survives a payload with no asset list at all', async () => {
    // A fixture written by hand, or a response that lost its array. The banner
    // under-reports rather than throwing, which is the only acceptable failure
    // mode for a screen an approver reads before signing off an exit.
    settle({ cleared: false, assetCleared: false } as ClearanceStatus);

    renderWithProviders(<ClearanceBanner employeeId="e-1" />, { role: 'HR_MANAGER' });

    await waitFor(() => expect(state()).toBe('blocked'));
    expect(screen.getByTestId('clearance-status')).toHaveAttribute('data-open-assets', '0');
    expect(banner()).toHaveTextContent('clearance obligations are outstanding');
  });
});
