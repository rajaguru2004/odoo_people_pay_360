import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import BranchForm from './BranchForm';

const createBranch = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useBranches', () => ({
  useBranch: () => ({ data: undefined, isLoading: false, isError: false }),
  useCreateBranch: () => ({ mutateAsync: createBranch, isPending: false }),
  useUpdateBranch: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteBranch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmployees', () => ({
  useEmployees: () => ({ data: { success: true, data: [] }, isLoading: false }),
}));

function fence() {
  return {
    toggle: screen.getByRole('checkbox', { name: /restrict clock-in/i }),
    latitude: screen.getByLabelText('Latitude'),
    longitude: screen.getByLabelText('Longitude'),
    radius: screen.getByLabelText('Radius in metres'),
  };
}

beforeEach(() => {
  createBranch.mockReset();
  createBranch.mockResolvedValue({ success: true, data: { id: 'b1' } });
});

describe('BranchForm geofence', () => {
  it('keeps the fence fields disabled until the fence is switched on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BranchForm mode="create" />);

    // Disabled rather than hidden: a coordinate typed into a fence that is off
    // would be dropped on save with nothing on screen saying so.
    expect(fence().latitude).toBeDisabled();
    expect(fence().longitude).toBeDisabled();
    expect(fence().radius).toBeDisabled();

    await user.click(fence().toggle);

    expect(fence().latitude).toBeEnabled();
    expect(fence().longitude).toBeEnabled();
    expect(fence().radius).toBeEnabled();
  });

  /**
   * The server refuses this too. The point of refusing it here is that a form
   * which lets you press Save spends a round trip being told something it
   * already knew.
   */
  it('refuses to submit an enabled fence with a missing coordinate', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BranchForm mode="create" />);

    await user.type(screen.getByLabelText('Branch code'), 'HQ');
    await user.type(screen.getByLabelText('Branch name'), 'Head Office');
    await user.click(fence().toggle);
    await user.type(fence().longitude, '58.3829');

    await user.click(screen.getByRole('button', { name: 'Create branch' }));

    expect(await screen.findByText('A geofence needs a latitude')).toBeInTheDocument();
    expect(createBranch).not.toHaveBeenCalled();
  });

  it('submits once the fence has a centre', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BranchForm mode="create" />);

    await user.type(screen.getByLabelText('Branch code'), 'HQ');
    await user.type(screen.getByLabelText('Branch name'), 'Head Office');
    await user.click(fence().toggle);
    await user.type(fence().latitude, '23.588');
    await user.type(fence().longitude, '58.3829');

    await user.click(screen.getByRole('button', { name: 'Create branch' }));

    await waitFor(() => expect(createBranch).toHaveBeenCalledTimes(1));
    expect(createBranch.mock.calls[0][0]).toMatchObject({
      code: 'HQ',
      name: 'Head Office',
      geofencingEnabled: true,
      latitude: 23.588,
      longitude: 58.3829,
    });
  });
});
