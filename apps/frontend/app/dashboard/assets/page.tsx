'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Loader2,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Undo2,
  ShieldAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import PageActionRow from '@/components/common/PageActionRow';
import Pagination from '@/components/common/Pagination';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import { usePermission } from '@/hooks/usePermission';
import { apiErrorMessage } from '@/utils/apiError';
import assetService from '@/services/assetService';
import branchService from '@/services/branchService';
import employeeService from '@/services/employeeService';
import libraryService from '@/services/libraryService';
import MasterEmptyHint from '@/components/common/MasterEmptyHint';
import {
  AssetItem,
  AssetReturnStatus,
  AssetStatus,
  AssetSummary,
  CreateAssetData,
} from '@/types/asset';

const STATUS_STYLE: Record<AssetStatus, string> = {
  AVAILABLE: 'bg-emerald-50 text-emerald-700',
  ASSIGNED: 'bg-blue-50 text-blue-700',
  IN_REPAIR: 'bg-amber-50 text-amber-700',
  LOST: 'bg-red-50 text-red-700',
  RETIRED: 'bg-slate-100 text-slate-600',
};

const RETURN_STATUSES: AssetReturnStatus[] = [
  'AVAILABLE',
  'IN_REPAIR',
  'LOST',
  'RETIRED',
];

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

function StatTile({
  label,
  value,
  icon: Icon,
  emphasis,
  testId,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  emphasis?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      // The tile renders a formatted figure; the raw number is published
      // beside it so a test never has to parse the rendering.
      data-value={value}
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
        <Icon size={14} /> {label}
      </div>
      <p
        className={`mt-1 text-2xl font-bold ${emphasis ? 'text-amber-600' : 'text-slate-900'}`}
      >
        {value}
      </p>
    </div>
  );
}

const emptyForm: CreateAssetData = {
  assetTag: '',
  category: '',
  name: '',
  branchId: '',
};

