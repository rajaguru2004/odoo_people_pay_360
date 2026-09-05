'use client';

import { useEffect, useState } from 'react';
import systemSettingsService from '@/services/systemSettingsService';

export interface StartDateBounds {
  /** `min` for a date input, or undefined when backdating is unrestricted. */
  min?: string;
  /** `max` for a date input. */
  max?: string;
}

const DEFAULT_FLOOR = '1970-01-01';
const DEFAULT_MAX_FUTURE_DAYS = 180;

const isoDay = (date: Date) => date.toISOString().split('T')[0];

const shiftDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};

/**
 * Employment start-date bounds, read from the PUBLIC settings endpoint.
 *
 * Public on purpose: GET /system-settings is limited to ADMIN/HR_MANAGER/MANAGER
 * and the onboarding form must not break for anyone narrower.
 *
 * These are picker hints only — a typed value still submits, and the server
 * re-checks it against the same policy. Never treat them as validation.
 */
export function useStartDateBounds(): StartDateBounds {
  const [bounds, setBounds] = useState<StartDateBounds>({});

  useEffect(() => {
    let cancelled = false;

    systemSettingsService
      .getPublic()
      .then((res) => {
        if (cancelled) return;
        const s = (res?.data ?? {}) as Record<string, string>;

        // Blank or 0 means unrestricted backdating; fall back to the absolute
        // floor so the picker still has a sane lower stop.
        const pastRaw = parseInt(s.employee_start_date_max_past_days ?? '', 10);
        const min =
          !isNaN(pastRaw) && pastRaw > 0
            ? shiftDays(-pastRaw)
            : s.employee_start_date_floor || DEFAULT_FLOOR;

        const futureRaw = parseInt(
          s.employee_start_date_max_future_days ?? '',
          10,
        );
        const max = shiftDays(
          isNaN(futureRaw) ? DEFAULT_MAX_FUTURE_DAYS : Math.max(0, futureRaw),
        );

        setBounds({ min, max });
      })
      .catch(() => {
        // A settings outage must not make the form unusable: leaving the bounds
        // empty just drops the picker hints, and the server still decides.
        if (!cancelled) setBounds({});
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return bounds;
}

export default useStartDateBounds;
