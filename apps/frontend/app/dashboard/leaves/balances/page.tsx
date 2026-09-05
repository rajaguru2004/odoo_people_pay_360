'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Save } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import {
  useCompanyLeaveOverview,
  useLeaveBalances,
  useRunLeaveAccrual,
  useUpdateTypeBalance,
} from '@/hooks/useLeaveBalances';
import { useLeaveTypes } from '@/hooks/useLeaveRequests';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import { formatDays, formatRate } from '@/components/leave/leaveFormat';

const CURRENT_YEAR = new Date().getUTCFullYear();
const YEARS = [CURRENT_YEAR + 1, CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

/**
 * Every employee's entitlement, and the one place it is edited.
 *
 * An allocation is edited per TYPE rather than as a single number: annual and
 * sick leave are separate entitlements with separate rules, and one field for
 * "leave days" is how a company ends up unable to say how much sick leave it
 * actually grants.
 *
 * Editing an allocation deliberately never touches `used`. Changing what
 * somebody is entitled to is not the same act as handing back leave they have
 * already taken — and the days behind `used` are already on the attendance board.
 */
function LeaveBalancesContent() {
  const [year, setYear] = useState(CURRENT_YEAR);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{
    employeeId: string;
    leaveTypeKey: string;
  } | null>(null);
  const [allocated, setAllocated] = useState('');

  const balances = useLeaveBalances(year);
  const overview = useCompanyLeaveOverview(year);
  const types = useLeaveTypes();
  const updateAllocation = useUpdateTypeBalance();
  const runAccrual = useRunLeaveAccrual();

  const rows = useMemo(() => {
    const all = balances.data?.data ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((row) =>
      `${row.employee.firstName} ${row.employee.lastName} ${row.employee.employeeCode}`
        .toLowerCase()
        .includes(needle),
    );
  }, [balances.data, search]);

  usePageHeader('Leave balances', `Entitlement for ${year}`);

  const typeColumns = useMemo(
    () =>
      (types.data?.data ?? [])
        .filter((t) => t.affectsBalance)
        .map((t) => t.label),
    [types.data],
  );

  const saveAllocation = async (employeeId: string, leaveTypeKey: string) => {
    const value = Number(allocated);
    if (!Number.isInteger(value) || value < 0) {
      toast.error('An allocation is a whole number of days.');
      return;
    }
    try {
      await updateAllocation.mutateAsync({
        employeeId,
        year,
        leaveTypeKey,
        allocated: value,
      });
      toast.success('Allocation updated.');
      setEditing(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The allocation could not be saved.'));
    }
  };

  const onRunAccrual = async () => {
    try {
      const result = await runAccrual.mutateAsync();
      toast.success(result.message ?? 'Accrual run.');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The accrual could not be run.'));
    }
  };

  const totals = overview.data?.data;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active staff"
          value={totals?.activeHeadcount ?? '—'}
          hint={`In the ${year} year`}
        />
        <StatCard
          label="Allocated"
          value={formatDays(
            totals?.leaveTypes.reduce((a, t) => a + t.totalAllocated, 0) ?? null,
          )}
        />
        <StatCard
          label="Taken"
          value={formatDays(
            totals?.leaveTypes.reduce((a, t) => a + t.totalUsed, 0) ?? null,
          )}
        />
        <StatCard
          label="Still owed"
          value={formatDays(
            totals?.leaveTypes.reduce((a, t) => a + t.totalRemaining, 0) ?? null,
          )}
        />
      </div>

      <Card>
        <CardHeader
          title="By leave type"
          subtitle={`Company-wide, ${year}.`}
          action={
            <Button
              variant="outline"
              size="sm"
              isLoading={runAccrual.isPending}
              onClick={() => void onRunAccrual()}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Run monthly accrual
            </Button>
          }
        />
        <CardBody>
          {overview.isLoading ? (
            <div className="h-24 animate-pulse rounded-lg bg-surface-border/60" />
          ) : (totals?.leaveTypes.length ?? 0) === 0 ? (
            <p className="text-sm text-text-muted">
              No entitlement has been allocated for this year yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b border-surface-border-light text-start">
                    <th scope="col" className="px-3 py-2 text-start text-[11px] font-semibold uppercase tracking-wider text-text-muted">Type</th>
                    <th scope="col" className="px-3 py-2 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">Allocated</th>
                    <th scope="col" className="px-3 py-2 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">Carried over</th>
                    <th scope="col" className="px-3 py-2 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">Taken</th>
                    <th scope="col" className="px-3 py-2 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">Remaining</th>
                    <th scope="col" className="px-3 py-2 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">Used</th>
                  </tr>
                </thead>
                <tbody>
                  {totals!.leaveTypes.map((type) => (
                    <tr key={type.leaveTypeKey} className="border-b border-surface-border-light last:border-0">
                      <td className="px-3 py-2 font-medium text-text-heading">{type.leaveTypeKey}</td>
                      <td className="px-3 py-2 text-end tabular-nums text-text-body">{type.totalAllocated}</td>
                      <td className="px-3 py-2 text-end tabular-nums text-text-body">{type.totalCarriedOver}</td>
                      <td className="px-3 py-2 text-end tabular-nums text-text-body">{type.totalUsed}</td>
                      <td className="px-3 py-2 text-end tabular-nums font-medium text-text-heading">{type.totalRemaining}</td>
                      {/* An em dash, not 0%, when nothing was allocated: the two
                          are different facts about the same type. */}
                      <td className="px-3 py-2 text-end tabular-nums text-text-muted">{formatRate(type.utilisation)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <div className="grid gap-3 border-b border-surface-border-light p-4 sm:grid-cols-3">
          <Input
            label="Search"
            placeholder="Name or employee code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            label="Year"
            value={String(year)}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </div>

        {balances.isError ? (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(balances.error, 'The balances could not be loaded.')}
          </p>
        ) : balances.isLoading ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-border/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nobody matches"
            description="Clear the search, or pick another year."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-surface-border-light">
                  <th scope="col" className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Employee
                  </th>
                  {typeColumns.map((label) => (
                    <th
                      key={label}
                      scope="col"
                      className="px-4 py-3 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      {label}
                    </th>
                  ))}
                  <th scope="col" className="px-4 py-3 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Remaining
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.employee.id}
                    className="border-b border-surface-border-light last:border-0 hover:bg-surface-page/60"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-heading">{fullName(row.employee)}</p>
                      <p className="text-xs text-text-muted">
                        {row.employee.employeeCode}
                        {row.employee.department ? ` · ${row.employee.department.name}` : ''}
                      </p>
                    </td>

                    {typeColumns.map((label) => {
                      const cell = row.leaveTypeBalances.find(
                        (b) => b.leaveTypeKey === label,
                      );
                      const isEditing =
                        editing?.employeeId === row.employee.id &&
                        editing.leaveTypeKey === label;

                      return (
                        <td key={label} className="px-4 py-3 text-end">
                          {isEditing ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <input
                                type="number"
                                min={0}
                                value={allocated}
                                onChange={(e) => setAllocated(e.target.value)}
                                aria-label={`${label} allocation for ${fullName(row.employee)}`}
                                className="w-20 rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-2 py-1 text-end text-sm tabular-nums"
                              />
                              <Button
                                size="sm"
                                isLoading={updateAllocation.isPending}
                                onClick={() =>
                                  void saveAllocation(row.employee.id, label)
                                }
                              >
                                <Save className="h-3.5 w-3.5" aria-hidden />
                              </Button>
                            </div>
                          ) : cell ? (
                            <button
                              type="button"
                              onClick={() => {
                                setEditing({
                                  employeeId: row.employee.id,
                                  leaveTypeKey: label,
                                });
                                setAllocated(String(cell.allocated));
                              }}
                              className="tabular-nums text-text-body hover:text-brand-primary"
                              title={`${cell.allocated} allocated, ${cell.carriedOver} carried over, ${cell.used} taken`}
                            >
                              <span className="font-medium text-text-heading">
                                {cell.remaining}
                              </span>
                              <span className="text-text-muted"> / {cell.allocated + cell.carriedOver}</span>
                            </button>
                          ) : (
                            // Not "0": this employee has no row for the type,
                            // which is a different fact from an exhausted one.
                            <span className="text-text-muted">—</span>
                          )}
                        </td>
                      );
                    })}

                    <td className="px-4 py-3 text-end">
                      {row.headline ? (
                        <span className="font-semibold tabular-nums text-text-heading">
                          {row.totals.remaining}
                        </span>
                      ) : (
                        <Badge tone="neutral">not set up</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function LeaveBalancesPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <LeaveBalancesContent />
    </ProtectedRoute>
  );
}
