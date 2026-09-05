'use client';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { usePageHeaderStore, type Crumb } from '@/store/pageHeaderStore';
import { useNavLocation } from './useModuleNav';

export interface PageChrome {
  title: string;
  subtitle?: string;
  crumbs: Crumb[];
}

/**
 * What the shell prints about the current page: its heading and its trail.
 *
 * One derivation with two consumers — the header bar draws the heading, the
 * content area draws the trail above the page. They were computed together in
 * the header while the trail lived there too; splitting them apart without
 * splitting the derivation is what keeps "Add employee" the heading and
 * "People › Add employee" the trail rather than letting the two drift.
 */
export function usePageChrome(): PageChrome {
  const pathname = usePathname();
  const t = useTranslations('sidebar');
  const navLocation = useNavLocation(pathname);

  // Guarded on pathname: React runs the incoming page's effect before the
  // outgoing page's cleanup, so an unguarded read paints the previous page's
  // title over the new one for a frame.
  const entry = usePageHeaderStore((s) => s.entry);
  const declared = entry?.pathname === pathname ? entry : null;

  // A page declares its own text through `usePageHeader`; anything that
  // declares nothing is named by the nav entry that owns its route, so no
  // screen is left with a blank bar.
  const title =
    declared?.title ??
    (navLocation ? t(navLocation.child?.labelKey ?? navLocation.group.labelKey) : '');

  const crumbs = useMemo<Crumb[]>(() => {
    if (declared?.breadcrumbs?.length) return declared.breadcrumbs;
    if (!navLocation) return [];

    const { group, child } = navLocation;
    // A leaf entry has nothing above it, and a trail of one crumb only repeats
    // the heading beside it — "Payroll" over "Payroll".
    if (!group.children?.length) return [];

    const trail: Crumb[] = [{ label: t(group.labelKey), href: group.href }];
    if (child) trail.push({ label: t(child.labelKey), href: child.href });

    // Deeper than any nav entry — a record page or a form. Only the page's own
    // title names it, and it is the crumb the reader is standing on.
    const deepest = child?.href ?? group.href;
    if (pathname !== deepest && declared?.title) trail.push({ label: declared.title });

    return trail;
  }, [declared, navLocation, pathname, t]);

  return { title, subtitle: declared?.subtitle, crumbs };
}
