'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useDevModeStore } from '@/store/devModeStore';
import devModeService from '@/services/devModeService';

/**
 * The single source of "is this session in developer mode".
 *
 * Every gated tab and section reads `elevated` from here rather than repeating
 * its own role-string check, which is how the settings page ended up with
 * `user?.role === 'ADMIN'` written out a dozen times.
 *
 * Semantics of `elevated`:
 *   - false while locked, always;
 *   - false for any role other than ADMIN, regardless of token;
 *   - true when the backend does not enforce yet AND the user is ADMIN, so the
 *     pre-rollout UI matches the pre-rollout API (which is still permitting the
 *     admin through). Flipping DEV_MODE_ENFORCED changes both at once.
 */
export function useDevMode() {
  const { user } = useAuthStore();
  const { devToken, expiresAt, available, enforced, checked, setAvailability, clear } =
    useDevModeStore();

  const isAdmin = user?.role === 'ADMIN';
  const hasLiveToken = Boolean(devToken && expiresAt && expiresAt > Date.now());
  const elevated = isAdmin && (enforced ? hasLiveToken : true);

  const refreshStatus = useCallback(async () => {
    if (!isAdmin) {
      setAvailability({ available: false, enforced: false });
      return;
    }
    try {
      const res = await devModeService.status();
      setAvailability({ available: res.data.available, enforced: res.data.enforced });
    } catch {
      // A failed probe must not reveal anything or leave the icon showing.
      setAvailability({ available: false, enforced: false });
    }
  }, [isAdmin, setAvailability]);

  useEffect(() => {
    if (!checked) void refreshStatus();
  }, [checked, refreshStatus]);

  const exit = useCallback(async () => {
    try {
      await devModeService.revoke();
    } finally {
      // Clear locally even if the revoke call fails — the user asked to leave.
      clear();
    }
  }, [clear]);

  return {
    /** Show the hidden settings. */
    elevated,
    /** Holding a live token right now (distinct from `elevated`, which is also
     *  true for an admin before enforcement is switched on). */
    unlocked: hasLiveToken,
    /** Backend has a developer password configured. */
    available: available && isAdmin,
    enforced,
    expiresAt,
    exit,
    refreshStatus,
  };
}

/** Minutes:seconds left on the current elevation, or null. Ticks every second. */
export function useDevModeCountdown(): string | null {
  const expiresAt = useDevModeStore((s) => s.expiresAt);
  const [, force] = useState(0);

  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (!expiresAt) return null;
  const ms = expiresAt - Date.now();
  if (ms <= 0) return null;

  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}
