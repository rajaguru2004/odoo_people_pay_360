'use client';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import BreadcrumbTrail from '@/components/common/BreadcrumbTrail';
import { useNavLocation } from '@/hooks/useModuleNav';
import { usePageHeaderStore, type Crumb } from '@/store/pageHeaderStore';

/**
 * The "you are here" line at the top of the page body.
 *
 * Deliberately NOT in TopHeader: that bar carries the page title and its
 * description, and stacking a third line into 64px squeezes all three. The
 * trail belongs with the content it describes, on the first row of the page.
 *
 * Derived from the nav tree rather than declared page by page, so all ~100
 * screens get a trail without being edited and a route that moves in navConfig
 * cannot leave a stale crumb behind. A page may still override through
 * `usePageHeader`'s third argument when the route alone cannot name it — a
 * record page whose crumb should carry the record's name.
 *
 * Rooted at the module hub rather than at the main dashboard: from inside
 * Payroll, the useful way back is the payroll hub, and the main dashboard is
 * already one click away in the rail and on the logo.
 *
 * Renders nothing only where there is no module to name: the main dashboard,
 * and the handful of screens the nav does not list. On a hub the single module
 * crumb stays — it is the anchor the deeper trails grow from, and dropping it
 * would make the row appear and disappear as the reader moves in and out.
 */
export default function PageBreadcrumbs() {
  const pathname = usePathname();
  const tNav = useTranslations('sidebar');
  const navLocation = useNavLocation(pathname);

  // Guarded on pathname for the same reason TopHeader guards its title: the
  // outgoing page's cleanup can run after the incoming page's effect, and a
  // stale trail is worse than none.
  const declaredEntry = usePageHeaderStore((s) => s.entry);
  const declared = declaredEntry?.pathname === pathname ? declaredEntry : null;

  const crumbs: Crumb[] = useMemo(() => {
    if (declared?.breadcrumbs?.length) return declared.breadcrumbs;
    if (pathname === '/dashboard' || !navLocation) return [];

    const { group, child } = navLocation;

    // The trail is rooted at the MODULE, not at the main dashboard. Every crumb
    // in it should lead somewhere the reader is likely to want next, and from
    // inside Payroll that is the payroll hub — the main dashboard is a step
    // sideways, already one click away in the rail and on the logo.
    const trail: Crumb[] = [];

    // A screen the nav does not list — a profile page, an admin opening their
    // own payslips. There is no module to root the trail at.
    if (group.href === '/dashboard' && !child) return [];

    if (group.children?.length) {
      trail.push({ label: tNav(group.labelKey), href: group.href });
    } else {
      // A leaf nav item (Approvals, My Team) is its own crumb, not a section.
      trail.push({ label: tNav(group.labelKey) });
      return trail;
    }

    if (child) trail.push({ label: tNav(child.labelKey), href: child.href });

    // Deeper than any nav entry — a record page, a /new form. The page's own
    // title is the only thing that names it.
    const deepest = child?.href ?? group.href;
    if (deepest && pathname !== deepest && declared?.title) {
      trail.push({ label: declared.title });
    }

    return trail;
  }, [declared, navLocation, pathname, tNav]);

  if (crumbs.length === 0) return null;

  return <BreadcrumbTrail crumbs={crumbs} className="mb-4" />;
}
