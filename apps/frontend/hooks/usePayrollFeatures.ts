'use client';

import { useMemo } from 'react';
import { useBrandingStore, type BrandingData } from '@/store/brandingStore';

/**
 * Which payroll extensions are switched on, in the shape a screen wants to read.
 *
 * A thin typed selector over `brandingStore` rather than a second fetch. The
 * store is already populated once at app mount and — importantly — the settings
 * screen calls `fetchBranding()` at the end of every save, so an admin who flips
 * a payroll switch sees the nav and the payslip update in the same tick. A
 * separate React Query hook would be a second network call for data already in
 * memory, and would introduce a loading state into the Sidebar's `useMemo`,
 * which reads `branding` synchronously today — that would flash-hide menu items
 * on every mount.
 */
export interface PayrollFeatures {
  /** Payslips carry an itemised earning/deduction breakdown. */
  itemLines: boolean;
  /** End-of-service benefits: the master switch. */
  eosb: boolean;
  /**
   * Final settlements specifically.
   *
   * Its own field because the server needs BOTH — `assertEnabled()` on
   * `FinalSettlementsService` refuses every route unless `eosb` and this are
   * on together. A screen gated on the master alone renders a complete
   * settlements page whose every request answers 404.
   */
  eosbSettlement: boolean;
  /** The monthly gratuity accrual ledger. Same two-switch rule. */
  eosbAccrual: boolean;
  /** Per-branch payroll periods with cut-off and payment dates. */
  calendar: boolean;
  /** The pre-run validation checklist. */
  preflight: boolean;
  /** Asset damage, training bonds and other recoveries through payroll. */
  recovery: boolean;
  /** In-service leave encashment requests. */
  encashment: boolean;
  /** The payroll reporting suite. */
  reports: boolean;
  /** The reviewed branch-transfer flow. */
  transfer: boolean;
  /** Employee grades and grade-based salary structures. */
  grade: boolean;
  /**
   * Whether these values came from the server or are still the store's
   * defaults.
   *
   * Every flag above defaults to `false`, so without this a screen cannot tell
   * "off" from "not read yet" and shows its kill-switch panel over a feature
   * that is actually on. Screens must hold their verdict until this is true.
   */
  loaded: boolean;
}

/**
 * Pure, so the Sidebar can call it inside a `useMemo` over `branding` and so it
 * can be unit-tested without a store.
 */
export function payrollFeaturesFrom(
  b: Partial<BrandingData> | undefined | null,
  loaded = false,
): PayrollFeatures {
  // `=== true` throughout: an absent key is a feature that is off. Reading it
  // as `!== false` would turn a missing field — an older backend, a failed
  // request, a typo — into an enabled feature.
  return {
    itemLines: b?.payroll_item_lines_enabled === true,
    eosb: b?.payroll_eosb_enabled === true,
    eosbSettlement:
      b?.payroll_eosb_enabled === true && b?.payroll_eosb_settlement_enabled === true,
    eosbAccrual:
      b?.payroll_eosb_enabled === true && b?.payroll_eosb_accrual_enabled === true,
    calendar: b?.payroll_calendar_enabled === true,
    preflight: b?.payroll_preflight_enabled === true,
    recovery: b?.payroll_employee_recovery_enabled === true,
    encashment: b?.leave_encashment_enabled === true,
    reports: b?.payroll_reports_enabled === true,
    transfer: b?.employee_transfer_enabled === true,
    grade: b?.employee_grade_enabled === true,
    loaded,
  };
}

export function usePayrollFeatures(): PayrollFeatures {
  // Select the stored value, derive OUTSIDE the selector. Deriving inside it —
  // `useBrandingStore((s) => payrollFeaturesFrom(s.branding))` — built a fresh
  // object on every call, so useSyncExternalStore saw a new snapshot each time
  // it compared, re-rendered to get another new one, and never converged:
  // "The result of getSnapshot should be cached to avoid an infinite loop",
  // then "Maximum update depth exceeded". Every screen calling this hook died
  // to an error boundary — the payroll calendar, grades, reports, recoveries,
  // encashment, settlements, transfers, gratuity-rules and validate pages all
  // rendered nothing at all.
  const branding = useBrandingStore((s) => s.branding);
  const loaded = useBrandingStore((s) => s.loaded);
  return useMemo(() => payrollFeaturesFrom(branding, loaded), [branding, loaded]);
}
