import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import enMessages from '@/messages/en';

/**
 * Render inside the providers a screen expects.
 *
 * `retry: false` matters more than it looks: with the app's default of 1, a
 * test asserting an error state waits for a retry that will also fail, and the
 * assertion times out instead of failing on the thing it is testing.
 *
 * The locale is pinned to English rather than read from the locale store:
 * assertions name the strings they expect, and a test that changed language
 * with the browser would pass or fail on what was in localStorage.
 */
export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </NextIntlClientProvider>
    );
  }

  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}

export * from '@testing-library/react';