function AssetsPageInner() {
  const [rows, setRows] = useState<AssetItem[]>([]);
  const [summary, setSummary] = useState<AssetSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AssetStatus | ''>('');

  const [categories, setCategories] = useState<string[]>([]);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [employees, setEmployees] = useState<
    { id: string; fullName: string; employeeCode: string }[]
  >([]);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateAssetData>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [assignFor, setAssignFor] = useState<AssetItem | null>(null);
  const [assignEmployeeId, setAssignEmployeeId] = useState('');
  const [conditionOut, setConditionOut] = useState('');

  const [returnFor, setReturnFor] = useState<AssetItem | null>(null);
  const [conditionIn, setConditionIn] = useState('');
  const [returnStatus, setReturnStatus] = useState<AssetReturnStatus>('AVAILABLE');

  const { confirm, ConfirmDialog } = useConfirm();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Asset Register',
    'Who holds what — and whether they can leave without returning it',
  );

  /**
   * Role projection (R74). `<ProtectedRoute>` admits ADMIN, HR_MANAGER and
   * MANAGER, and every one of them may READ the register — but the server's
   * write matrix is narrower than that, and the screen used to offer all four
   * controls to all three roles (plan §6.1):
   *
   *   POST /assets, POST /assets/assignments, .../return  → ADMIN, HR_MANAGER
   *   DELETE /assets/:id                                   → ADMIN only
   *   GET  /assets/summary                                 → ADMIN, HR_MANAGER
   *
   * A control a caller cannot use is not drawn, rather than drawn and then
   * refused — a 403 the user only meets after committing to the action tells
   * them nothing about which of the things on screen were ever theirs.
   */
  const { isAdmin, isRole } = usePermission();
  const canWriteAssets = isAdmin() || isRole('HR_MANAGER');
  const canDeleteAssets = isAdmin();
  const canReadSummary = canWriteAssets;
  const showActions = canWriteAssets || canDeleteAssets;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await assetService.getAll({
        page,
        limit,
        search: search.trim() || undefined,
        status: status || undefined,
      });
      setRows(Array.isArray(res.data) ? res.data : []);
      setTotal(res.meta?.total ?? 0);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load assets'));
    } finally {
      setLoading(false);
    }
  }, [page, limit, search, status]);

  const loadSummary = useCallback(async () => {
    /**
     * R75. `GET /assets/summary` is ADMIN/HR only. The catch below keeps a
     * decorative failure from blanking the table, but it cannot un-fire what
     * has already happened upstream: `lib/axios.ts` calls
     * `triggerPermissionError()` from the response interceptor, which runs
     * before any caller sees the rejection and knows nothing about the
     * caller's intent. The result was a full-page, pointer-event-eating
     * "Access Denied" dialog over a register the MANAGER is entitled to read.
     *
     * Fixed by not asking a question this role may not ask, rather than by
     * weakening the modal — a genuine denial must still raise it.
     */
    if (!canReadSummary) {
      setSummary(null);
      return;
    }
    try {
      const res = await assetService.getSummary();
      setSummary(res.data);
    } catch {
      // Summary is decorative — a failure here must not blank the table.
    }
  }, [canReadSummary]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  // Reference data for the forms, loaded once.
  useEffect(() => {
    (async () => {
      try {
        const [cats, brs, emps] = await Promise.all([
          libraryService.getAll('ASSET_CATEGORY', true),
          branchService.getAll(),
          employeeService.getDirectory(),
        ]);
        setCategories((cats.data || []).map((c: any) => c.label));
        setBranches((brs.data || []).map((b: any) => ({ id: b.id, name: b.name })));
        setEmployees(
          (emps.data || []).map((e: any) => ({
            id: e.id,
            fullName: e.fullName,
            employeeCode: e.employeeCode,
          })),
        );
      } catch {
        // Non-fatal: the register still renders, the pickers are just empty.
      }
    })();
  }, []);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / limit)),
    [total, limit],
  );

  const submitCreate = async () => {
    if (!form.assetTag.trim() || !form.name.trim() || !form.category || !form.branchId) {
      toast.warning('Tag, name, category and branch are required');
      return;
    }
    setSaving(true);
    try {
      await assetService.create({
        ...form,
        assetTag: form.assetTag.trim(),
        name: form.name.trim(),
      });
      toast.success('Asset added');
      setShowForm(false);
      setForm(emptyForm);
      await Promise.all([load(), loadSummary()]);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to add asset'));
    } finally {
      setSaving(false);
    }
  };

  const submitAssign = async () => {
    if (!assignFor || !assignEmployeeId) {
      toast.warning('Pick an employee');
      return;
    }
    setSaving(true);
    try {
      await assetService.assign({
        assetId: assignFor.id,
        employeeId: assignEmployeeId,
        conditionOut: conditionOut.trim() || undefined,
      });
      toast.success('Asset assigned');
      setAssignFor(null);
      setAssignEmployeeId('');
      setConditionOut('');
      await Promise.all([load(), loadSummary()]);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to assign'));
    } finally {
      setSaving(false);
    }
  };

  const submitReturn = async () => {
    if (!returnFor?.currentHolder) return;
    setSaving(true);
    try {
      await assetService.returnAsset(returnFor.currentHolder.assignmentId, {
        conditionIn: conditionIn.trim() || undefined,
        assetStatus: returnStatus,
      });
      toast.success('Return recorded');
      setReturnFor(null);
      setConditionIn('');
      setReturnStatus('AVAILABLE');
      await Promise.all([load(), loadSummary()]);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to record return'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (asset: AssetItem) => {
    const ok = await confirm({
      title: 'Delete asset',
      message: `Delete ${asset.name} (${asset.assetTag})? Its custody history is deleted with it.`,
      type: 'danger',
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      await assetService.delete(asset.id);
      toast.success('Asset deleted');
      await Promise.all([load(), loadSummary()]);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to delete'));
    }
  };

  return (
    <div className="p-6 space-y-6">
      <PageActionRow
        action={
          canWriteAssets ? (
            <button
              data-testid="asset-new"
              onClick={() => setShowForm((s) => !s)}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white"
            >
              <Plus size={16} /> Add asset
            </button>
          ) : undefined
        }
      />

      {summary && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile
            testId="asset-stat-total"
            label="Total assets"
            value={summary.total}
            icon={Boxes}
          />
          <StatTile
            testId="asset-stat-held"
            label="Currently held"
            value={summary.held}
            icon={UserPlus}
          />
          <StatTile
            testId="asset-stat-available"
            label="Available"
            value={summary.byStatus.AVAILABLE ?? 0}
            icon={Boxes}
          />
          <StatTile
            testId="asset-stat-unacknowledged"
            label="Unacknowledged"
            value={summary.unacknowledged}
            icon={ShieldAlert}
            emphasis={summary.unacknowledged > 0}
          />
        </div>
      )}

      {showForm && canWriteAssets && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">New asset</h3>
            <button onClick={() => setShowForm(false)} className="text-slate-400">
              <X size={18} />
            </button>
          </div>
          {categories.length === 0 && (
            <MasterEmptyHint what="asset categories" className="mb-3" />
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <input
              data-testid="asset-form-tag"
              className={inputCls}
              placeholder="Asset tag (e.g. LT-0042)"
              value={form.assetTag}
              onChange={(e) => setForm({ ...form, assetTag: e.target.value })}
            />
            <input
              data-testid="asset-form-name"
              className={inputCls}
              placeholder="Name (e.g. Dell Latitude 5540)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <select
              data-testid="asset-form-category"
              className={inputCls}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              <option value="">Category…</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              data-testid="asset-form-branch"
              className={inputCls}
              value={form.branchId}
              onChange={(e) => setForm({ ...form, branchId: e.target.value })}
            >
              <option value="">Branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <input
              data-testid="asset-form-serial"
              className={inputCls}
              placeholder="Serial number (optional)"
              value={form.serialNumber ?? ''}
              onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
            />
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              Warranty expiry (drives reminders)
              <input
                data-testid="asset-form-warranty"
                type="date"
                className={inputCls}
                value={form.warrantyExpiry ?? ''}
                onChange={(e) =>
                  setForm({ ...form, warrantyExpiry: e.target.value })
                }
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              data-testid="asset-form-submit"
              onClick={submitCreate}
              disabled={saving}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            data-testid="asset-search"
            className={`${inputCls} pl-9`}
            placeholder="Search tag, name or serial number…"
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
          />
        </div>
        <select
          data-testid="asset-status-filter"
          className={`${inputCls} !w-auto`}
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value as AssetStatus | '');
          }}
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_STYLE) as AssetStatus[]).map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Tag</th>
              <th className="px-4 py-3">Asset</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Held by</th>
              <th className="px-4 py-3">Warranty</th>
              {showActions && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={showActions ? 7 : 6} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  data-testid="asset-empty"
                  colSpan={showActions ? 7 : 6}
                  className="px-4 py-10 text-center text-slate-400"
                >
                  No assets found.
                </td>
              </tr>
            ) : (
              rows.map((asset) => (
                <tr
                  key={asset.id}
                  data-testid={`asset-row-${asset.assetTag}`}
                  className="hover:bg-slate-50/60"
                >
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {asset.assetTag}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{asset.name}</p>
                    {asset.serialNumber && (
                      <p className="text-xs text-slate-400">
                        S/N {asset.serialNumber}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{asset.category}</td>
                  <td className="px-4 py-3">
                    <span
                      data-testid={`asset-row-status-${asset.assetTag}`}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[asset.status]}`}
                    >
                      {asset.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {asset.currentHolder ? (
                      <div>
                        <p className="text-slate-800">
                          {asset.currentHolder.employee.fullName}
                        </p>
                        <p className="text-xs text-slate-400">
                          since {fmtDate(asset.currentHolder.assignedAt)}
                          {!asset.currentHolder.acknowledgedAt && ' · unacknowledged'}
                        </p>
                      </div>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {fmtDate(asset.warrantyExpiry)}
                  </td>
                  {showActions && (() => {
                    /**
                     * R76. The server's refusals used to reach the screen as a
                     * native `title` on a `disabled` button and nothing else,
                     * so the sentence that explains them —
                     * "This asset is currently held by an employee. Record its
                     * return before deleting it." — never rendered. A tooltip
                     * is mouse-only: a keyboard user cannot focus a disabled
                     * button to summon it and a touch user has no hover at all,
                     * so the entire explanation was unreachable for them.
                     *
                     * The reason is now written into the row. The control still
                     * refuses before the round trip (the request would 400
                     * either way), but why it refuses is on screen for
                     * everyone, and `aria-describedby` ties the sentence to the
                     * control it is about.
                     */
                    const assignBlocked =
                      canWriteAssets && !asset.currentHolder && asset.status !== 'AVAILABLE';
                    const deleteBlocked = canDeleteAssets && !!asset.currentHolder;
                    const assignReasonId = `asset-assign-reason-${asset.assetTag}`;
                    const deleteReasonId = `asset-delete-reason-${asset.assetTag}`;
                    return (
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-end gap-1.5">
                      <div className="flex items-center justify-end gap-2">
                      {canWriteAssets && (asset.currentHolder ? (
                        <button
                          data-testid={`asset-return-${asset.assetTag}`}
                          onClick={() => {
                            setReturnFor(asset);
                            setReturnStatus('AVAILABLE');
                          }}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <Undo2 size={13} /> Return
                        </button>
                      ) : (
                        <button
                          data-testid={`asset-assign-${asset.assetTag}`}
                          onClick={() => setAssignFor(asset)}
                          disabled={assignBlocked}
                          aria-describedby={assignBlocked ? assignReasonId : undefined}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          <UserPlus size={13} /> Assign
                        </button>
                      ))}
                      {canDeleteAssets && (
                        <button
                          data-testid={`asset-delete-${asset.assetTag}`}
                          onClick={() => remove(asset)}
                          disabled={deleteBlocked}
                          aria-describedby={deleteBlocked ? deleteReasonId : undefined}
                          className="inline-flex h-8 items-center rounded-lg border border-red-200 px-2 text-red-600 hover:bg-red-50 disabled:opacity-40"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                      </div>

                      {assignBlocked && (
                        <p
                          id={assignReasonId}
                          data-testid={`asset-assign-reason-${asset.assetTag}`}
                          className="flex max-w-[16rem] items-start gap-1 text-end text-[11px] leading-tight text-amber-700"
                        >
                          <ShieldAlert size={11} className="mt-0.5 shrink-0" />
                          <span>
                            This asset is {asset.status.replace('_', ' ')}. Only an
                            AVAILABLE asset can be handed out — set it back to
                            AVAILABLE before assigning it.
                          </span>
                        </p>
                      )}

                      {deleteBlocked && (
                        <p
                          id={deleteReasonId}
                          data-testid={`asset-delete-reason-${asset.assetTag}`}
                          className="flex max-w-[16rem] items-start gap-1 text-end text-[11px] leading-tight text-amber-700"
                        >
                          <ShieldAlert size={11} className="mt-0.5 shrink-0" />
                          <span>
                            {asset.currentHolder!.employee.fullName} is currently
                            holding this asset. Record its return before deleting
                            it.
                          </span>
                        </p>
                      )}
                    </div>
                  </td>
                    );
                  })()}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <Pagination
          testIdPrefix="asset-pg"
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

      {/* Assign */}
      {assignFor && (
        <div
          data-testid="asset-assign-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="mb-1 text-base font-semibold text-slate-900">
              Assign {assignFor.name}
            </h3>
            <p className="mb-4 text-xs text-slate-500">
              The employee will be asked to acknowledge receipt, and will not be
              able to complete offboarding until it is returned.
            </p>
            <div className="space-y-3">
              <select
                data-testid="asset-assign-employee"
                className={inputCls}
                value={assignEmployeeId}
                onChange={(e) => setAssignEmployeeId(e.target.value)}
              >
                <option value="">Select employee…</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName} ({e.employeeCode})
                  </option>
                ))}
              </select>
              <input
                data-testid="asset-assign-condition"
                className={inputCls}
                placeholder="Condition at hand-over (optional)"
                value={conditionOut}
                onChange={(e) => setConditionOut(e.target.value)}
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                data-testid="asset-assign-cancel"
                onClick={() => setAssignFor(null)}
                className="h-9 rounded-lg border border-slate-200 px-3 text-sm text-slate-600"
              >
                Cancel
              </button>
              <button
                data-testid="asset-assign-submit"
                onClick={submitAssign}
                disabled={saving}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Return */}
      {returnFor && (
        <div
          data-testid="asset-return-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="mb-1 text-base font-semibold text-slate-900">
              Return {returnFor.name}
            </h3>
            <p className="mb-4 text-xs text-slate-500">
              From {returnFor.currentHolder?.employee.fullName}. A damaged or
              missing item should not go back to AVAILABLE.
            </p>
            <div className="space-y-3">
              <input
                data-testid="asset-return-condition"
                className={inputCls}
                placeholder="Condition on return (optional)"
                value={conditionIn}
                onChange={(e) => setConditionIn(e.target.value)}
              />
              <label className="flex flex-col gap-1 text-xs text-slate-500">
                New asset status
                <select
                  data-testid="asset-return-status"
                  className={inputCls}
                  value={returnStatus}
                  onChange={(e) =>
                    setReturnStatus(e.target.value as AssetReturnStatus)
                  }
                >
                  {RETURN_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                data-testid="asset-return-cancel"
                onClick={() => setReturnFor(null)}
                className="h-9 rounded-lg border border-slate-200 px-3 text-sm text-slate-600"
              >
                Cancel
              </button>
              <button
                data-testid="asset-return-submit"
                onClick={submitReturn}
                disabled={saving}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Record return
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog />
    </div>
  );
}

export default function AssetsPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <AssetsPageInner />
    </ProtectedRoute>
  );
}
