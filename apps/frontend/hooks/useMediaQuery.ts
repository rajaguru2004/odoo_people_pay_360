'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Reports `false` on the server and for the hydrating render, then settles to
 * the real match.
 *
 * Reading `window.matchMedia` during the initial render would make SSR output
 * and the client's first render disagree, which React reports as a hydration
 * mismatch and repaints. `useSyncExternalStore` keeps that guarantee — React
 * uses `getServerSnapshot` for the hydration pass and re-renders with the live
 * value immediately afterwards — without the setState-in-an-effect cascade that
 * an effect-based version needs.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onStoreChange);
      return () => mql.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  // The server has no matchMedia; `false` is also what the hydrating render
  // must produce so the client's markup matches what was sent.
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export const useIsMobile = () => useMediaQuery('(max-width: 767px)');
