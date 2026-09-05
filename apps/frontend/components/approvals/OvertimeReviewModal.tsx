'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Loader2, X } from 'lucide-react';
import overtimeService from '@/services/overtimeService';
import approvalWorkflowService, {
  ApprovalTrail,
} from '@/services/approvalWorkflowService';
import { apiErrorMessage } from '@/utils/apiError';
import { formatCurrency, formatWallClockDate } from '@/utils/formatters';
import { useBrandingStore } from '@/store/brandingStore';
import type {
  ApproveOvertimeData,
  Overtime,
  OvertimeServerPreview,
  OtType,
} from '@/types/overtime';

/**
 * Review an overtime request in full, correct it, and approve.
 *
 * Why a shared component rather than one modal per screen: the inbox and the
 * overtime detail page BOTH approve overtime, and a correction offered on one
 * and not the other is a screen that quietly refuses a supported action. Both
 * mount this.
 *
 * Why the figures come from the server on every keystroke: the browser can only
 * read the GLOBAL overtime settings. It cannot see the employee's Overtime
 * Policy or the branch-aware rest-day/holiday classification, so a local
 * recompute would show an approver hours, a tier and an allowance that the
 * payslip then disagrees with — the same reason the detail endpoint grew a
 * server-side `preview`.
 *
 * Times are tz-naive wall-clock tagged `Z`. They are read and written in UTC
 * throughout, so what the employee typed is what the approver sees and what the
 * approver types is what is stored. Rendering them in the viewer's local zone
 * would shift every request by the browser's offset.
 */

const OT_TYPE_LABEL: Record<OtType, string> = {
  REGULAR: 'Regular',
  LATE: 'Late',
  DOUBLE: 'Double',
  DOUBLE_LATE: 'Double late',
};

const OT_TYPE_CLASS: Record<OtType, string> = {
  REGULAR: 'bg-brand-primary/10 text-brand-primary',
  LATE: 'bg-amber-50 text-amber-700',
  DOUBLE: 'bg-red-50 text-red-700',
  DOUBLE_LATE: 'bg-red-50 text-red-700',
};

const num = (v: unknown) => Number(v ?? 0) || 0;

