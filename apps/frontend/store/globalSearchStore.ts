import { create } from 'zustand';

interface GlobalSearchState {
  query: string;
  setQuery: (query: string) => void;
}

export const useGlobalSearchStore = create<GlobalSearchState>((set) => ({
  query: '',
  setQuery: (query) => set({ query }),
}));
