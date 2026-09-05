'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useLocaleStore, type Locale } from '@/store/localeStore';
import enMessages from '@/messages/en';
import arMessages from '@/messages/ar';

const MESSAGES: Record<Locale, typeof enMessages> = {
  en: enMessages,
  ar: arMessages,
};

export function directionForLocale(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

/**
 * Mirrors ThemeProvider: reads the active locale from Zustand, applies lang/dir
 * to <html> reactively, and provides the messages to the subtree.
 *
 * `dir` on <html> rather than on a wrapper is what makes Tailwind's logical
 * properties (`ps-*`, `me-*`, `start-*`) flip — which is why the components in
 * this project use those instead of `pl-*`/`mr-*`/`left-*`.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useLocaleStore((s) => s.locale);
  const messages = useMemo(() => MESSAGES[locale], [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = directionForLocale(locale);
  }, [locale]);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
