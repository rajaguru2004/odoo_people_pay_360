import type { ReactNode } from 'react';
import { BookOpen, CalendarDays, Clock, type LucideIcon } from 'lucide-react';
import type { ApprovalRequestPayload, ApprovalRequestType } from '@/types/approval';
import {
  formatOvertimeHours,
  formatWallClockRange,
} from '@/components/overtime/overtimeFormat';
import { formatDateOnly } from '@/utils/formatDate';

/**
 * How the shared inbox draws one card, per request type.
 *
 * A total `Record` on purpose: a type added to `ApprovalRequestType` without an
 * entry here is a compile error. An if/else chain instead would fall through to
 * whichever branch came last, which is a card silently decided through the
 * wrong module.
 *
 * Only presentation lives here. Which endpoint settles a decision belongs to
 * `useDecideApproval`, so the queue and any future screen cannot drift into two
 * different approve calls.
 */
export interface ApprovalKindUi {
  /** The fallback label. The server's own registry wins when it answers. */
  label: string;
  icon: LucideIcon;
  /** The badge tone the type chip is drawn in. */
  tone: 'neutral' | 'success' | 'warning' | 'error' | 'info';
  /**
   * Whether this screen can carry a decision through to the request's module.
   * A kind whose module has no screen here yet is drawn read-only — a dead
   * button is worse than no button.
   */
  decidable: boolean;
  /** The record page for one request, where this repo has one. */
  href?: (requestId: string) => string;
  summary(request: ApprovalRequestPayload): ReactNode;
}

/** "3 days", and "1 day" without the stray plural. */
function days(total: number | string | undefined) {
  const value = Number(total ?? 0);
  return `${value} day${value === 1 ? '' : 's'}`;
}

export const APPROVAL_KIND_UI: Record<ApprovalRequestType, ApprovalKindUi> = {
  LEAVE: {
    label: 'Leave',
    icon: CalendarDays,
    tone: 'info',
    decidable: true,
    summary: (request) => (
      <>
        <span className="font-medium">{request.leaveType ?? 'Leave'}</span> ·{' '}
        {formatDateOnly(request.startDate)} → {formatDateOnly(request.endDate)} (
        {days(request.totalDays)})
      </>
    ),
  },

  OVERTIME: {
    label: 'Overtime',
    icon: Clock,
    tone: 'warning',
    decidable: true,
    href: (requestId) => `/dashboard/overtime/${requestId}`,
    summary: (request) => (
      <>
        <span className="font-medium">{formatDateOnly(request.date)}</span> ·{' '}
        {formatWallClockRange(request.startTime, request.endTime)} ·{' '}
        {formatOvertimeHours(request.hours)}
        {Number(request.foodAllowance ?? 0) > 0 ||
        Number(request.siteAllowance ?? 0) > 0 ? (
          <span className="ms-1.5 rounded-[var(--radius-badge)] bg-status-success-bg px-2 py-0.5 text-[11px] font-medium text-status-success">
            + allowance
          </span>
        ) : null}
      </>
    ),
  },

  TRAINING: {
    label: 'Training',
    icon: BookOpen,
    tone: 'neutral',
    // The training module has no screen in this app yet, so the card reports
    // the nomination without offering a decision it cannot deliver.
    decidable: false,
    summary: (request) => (
      <>
        <span className="font-medium">{request.session?.course?.title ?? 'Training'}</span>
        {request.session?.startDate ? ` · ${formatDateOnly(request.session.startDate)}` : ''}
      </>
    ),
  },
};
