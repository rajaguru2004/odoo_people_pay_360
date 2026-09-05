'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils/cn';
import { hasAnyPermission } from '@/utils/permissions';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { buildMenu, findGroupForPathname } from './navConfig';

export default function Sidebar() {
  const pathname = usePathname();
  const role = useAuthStore((s) => s.user?.role);
  const branding = useBrandingStore((s) => s.branding);
  const t = useTranslations('sidebar');

  // The tree, and who may see which part of it, come from navConfig — the module
  // hubs render the same children as tiles and have to gate them identically.
  // The permission check stays here as the outer gate: it is the same
  // affordance layer the rest of the UI reads, so a route hidden by either rule
  // is hidden by both.
  const items = useMemo(
    () =>
      buildMenu(role, branding).filter(
        (group) => !group.permissions || hasAnyPermission(role, group.permissions),
      ),
    [role, branding],
  );

  // Longest match, so /dashboard/departments/tree lights Organisational chart
  // rather than the shorter All departments prefix it also starts with.
  const location = findGroupForPathname(items, pathname);
  const activeKey = location?.group.labelKey;

  // The route decides which section is open; a click on a chevron overrides that
  // until the route changes. Derived rather than synced in an effect, so there is
  // never a render where the rail disagrees with the page it is next to — and the
  // override is stamped with the pathname it was made on, which is what expires
  // it on navigation.
  const [override, setOverride] = useState<{ pathname: string; key: string | null } | null>(null);
  const expandedKey = override?.pathname === pathname ? override.key : (activeKey ?? null);

  return (
    // `h-full` against the pinned shell, with the nav below scrolling on its
    // own: a fully-expanded accordion can be taller than the window, and a rail
    // that cannot reach its own last entry is no better than one that scrolled
    // off the page.
    <aside className="hidden h-full w-64 shrink-0 overflow-hidden border-e border-sidebar-border bg-sidebar-bg md:flex md:flex-col">
      {/* Fixed beside the header bar, so the brand row and the page heading sit
          on the same line however far the nav below is scrolled. */}
      <div className="flex h-16 shrink-0 items-center gap-2 border-b border-sidebar-border px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary text-sm font-bold text-text-on-brand">
          PP
        </span>
        <span className="truncate font-semibold text-text-heading">{branding.company_name}</span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {items.map((group) => {
          const Icon = group.icon;
          const isActive = activeKey === group.labelKey;
          const hasChildren = Boolean(group.children?.length);
          const isExpanded = hasChildren && expandedKey === group.labelKey;
          // Exactly one entry may be the current page. A group header claims it
          // only when the route IS its own href and no child of it is a closer
          // match — the module hubs and the system group both point at a screen
          // that is also one of their children.
          const isCurrent = isActive && pathname === group.href && !location?.child;
          const label = t(group.labelKey);

          return (
            <div key={group.labelKey}>
              <div
                className={cn(
                  'flex items-center rounded-[var(--radius-button)] text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-active-bg text-sidebar-active-text'
                    : 'text-sidebar-text hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text',
                )}
              >
                <Link
                  href={group.href}
                  aria-current={isCurrent ? 'page' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2"
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{label}</span>
                </Link>

                {hasChildren && (
                  // A sibling button, never a button nested in the link: the
                  // label navigates to the module hub and the chevron opens the
                  // section, and one control cannot serve both intents.
                  <button
                    type="button"
                    onClick={() =>
                      setOverride({
                        pathname,
                        key: expandedKey === group.labelKey ? null : group.labelKey,
                      })
                    }
                    aria-expanded={isExpanded}
                    aria-label={t('toggleSection', { section: label })}
                    className="me-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] hover:bg-sidebar-hover-bg"
                  >
                    <ChevronDown
                      className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-180')}
                      aria-hidden
                    />
                  </button>
                )}
              </div>

              {hasChildren && isExpanded && (
                <ul className="mt-1 ms-6 space-y-1 border-s border-sidebar-border ps-2">
                  {group.children!.map((child) => {
                    const childActive = location?.child?.href === child.href;
                    return (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          aria-current={childActive ? 'page' : undefined}
                          className={cn(
                            'block truncate rounded-[var(--radius-button)] px-3 py-2 text-sm transition-colors',
                            childActive
                              ? 'bg-sidebar-sub-active-bg font-semibold text-sidebar-sub-active-text'
                              : 'text-sidebar-text hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text',
                          )}
                        >
                          {t(child.labelKey)}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
