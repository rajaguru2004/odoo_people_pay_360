'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useBrandingStore } from '@/store/brandingStore';

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  // Company branding drives the theme, so it is fetched once here rather than
  // by whichever screen happens to mount first.
  useEffect(() => {
    void useBrandingStore.getState().fetchBranding();
  }, []);

  // Created in state, not at module scope: a module-level client would be
  // shared across requests on the server and leak one user's cached data into
  // another's render.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            gcTime: 5 * 60 * 1000,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
