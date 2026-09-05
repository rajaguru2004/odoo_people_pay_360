'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plane,
  Loader2,
  Plus,
  Check,
  X,
  Wallet,
  Globe,
  Receipt,
  Ban,
} from 'lucide-react';
import { toast } from 'sonner';
import PageActionRow from '@/components/common/PageActionRow';
import Pagination from '@/components/common/Pagination';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import travelService from '@/services/travelService';
import libraryService from '@/services/libraryService';
import MasterEmptyHint from '@/components/common/MasterEmptyHint';
import { useAuthStore } from '@/store/authStore';
import {
  CreateTravelRequestData,
  TravelRequest,
  TravelStatus,
  TravelType,
} from '@/types/travel';
import { apiErrorMessage } from '@/utils/apiError';

const STATUS_STYLE: Record<TravelStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700',
  APPROVED: 'bg-emerald-50 text-emerald-700',
  REJECTED: 'bg-red-50 text-red-700',
  CANCELLED: 'bg-slate-100 text-slate-600',
};

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30';

function fmtDate(d?: string | null) {
  if (!d) return '—';
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

function money(v: string | number | null | undefined) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 });
}

const emptyForm: CreateTravelRequestData = {
  purpose: '',
  travelType: 'DOMESTIC',
  destination: '',
  departureDate: '',
  returnDate: '',
  estimatedCost: 0,
};

