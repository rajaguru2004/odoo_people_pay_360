'use client';

import { memo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Home, Clock, CalendarDays, Wallet, Menu } from 'lucide-react';

/**
 * The ESS portal's bottom tab bar — phones only.
 *
 * Why a tab bar at all: on a phone the only way into the portal was the
 * hamburger in `TopHeader`, which is a two-tap, out-of-thumb-reach path to the
 * four screens an employee actually opens (home, attendance, leave, payslip).
 * A labelled bar of five targets in the bottom third of the screen is the
 * pattern every phone user already knows, and it puts those four one tap away.
 *
 * Scope, deliberately narrow:
 * - `md:hidden`, so the approved desktop shell is untouched at ≥768px.
 * - EMPLOYEE only — `DashboardLayout` decides. Admin/HR carry a nav tree far
 *   too wide for five slots, and their mobile pass has not been designed yet.
 *
 * Five items is the ceiling: below ~64px per slot the label stops fitting and
 * the target stops being reliably thumb-sized. The fifth is "More", which opens
 * the existing sidebar drawer rather than duplicating its tree here — one
 * source of truth for navigation, and every screen the bar cannot hold is still
 * exactly two taps away.
 */

interface MobileTabBarProps {
  /** Opens the existing off-canvas sidebar — the "More" tab's whole job. */
  onMoreClick: () => void;
}

/**
 * `href` is where the tab goes; `prefixes` are the route roots that light it.
 *
 * The two are not the same thing, and the first version of this file assumed
 * they were. `href` was also used as the only prefix, so the payslip tab was
 * written as `/dashboard/my-payroll` — a segment that has no `page.tsx` at all
 * (only `[id]/` and `gratuity/` live under it). The employee payslip list is
 * `/dashboard/payroll` (`navConfig.ts:321`), so one of the four tabs 404'd.
 * Separating them lets the tab go to the list and still light up on the
 * gratuity and payslip-detail screens that sit under the other segment.
 *
 * An empty `prefixes` means EXACT match — otherwise `/dashboard` would light
 * Home on every screen in the portal.
 */
const TABS = [
  { key: 'navHome', href: '/dashboard', icon: Home, prefixes: [] },
  {
    key: 'navAttendance',
    href: '/dashboard/my-attendance',
    icon: Clock,
    prefixes: ['/dashboard/my-attendance', '/dashboard/attendance'],
  },
  {
    key: 'navLeave',
    href: '/dashboard/my-leaves',
    icon: CalendarDays,
    // `/dashboard/leaves` is where filing and the request detail live.
    prefixes: ['/dashboard/my-leaves', '/dashboard/leaves'],
  },
  {
    key: 'navPayslip',
    href: '/dashboard/payroll',
    icon: Wallet,
    prefixes: ['/dashboard/payroll', '/dashboard/my-payroll'],
  },
] as const satisfies ReadonlyArray<{
  key: string;
  href: string;
  icon: typeof Home;
  prefixes: readonly string[];
}>;

/** Exact when no prefixes; otherwise the segment itself or anything under it. */
function isActive(pathname: string, href: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return pathname === href;
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const MobileTabBar = memo(function MobileTabBar({ onMoreClick }: MobileTabBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations('employeeDashboard');

  return (
    <nav
      // `pb-[env(safe-area-inset-bottom)]`: on a notched phone the home
      // indicator sits over the last ~34px of the viewport, and without this
      // the labels are underneath it.
      className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-surface-border bg-surface-card/95 backdrop-blur-lg pb-[env(safe-area-inset-bottom)]"
      aria-label="Primary"
      data-testid="mobile-tab-bar"
    >
      <ul className="grid grid-cols-5">
        {TABS.map(({ key, href, icon: Icon, prefixes }) => {
          const active = isActive(pathname, href, prefixes);
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => router.push(href)}
                aria-current={active ? 'page' : undefined}
                data-testid={`mobile-tab-${key}`}
                // h-14 + the label line clears 44px comfortably; `touch-manipulation`
                // drops the 300ms double-tap-zoom delay Safari still applies.
                className={`w-full h-14 flex flex-col items-center justify-center gap-0.5 touch-manipulation transition-colors active:bg-surface-page ${
                  active ? 'text-brand-primary' : 'text-text-muted'
                }`}
              >
                <span
                  className={`flex items-center justify-center h-6 w-10 rounded-full transition-colors ${
                    active ? 'bg-brand-primary/10' : ''
                  }`}
                >
                  <Icon size={19} strokeWidth={active ? 2.4 : 2} />
                </span>
                <span className={`text-[10px] leading-none ${active ? 'font-semibold' : 'font-medium'}`}>
                  {t(key)}
                </span>
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={onMoreClick}
            data-testid="mobile-tab-navMore"
            className="w-full h-14 flex flex-col items-center justify-center gap-0.5 text-text-muted touch-manipulation transition-colors active:bg-surface-page"
          >
            <span className="flex items-center justify-center h-6 w-10">
              <Menu size={19} strokeWidth={2} />
            </span>
            <span className="text-[10px] leading-none font-medium">{t('navMore')}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
});

export default MobileTabBar;
