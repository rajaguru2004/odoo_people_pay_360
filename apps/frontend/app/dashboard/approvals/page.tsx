'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Check, X, Eye } from 'lucide-react';
import { toast } from 'sonner';
import approvalWorkflowService, {
  ApprovalInboxItem,
} from '@/services/approvalWorkflowService';
import { APPROVAL_KIND_UI } from '@/lib/approvalKinds';
import OvertimeReviewModal from '@/components/approvals/OvertimeReviewModal';
import type { ApproveOvertimeData, Overtime } from '@/types/overtime';
import { apiErrorMessage } from '@/utils/apiError';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function ApprovalsPage() {
  const [items, setItems] = useState<ApprovalInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // The request being reviewed in full. Only kinds that declare `reviewable`
  // open one; the rest keep the one-click card actions they have always had.
  const [reviewing, setReviewing] = useState<ApprovalInboxItem | null>(null);
  /**
   * Which half of the screen is showing. The queue answers "what needs me"; the
   * record answers "what did I decide" — the inbox drops a row the instant it
   * is acted on, so without the second tab an approver's own decisions, and any
   * correction they made, were simply gone.
   */
  const [tab, setTab] = useState<'pending' | 'decided'>('pending');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Approvals',
    tab === 'decided'
      ? 'Requests you have already decided'
      : 'Requests awaiting your decision',
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res =
        tab === 'decided'
          ? await approvalWorkflowService.history()
          : await approvalWorkflowService.inbox();
      setItems(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      toast.error(
        apiErrorMessage(
          e,
          tab === 'decided'
            ? 'Failed to load decided requests'
            : 'Failed to load approvals',
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * `payload` carries an approver's corrections when the decision came from the
   * review modal. Sent through the kind registry rather than straight to the
   * service so one busy/refresh path still serves every request type — and so
   * the card's fast path (no payload) and the modal cannot diverge.
   */
  const approve = async (item: ApprovalInboxItem, payload?: unknown) => {
    const kind = APPROVAL_KIND_UI[item.requestType];
    if (!kind) {
      toast.error(`Unsupported request type: ${item.requestType}`);
      return;
    }
    setBusyId(item.requestId);
    try {
      await kind.approve(item.requestId, payload);
      toast.success('Approved');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || 'Failed to approve');
      // Rethrown so the review modal keeps itself open on the refusal — the
      // approver's typed corrections are still on screen to fix.
      throw e;
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (item: ApprovalInboxItem, explicitReason?: string) => {
    const text = (explicitReason ?? reason).trim();
    if (!text) {
      toast.warning('Please enter a reason');
      return;
    }
    const kind = APPROVAL_KIND_UI[item.requestType];
    if (!kind) {
      toast.error(`Unsupported request type: ${item.requestType}`);
      return;
    }
    setBusyId(item.requestId);
    try {
      await kind.reject(item.requestId, text);
      toast.success('Rejected');
      setRejecting(null);
      setReason('');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || 'Failed to reject');
      throw e;
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-4 md:p-6" data-testid="ess-approvals">
      {/* The title/subtitle live in the sticky TopHeader, declared via
          usePageHeader above. */}

      {/* Two lists, one screen. Merging them would bury what still needs a
          decision, which is this screen's first job. */}
      <div className="mb-4 flex items-center gap-2">
        {(
          [
            ['pending', 'Awaiting me'],
            ['decided', 'Decided by me'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            data-testid={`approval-tab-${value}`}
            data-active={tab === value}
            onClick={() => setTab(value)}
            className={`min-w-11 h-11 md:h-9 rounded-full px-4 text-sm font-medium transition-colors touch-manipulation ${
              tab === value
                ? 'bg-brand-primary/10 text-brand-primary'
                : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> <span data-testid="approval-loading">Loading…</span>
        </div>
      ) : items.length === 0 ? (
        // An empty QUEUE is good news; an empty RECORD means "you have decided
        // nothing yet". One message for both would say the wrong thing on one.
        <div
          data-testid={tab === 'decided' ? 'approval-decided-empty' : 'approval-empty'}
          className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm"
        >
          {tab === 'decided' ? 'Nothing decided yet.' : 'No pending approvals.'}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const req = item.request || {};
            const emp = req.employee || {};
            const kind = APPROVAL_KIND_UI[item.requestType];
            const KindIcon = kind?.icon;
            const busy = busyId === item.requestId;
            return (
              <div
                key={`${item.requestType}-${item.requestId}`}
                data-testid="approval-row"
                data-request-type={item.requestType}
                data-request-id={item.requestId}
                data-step-order={item.stepOrder}
                data-approver-type={item.approverType}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-primary/10 text-sm font-bold text-brand-primary">
                      {emp.fullName?.charAt(0) || '?'}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-slate-800">
                          {emp.fullName || 'Employee'}
                        </p>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${kind?.badgeClass ?? 'bg-slate-100 text-slate-600'}`}
                        >
                          {KindIcon ? <KindIcon size={11} /> : null}
                          {kind?.label ?? item.requestType}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                          Step {item.stepOrder} · {item.approverType}
                        </span>
                        {/* What THIS user did. Not the request's status: a
                            step-1 approval leaves it PENDING behind them. */}
                        {item.decision ? (
                          <span
                            data-testid="approval-decision"
                            data-decision={item.decision}
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              item.decision === 'APPROVED'
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-red-50 text-red-700'
                            }`}
                          >
                            {item.decision === 'APPROVED'
                              ? 'You approved'
                              : 'You rejected'}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {emp.employeeCode}
                        {emp.department?.name ? ` · ${emp.department.name}` : ''}
                      </p>
                      <p className="mt-2 text-sm text-slate-700">
                        {kind?.summary(req)}
                      </p>
                      {req.reason && (
                        <p className="mt-1 text-xs italic text-slate-500">
                          “{req.reason}”
                        </p>
                      )}
                      {item.decidedAt ? (
                        <p
                          data-testid="approval-decided-at"
                          className="mt-1 text-xs text-slate-400"
                        >
                          Decided{' '}
                          {new Date(item.decidedAt).toLocaleDateString('en-GB')}
                          {item.comment ? ` · “${item.comment}”` : ''}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* A settled row is a RECORD, not a control: the server
                        refuses a decision on it, and a dead button is worse
                        than no button. */}
                    {item.decision && kind?.reviewable ? (
                      <button
                        data-testid="approval-details"
                        onClick={() => setReviewing(item)}
                        className="inline-flex h-11 md:h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
                      >
                        <Eye size={14} /> View full request
                      </button>
                    ) : item.decision ? null : (
                      <>
                    {kind?.reviewable ? (
                      <button
                        data-testid="approval-details"
                        onClick={() => setReviewing(item)}
                        disabled={busy}
                        className="inline-flex h-11 md:h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        <Eye size={14} /> View details
                      </button>
                    ) : null}
                    <button
                      data-testid="approval-approve"
                      onClick={() => approve(item)}
                      disabled={busy}
                      className="inline-flex h-11 md:h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check size={14} />
                      )}
                      Approve
                    </button>
                    <button
                      data-testid="approval-reject-open"
                      onClick={() =>
                        setRejecting(
                          rejecting === item.requestId ? null : item.requestId,
                        )
                      }
                      disabled={busy}
                      className="inline-flex h-11 md:h-9 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      <X size={14} /> Reject
                    </button>
                      </>
                    )}
                  </div>
                </div>

                {rejecting === item.requestId && !item.decision && (
                  <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                    <input
                      data-testid="approval-reject-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason for rejection…"
                      className="h-11 md:h-9 flex-1 rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                    />
                    <button
                      data-testid="approval-reject-confirm"
                      onClick={() => reject(item)}
                      disabled={busy}
                      className="inline-flex h-11 md:h-9 items-center gap-1.5 rounded-lg bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      Confirm reject
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {reviewing && reviewing.requestType === 'OVERTIME' ? (
        <OvertimeReviewModal
          request={reviewing.request as Overtime}
          onClose={() => setReviewing(null)}
          onApprove={async (payload: ApproveOvertimeData) => {
            await approve(reviewing, payload);
            setReviewing(null);
          }}
          onReject={async (r: string) => {
            await reject(reviewing, r);
            setReviewing(null);
          }}
        />
      ) : null}
    </div>
  );
}
