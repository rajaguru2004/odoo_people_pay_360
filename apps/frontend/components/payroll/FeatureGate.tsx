'use client';

import type { ReactNode } from 'react';

/**
 * "Is this feature on?" is three answers, not two.
 *
 * The nine payroll extension screens each read a flag off `usePayrollFeatures`
 * and print a kill-switch panel when it is false. That was wrong in a way
 * nobody could see: every flag in `brandingStore` initialises to `false`, and
 * `isLoading` initialises to `false` too, so a screen could not tell
 *
 *   - "settings were read, and this feature is off"  from
 *   - "settings have not been read yet"              or
 *   - "settings could not be read at all"
 *
 * and reported all three as the first one. An admin who turned a switch on was
 * told, in a confident sentence, that it was off — during the window before the
 * first `/system-settings/public` response, and permanently after a failed one.
 *
 * So a screen renders a placeholder while unknown, and only prints its `off`
 * panel once the answer is genuinely known.
 */

/**
 * What a screen shows while it does not yet know whether its feature is on.
 *
 * Not a blank screen and not the kill-switch panel: it says what it is waiting
 * for, so a slow settings read looks like a slow settings read.
 */
export function FeaturePending() {
  return (
    <div
      data-testid="feature-gate-pending"
      className="rounded-xl border border-slate-200 bg-white p-8 text-center"
    >
      <div className="mx-auto h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-primary" />
      <p className="mt-3 text-sm text-slate-500">Checking what is switched on…</p>
    </div>
  );
}

export default function FeatureGate({
  loaded,
  enabled,
  off,
  children,
}: {
  /** `usePayrollFeatures().loaded` — whether the flags came from the server. */
  loaded: boolean;
  enabled: boolean;
  /** What to show when the feature really is switched off. */
  off: ReactNode;
  children: ReactNode;
}) {
  if (!loaded) return <FeaturePending />;
  return <>{enabled ? children : off}</>;
}
