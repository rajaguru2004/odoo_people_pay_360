'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronRight, LogOut } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { usePageHeaderStore, type Crumb } from '@/store/pageHeaderStore';
import { useNavLocation } from '@/hooks/useModuleNav';
import { fullName, initials } from '@/utils/formatters';
import { Button } from '@/components/ui/Button';

/**
 * The trail, from the module down to the page.
 *
 * Rooted at the module rather than at the main dashboard: from inside People the
 * useful way back is the People hub, and the dashboard is already one click away
 * in the rail.
 */
function BreadcrumbTrail({ crumbs }: { crumbs: Crumb[] }) {
  if (!crumbs.length) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[11px]">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && (
              <ChevronRight className="h-3 w-3 shrink-0 text-text-muted rtl:rotate-180" aria-hidden />
            )}
            {crumb.href && !isLast ? (
              <Link
                href={crumb.href}
                className="truncate text-text-muted transition-colors hover:text-text-heading"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className="truncate text-text-muted">{crumb.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export default function Topbar() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const t = useTranslations('sidebar');

  const navLocation = useNavLocation(pathname);

  // Guarded on pathname: React runs the incoming page's effect before the
  // outgoing page's cleanup, so an unguarded read paints the previous page's
  // title over the new one for a frame.
  const entry = usePageHeaderStore((s) => s.entry);
  const declared = entry?.pathname === pathname ? entry : null;

  // The single heading slot for the whole shell. A page declares its own text
  // through `usePageHeader`; anything that declares nothing is named by the nav
  // entry that owns its route, so no screen is left with a blank bar.
  const title = declared?.title ?? (navLocation
    ? t(navLocation.child?.labelKey ?? navLocation.group.labelKey)
    : '');
  const subtitle = declared?.subtitle;

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

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <header className="flex h-16 items-center justify-between gap-4 border-b border-header-border bg-header-bg px-4 md:px-6">
      <div className="min-w-0">
        <BreadcrumbTrail crumbs={crumbs} />
        {title && (
          <h1 className="truncate text-base font-semibold leading-tight text-header-text md:text-lg">
            {title}
          </h1>
        )}
        {subtitle && <p className="hidden truncate text-xs text-text-muted sm:block">{subtitle}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden min-w-0 text-end sm:block">
          <p className="truncate text-sm font-semibold text-header-text">
            {fullName(user?.employee) !== '—' ? fullName(user?.employee) : user?.email}
          </p>
          <p className="truncate text-xs text-text-muted">
            {user?.employee?.position ?? user?.role?.replace(/_/g, ' ')}
          </p>
        </div>
        <span
          aria-hidden
          className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-primary text-sm font-semibold text-text-on-brand"
        >
          {initials(user?.employee) !== '?' ? initials(user?.employee) : user?.email?.[0]?.toUpperCase()}
        </span>
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">Sign out</span>
        </Button>
      </div>
    </header>
  );
}
