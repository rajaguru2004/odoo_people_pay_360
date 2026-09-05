'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { usePageHeaderStore, type Crumb } from '@/store/pageHeaderStore';

/**
 * Declares this page's heading to the single slot in Topbar.
 *
 * Pass the strings the page already has:
 *
 *     usePageHeader('Employees', `${total} records`);
 *
 * A page that calls this must not also render an `<h1>` — the shell is drawing
 * one, and two headings on a screen leave a reader (and a screen reader) with
 * two answers to "where am I". A page that declares nothing keeps the title
 * Topbar derives from the nav tree.
 *
 * The third argument overrides the derived breadcrumb trail. Most pages should
 * omit it; it earns its place on a record page whose crumb should name the
 * record.
 */
export function usePageHeader(title: string, subtitle?: string, breadcrumbs?: Crumb[]) {
  const pathname = usePathname();
  const set = usePageHeaderStore((s) => s.set);
  const clear = usePageHeaderStore((s) => s.clear);

  // Depend on the CONTENT of the trail, not on its identity. Callers pass array
  // literals, which are a fresh reference on every render, so an identity
  // dependency here is an infinite loop: set() → render → new array → set().
  const crumbKey = breadcrumbs ? JSON.stringify(breadcrumbs) : '';

  useEffect(() => {
    set({
      pathname,
      title,
      subtitle,
      breadcrumbs: crumbKey ? (JSON.parse(crumbKey) as Crumb[]) : undefined,
    });
    return () => clear(pathname);
    // `breadcrumbs` is deliberately absent from the dependencies — `crumbKey`
    // stands in for it, and adding the array back is the loop described above.
  }, [pathname, title, subtitle, crumbKey, set, clear]);
}
