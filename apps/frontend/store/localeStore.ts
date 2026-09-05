import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Locale = 'en' | 'ar';

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/**
 * Persisted per browser rather than per user, on purpose: the language a
 * visitor reads is a property of the device they read on, and it has to be
 * correct on the login screen — before anyone is signed in.
 */
export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      locale: 'en',
      setLocale: (locale) => set({ locale }),
    }),
    { name: 'locale-storage' },
  ),
);
