import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SidebarState {
  /** Whether the rail is shrunk to its icon-only width. */
  isCollapsed: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (value: boolean) => void;
}

/**
 * Persisted per browser rather than per user, like the locale: how wide the
 * rail is is a property of the screen somebody works on, not of the account
 * they signed into, and a person who shrank it on a laptop should not find it
 * expanded again after the next reload.
 *
 * It is deliberately NOT gated behind a hydration flag. The rail is chrome, not
 * a session decision — the worst a first paint at the default width can do is
 * settle a frame later, whereas rendering nothing until storage is read would
 * blank the navigation on every load.
 */
export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      isCollapsed: false,
      toggleCollapsed: () => set((s) => ({ isCollapsed: !s.isCollapsed })),
      setCollapsed: (value) => set({ isCollapsed: value }),
    }),
    { name: 'sidebar-storage' },
  ),
);
