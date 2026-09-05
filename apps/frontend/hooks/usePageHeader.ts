'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { usePageHeaderStore, type Crumb } from '@/store/pageHeaderStore';

/**
 * Declares this page's title/subtitle to the global TopHeader.
 *
 * The dashboard renders exactly one heading slot, in TopHeader. A page must not
 * paint its own `<h1>` + subtitle as well — that is the duplicate-title defect
 * this hook exists to remove. Pass the strings the page already translates:
 *
 *   usePageHeader(t('title'), t('subtitle'));
 *
 * Pages that declare nothing keep TopHeader's static `getPageInfo()` fallback.
 *
 * The optional third argument overrides the breadcrumb trail TopHeader derives
 * from the nav tree. Most pages should omit it: the derived trail is already
 * correct for anything the sidebar links to, and a hand-written one is one more
 * place to forget when a route moves. Pass it for record pages whose crumb
 * should name the record.
 */
export function usePageHeader(title: string, subtitle?: string, breadcrumbs?: Crumb[]) {
  const pathname = usePathname();
  const set = usePageHeaderStore((s) => s.set);
  const clear = usePageHeaderStore((s) => s.clear);

  // Callers pass array literals, which are a new reference every render. Depend
  // on the content instead, or the effect re-runs forever: set() → render →
  // new array → set().
  const crumbKey = breadcrumbs ? JSON.stringify(breadcrumbs) : '';

  useEffect(() => {
    set({ pathname, title, subtitle, breadcrumbs: crumbKey ? JSON.parse(crumbKey) : undefined });
    return () => clear(pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, title, subtitle, crumbKey, set, clear]);
}
