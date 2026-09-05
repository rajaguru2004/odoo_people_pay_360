import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useBranchStore } from '@/store/branchStore';
import BranchPicker from './BranchPicker';

/**
 * The branch selector.
 *
 * Three separate places have to agree about branch scope: this picker, the
 * `branch-storage` slice it writes, and the axios interceptor that turns that
 * slice into an `X-Branch-Id` header. Disagreement is not a cosmetic bug — it
 * produces "You do not have access to the selected branch" on every request,
 * including `/auth/me`, which locks the user out of the app entirely.
 *
 * Two invariants the component's own comments call out, and the reason this
 * file exists:
 *
 *   - an EMPTY access envelope means "no branch access", NOT "all branches".
 *     Falling back to the full list would offer branches the server refuses —
 *     the 403 loop above. The picker renders nothing instead.
 *   - a CONCRETE branch is always selected. There is deliberately no "All
 *     Branches" entry, and an absent or stale selection is repaired to the
 *     first available branch rather than left null.
 */

/** Options live in a portal; the trigger shows the selected name too. */
const optionButtons = () =>
  Array.from(document.querySelectorAll('body > div button')) as HTMLButtonElement[];

const optionLabelled = (name: string) =>
  optionButtons().find((b) => b.textContent?.includes(name));

vi.mock('@/hooks/useBranches', () => ({
  useBranches: vi.fn(),
}));

import { useBranches } from '@/hooks/useBranches';

const mockBranches = vi.mocked(useBranches);

const BRANCHES = [
  { id: 'br-1', code: 'HO', name: 'Head Office' },
  { id: 'br-2', code: 'MCT', name: 'Muscat' },
];

function withAllBranches(list = BRANCHES) {
  mockBranches.mockReturnValue({ data: { data: list } } as never);
}

function withNoBranchList() {
  mockBranches.mockReturnValue({ data: undefined } as never);
}

beforeEach(() => {
  mockBranches.mockReset();
  withNoBranchList();
  useBranchStore.setState({ selectedBranchId: null });
});

describe('who may switch branch at all', () => {
  it.each(['MANAGER', 'EMPLOYEE'])('renders nothing for a %s, who is pinned server-side', (role) => {
    // Sending a branch header for a pinned role can only ever produce a 403,
    // so the control must not exist rather than merely be disabled.
    const { container } = renderWithProviders(<BranchPicker />, { role: role as 'MANAGER' });
    expect(container.textContent?.trim()).toBe('');
  });

  it('renders for an ADMIN with global access', () => {
    withAllBranches();
    renderWithProviders(<BranchPicker />, {
      role: 'ADMIN',
      user: { isGlobalBranchAccess: true },
    });
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders for a scoped HR_MANAGER who holds grants', () => {
    renderWithProviders(<BranchPicker />, {
      role: 'HR_MANAGER',
      user: { isGlobalBranchAccess: false, accessibleBranches: BRANCHES },
    });
    expect(screen.getByRole('button')).toBeInTheDocument();
  });
});

describe('where the options come from', () => {
  it('offers every active branch to a global user', async () => {
    withAllBranches();
    const { user } = renderWithProviders(<BranchPicker />, {
      role: 'ADMIN',
      user: { isGlobalBranchAccess: true },
    });

    await user.click(screen.getAllByRole('button')[0]);

    // Scoped to the dropdown: the trigger also renders the selected branch's
    // name, so a bare text query matches twice.
    await waitFor(() => expect(optionLabelled('Head Office')).toBeTruthy());
    expect(optionLabelled('Muscat')).toBeTruthy();
  });

  it('offers a scoped user only their granted set', async () => {
    // The grant list is what the server will accept. Widening it here would
    // offer a branch every request is then refused for.
    withAllBranches();
    const { user } = renderWithProviders(<BranchPicker />, {
      role: 'HR_MANAGER',
      user: { isGlobalBranchAccess: false, accessibleBranches: [BRANCHES[0]] },
    });

    await user.click(screen.getAllByRole('button')[0]);

    await waitFor(() => expect(optionLabelled('Head Office')).toBeTruthy());
    expect(optionLabelled('Muscat')).toBeFalsy();
  });

  it('does NOT fall back to the full list when the envelope is empty', async () => {
    // The invariant. An empty envelope means no access; offering the full list
    // would make every subsequent request 403 with "You do not have access to
    // the selected branch". The picker renders nothing at all rather than an
    // empty dropdown, which is the honest signal.
    withAllBranches();
    const { container } = renderWithProviders(<BranchPicker />, {
      role: 'HR_MANAGER',
      user: { isGlobalBranchAccess: false, accessibleBranches: [] },
    });

    expect(container.textContent?.trim()).toBe('');
    expect(optionLabelled('Head Office')).toBeFalsy();
  });

  it('does not request the branch list for a scoped user', () => {
    // `/branches` is forbidden for some scoped roles, so asking for it would
    // log a 403 on every page load.
    renderWithProviders(<BranchPicker />, {
      role: 'HR_MANAGER',
      user: { isGlobalBranchAccess: false, accessibleBranches: BRANCHES },
    });

    expect(mockBranches).toHaveBeenCalledWith(false);
  });

  it('requests the branch list for a global user', () => {
    withAllBranches();
    renderWithProviders(<BranchPicker />, {
      role: 'ADMIN',
      user: { isGlobalBranchAccess: true },
    });

    expect(mockBranches).toHaveBeenCalledWith(true);
  });
});

describe('selecting a branch', () => {
  it('writes the choice to the store the interceptor reads', async () => {
    // `branch-storage` is what becomes `X-Branch-Id`. If the picker and the
    // store disagree, the screen shows one branch and the API answers for
    // another.
    withAllBranches();
    const { user } = renderWithProviders(<BranchPicker />, {
      role: 'ADMIN',
      user: { isGlobalBranchAccess: true },
    });

    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(optionLabelled('Muscat')).toBeTruthy());
    optionLabelled('Muscat')!.click();

    await waitFor(() => expect(useBranchStore.getState().selectedBranchId).toBe('br-2'));
  });

  it('repairs an absent selection to the first available branch', async () => {
    // Deliberately NOT an "All Branches" entry: the component keeps a concrete
    // branch selected at all times, so a null selection is a state to repair
    // rather than an option to offer.
    withAllBranches();
    useBranchStore.setState({ selectedBranchId: null });

    renderWithProviders(<BranchPicker />, { role: 'ADMIN', user: { isGlobalBranchAccess: true } });

    await waitFor(() => expect(useBranchStore.getState().selectedBranchId).toBe('br-1'));
  });

  it('repairs a stale selection that is no longer in the envelope', async () => {
    // The cross-session leak this guards: a branch persisted by a previous user
    // and no longer granted would otherwise be sent as X-Branch-Id on every
    // request and refused.
    withAllBranches();
    useBranchStore.setState({ selectedBranchId: 'br-gone' });

    renderWithProviders(<BranchPicker />, {
      role: 'HR_MANAGER',
      user: { isGlobalBranchAccess: false, accessibleBranches: [BRANCHES[1]] },
    });

    await waitFor(() => expect(useBranchStore.getState().selectedBranchId).toBe('br-2'));
  });
});
