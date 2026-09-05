'use client';

import { useMemo } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import {
  buildMenu,
  findGroupByModuleKey,
  findGroupForPathname,
  FLAG_ROUTES,
  type NavGroup,
} from '@/components/dashboard/navConfig';

/**
 * One derived scalar rather than one entry per flag.
 *
 * Enumerating them individually is the trap: adding a flag and forgetting its
 * dependency means the menu never updates after `fetchBranding()` resolves,
 * which reads as an intermittent bug rather than a missing line.
 */
function useMenu(): NavGroup[] {
  const { user } = useAuthStore();
  const { branding } = useBrandingStore();
  const payrollFlagsKey = FLAG_ROUTES.map((r) => String(branding?.[r.flag])).join('|');

  return useMemo(
    () => buildMenu(user?.role, branding),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.role, branding?.overtime_enabled, branding?.reimbursement_enabled, payrollFlagsKey],
  );
}

/**
 * The nav group a module landing page is the hub for, gated exactly as the
 * sidebar gates it — so a tile can never offer a route the rail hides and
 * `ProtectedRoute` then refuses.
 *
 * Returns undefined while branding is still loading, or when the current role
 * has no such group; the caller renders nothing rather than a half-menu.
 */
export function useModuleNav(moduleKey: string): NavGroup | undefined {
  const menu = useMenu();
  return useMemo(() => findGroupByModuleKey(menu, moduleKey), [menu, moduleKey]);
}

/** Which group/child owns a route — used to derive a breadcrumb trail. */
export function useNavLocation(pathname: string) {
  const menu = useMenu();
  return useMemo(() => findGroupForPathname(menu, pathname), [menu, pathname]);
}
