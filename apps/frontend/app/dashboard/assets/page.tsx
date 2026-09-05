'use client';

import { useState } from 'react';
import {
  Boxes,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  Undo2,
  UserPlus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { Pagination } from '@/components/common/Pagination';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useAssets,
  useAssetSummary,
  useAssignAsset,
  useCreateAsset,
  useDeleteAsset,
  useReturnAsset,
} from '@/hooks/useAssets';
import { useBranches } from '@/hooks/useBranches';
import { useEmployees } from '@/hooks/useEmployees';
import { useLibraryItems } from '@/hooks/useLibraryItems';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type {
  AssetItem,
  AssetReturnStatus,
  AssetStatus,
  CreateAssetData,
} from '@/types/asset';

const STATUS_TONE: Record<
  AssetStatus,
  'neutral' | 'success' | 'warning' | 'error' | 'info'
> = {
  AVAILABLE: 'success',
  ASSIGNED: 'info',
  IN_REPAIR: 'warning',
  LOST: 'error',
  RETIRED: 'neutral',
};

const STATUSES = Object.keys(STATUS_TONE) as AssetStatus[];

const RETURN_STATUSES: AssetReturnStatus[] = [
  'AVAILABLE',
  'IN_REPAIR',
  'LOST',
  'RETIRED',
];

const EMPTY_ASSET: CreateAssetData = {
  assetTag: '',
  category: '',
  name: '',
  branchId: '',
};

const PAGE_SIZE = 25;

