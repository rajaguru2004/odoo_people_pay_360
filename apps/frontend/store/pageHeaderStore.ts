import { create } from 'zustand';
import type { ReactNode } from 'react';

interface PageHeaderState {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  setHeader: (header: { title: string; subtitle?: string; actions?: ReactNode }) => void;
  reset: () => void;
}

/**
 * Lets a deeply-nested page own the shell's header without every layout in
 * between having to forward props for it. Pages set on mount and reset on
 * unmount — otherwise the previous page's title survives the navigation.
 */
export const usePageHeaderStore = create<PageHeaderState>((set) => ({
  title: '',
  subtitle: undefined,
  actions: undefined,
  setHeader: ({ title, subtitle, actions }) => set({ title, subtitle, actions }),
  reset: () => set({ title: '', subtitle: undefined, actions: undefined }),
}));
