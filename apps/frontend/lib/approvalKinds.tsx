import { ReactNode } from 'react';
import {
  BookOpen,
  CalendarDays,
  Clock,
  Landmark,
  Plane,
  Wallet,
  LucideIcon,
} from 'lucide-react';
import leaveService from '@/services/leaveService';
import overtimeService from '@/services/overtimeService';
import bankChangeService from '@/services/bankChangeService';
import travelService from '@/services/travelService';
import advanceLoanService from '@/services/advanceLoanService';
import trainingService from '@/services/trainingService';
import type { ApprovalRequestType } from '@/services/approvalWorkflowService';
import type { ApproveOvertimeData } from '@/types/overtime';

/**
 * The worked window, read as UTC wall-clock.
 *
 * Overtime times are stored tz-naive and tagged `Z`, so `getUTCHours` recovers
 * the hour that was entered. Rendering them in the viewer's local zone would
 * shift every OT request by the browser's offset.
 */
function fmtTimeRange(from?: string, to?: string) {
  if (!from || !to) return '';
  const hhmm = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(
      d.getUTCMinutes(),
    ).padStart(2, '0')}`;
  };
  const a = hhmm(from);
  const b = hhmm(to);
  return a && b ? `${a}–${b}` : '';
}

function fmtDate(d?: string) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(d);
  }
}

export interface ApprovalKindUi {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the type chip. */
  badgeClass: string;
  /**
   * `payload` carries approver corrections. Only OVERTIME reads it today; the
   * other kinds ignore it, so the inbox can call every kind the same way.
   */
  approve(requestId: string, payload?: unknown): Promise<unknown>;
  reject(requestId: string, reason: string): Promise<unknown>;
  /** Whether this kind offers a review-and-edit screen before approving. */
  reviewable?: boolean;
  /** One-line description of the request, rendered inside the inbox card. */
  summary(request: any): ReactNode;
}

/**
 * Per-type behaviour for the shared approval inbox.
 *
 * Declared as a total `Record` on purpose: adding a value to
 * `ApprovalRequestType` without adding an entry here is a compile error. The
 * previous if/else chain fell through to overtime, so a new request type would
 * have been silently approved through the wrong service.
 */
export const APPROVAL_KIND_UI: Record<ApprovalRequestType, ApprovalKindUi> = {
  LEAVE: {
    label: 'Leave',
    icon: CalendarDays,
    badgeClass: 'bg-blue-50 text-blue-700',
    approve: (id) => leaveService.approve(id),
    reject: (id, reason) => leaveService.reject(id, reason),
    summary: (req) => (
      <>
        <span className="font-medium">{req.leaveType}</span> ·{' '}
        {fmtDate(req.startDate)} → {fmtDate(req.endDate)} ({req.totalDays} day
        {req.totalDays === 1 ? '' : 's'})
      </>
    ),
  },

  OVERTIME: {
    label: 'Overtime',
    icon: Clock,
    badgeClass: 'bg-amber-50 text-amber-700',
    approve: (id, payload) =>
      overtimeService.approve(id, payload as ApproveOvertimeData | undefined),
    reject: (id, reason) =>
      overtimeService.reject(id, { rejectedReason: reason }),
    reviewable: true,
    summary: (req) => (
      <>
        <span className="font-medium">{fmtDate(req.date)}</span> ·{' '}
        {fmtTimeRange(req.startTime, req.endTime)} · {Number(req.hours)}h
        {Number(req.foodAllowance ?? 0) > 0 || Number(req.siteAllowance ?? 0) > 0 ? (
          <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            + allowance
          </span>
        ) : null}
      </>
    ),
  },

  TRAVEL: {
    label: 'Travel',
    icon: Plane,
    badgeClass: 'bg-sky-50 text-sky-700',
    approve: (id) => travelService.approve(id),
    reject: (id, reason) => travelService.reject(id, reason),
    summary: (req) => (
      <>
        <span className="font-medium">{req.destination}</span>
        {req.travelType === 'INTERNATIONAL' && req.country ? ` (${req.country})` : ''} ·{' '}
        {fmtDate(req.departureDate)} → {fmtDate(req.returnDate)}
        {req.estimatedCost ? ` · est. ${Number(req.estimatedCost).toLocaleString()}` : ''}
      </>
    ),
  },

  ADVANCE_LOAN: {
    label: 'Advance & Loan',
    icon: Wallet,
    badgeClass: 'bg-emerald-50 text-emerald-700',
    approve: (id) => advanceLoanService.approve(id),
    reject: (id, reason) => advanceLoanService.reject(id, reason),
    summary: (req) => (
      <>
        <span className="font-medium">
          {req.type === 'ADVANCE' ? 'Salary advance' : 'Loan'}
        </span>{' '}
        · {req.currency ?? ''}
        {Number(req.amount ?? 0).toLocaleString()}
        {req.installments ? ` · ${req.installments} instalment${req.installments === 1 ? '' : 's'}` : ''}
        {req.referenceNo ? ` · ${req.referenceNo}` : ''}
      </>
    ),
  },

  TRAINING: {
    label: 'Training',
    icon: BookOpen,
    badgeClass: 'bg-indigo-50 text-indigo-700',
    approve: (id) => trainingService.approve(id),
    reject: (id, reason) => trainingService.reject(id, reason),
    summary: (req) => (
      <>
        <span className="font-medium">
          {req.session?.course?.title ?? 'Training'}
        </span>
        {req.session?.startDate ? ` · ${fmtDate(req.session.startDate)}` : ''}
        {req.cost ? ` · ${Number(req.cost).toLocaleString()}` : ''}
      </>
    ),
  },

  BANK_CHANGE: {
    label: 'Bank details',
    icon: Landmark,
    badgeClass: 'bg-violet-50 text-violet-700',
    approve: (id) => bankChangeService.approve(id),
    reject: (id, reason) => bankChangeService.reject(id, reason),
    summary: (req) => (
      <>
        Requests to update bank details
        {req.bank?.name ? (
          <>
            {' '}
            · new bank: <span className="font-medium">{req.bank.name}</span>
          </>
        ) : null}
      </>
    ),
  },
};

export { fmtDate, fmtTimeRange };
