'use client';

import type { ComponentType } from 'react';
import { cn } from '@/utils/cn';

/**
 * The status chip, and ONLY the chip.
 *
 * Twenty files in this app define a local `getStatusBadge`, and every one of
 * them is the same two maps: status → colour classes, and status → label. The
 * colours are worth sharing. **The labels are not, and this component
 * deliberately cannot take a status string.**
 *
 * `components/advance-loans/loanStatus.ts` already argues the reason at length:
 * a partial lookup keyed by an enum is the shape of a bug, because adding a
 * status server-side silently degrades every screen that forgot to update its
 * map. A single app-wide `status → label` table would be exactly that, times
 * twenty domains, and it would also have to be i18n'd for vocabulary that is
 * domain-specific ("Refused" for leave, "Rejected" for a loan, "Void" for a
 * payslip).
 *
 * So each domain keeps its own map, which TypeScript can make exhaustive:
 *
 *     const LEAVE_STATUS: Record<LeaveStatus, { label: string; tone: Tone }> = {
 *       PENDING:   { label: t('statusPending'),   tone: 'pending' },
 *       APPROVED:  { label: t('statusApproved'),  tone: 'success' },
 *       REJECTED:  { label: t('statusRefused'),   tone: 'danger'  },
 *       CANCELLED: { label: t('statusCancelled'), tone: 'neutral' },
 *     };
 *     <StatusBadge {...LEAVE_STATUS[leave.status]} />
 *
 * Adding a status to `LeaveStatus` then fails the build instead of rendering a
 * grey chip that says "APPROVED_L2".
 *
 * Tokens only. The two existing shared badges — `components/tasks/TaskStatusBadge`
 * and `components/timesheets/TimesheetStatusBadge`, which are byte-for-byte the
 * same component with different maps — paint raw `bg-slate-100` / `bg-emerald-50`,
 * which survive a theme-preset change. Adoption fixes that.
 */

export type StatusTone =
  | 'neutral'
  | 'pending'
  | 'success'
  | 'info'
  | 'warning'
  | 'danger';

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'bg-surface-page text-text-muted',
  pending: 'bg-status-warning-bg text-status-warning',
  success: 'bg-status-success-bg text-status-success',
  info: 'bg-status-info-bg text-status-info',
  warning: 'bg-status-warning-bg text-status-warning',
  danger: 'bg-status-error-bg text-status-error',
};

/**
 * `md` reproduces the chip those twenty functions emit today, character for
 * character, so first adoption on a screen is a no-op at desktop width. `sm` is
 * the tighter one for a card header on a phone.
 */
const SIZE_CLASS = {
  sm: 'px-2 py-0.5 text-[11px] gap-1',
  md: 'px-2.5 py-1 text-xs gap-1.5',
} as const;

export interface StatusBadgeProps {
  tone: StatusTone;
  /** Already translated, already humanised. This component never maps a value. */
  label: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
  testId?: string;
}

export default function StatusBadge({
  tone,
  label,
  icon: Icon,
  size = 'md',
  className,
  testId,
}: StatusBadgeProps) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full font-medium whitespace-nowrap',
        TONE_CLASS[tone],
        SIZE_CLASS[size],
        className,
      )}
    >
      {Icon && <Icon size={size === 'sm' ? 11 : 12} />}
      {label}
    </span>
  );
}
