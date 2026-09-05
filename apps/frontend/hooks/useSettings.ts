'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import settingsService from '@/services/settingsService';
import { useAuthStore } from '@/store/authStore';

export const settingsKeys = {
  all: ['system-settings'] as const,
  admin: () => [...settingsKeys.all, 'admin'] as const,
  public: () => [...settingsKeys.all, 'public'] as const,
};

/**
 * The whole settings map, secrets masked.
 *
 * `GET /system-settings` is ADMIN only. The query is disabled for everyone else
 * rather than left to 403, because a refused request here puts the shared
 * permission-denied modal on screen for an HR manager who opened Settings for
 * the parts they ARE entitled to. `retry: false` for the same reason: a role
 * that changed mid-session should fail once and be handled, not four times.
 */
export function useSystemSettings() {
  const role = useAuthStore((s) => s.user?.role);
  return useQuery({
    queryKey: settingsKeys.admin(),
    queryFn: () => settingsService.getAll(),
    enabled: role === 'ADMIN',
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** Branding, readable by anyone — this is the endpoint the login screen uses. */
export function usePublicBranding() {
  return useQuery({
    queryKey: settingsKeys.public(),
    queryFn: () => settingsService.getPublic(),
    staleTime: 5 * 60_000,
  });
}

/**
 * Writes a partial settings map. Keys absent from the body are left untouched,
 * so a section saves the fields it owns without round-tripping the rest.
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: Record<string, string>) => settingsService.update(settings),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
  });
}
