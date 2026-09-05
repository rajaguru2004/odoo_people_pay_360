'use client';

import { useMemo } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import {
  buildMenu,
  findGroupByModuleKey,
  findGroupForPathname,
  type NavGroup,
} from '@/components/layout/navConfig';

/**
 * The menu for the signed-in user, memoised on the two things that decide it.
 *
 * One `buildMenu` behind both hooks below: the rail, the hub tiles and the
 * breadcrumb trail all have to agree about which routes exist for this role,
 * and the cheapest way to guarantee that is to make them read the same call.
 */
function useMenu(): NavGroup[] {
  const role = useAuthStore((s) => s.user?.role);
  const branding = useBrandingStore((s) => s.branding);

  return useMemo(() => buildMenu(role, branding), [role, branding]);
}

/**
 * The nav group a module landing page is the hub for, gated exactly as the rail
 * gates it — so a tile can never offer a route the sidebar hides and
 * `ProtectedRoute` then refuses.
 *
 * Undefined while the session is still restoring, or when this role has no such
 * module. The caller renders nothing rather than half a menu.
 */
export function useModuleNav(moduleKey: string): NavGroup | undefined {
  const menu = useMenu();
  return useMemo(() => findGroupByModuleKey(menu, moduleKey), [menu, moduleKey]);
}

/** Which group and child own a route — the raw material for a breadcrumb trail. */
export function useNavLocation(pathname: string) {
  const menu = useMenu();
  return useMemo(() => findGroupForPathname(menu, pathname), [menu, pathname]);
}