function TravelPageInner() {
  const { user } = useAuthStore();
  const isApprover = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';
  /**
   * Who may withdraw a trip, mirroring `TravelService.cancel`: the traveller
   * themselves, or ADMIN/HR_MANAGER.
   *
   * The list used to offer Cancel to every role on every row, so a MANAGER —
   * who can reach this screen but is not an approver — was shown a button that
   * always answered "Not permitted to cancel this travel request". A control
   * that exists only to be refused is worse than no control: it reads as a
   * broken screen rather than as a boundary.
   */
  const canCancel = (row: TravelRequest) =>
    isApprover || row.employee?.id === user?.employeeId;

  const [rows, setRows] = useState<TravelRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [status, setStatus] = useState<TravelStatus | ''>('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [destinations, setDestinations] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateTravelRequestData>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { confirm, ConfirmDialog, closeModal } = useConfirm();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Travel',
    'Trip requests, per-diem and advances.',
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await travelService.getAll({
        page,
        limit,
        status: status || undefined,
      });
      setRows(Array.isArray(res.data) ? res.data : []);
      setTotal(res.meta?.total ?? 0);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load travel requests'));
    } finally {
      setLoading(false);
    }
  }, [page, limit, status]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const res = await libraryService.getAll('PER_DIEM_DESTINATION', true);
        setDestinations((res.data || []).map((d: any) => d.label));
      } catch {
        // Non-fatal — the destination picker is just empty.
      }
    })();
  }, []);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / limit)),
    [total, limit],
  );

  const submit = async () => {
    if (!form.purpose.trim() || !form.destination || !form.departureDate || !form.returnDate) {
      toast.warning('Purpose, destination and dates are required');
      return;
    }
    if (form.travelType === 'INTERNATIONAL' && !form.country?.trim()) {
      toast.warning('Country is required for international travel (drives the visa check)');
      return;
    }
    setSaving(true);
    try {
      await travelService.create(form);
      toast.success('Travel request submitted');
      setShowForm(false);
      setForm(emptyForm);
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to submit'));
    } finally {
      setSaving(false);
    }
  };

  const approve = async (row: TravelRequest) => {
    setBusyId(row.id);
    try {
      await travelService.approve(row.id);
      toast.success('Approved — per-diem claim and any advance have been raised');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to approve'));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (row: TravelRequest) => {
    if (!reason.trim()) {
      toast.warning('Please enter a reason');
      return;
    }
    setBusyId(row.id);
    try {
      await travelService.reject(row.id, reason);
      toast.success('Rejected');
      setRejecting(null);
      setReason('');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to reject'));
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (row: TravelRequest) => {
    const ok = await confirm({
      title: 'Cancel travel request',
      message:
        'This also withdraws the expense claims this trip raised. Claims already included in a payroll run are left untouched.',
      type: 'warning',
      confirmText: 'Cancel trip',
    });
    // `confirm()` deliberately leaves the dialog up so the caller can show
    // "Processing…" over its own async work — which means the caller owes it a
    // `closeModal()` on EVERY exit, including the failure one. Omitting it
    // stranded the dialog over the refreshed list forever.
    if (!ok) return;
    try {
      const res = await travelService.cancel(row.id);
      toast.success(res.message || 'Travel request cancelled');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to cancel'));
    } finally {
      // In a `finally`, not on the success path: a refused cancellation leaves
      // the dialog just as stranded as a successful one, and the failure path
      // is the one nobody exercises by hand.
      closeModal();
    }
  };

  return (
    <div className="p-6 space-y-6">
      <PageActionRow
        action={
          <button
            data-testid="travel-new"
            onClick={() => setShowForm((s) => !s)}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white"
          >
            <Plus size={16} /> New trip
          </button>
        }
      />

      {showForm && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">New travel request</h3>
            <button onClick={() => setShowForm(false)} className="text-slate-400">
              <X size={18} />
            </button>
          </div>
          {destinations.length === 0 && (
            <MasterEmptyHint what="travel destinations" className="mb-3" />
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <input
              data-testid="travel-purpose"
              className={`${inputCls} md:col-span-3`}
              placeholder="Purpose of travel"
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
            />
            <select
              data-testid="travel-type"
              className={inputCls}
              value={form.travelType}
              onChange={(e) =>
                setForm({ ...form, travelType: e.target.value as TravelType })
              }
            >
              <option value="DOMESTIC">Domestic</option>
              <option value="INTERNATIONAL">International</option>
            </select>
            <select
              data-testid="travel-destination"
              className={inputCls}
              value={form.destination}
              onChange={(e) => setForm({ ...form, destination: e.target.value })}
              disabled={destinations.length === 0}
            >
              <option value="">
                {destinations.length === 0
                  ? 'No destinations configured'
                  : 'Destination…'}
              </option>
              {destinations.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            {form.travelType === 'INTERNATIONAL' && (
              <input
                data-testid="travel-country"
                className={inputCls}
                placeholder="Country (drives the visa check)"
                value={form.country ?? ''}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
              />
            )}
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              Departure
              <input
                data-testid="travel-departure"
                type="date"
                className={inputCls}
                value={form.departureDate}
                onChange={(e) => setForm({ ...form, departureDate: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              Return
              <input
                data-testid="travel-return"
                type="date"
                className={inputCls}
                value={form.returnDate}
                onChange={(e) => setForm({ ...form, returnDate: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              Estimated cost
              <input
                data-testid="travel-cost"
                type="number"
                min={0}
                className={inputCls}
                value={form.estimatedCost}
                onChange={(e) =>
                  setForm({ ...form, estimatedCost: Number(e.target.value) })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              Cash advance (optional) — recovered via the loans ledger
              <input
                data-testid="travel-advance"
                type="number"
                min={0}
                className={inputCls}
                value={form.advanceAmount ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    advanceAmount: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
              />
            </label>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            On approval the per-diem for this destination becomes an ordinary
            expense claim, paid through the normal payroll run.
          </p>
          <div className="mt-4 flex justify-end">
            <button
              data-testid="travel-submit"
              onClick={submit}
              disabled={saving}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Submit
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <select
          data-testid="travel-filter-status"
          className={`${inputCls} !w-auto`}
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value as TravelStatus | '');
          }}
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_STYLE) as TravelStatus[]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid="travel-empty"
          className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm"
        >
          No travel requests.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const busy = busyId === row.id;
            return (
              <div
                key={row.id}
                data-testid="travel-row"
                data-travel-id={row.id}
                data-status={row.status}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Plane size={15} className="text-brand-primary" />
                      <p className="text-sm font-semibold text-slate-800">
                        {row.destination}
                      </p>
                      {row.travelType === 'INTERNATIONAL' && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-700">
                          <Globe size={11} /> {row.country || 'International'}
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[row.status]}`}
                      >
                        {row.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {row.employee?.fullName} ({row.employee?.employeeCode}) ·{' '}
                      {fmtDate(row.departureDate)} → {fmtDate(row.returnDate)}
                    </p>
                    <p className="mt-1 text-sm text-slate-700">{row.purpose}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                      <span>Estimated {money(row.estimatedCost)}</span>
                      {row.perDiemRate && (
                        <span className="inline-flex items-center gap-1">
                          <Receipt size={11} /> Per diem {money(row.perDiemRate)} ×{' '}
                          {row.perDiemDays} day(s)
                        </span>
                      )}
                      {row.advanceLoanId && (
                        <span className="inline-flex items-center gap-1 text-amber-700">
                          <Wallet size={11} /> Advance {money(row.advanceAmount)} in
                          loans ledger
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {row.status === 'PENDING' && isApprover && (
                      <>
                        <button
                          data-testid="travel-approve"
                          onClick={() => approve(row)}
                          disabled={busy}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {busy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check size={14} />
                          )}
                          Approve
                        </button>
                        <button
                          data-testid="travel-reject"
                          onClick={() =>
                            setRejecting(rejecting === row.id ? null : row.id)
                          }
                          disabled={busy}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          <X size={14} /> Reject
                        </button>
                      </>
                    )}
                    {['PENDING', 'APPROVED'].includes(row.status) &&
                      canCancel(row) && (
                      <button
                        data-testid="travel-cancel"
                        onClick={() => cancel(row)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
                      >
                        <Ban size={14} /> Cancel
                      </button>
                    )}
                  </div>
                </div>

                {rejecting === row.id && (
                  <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                    <input
                      data-testid="travel-reject-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason for rejection…"
                      className={inputCls}
                    />
                    <button
                      data-testid="travel-reject-confirm"
                      onClick={() => reject(row)}
                      disabled={busy}
                      className="inline-flex h-9 shrink-0 items-center rounded-lg bg-red-600 px-3 text-sm font-medium text-white disabled:opacity-50"
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

      {total > 0 && (
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={total}
          itemsPerPage={limit}
          onPageChange={setPage}
          onItemsPerPageChange={(n) => {
            setLimit(n);
            setPage(1);
          }}
        />
      )}

      <ConfirmDialog />
    </div>
  );
}

export default function TravelPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <TravelPageInner />
    </ProtectedRoute>
  );
}
