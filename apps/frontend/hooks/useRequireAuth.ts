'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';

/**
 * Route guard for the signed-in shell.
 *
 * The `hasHydrated` gate is the whole point: before the persist middleware has
 * read storage, `isAuthenticated` is `false` for a signed-in user too, so
 * redirecting on it would bounce every reload to /login and back. See the note
 * on that flag in store/authStore.ts.
 */
export function useRequireAuth() {
  const router = useRouter();
  const { isAuthenticated, hasHydrated, user, loadUser } = useAuthStore();

  useEffect(() => {
    if (!hasHydrated) return;
    if (!isAuthenticated) {
      router.replace('/login');
      return;
    }
    void loadUser();
    // loadUser is stable (zustand action); re-running on it would refetch on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasHydrated, isAuthenticated, router]);

  return { user, isReady: hasHydrated && isAuthenticated };
}
