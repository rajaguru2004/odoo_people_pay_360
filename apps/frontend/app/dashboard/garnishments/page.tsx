'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import garnishmentService, {
  GarnishmentInput,
  GarnishmentOrder,
} from '@/services/garnishmentService';
import employeeService from '@/services/employeeService';
import { useAuthStore } from '@/store/authStore';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { toast } from '@/lib/toast';
import { apiErrorMessage } from '@/utils/apiError';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';

/**
 * Court orders against earnings.
 *
 * These are recovered ahead of every advance and loan — payroll subtracts them
 * from the pool before the loan allocator sees the money — so the screen says
 * that out loud rather than leaving it to be discovered from a payslip.
 *
 * Two rules the form enforces before the round trip, because they are the two
 * an administrator gets wrong:
 *
 *  - An order states EITHER a fixed amount OR a percentage of net pay. Both is
 *    two conflicting instructions; neither is none.
 *  - It cannot end before it starts.
 */
export default function GarnishmentsPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { confirm, ConfirmDialog } = useConfirm();

  const canManage = ['ADMIN', 'HR_MANAGER'].includes(user?.role ?? '');
  const isAdmin = user?.role === 'ADMIN';

  const [rows, setRows] = useState<GarnishmentOrder[]>([]);
  const [directory, setDirectory] = useState<
    { id: string; fullName: string; employeeCode: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [editing, setEditing] = useState<(GarnishmentInput & { id?: string }) | null>(null);
  const [saving, setSaving] = useState(false);

  // The one heading for this route, rendered by TopHeader. Declared above the
  // permission early return so the hook runs on every render.
  usePageHeader(
    'Court orders',
    'Recovered ahead of every advance and loan.',
  );

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(null);
    try {
      const res: any = await garnishmentService.getAll();
      setRows(Array.isArray(res) ? res : (res?.data ?? []));
    } catch (e) {
      // A refusal is not "no orders": telling a payroll officer there are none
      // when they simply may not see them is how a deduction goes unexplained.
      const reason = apiErrorMessage(e, 'Could not load the garnishment orders');
      setFailed(reason);
      setRows([]);
      toast.error(reason);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    load();
    employeeService
      .getDirectory()
      .then((res: any) => setDirectory(Array.isArray(res) ? res : (res?.data ?? [])))
      .catch(() => setDirectory([]));
  }, [canManage, load]);

  const save = async () => {
    if (!editing) return;

    const hasAmount = editing.amount != null && String(editing.amount) !== '';
    const hasPercent =
      editing.percentOfNet != null && String(editing.percentOfNet) !== '';

    if (!editing.id && !editing.employeeId) {
      toast.warning('Choose the employee this order is against');
      return;
    }
    if (!editing.id && !(editing.reference ?? '').trim()) {
      toast.warning('A court reference is required — it is what a payslip query is answered with');
      return;
    }
    if (hasAmount && hasPercent) {
      toast.warning('An order states either a fixed amount or a percentage of net pay, not both');
      return;
    }
    if (!hasAmount && !hasPercent) {
      toast.warning('An order needs either a fixed amount or a percentage of net pay');
      return;
    }
    if (editing.startDate && editing.endDate && editing.endDate < editing.startDate) {
      toast.warning('The order ends before it starts');
      return;
    }

    const payload: GarnishmentInput = {
      reference: editing.reference,
      authority: editing.authority || null,
      amount: hasAmount ? Number(editing.amount) : null,
      percentOfNet: hasPercent ? Number(editing.percentOfNet) : null,
      totalCap:
        editing.totalCap != null && String(editing.totalCap) !== ''
          ? Number(editing.totalCap)
          : null,
      priority:
        editing.priority != null && String(editing.priority) !== ''
          ? Number(editing.priority)
          : undefined,
      startDate: editing.startDate,
      endDate: editing.endDate || null,
      notes: editing.notes || null,
    };

    try {
      setSaving(true);
      if (editing.id) {
        await garnishmentService.update(editing.id, payload);
        toast.success('Order updated');
      } else {
        await garnishmentService.create({ ...payload, employeeId: editing.employeeId });
        toast.success('Order recorded');
      }
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save this order'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (row: GarnishmentOrder) => {
    try {
      await garnishmentService.update(row.id, { isActive: !row.isActive });
      toast.success(row.isActive ? 'Order stopped' : 'Order resumed');
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not change this order'));
    }
  };

  const remove = async (row: GarnishmentOrder) => {
    const ok = await confirm({
      title: 'Delete order',
      message: `Delete ${row.reference}? Only possible while nothing has been collected under it.`,
      confirmText: 'Delete',
      type: 'danger',
    });
    if (!ok) return;
    try {
      await garnishmentService.remove(row.id);
      toast.success('Order deleted');
      await load();
    } catch (e) {
      // The server explains that money has been collected and says to
      // deactivate instead — that sentence is the useful one.
      toast.error(apiErrorMessage(e, 'Could not delete this order'));
    }
  };

  if (!canManage) {
    return (
      <div className="p-6" data-testid="garnishment-forbidden">
        <p className="text-sm font-medium text-text-heading">
          Court orders are handled by HR
        </p>
        <p className="mt-1 text-sm text-text-muted">
          An order takes money out of somebody&apos;s pay ahead of every loan they
          hold, so it is limited to HR and administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <ConfirmDialog />

      <PageActionRow
        onBack={() => router.push('/dashboard/payroll')}
        action={
          <button
            data-testid="garnishment-new"
            onClick={() =>
              setEditing({
                startDate: new Date().toISOString().slice(0, 10),
                isActive: true,
              })
            }
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white"
          >
            <Plus size={15} />
            New order
          </button>
        }
      />

      {loading && <p className="text-sm text-text-muted">Loading…</p>}

      {!loading && failed && (
        <div
          data-testid="garnishment-failed"
          className="rounded-lg border border-status-error bg-status-error-bg p-3"
        >
          <p className="text-sm font-medium text-text-heading">
            The orders could not be loaded
          </p>
          <p className="mt-1 text-sm text-text-muted">{failed}</p>
        </div>
      )}

      {!loading && !failed && rows.length === 0 && (
        <p data-testid="garnishment-empty" className="text-sm text-text-muted">
          No court orders are on file.
        </p>
      )}

      {!loading && !failed && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-page text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2 text-start">Employee</th>
                <th className="px-3 py-2 text-start">Reference</th>
                <th className="px-3 py-2 text-start">Takes</th>
                <th className="px-3 py-2 text-start">Collected</th>
                <th className="px-3 py-2 text-start">Runs</th>
                <th className="px-3 py-2 text-start">State</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  data-testid="garnishment-row"
                  data-order-id={r.id}
                  className="border-t border-surface-border"
                >
                  <td className="px-3 py-2">
                    {r.employee?.fullName ?? r.employeeId}
                    <div className="text-xs text-text-muted">
                      {r.employee?.employeeCode}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {r.reference}
                    {r.authority && (
                      <div className="text-xs text-text-muted">{r.authority}</div>
                    )}
                  </td>
                  <td className="px-3 py-2" data-testid="garnishment-takes">
                    {r.amount != null
                      ? formatCurrency(Number(r.amount))
                      : `${Number(r.percentOfNet)}% of net`}
                    {r.totalCap != null && (
                      <div className="text-xs text-text-muted">
                        capped at {formatCurrency(Number(r.totalCap))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2" data-testid="garnishment-collected">
                    {formatCurrency(Number(r.collected))}
                  </td>
                  <td className="px-3 py-2">
                    {formatDate(r.startDate)}
                    {r.endDate ? ` – ${formatDate(r.endDate)}` : ' – open'}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      data-testid="garnishment-state"
                      data-active={r.isActive}
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        r.isActive
                          ? 'bg-status-success-bg text-status-success'
                          : 'bg-surface-page text-text-muted'
                      }`}
                    >
                      {r.isActive ? 'In force' : 'Stopped'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      <button
                        data-testid="garnishment-edit"
                        onClick={() =>
                          setEditing({
                            id: r.id,
                            reference: r.reference,
                            authority: r.authority,
                            amount: r.amount != null ? Number(r.amount) : null,
                            percentOfNet:
                              r.percentOfNet != null ? Number(r.percentOfNet) : null,
                            totalCap: r.totalCap != null ? Number(r.totalCap) : null,
                            startDate: r.startDate.slice(0, 10),
                            endDate: r.endDate ? r.endDate.slice(0, 10) : null,
                            notes: r.notes,
                          })
                        }
                        className="rounded-lg border border-surface-border px-2 py-1 text-xs hover:bg-surface-page"
                      >
                        Edit
                      </button>
                      <button
                        data-testid="garnishment-toggle"
                        onClick={() => toggle(r)}
                        className="rounded-lg border border-surface-border px-2 py-1 text-xs hover:bg-surface-page"
                      >
                        {r.isActive ? 'Stop' : 'Resume'}
                      </button>
                      {isAdmin && (
                        <button
                          data-testid="garnishment-delete"
                          onClick={() => remove(r)}
                          className="rounded-lg border border-status-error px-2 py-1 text-xs text-status-error hover:bg-status-error-bg"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            data-testid="garnishment-modal"
            className="w-full max-w-lg space-y-3 rounded-xl bg-surface-card p-4"
          >
            <h2 className="text-base font-semibold">
              {editing.id ? 'Edit order' : 'New court order'}
            </h2>

            <div className="grid grid-cols-2 gap-3">
              {!editing.id && (
                <div className="col-span-2">
                  <label className="mb-1 block text-xs font-medium">Employee</label>
                  <select
                    data-testid="garnishment-employee"
                    value={editing.employeeId ?? ''}
                    onChange={(e) => setEditing({ ...editing, employeeId: e.target.value })}
                    className="h-9 w-full rounded-lg border border-surface-border px-3 text-sm"
                  >
                    <option value="">Choose an employee…</option>
                    {directory.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.fullName} ({e.employeeCode})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium">Court reference</label>
                <input
                  data-testid="garnishment-reference"
                  value={editing.reference ?? ''}
                  onChange={(e) => setEditing({ ...editing, reference: e.target.value })}
                  className="h-9 w-full rounded-lg border border-surface-border px-3 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium">Authority</label>
                <input
                  data-testid="garnishment-authority"
                  value={editing.authority ?? ''}
                  onChange={(e) => setEditing({ ...editing, authority: e.target.value })}
                  className="h-9 w-full rounded-lg border border-surface-border px-3 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium">Fixed amount</label>
                <input
                  data-testid="garnishment-amount"
                  type="number"
                  step="0.01"
                  value={editing.amount == null ? '' : String(editing.amount)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      amount: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  className="h-9 w-full rounded-lg border border-surface-border px-3 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium">…or % of net pay</label>
                <input
                  data-testid="garnishment-percent"
                  type="number"
                  step="0.01"
                  value={editing.percentOfNet == null ? '' : String(editing.percentOfNet)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      percentOfNet: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  className="h-9 w-full rounded-lg border border-surface-border px-3 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium">Stop after (total)</label>
                <input
                  data-testid="garnishment-cap"
                  type="number"
                  step="0.01"
                  value={editing.totalCap == null ? '' : String(editing.totalCap)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      totalCap: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  className="h-9 w-full rounded-lg border border-surface-border px-3 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium">
                  Rank against other orders
                </label>
                <input
                  data-testid="garnishment-priority"
                  type="number"
                  step="1"
                  min="1"
                  placeholder="100"
                  value={editing.priority == null ? '' : String(editing.priority)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      priority:
                        e.target.value === ''
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                  className="h-9 w-full rounded-lg border border-surface-border px-3 text-sm"
                />
                <p className="mt-1 text-[11px] text-muted">
                  Lower goes first when pay cannot cover every order. Leave
                  blank for the default.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium">Starts</label>
                <input
                  data-testid="garnishment-start"
                  type="date"
                  value={editing.startDate ?? ''}
                  onChange={(e) => setEditing({ ...editing, startDate: e.target.value })}
                  className="h-9 w-full rounded-lg border border-surface-border px-3 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium">Ends (optional)</label>
                <input
                  data-testid="garnishment-end"
                  type="date"
                  value={editing.endDate ?? ''}
                  onChange={(e) => setEditing({ ...editing, endDate: e.target.value })}
                  className="h-9 w-full rounded-lg border border-surface-border px-3 text-sm"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                data-testid="garnishment-cancel"
                onClick={() => setEditing(null)}
                className="rounded-lg border border-surface-border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                data-testid="garnishment-save"
                disabled={saving}
                onClick={save}
                className="rounded-lg bg-brand-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
