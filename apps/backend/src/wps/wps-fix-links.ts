import { WpsFinding } from './types/wps-finding';

/**
 * Maps a finding code to the screen that fixes it.
 *
 * Core-owned on purpose: a format adapter must never know frontend routes, or
 * "add a country" stops being one file. Adapters emit a code; the core decides
 * where to send the operator.
 *
 * Codes with no entry simply get no link and the UI shows plain text, so an
 * adapter inventing its own code degrades gracefully rather than breaking.
 */
type LinkBuilder = (f: WpsFinding, ctx: { payrollId: string }) => { label: string; href: string };

const FIX_LINKS: Record<string, LinkBuilder> = {
  // ── Payroll state ───────────────────────────────────────────────────────
  PAYROLL_NOT_PROPERLY_LOCKED: (_f, ctx) => ({
    label: 'Open payroll',
    href: `/dashboard/payroll/${ctx.payrollId}`,
  }),
  // Deliberately labelled for the ONLY action that works from a stuck LOCKED run.
  PAYROLL_LOCKED_WITHOUT_APPROVAL: (_f, ctx) => ({
    label: 'Create a revision',
    href: `/dashboard/payroll/${ctx.payrollId}?action=revise`,
  }),
  PAYROLL_HAS_NO_BRANCH: (_f, ctx) => ({
    label: 'Open payroll',
    href: `/dashboard/payroll/${ctx.payrollId}`,
  }),

  // ── Configuration ───────────────────────────────────────────────────────
  NO_WPS_CONFIGURATION: () => ({
    label: 'Configure WPS',
    href: '/dashboard/settings?tab=wps',
  }),
  WPS_DISABLED: () => ({
    label: 'Enable WPS',
    href: '/dashboard/settings?tab=wps',
  }),
  EMPLOYER_FIELD_MISSING: () => ({
    label: 'Complete employer details',
    href: '/dashboard/settings?tab=wps',
  }),
  EMPLOYER_FIELD_INVALID: () => ({
    label: 'Fix employer details',
    href: '/dashboard/settings?tab=wps',
  }),
  EMPLOYER_ACCOUNT_INVALID: () => ({
    label: 'Fix employer account',
    href: '/dashboard/settings?tab=wps',
  }),
  EMPLOYER_BANK_CODE_INVALID: () => ({
    label: 'Fix employer bank code',
    href: '/dashboard/settings?tab=wps',
  }),
  EMPLOYER_MOL_INVALID: () => ({
    label: 'Fix establishment number',
    href: '/dashboard/settings?tab=wps',
  }),

  // ── Employee bank data ──────────────────────────────────────────────────
  NO_ACTIVE_BANK_DETAIL: () => ({
    label: 'Add bank details',
    href: '/dashboard/banks/migrate',
  }),
  BANK_DETAIL_INVALID: (f) => ({
    label: 'Fix bank details',
    href: `/dashboard/employees/${f.employeeId ?? ''}`,
  }),
  IBAN_MISSING: () => ({
    label: 'Add bank details',
    href: '/dashboard/banks/migrate',
  }),
  IBAN_INVALID: (f) => ({
    label: 'Fix bank details',
    href: `/dashboard/employees/${f.employeeId ?? ''}`,
  }),
  BANK_INACTIVE: () => ({ label: 'Bank Master', href: '/dashboard/banks' }),
  BANK_COUNTRY_NOT_ALLOWED: () => ({ label: 'Branch countries', href: '/dashboard/banks/branch-countries' }),
  BANK_CODE_UNKNOWN: () => ({ label: 'Set the bank code', href: '/dashboard/banks' }),
  BANK_CHANGE_PENDING: () => ({
    label: 'Review pending change',
    href: '/dashboard/approvals',
  }),

  // ── Employee identifiers ────────────────────────────────────────────────
  IDENTIFIER_MISSING: (f) => ({
    label: 'Add document',
    href: `/dashboard/employees/${f.employeeId ?? ''}`,
  }),
  IDENTIFIER_EXPIRED: (f) => ({
    label: 'Renew document',
    href: `/dashboard/employees/${f.employeeId ?? ''}`,
  }),
  IDENTIFIER_FORMAT: (f) => ({
    label: 'Fix document number',
    href: `/dashboard/employees/${f.employeeId ?? ''}`,
  }),

  // ── Payroll figures ─────────────────────────────────────────────────────
  NET_NOT_POSITIVE: (_f, ctx) => ({
    label: 'Review payroll item',
    href: `/dashboard/payroll/${ctx.payrollId}`,
  }),
  AMOUNT_TOO_LARGE: (_f, ctx) => ({
    label: 'Review payroll item',
    href: `/dashboard/payroll/${ctx.payrollId}`,
  }),
  PRECISION_LOSS: (_f, ctx) => ({
    label: 'Review payroll item',
    href: `/dashboard/payroll/${ctx.payrollId}`,
  }),
  EMPLOYEE_LEFT_MID_PERIOD: (f) => ({
    label: 'Open employee',
    href: `/dashboard/employees/${f.employeeId ?? ''}`,
  }),
  EMPLOYEE_MISSING_FROM_RUN: (_f, ctx) => ({
    label: 'Revise payroll',
    href: `/dashboard/payroll/${ctx.payrollId}`,
  }),
  NOT_IN_BRANCH: (f) => ({
    label: 'Open employee',
    href: `/dashboard/employees/${f.employeeId ?? ''}`,
  }),
};

/** Attach a `fix` link to every finding that has one. Mutates nothing. */
export function withFixLinks(
  findings: WpsFinding[],
  ctx: { payrollId: string },
): WpsFinding[] {
  return findings.map((f) => {
    const build = FIX_LINKS[f.code];
    return build ? { ...f, fix: build(f, ctx) } : f;
  });
}
