import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface BranchState {
  /**
   * The branch the admin is currently viewing.
   *   null  = "All Branches" (global) / all accessible (scoped) — no narrowing.
   *   <id>  = narrow the whole app to this branch.
   * Sent to the backend as the `X-Branch-Id` header (a selector, never a grant).
   */
  selectedBranchId: string | null;
  setSelectedBranch: (id: string | null) => void;
  /**
   * Drop the selection. MUST be called whenever the session changes.
   *
   * This store is persisted under one localStorage key with no user scoping, so
   * without this an admin's chosen branch survives logout and is then sent as
   * `X-Branch-Id` by the NEXT user on that browser — who almost certainly has
   * no access to it, and gets 403 on every request including /auth/me.
   */
  clearSelectedBranch: () => void;
}

export const useBranchStore = create<BranchState>()(
  persist(
    (set) => ({
      selectedBranchId: null,
      setSelectedBranch: (id) => set({ selectedBranchId: id }),
      clearSelectedBranch: () => set({ selectedBranchId: null }),
    }),
    { name: 'branch-storage' },
  ),
);
