import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen } from '@/test/render';
import BranchCard from './BranchCard';
import type { Branch } from '@/types/branch';

/**
 * The branch card's two states.
 *
 * Deactivating a branch is a SOFT delete: the row survives, but it is filtered
 * out of the list and the detail route 404s on it. So a retired card must not
 * offer Edit or Details — both are dead ends that answer "Branch not found" —
 * and it must offer the one action that gets it back. Before this, a branch
 * switched off by mistake had no route back through the UI at all.
 */

const baseBranch: Branch = {
  id: 'br-1',
  code: 'MCT',
  name: 'Muscat Branch',
  isActive: true,
  city: 'Muscat',
  country: 'OM',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  _count: { employees: 13 },
};

const onEdit = vi.fn();
const onDelete = vi.fn();
const onReactivate = vi.fn();

const renderCard = (overrides: Partial<Branch>) =>
  renderWithProviders(
    <BranchCard
      branch={{ ...baseBranch, ...overrides }}
      onEdit={onEdit}
      onDelete={onDelete}
      onReactivate={onReactivate}
    />,
    { role: 'ADMIN' },
  );

beforeEach(() => {
  onEdit.mockReset();
  onDelete.mockReset();
  onReactivate.mockReset();
});

describe('BranchCard', () => {
  it('offers edit, delete and details for an active branch, and no reactivate', () => {
    renderCard({ isActive: true });

    expect(screen.getByTestId('branch-card-edit')).toBeTruthy();
    expect(screen.getByTestId('branch-card-delete')).toBeTruthy();
    expect(screen.getByTestId('branch-card-details')).toBeTruthy();
    expect(screen.queryByTestId('branch-card-reactivate')).toBeNull();
  });

  it('offers only reactivate for a retired branch', () => {
    renderCard({ isActive: false });

    expect(screen.getByTestId('branch-card-reactivate')).toBeTruthy();
    // Both of these lead to a route that 404s on an inactive branch.
    expect(screen.queryByTestId('branch-card-edit')).toBeNull();
    expect(screen.queryByTestId('branch-card-details')).toBeNull();
    // Deleting something already soft-deleted is meaningless.
    expect(screen.queryByTestId('branch-card-delete')).toBeNull();
  });

  it('reports the branch id when reactivate is pressed', async () => {
    const { user } = renderCard({ isActive: false });

    await user.click(screen.getByTestId('branch-card-reactivate'));

    expect(onReactivate).toHaveBeenCalledWith('br-1');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('labels the status badge so a retired branch is identifiable at a glance', () => {
    renderCard({ isActive: false });
    expect(screen.getByTestId('branch-card-status').textContent).toBe('Inactive');
  });
});