/** `...T18:30:00.000Z` → `18:30`, for an `<input type="time">`. */
export function toTimeInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(
    d.getUTCMinutes(),
  ).padStart(2, '0')}`;
}

/**
 * `18:30` back onto the request's own calendar date, tagged `Z`.
 *
 * The DATE comes from the original start time, never from the end time: an
 * overnight shift is filed with both stamps on the same calendar day and the
 * server reads an end at or before the start as crossing midnight. Anchoring
 * the end to its own day would turn a corrected 01:00 into a window that ran
 * backwards.
 */
export function fromTimeInput(anchorIso: string, hhmm: string): string {
  const d = new Date(anchorIso);
  const [h, m] = hhmm.split(':').map(Number);
  return `${d.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:${String(
    m,
  ).padStart(2, '0')}:00.000Z`;
}

export interface OvertimeReviewModalProps {
  /** The request as the inbox or the detail page already has it. */
  request: Overtime;
  onClose(): void;
  /**
   * Perform the decision. The inbox routes this through its own kind registry
   * so one busy/refresh path serves every request type.
   */
  onApprove(payload: ApproveOvertimeData): Promise<void>;
  onReject(reason: string): Promise<void>;
}

export default function OvertimeReviewModal({
  request,
  onClose,
  onApprove,
  onReject,
}: OvertimeReviewModalProps) {
  const { branding } = useBrandingStore();
  const editable = branding?.overtime_approver_edit_enabled !== false;
  const siteAllowanceEnabled = !!branding?.overtime_site_allowance_enabled;
  const siteAllowanceMax = num(branding?.overtime_site_allowance_max);

  // The window, as `<input type="time">` values.
  const [startAt, setStartAt] = useState(() => toTimeInput(request.startTime));
  const [endAt, setEndAt] = useState(() => toTimeInput(request.endTime));

  // Food allowance: `null` means "leave it to the policy". The checkbox is what
  // distinguishes that from an explicit 0, which the server treats as a real
  // instruction to pay nothing.
  const [foodOverride, setFoodOverride] = useState<string | null>(() =>
    request.foodAllowanceOverride === null ||
    request.foodAllowanceOverride === undefined
      ? null
      : String(request.foodAllowanceOverride),
  );

  const [siteOn, setSiteOn] = useState(() => num(request.siteAllowance) > 0);
  const [siteAmount, setSiteAmount] = useState(() =>
    num(request.siteAllowance) > 0 ? String(request.siteAllowance) : '',
  );
  const [siteNote, setSiteNote] = useState(request.siteAllowanceNote ?? '');
  const [approverNote, setApproverNote] = useState(request.approverNote ?? '');

  const [preview, setPreview] = useState<OvertimeServerPreview | null>(
    request.preview ?? null,
  );
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [trail, setTrail] = useState<ApprovalTrail | null>(null);

  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const startIso = request.startTime;

  /** Only the fields that actually differ from what is stored. */
  const edits = useMemo<ApproveOvertimeData>(() => {
    const out: ApproveOvertimeData = {};
    if (!editable) return out;

    const nextStart = startAt ? fromTimeInput(startIso, startAt) : undefined;
    const nextEnd = endAt ? fromTimeInput(startIso, endAt) : undefined;
    if (nextStart && nextStart !== new Date(request.startTime).toISOString()) {
      out.startTime = nextStart;
    }
    if (nextEnd && nextEnd !== new Date(request.endTime).toISOString()) {
      out.endTime = nextEnd;
    }

    const storedOverride =
      request.foodAllowanceOverride === null ||
      request.foodAllowanceOverride === undefined
        ? null
        : String(request.foodAllowanceOverride);
    if (foodOverride !== storedOverride && foodOverride !== null) {
      out.foodAllowance = num(foodOverride);
    }

    if (siteAllowanceEnabled) {
      const nextSite = siteOn ? num(siteAmount) : 0;
      if (nextSite !== num(request.siteAllowance)) out.siteAllowance = nextSite;
      const nextNote = siteOn ? siteNote.trim() : '';
      if (nextNote !== (request.siteAllowanceNote ?? '')) {
        out.siteAllowanceNote = nextNote;
      }
    }

    if (approverNote.trim() !== (request.approverNote ?? '')) {
      out.approverNote = approverNote.trim();
    }
    return out;
  }, [
    editable,
    startAt,
    endAt,
    startIso,
    foodOverride,
    siteOn,
    siteAmount,
    siteNote,
    approverNote,
    siteAllowanceEnabled,
    request,
  ]);

  const hasEdits = Object.keys(edits).length > 0;

  /**
   * Client-side mirror of the server's ceiling rule, so the approver is told
   * before they submit rather than by a 400. `0` means no ceiling.
   */
  const siteError =
    siteOn && siteAllowanceMax > 0 && num(siteAmount) > siteAllowanceMax
      ? `Site allowance cannot exceed ${formatCurrency(siteAllowanceMax)}`
      : siteOn && num(siteAmount) < 0
        ? 'Site allowance cannot be negative'
        : null;

  // Escape closes, as the confirm dialog this screen replaced did — but never
  // mid-decision, where it would hide a request whose outcome is not yet known.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  useEffect(() => {
    approvalWorkflowService
      .trail('OVERTIME', request.id)
      .then((res) => setTrail(res.data ?? null))
      .catch(() => setTrail(null));
  }, [request.id]);

  // Debounced dry run. The timer is cleared on every change so a fast typist
  // makes one request, not one per keystroke.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runPreview = useCallback(
    async (payload: ApproveOvertimeData) => {
      setPreviewing(true);
      setPreviewError(null);
      try {
        const res = await overtimeService.editPreview(request.id, payload);
        setPreview(res.data ?? null);
      } catch (e) {
        // The request stays valid on screen; only the figures are unknown.
        setPreviewError(apiErrorMessage(e, 'Could not price this correction'));
      } finally {
        setPreviewing(false);
      }
    },
    [request.id],
  );

  useEffect(() => {
    if (!hasEdits) {
      setPreview(request.preview ?? null);
      setPreviewError(null);
      return;
    }
    if (siteError) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runPreview(edits), 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [edits, hasEdits, siteError, runPreview, request.preview]);

  const submit = async () => {
    if (siteError) return;
    setBusy(true);
    setError(null);
    try {
      await onApprove({
        ...edits,
        // Concurrency guard: two approvers can hold the same request open.
        expectedUpdatedAt: request.updatedAt,
      });
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to approve'));
    } finally {
      setBusy(false);
    }
  };

  const submitReject = async () => {
    if (!rejectReason.trim()) {
      setError('Please enter a reason');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onReject(rejectReason.trim());
    } catch (e) {
      setError(apiErrorMessage(e, 'Failed to reject'));
    } finally {
      setBusy(false);
    }
  };

  const otType = (preview?.otType ?? request.otType ?? 'REGULAR') as OtType;
  const food = num(preview?.foodAllowance ?? request.foodAllowance);
  const site = siteOn ? num(siteAmount) : 0;

  const tier = (
    label: string,
    hours: number,
    rate: number | undefined,
    key: string,
  ) =>
    hours > 0 ? (
      <div key={key}>
        <p className="text-xs text-slate-500">
          {label}
          {rate ? ` · ${rate}×` : ''}
        </p>
        <p
          data-testid="ot-review-tier"
          data-tier={key}
          data-hours={hours}
          className="mt-0.5 text-sm font-semibold text-slate-800"
        >
          {hours}h
        </p>
      </div>
    ) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div
        data-testid="ot-review-modal"
        data-request-id={request.id}
        className="my-8 w-full max-w-2xl rounded-2xl bg-white shadow-xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Overtime request
              </h2>
              <p className="text-sm text-slate-500">
                {request.employee?.fullName ?? 'Employee'}
                {request.employee?.employeeCode
                  ? ` · ${request.employee.employeeCode}`
                  : ''}
                {request.employee?.department?.name
                  ? ` · ${request.employee.department.name}`
                  : ''}
              </p>
            </div>
          </div>
          <button
            data-testid="ot-review-close"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-600"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* ── The request as filed ──────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-4 rounded-xl bg-slate-50 p-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-slate-500">Date</p>
              <p
                data-testid="ot-review-date"
                className="mt-0.5 text-sm font-semibold text-slate-800"
              >
                {formatWallClockDate(request.date)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Worked</p>
              <p
                data-testid="ot-review-window"
                className="mt-0.5 text-sm font-semibold text-slate-800"
              >
                {toTimeInput(request.startTime)} – {toTimeInput(request.endTime)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Hours</p>
              <p
                data-testid="ot-review-hours"
                data-hours={num(preview?.hours ?? request.hours)}
                className="mt-0.5 text-sm font-semibold text-slate-800"
              >
                {num(preview?.hours ?? request.hours)}h
              </p>
            </div>
          </div>

          {request.reason ? (
            <div>
              <p className="text-xs text-slate-500">Reason given</p>
              <p className="mt-1 whitespace-pre-wrap text-sm italic text-slate-600">
                “{request.reason}”
              </p>
            </div>
          ) : null}

          {/* The employee's original window, once an approver has moved it. */}
          {request.originalStartTime && request.originalEndTime ? (
            <p
              data-testid="ot-review-original"
              className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              Filed as {toTimeInput(request.originalStartTime)} –{' '}
              {toTimeInput(request.originalEndTime)} and corrected since.
            </p>
          ) : null}

          {/* ── Correcting the window ─────────────────────────────────── */}
          {editable ? (
            <div className="space-y-3 rounded-xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-800">
                Correct the worked window
              </p>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-slate-500">From</span>
                  <input
                    data-testid="ot-review-start"
                    type="time"
                    value={startAt}
                    onChange={(e) => setStartAt(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500">To</span>
                  <input
                    data-testid="ot-review-end"
                    type="time"
                    value={endAt}
                    onChange={(e) => setEndAt(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none"
                  />
                </label>
              </div>
              <p className="text-xs text-slate-400">
                Hours are recalculated from the window — an end before the start
                is read as crossing midnight.
              </p>
            </div>
          ) : null}

          {/* ── What it pays ──────────────────────────────────────────── */}
          <div
            data-testid="ot-review-breakdown"
            data-ot-type={otType}
            data-food-allowance={food}
            data-site-allowance={site}
            className="space-y-3 rounded-xl border border-slate-200 p-4"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-800">
                Payable breakdown
              </p>
              <div className="flex items-center gap-2">
                {previewing ? (
                  <Loader2
                    data-testid="ot-review-pricing"
                    className="h-4 w-4 animate-spin text-slate-400"
                  />
                ) : null}
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${OT_TYPE_CLASS[otType]}`}
                >
                  {OT_TYPE_LABEL[otType]}
                </span>
              </div>
            </div>

            {previewError ? (
              <p
                data-testid="ot-review-preview-error"
                className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"
              >
                {previewError}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {tier(
                'Regular',
                num(preview?.regularHours),
                preview?.regularRate,
                'regular',
              )}
              {tier('Late', num(preview?.lateHours), preview?.lateRate, 'late')}
              {tier(
                'Double',
                num(preview?.doubleHours),
                preview?.doubleRate,
                'double',
              )}
              {tier(
                'Double late',
                num(preview?.doubleLateHours),
                preview?.doubleLateRate,
                'doubleLate',
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3">
              <div>
                <p className="text-xs text-slate-500">Food allowance</p>
                <p
                  data-testid="ot-review-food-value"
                  className={`mt-0.5 text-sm font-semibold ${food > 0 ? 'text-emerald-700' : 'text-slate-400'}`}
                >
                  {food > 0 ? formatCurrency(food) : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Site allowance</p>
                <p
                  data-testid="ot-review-site-value"
                  className={`mt-0.5 text-sm font-semibold ${site > 0 ? 'text-emerald-700' : 'text-slate-400'}`}
                >
                  {site > 0 ? formatCurrency(site) : '—'}
                </p>
              </div>
            </div>

            {preview?.policyName ? (
              <p className="text-xs text-slate-400">
                Priced under {preview.policyName}.
              </p>
            ) : null}
          </div>

          {/* ── Allowances the approver controls ──────────────────────── */}
          {editable ? (
            <div className="space-y-4 rounded-xl border border-slate-200 p-4">
              <label className="flex items-start gap-2.5">
                <input
                  data-testid="ot-review-food-toggle"
                  type="checkbox"
                  checked={foodOverride !== null}
                  onChange={(e) =>
                    setFoodOverride(
                      e.target.checked ? String(num(preview?.foodAllowance)) : null,
                    )
                  }
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span className="text-sm text-slate-700">
                  Set the food allowance by hand
                  <span className="block text-xs text-slate-400">
                    Otherwise the overtime policy decides it from the window.
                  </span>
                </span>
              </label>
              {foodOverride !== null ? (
                <input
                  data-testid="ot-review-food"
                  type="number"
                  min={0}
                  step="0.01"
                  value={foodOverride}
                  onChange={(e) => setFoodOverride(e.target.value)}
                  className="h-9 w-40 rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none"
                />
              ) : null}

              {siteAllowanceEnabled ? (
                <div className="border-t border-slate-100 pt-4">
                  <label className="flex items-start gap-2.5">
                    <input
                      data-testid="ot-review-site-toggle"
                      type="checkbox"
                      checked={siteOn}
                      onChange={(e) => setSiteOn(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    <span className="text-sm text-slate-700">
                      Add a site allowance
                      <span className="block text-xs text-slate-400">
                        For site activity that warrants extra pay on this
                        request.
                        {siteAllowanceMax > 0
                          ? ` Up to ${formatCurrency(siteAllowanceMax)}.`
                          : ''}
                      </span>
                    </span>
                  </label>
                  {siteOn ? (
                    <div className="mt-3 space-y-2">
                      <input
                        data-testid="ot-review-site-amount"
                        type="number"
                        min={0}
                        step="0.01"
                        value={siteAmount}
                        onChange={(e) => setSiteAmount(e.target.value)}
                        placeholder="Amount"
                        className="h-9 w-40 rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none"
                      />
                      <input
                        data-testid="ot-review-site-note"
                        value={siteNote}
                        onChange={(e) => setSiteNote(e.target.value)}
                        maxLength={500}
                        placeholder="Why this site allowance…"
                        className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none"
                      />
                      {siteError ? (
                        <p
                          data-testid="ot-review-site-error"
                          className="text-xs text-red-600"
                        >
                          {siteError}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="border-t border-slate-100 pt-4">
                <label className="block">
                  <span className="text-xs text-slate-500">
                    Note for the record
                  </span>
                  <input
                    data-testid="ot-review-note"
                    value={approverNote}
                    onChange={(e) => setApproverNote(e.target.value)}
                    maxLength={500}
                    placeholder="Why you changed this request…"
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none"
                  />
                </label>
              </div>
            </div>
          ) : null}

          {/* ── Approval trail ────────────────────────────────────────── */}
          {trail?.engaged ? (
            <div data-testid="ot-review-trail" className="space-y-2">
              <p className="text-sm font-semibold text-slate-800">
                Approval progress
              </p>
              <ol className="space-y-1">
                {trail.steps.map((s) => (
                  <li
                    key={s.stepOrder}
                    data-testid="ot-review-trail-step"
                    data-step-order={s.stepOrder}
                    data-step-status={s.status}
                    className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs"
                  >
                    <span className="text-slate-600">
                      Step {s.stepOrder} · {s.approverType}
                    </span>
                    <span className="font-medium text-slate-500">
                      {s.status}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {error ? (
            <p
              data-testid="ot-review-error"
              className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </p>
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 p-5">
          {rejecting ? (
            <div className="flex w-full items-center gap-2">
              <input
                data-testid="ot-review-reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason for rejection…"
                className="h-9 flex-1 rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none"
              />
              <button
                data-testid="ot-review-reject-confirm"
                onClick={submitReject}
                disabled={busy}
                className="h-9 rounded-lg bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Confirm reject
              </button>
            </div>
          ) : (
            <>
              <button
                data-testid="ot-review-reject-open"
                onClick={() => setRejecting(true)}
                disabled={busy}
                className="h-9 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Reject
              </button>
              <button
                data-testid="ot-review-approve"
                onClick={submit}
                disabled={busy || !!siteError}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {hasEdits ? 'Save changes & approve' : 'Approve'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
