'use client';

import { useMemo, useState, type FocusEvent, type MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/utils/cn';
import { hasAnyPermission } from '@/utils/permissions';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { buildMenu, findGroupForPathname } from './navConfig';

/** `w-16`, in pixels: where the shrunk rail ends and a hover label begins. */
const COLLAPSED_RAIL_PX = 64;

/** How far the label sits from the top and bottom edges of the window. */
const LABEL_EDGE_PX = 12;
/** One label row, used to keep the last entry's label on screen. */
const LABEL_HEIGHT_PX = 36;

export default function Sidebar() {
  const pathname = usePathname();
  const role = useAuthStore((s) => s.user?.role);
  const branding = useBrandingStore((s) => s.branding);
  const isCollapsed = useSidebarStore((s) => s.isCollapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
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

  // Which icon is naming itself, and where. Only ever set while the rail is
  // collapsed: expanded, the label is already beside the icon.
  //
  // It names the module and stops there. Listing the children here would put a
  // second, mouse-only menu beside the one the rail already has — and the module
  // hub the icon opens is the screen whose whole job is to present them.
  const [hovered, setHovered] = useState<{ key: string; top: number } | null>(null);

  // Centred on the row, then nudged in if it would sit off either end of the
  // window — the last entry in a long menu is the case that needs it.
  const showLabel = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>, key: string) => {
    if (!isCollapsed) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const centred = rect.top + rect.height / 2 - LABEL_HEIGHT_PX / 2;
    const ceiling = Math.max(
      LABEL_EDGE_PX,
      window.innerHeight - LABEL_HEIGHT_PX - LABEL_EDGE_PX,
    );
    setHovered({ key, top: Math.max(LABEL_EDGE_PX, Math.min(centred, ceiling)) });
  };

  const hideLabel = () => setHovered(null);

  return (
    // `h-full` against the pinned shell, with the nav below scrolling on its
    // own: a fully-expanded accordion can be taller than the window, and a rail
    // that cannot reach its own last entry is no better than one that scrolled
    // off the page.
    //
    // `overflow-hidden` clips the rail, not the pop-outs: those are fixed, and a
    // fixed box is positioned against the viewport rather than against this one.
    <aside
      className={cn(
        'hidden h-full shrink-0 overflow-hidden border-e border-sidebar-border bg-sidebar-bg transition-[width] duration-200 ease-out md:flex md:flex-col',
        isCollapsed ? 'w-16' : 'w-64',
      )}
    >
      {/* Fixed beside the header bar, so the brand row and the page heading sit
          on the same line however far the nav below is scrolled. Shrunk, the
          row carries the toggle alone: 64px does not hold a mark and a control
          side by side, and the control is the one that has to stay reachable. */}
      <div
        className={cn(
          'flex h-16 shrink-0 items-center border-b border-sidebar-border',
          isCollapsed ? 'justify-center px-2' : 'gap-2 px-5',
        )}
      >
        {!isCollapsed && (
          <>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary text-sm font-bold text-text-on-brand">
              PP
            </span>
            <span className="truncate font-semibold text-text-heading">
              {branding.company_name}
            </span>
          </>
        )}

        <button
          type="button"
          onClick={() => {
            toggleCollapsed();
            hideLabel();
          }}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? t('expandSidebar') : t('collapseSidebar')}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] text-sidebar-text transition-colors hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text',
            !isCollapsed && 'ms-auto',
          )}
        >
          {/* Mirrored rather than rotated in RTL: the rail moves to the other
              edge with the layout, and a panel icon flipped end over end reads
              as a different glyph. */}
          {isCollapsed ? (
            <PanelLeftOpen className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
          )}
        </button>
      </div>

      <nav
        className={cn(
          'flex-1 space-y-1 overflow-y-auto py-3',
          isCollapsed ? 'px-2' : 'px-3',
        )}
      >
        {items.map((group) => {
          const Icon = group.icon;
          const isActive = activeKey === group.labelKey;
          const hasChildren = Boolean(group.children?.length);
          const isExpanded = !isCollapsed && hasChildren && expandedKey === group.labelKey;
          // Exactly one entry may be the current page. A group header claims it
          // only when the route IS its own href and no child of it is a closer
          // match — the module hubs and the system group both point at a screen
          // that is also one of their children.
          const isCurrent = isActive && pathname === group.href && !location?.child;
          const label = t(group.labelKey);
          const isNamed = isCollapsed && hovered?.key === group.labelKey;

          return (
            <div
              key={group.labelKey}
              onMouseEnter={(e) => showLabel(e, group.labelKey)}
              onMouseLeave={hideLabel}
              onFocus={(e) => showLabel(e, group.labelKey)}
              onBlur={hideLabel}
              onKeyDown={(e) => {
                if (e.key === 'Escape') hideLabel();
              }}
            >
              <div
                className={cn(
                  'flex items-center rounded-[var(--radius-button)] text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-active-bg text-sidebar-active-text'
                    : 'text-sidebar-text hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text',
                  isNamed && !isActive && 'bg-sidebar-hover-bg text-sidebar-hover-text',
                )}
              >
                <Link
                  href={group.href}
                  aria-current={isCurrent ? 'page' : undefined}
                  // Shrunk there is no text to read, so the accessible name has
                  // to come from the label the pop-out shows.
                  aria-label={isCollapsed ? label : undefined}
                  className={cn(
                    'flex min-w-0 flex-1 items-center py-2',
                    isCollapsed ? 'justify-center px-2' : 'gap-3 px-3',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {!isCollapsed && <span className="truncate">{label}</span>}
                </Link>

                {hasChildren && !isCollapsed && (
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

              {isNamed && (
                // Fixed, so neither the rail's own clipping nor the nav's
                // scroller can cut it off, and inert: it says what the icon is,
                // and a pointer crossing it on the way to the page must not be
                // caught by it.
                <div
                  role="tooltip"
                  className="pointer-events-none fixed z-50 ms-2 whitespace-nowrap rounded-[var(--radius-button)] border border-surface-border bg-surface-overlay px-3 py-2 text-sm font-medium text-text-heading shadow-lg"
                  style={{ top: hovered.top, insetInlineStart: COLLAPSED_RAIL_PX }}
                >
                  {label}
                </div>
              )}

              {isExpanded && (
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