function AssetRegister() {
  const role = useAuthStore((state) => state.user?.role);

  /**
   * The register is readable by managers; every write is ADMIN or HR, and
   * deleting is ADMIN alone. A control a caller cannot use is not drawn rather
   * than drawn and then refused — a 403 met after committing to an action says
   * nothing about which of the buttons were ever theirs.
   */
  const canWrite = role === 'ADMIN' || role === 'HR_MANAGER';
  const canDelete = role === 'ADMIN';

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AssetStatus | ''>('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateAssetData>(EMPTY_ASSET);

  const [assignFor, setAssignFor] = useState<AssetItem | null>(null);
  const [assignEmployeeId, setAssignEmployeeId] = useState('');
  const [conditionOut, setConditionOut] = useState('');

  const [returnFor, setReturnFor] = useState<AssetItem | null>(null);
  const [conditionIn, setConditionIn] = useState('');
  const [returnStatus, setReturnStatus] = useState<AssetReturnStatus>('AVAILABLE');

  const assets = useAssets({
    page,
    limit: PAGE_SIZE,
    search: search.trim() || undefined,
    status: status || undefined,
  });
  // Asking a question this role may not ask is what raises a permission dialog
  // over a register they are entitled to read.
  const summary = useAssetSummary(canWrite);
  const branches = useBranches();
  const people = useEmployees({ status: 'ACTIVE', limit: 200, sortBy: 'firstName' });
  const categories = useLibraryItems({ type: 'ASSET_CATEGORY', activeOnly: true });

  const create = useCreateAsset();
  const assign = useAssignAsset();
  const returnAsset = useReturnAsset();
  const remove = useDeleteAsset();

  const rows = assets.data?.data ?? [];
  const meta = assets.data?.meta;
  const totals = summary.data?.data;

  usePageHeader(
    'Asset register',
    'Who holds what — and whether they can leave without returning it',
  );

  const submitCreate = async () => {
    if (
      !form.assetTag.trim() ||
      !form.name.trim() ||
      !form.category ||
      !form.branchId
    ) {
      toast.warning('A tag, a name, a category and a branch are all needed');
      return;
    }
    try {
      await create.mutateAsync({
        ...form,
        assetTag: form.assetTag.trim(),
        name: form.name.trim(),
      });
      toast.success('Asset added');
      setShowForm(false);
      setForm(EMPTY_ASSET);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not add that asset.'));
    }
  };

  const submitAssign = async () => {
    if (!assignFor || !assignEmployeeId) {
      toast.warning('Choose who is taking it');
      return;
    }
    try {
      await assign.mutateAsync({
        assetId: assignFor.id,
        employeeId: assignEmployeeId,
        conditionOut: conditionOut.trim() || undefined,
      });
      toast.success('Asset assigned');
      setAssignFor(null);
      setAssignEmployeeId('');
      setConditionOut('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not assign that asset.'));
    }
  };

  const submitReturn = async () => {
    if (!returnFor?.currentHolder) return;
    try {
      await returnAsset.mutateAsync({
        assignmentId: returnFor.currentHolder.assignmentId,
        payload: {
          conditionIn: conditionIn.trim() || undefined,
          assetStatus: returnStatus,
        },
      });
      toast.success('Return recorded');
      setReturnFor(null);
      setConditionIn('');
      setReturnStatus('AVAILABLE');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not record that return.'));
    }
  };

  const submitDelete = async (asset: AssetItem) => {
    try {
      await remove.mutateAsync(asset.id);
      toast.success('Asset deleted');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not delete that asset.'));
    }
  };

  return (
    <div className="space-y-5">
      {totals && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="Total assets"
            value={totals.total}
            icon={<Boxes className="h-5 w-5" aria-hidden />}
          />
          <StatCard
            label="Currently held"
            value={totals.held}
            icon={<UserPlus className="h-5 w-5" aria-hidden />}
            hint="Open custody blocks an exit"
          />
          <StatCard label="Available" value={totals.byStatus.AVAILABLE ?? 0} />
          <StatCard
            label="Unacknowledged"
            value={totals.unacknowledged}
            icon={<ShieldAlert className="h-5 w-5" aria-hidden />}
            hint="Issued but not signed for"
          />
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-1 flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <Input
              aria-label="Search the register"
              placeholder="Search a tag, a name or a serial number…"
              icon={<Search className="h-4 w-4" aria-hidden />}
              value={search}
              onChange={(event) => {
                setPage(1);
                setSearch(event.target.value);
              }}
              data-testid="asset-search"
            />
          </div>
          <div className="w-48">
            <Select
              aria-label="Filter by status"
              placeholder="All statuses"
              value={status}
              onChange={(event) => {
                setPage(1);
                setStatus(event.target.value as AssetStatus | '');
              }}
              data-testid="asset-status-filter"
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {canWrite && (
          <Button onClick={() => setShowForm((open) => !open)} data-testid="asset-new">
            <Plus className="h-4 w-4" aria-hidden />
            Add asset
          </Button>
        )}
      </div>

      {showForm && canWrite && (
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-heading">New asset</h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              aria-label="Close the asset form"
              className="text-text-muted hover:text-text-body"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <Input
              label="Asset tag"
              placeholder="LT-0042"
              value={form.assetTag}
              onChange={(event) => setForm({ ...form, assetTag: event.target.value })}
              data-testid="asset-form-tag"
            />
            <Input
              label="Name"
              placeholder="Dell Latitude 5540"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              data-testid="asset-form-name"
            />
            <Select
              label="Category"
              placeholder="Choose a category…"
              value={form.category}
              onChange={(event) => setForm({ ...form, category: event.target.value })}
              data-testid="asset-form-category"
            >
              {(categories.data?.data ?? []).map((item) => (
                <option key={item.id} value={item.label}>
                  {item.label}
                </option>
              ))}
            </Select>
            <Select
              label="Branch"
              placeholder="Choose a branch…"
              value={form.branchId}
              onChange={(event) => setForm({ ...form, branchId: event.target.value })}
              data-testid="asset-form-branch"
            >
              {(branches.data?.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </Select>
            <Input
              label="Serial number"
              value={form.serialNumber ?? ''}
              onChange={(event) =>
                setForm({ ...form, serialNumber: event.target.value })
              }
              data-testid="asset-form-serial"
            />
            <Input
              label="Warranty expiry"
              type="date"
              value={form.warrantyExpiry ?? ''}
              onChange={(event) =>
                setForm({ ...form, warrantyExpiry: event.target.value })
              }
              data-testid="asset-form-warranty"
            />
          </div>

          <div className="mt-4 flex justify-end">
            <Button
              onClick={() => void submitCreate()}
              isLoading={create.isPending}
              data-testid="asset-form-submit"
            >
              Save
            </Button>
          </div>
        </Card>
      )}

      <Card>
        {assets.isLoading && (
          <p className="p-6 text-sm text-text-muted">Loading the register…</p>
        )}

        {assets.isError && (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(assets.error, 'Could not load the register.')}
          </p>
        )}

        {!assets.isLoading && !assets.isError && rows.length === 0 && (
          <EmptyState
            icon={<Boxes className="h-6 w-6" aria-hidden />}
            title="No assets"
            description="Add the first item to start tracking who holds what."
          />
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Tag</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Asset</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Category</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Status</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Held by</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Warranty</th>
                  {(canWrite || canDelete) && (
                    <th scope="col" className="px-5 py-3 text-end font-medium">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {rows.map((asset) => {
                  // Gated on the capability as well as the state: a reason
                  // for a control this role never sees is an explanation of
                  // something that is not on the page.
                  const assignBlocked =
                    canWrite && !asset.currentHolder && asset.status !== 'AVAILABLE';
                  const deleteBlocked = canDelete && Boolean(asset.currentHolder);
                  const assignReasonId = `asset-assign-reason-${asset.assetTag}`;
                  const deleteReasonId = `asset-delete-reason-${asset.assetTag}`;

                  return (
                    <tr
                      key={asset.id}
                      data-testid={`asset-row-${asset.assetTag}`}
                      className="hover:bg-surface-border-light/60"
                    >
                      <td className="px-5 py-3 font-mono text-xs text-text-muted">
                        {asset.assetTag}
                      </td>
                      <td className="px-5 py-3">
                        <p className="font-medium text-text-heading">{asset.name}</p>
                        {asset.serialNumber && (
                          <p className="text-xs text-text-muted">
                            S/N {asset.serialNumber}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3 text-text-body">{asset.category}</td>
                      <td className="px-5 py-3">
                        <Badge tone={STATUS_TONE[asset.status]}>
                          {asset.status.replace('_', ' ')}
                        </Badge>
                      </td>
                      <td className="px-5 py-3">
                        {asset.currentHolder ? (
                          <>
                            <p className="text-text-heading">
                              {asset.currentHolder.employee.fullName}
                            </p>
                            <p className="text-xs text-text-muted">
                              since {formatDateOnly(asset.currentHolder.assignedAt)}
                              {!asset.currentHolder.acknowledgedAt &&
                                ' · unacknowledged'}
                            </p>
                          </>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-text-muted">
                        {formatDateOnly(asset.warrantyExpiry)}
                      </td>

                      {(canWrite || canDelete) && (
                        <td className="px-5 py-3">
                          <div className="flex flex-col items-end gap-1.5">
                            <div className="flex items-center justify-end gap-2">
                              {canWrite &&
                                (asset.currentHolder ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setReturnFor(asset);
                                      setReturnStatus('AVAILABLE');
                                    }}
                                    data-testid={`asset-return-${asset.assetTag}`}
                                  >
                                    <Undo2 className="h-4 w-4" aria-hidden />
                                    Return
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setAssignFor(asset)}
                                    disabled={assignBlocked}
                                    aria-describedby={
                                      assignBlocked ? assignReasonId : undefined
                                    }
                                    data-testid={`asset-assign-${asset.assetTag}`}
                                  >
                                    <UserPlus className="h-4 w-4" aria-hidden />
                                    Assign
                                  </Button>
                                ))}
                              {canDelete && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void submitDelete(asset)}
                                  disabled={deleteBlocked}
                                  aria-label={`Delete ${asset.name}`}
                                  aria-describedby={
                                    deleteBlocked ? deleteReasonId : undefined
                                  }
                                  data-testid={`asset-delete-${asset.assetTag}`}
                                >
                                  <Trash2
                                    className="h-4 w-4 text-status-error"
                                    aria-hidden
                                  />
                                </Button>
                              )}
                            </div>

                            {/* The reason is written into the row, not into a
                                title: a tooltip is mouse-only, so a keyboard or
                                touch user could never reach the explanation. */}
                            {assignBlocked && (
                              <p
                                id={assignReasonId}
                                className="flex max-w-[18rem] items-start gap-1 text-end text-xs leading-tight text-status-warning"
                              >
                                <ShieldAlert
                                  className="mt-0.5 h-3 w-3 shrink-0"
                                  aria-hidden
                                />
                                <span>
                                  This asset is {asset.status.replace('_', ' ')}.
                                  Only an available asset can be handed out.
                                </span>
                              </p>
                            )}
                            {deleteBlocked && (
                              <p
                                id={deleteReasonId}
                                className="flex max-w-[18rem] items-start gap-1 text-end text-xs leading-tight text-status-warning"
                              >
                                <ShieldAlert
                                  className="mt-0.5 h-3 w-3 shrink-0"
                                  aria-hidden
                                />
                                <span>
                                  {asset.currentHolder?.employee.fullName} is
                                  holding this. Record its return first.
                                </span>
                              </p>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {meta && meta.total > 0 && (
        <Pagination meta={meta} onPageChange={setPage} />
      )}

      {assignFor && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Assign ${assignFor.name}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="asset-assign-modal"
        >
          <Card className="w-full max-w-md p-5">
            <h2 className="text-base font-semibold text-text-heading">
              Assign {assignFor.name}
            </h2>
            <p className="mb-4 mt-1 text-xs text-text-muted">
              The holder is asked to acknowledge receipt, and cannot complete an
              exit until it comes back.
            </p>

            <div className="space-y-3">
              <Select
                label="Employee"
                placeholder="Choose an employee…"
                value={assignEmployeeId}
                onChange={(event) => setAssignEmployeeId(event.target.value)}
                data-testid="asset-assign-employee"
              >
                {(people.data?.data ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {fullName(person)} ({person.employeeCode})
                  </option>
                ))}
              </Select>
              <Input
                label="Condition at hand-over"
                value={conditionOut}
                onChange={(event) => setConditionOut(event.target.value)}
                data-testid="asset-assign-condition"
              />
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAssignFor(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => void submitAssign()}
                isLoading={assign.isPending}
                data-testid="asset-assign-submit"
              >
                Assign
              </Button>
            </div>
          </Card>
        </div>
      )}

      {returnFor && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Record the return of ${returnFor.name}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="asset-return-modal"
        >
          <Card className="w-full max-w-md p-5">
            <h2 className="text-base font-semibold text-text-heading">
              Return {returnFor.name}
            </h2>
            <p className="mb-4 mt-1 text-xs text-text-muted">
              From {returnFor.currentHolder?.employee.fullName}. A damaged or
              missing item must not go back to available.
            </p>

            <div className="space-y-3">
              <Input
                label="Condition on return"
                value={conditionIn}
                onChange={(event) => setConditionIn(event.target.value)}
                data-testid="asset-return-condition"
              />
              <Select
                label="New status"
                value={returnStatus}
                onChange={(event) =>
                  setReturnStatus(event.target.value as AssetReturnStatus)
                }
                data-testid="asset-return-status"
              >
                {RETURN_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value.replace('_', ' ')}
                  </option>
                ))}
              </Select>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setReturnFor(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => void submitReturn()}
                isLoading={returnAsset.isPending}
                data-testid="asset-return-submit"
              >
                Record return
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function AssetsPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER']}>
      <AssetRegister />
    </ProtectedRoute>
  );
}
