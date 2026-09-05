'use client';

import { useEffect, useState } from 'react';

/**
 * SSR-safe media-query hook.
 *
 * Returns `false` on the server and the first client render (so markup matches
 * and hydration never mismatches), then updates to the real match after mount
 * and on every viewport change. Prefer pure CSS (`hidden md:block`) for styling;
 * reach for this only when behavior — not just appearance — must branch on size
 * (e.g. initial drawer state, rendering a table vs. a card list).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);

    onChange(); // sync once mounted
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** True below Tailwind's `md` breakpoint (< 768px) — i.e. phones / small tablets. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)');
}
