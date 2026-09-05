'use client';

import { useEffect, type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/messages/en';

/**
 * The portal ships ONE locale. Arabic was withdrawn deliberately, so there is
 * no locale state to read and no message map to index — `messages/en` is the
 * only catalogue, and English is left-to-right.
 *
 * This provider still exists because `useTranslations` is called across the
 * dashboard: it is what supplies the catalogue, not what chooses between
 * catalogues. Re-introducing a language means restoring a locale store and
 * widening the two constants below, nothing structural.
 *
 * Mounted inside DashboardLayout only — lifting it to the root layout later is
 * a one-line move.
 */
const LOCALE = 'en';
const DIRECTION = 'ltr';

interface LocaleProviderProps {
  children: ReactNode;
}

export function LocaleProvider({ children }: LocaleProviderProps) {
  useEffect(() => {
    document.documentElement.lang = LOCALE;
    document.documentElement.dir = DIRECTION;
  }, []);

  return (
    <NextIntlClientProvider locale={LOCALE} messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  );
}
