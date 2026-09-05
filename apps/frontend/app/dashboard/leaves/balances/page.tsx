'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Calendar, Pencil, RefreshCw, Users, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useLeaveBalances,
  useLeaveTypes,
  useSetDefaultLeaveAllocation,
  useUpdateLeaveBalance,
  useUpdateLeaveTypeBalance,
} from '@/hooks/useLeaveRequests';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { apiErrorMessage } from '@/utils/apiError';
import type { LeaveBalance, LeaveTypeOption } from '@/types/leave';

/**
 * A colour per leave type, cycled.
 *
 * The list is configured by an admin, so no fixed mapping can cover it. What the
 * cycle has to guarantee is only that two adjacent columns of a wide matrix
 * differ — every entry is a design token, never a raw palette colour.
 */
const TYPE_ACCENTS = [
  { text: 'text-brand-primary', dot: 'bg-brand-primary', chip: 'bg-brand-primary/10' },
  { text: 'text-status-success', dot: 'bg-status-success', chip: 'bg-status-success-bg' },
  { text: 'text-status-warning', dot: 'bg-status-warning', chip: 'bg-status-warning-bg' },
  { text: 'text-status-info', dot: 'bg-status-info', chip: 'bg-status-info-bg' },
  { text: 'text-brand-accent', dot: 'bg-brand-accent', chip: 'bg-brand-accent/10' },
  { text: 'text-status-error', dot: 'bg-status-error', chip: 'bg-status-error-bg' },
] as const;

function accentFor(index: number) {
  return TYPE_ACCENTS[index % TYPE_ACCENTS.length];
}

const YEARS = [2024, 2025, 2026, 2027];

/**
 * Whether a gender-restricted type applies to this employee.
 *
 * Stricter than the employee's own request form on purpose: this is HR's
 * allocation matrix, and a column with no gender recorded prints an em dash
 * rather than a figure that would look like an entitlement nobody granted.
 */
function genderAllowed(restriction: string | null | undefined, gender: string | null | undefined) {
  if (!restriction) return true;
  if (!gender) return false;
  return restriction.toUpperCase() === gender.toUpperCase();
}

/** What one employee holds of one configured type, per-type row or statutory fallback. */
function cellFor(balance: LeaveBalance, type: LeaveTypeOption) {
  const row = balance.leaveTypeBalances?.find((b) => b.leaveTypeKey === type.label);
  if (row) {
    return {
      allocated: row.allocated,
      carriedOver: row.carriedOver,
      remaining: row.remaining,
    };
  }

  const label = type.label.toLowerCase();
  if (label.includes('annual')) {
    return {
      allocated: balance.annualLeave,
      carriedOver: balance.carriedOver,
      remaining:
        balance.remainingAnnual ??
        balance.annualLeave + balance.carriedOver - balance.usedAnnual,
    };
  }
  if (label.includes('sick')) {
    return {
      allocated: balance.sickLeave,
      carriedOver: 0,
      remaining: balance.remainingSick ?? balance.sickLeave - balance.usedSick,
    };
  }

  const allocated = type.defaultDays ?? 0;
  return { allocated, carriedOver: 0, remaining: allocated };
}

type EditRow = { allocated: number; carriedOver: number };

function LeaveBalancesScreen() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [editing, setEditing] = useState<LeaveBalance | null>(null);
  const [editRows, setEditRows] = useState<Record<string, EditRow>>({});
  const [confirmReset, setConfirmReset] = useState(false);

  const balancesQuery = useLeaveBalances(year);
  const leaveTypesQuery = useLeaveTypes();
  const updateTypeBalance = useUpdateLeaveTypeBalance();
  const updateBalance = useUpdateLeaveBalance();
  const setDefaults = useSetDefaultLeaveAllocation();

  const balances = balancesQuery.data?.data ?? [];

  // A type that does not draw down an entitlement has no column here — there is
  // nothing to allocate and nothing to run out of.
  const trackedTypes = useMemo(
    () => (leaveTypesQuery.data?.data ?? []).filter((type) => type.affectsBalance !== false),
    [leaveTypesQuery.data],
  );

  usePageHeader('Leave balances', `Allocations and remaining days for ${year}`);

  const openEditor = (balance: LeaveBalance) => {
    const gender = balance.employee?.gender;
    const rows: Record<string, EditRow> = {};
    for (const type of trackedTypes) {
      if (!genderAllowed(type.genderRestriction, gender)) continue;
      const existing = balance.leaveTypeBalances?.find((b) => b.leaveTypeKey === type.label);
      rows[type.label] = {
        allocated: existing ? existing.allocated : (type.defaultDays ?? 0),
        carriedOver: existing ? existing.carriedOver : 0,
      };
    }
    setEditRows(rows);
    setEditing(balance);
  };

  const saveEdits = async () => {
    if (!editing) return;
    try {
      for (const [leaveTypeKey, row] of Object.entries(editRows)) {
        await updateTypeBalance.mutateAsync({
          employeeId: editing.employeeId,
          year,
          leaveTypeKey,
          allocated: row.allocated,
          carriedOver: row.carriedOver,
        });
      }

      // The two statutory buckets are stored separately from the per-type rows,
      // so an edit to either has to be written to both places or the employee's
      // own screens keep showing the old figure.
      const annual = editRows['Annual Leave']?.allocated ?? editRows['Annual']?.allocated;
      const sick = editRows['Sick Leave']?.allocated ?? editRows['Sick']?.allocated;
      if (annual !== undefined || sick !== undefined) {
        await updateBalance.mutateAsync({
          employeeId: editing.employeeId,
          year,
          annualLeave: annual ?? editing.annualLeave,
          sickLeave: sick ?? editing.sickLeave,
        });
      }

      toast.success('Leave balances updated');
      setEditing(null);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Could not update the balances'));
    }
  };

  const resetToDefaults = async () => {
    try {
      await setDefaults.mutateAsync(year);
      setConfirmReset(false);
      toast.success(`Allocations for ${year} reset to the library defaults`);
    } catch (error) {
      setConfirmReset(false);
      toast.error(apiErrorMessage(error, 'Could not reset the allocations'));
    }
  };

  const restrictedTypes = trackedTypes.filter((type) => type.genderRestriction);

  return (
    <div className="space-y-5" data-testid="leave-balances">
      <div className="flex flex-wrap items-end justify-end gap-3">
        <div className="w-32">
          <Select
            label="Year"
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          >
            {YEARS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="danger" onClick={() => setConfirmReset(true)}>
          Reset to defaults
        </Button>
        <Button
          variant="outline"
          aria-label="Refresh the balances"
          isLoading={balancesQuery.isFetching}
          onClick={() => void balancesQuery.refetch()}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        <StatCard
          label="Staff with balances"
          value={balances.length}
          hint={`for ${year}`}
          icon={<Users className="h-5 w-5" aria-hidden />}
        />
        {trackedTypes.map((type) => {
          const remaining = balances.reduce(
            (sum, balance) => sum + cellFor(balance, type).remaining,
            0,
          );
          return (
            <StatCard
              key={type.id}
              label={type.label}
              value={remaining}
              hint="days across all staff"
              icon={<Calendar className="h-5 w-5" aria-hidden />}
            />
          );
        })}
      </div>

      {restrictedTypes.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 rounded-[var(--radius-card)] border border-surface-border bg-surface-card px-4 py-2.5 text-xs text-text-muted">
          <span className="font-semibold text-text-body">Legend</span>
          {restrictedTypes.map((type) => (
            <span key={type.id} className="flex items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full ${accentFor(trackedTypes.indexOf(type)).dot}`}
                aria-hidden
              />
              {type.label} ({type.genderRestriction} only)
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-surface-border" aria-hidden />— not applicable
          </span>
        </div>
      )}

      <Card>
        {balancesQuery.isLoading && (
          <p className="p-6 text-sm text-text-muted">Loading the balances…</p>
        )}

        {balancesQuery.isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load the balances. Is the API running?
          </p>
        )}

        {!balancesQuery.isLoading && !balancesQuery.isError && balances.length === 0 && (
          <EmptyState
            icon={<Calendar className="h-6 w-6" aria-hidden />}
            title="No balances for this year"
            description="Reset to the library defaults to seed every employee's allocation."
            action={<Button onClick={() => setConfirmReset(true)}>Reset to defaults</Button>}
          />
        )}

        {balances.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Employee</th>
                  <th className="px-5 py-3 text-start font-medium">Department</th>
                  {trackedTypes.map((type, index) => (
                    <th
                      key={type.id}
                      className="whitespace-nowrap px-5 py-3 text-center font-medium"
                    >
                      <span className="flex flex-col items-center gap-1">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={`h-2 w-2 rounded-full ${accentFor(index).dot}`}
                            aria-hidden
                          />
                          {type.label}
                        </span>
                        <span className="text-[10px] font-normal normal-case opacity-70">
                          Remaining / total
                          {type.genderRestriction ? ` · ${type.genderRestriction} only` : ''}
                        </span>
                      </span>
                    </th>
                  ))}
                  <th className="px-5 py-3 text-center font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {balances.map((balance) => {
                  const gender = balance.employee?.gender;
                  return (
                    <tr
                      key={balance.id}
                      data-testid="balance-row"
                      data-employee-id={balance.employeeId}
                      className="hover:bg-surface-border-light/60"
                    >
                      <td className="px-5 py-3">
                        <p className="font-medium text-text-heading">
                          {balance.employee?.fullName ?? '—'}
                        </p>
                        <p className="text-xs text-text-muted">
                          {balance.employee?.employeeCode ?? ''}
                        </p>
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {balance.employee?.department?.name ?? '—'}
                      </td>

                      {trackedTypes.map((type, index) => {
                        const accent = accentFor(index);
                        if (!genderAllowed(type.genderRestriction, gender)) {
                          return (
                            <td
                              key={type.id}
                              data-testid="balance-cell"
                              data-applicable="false"
                              className="px-5 py-3 text-center"
                            >
                              <span className="select-none text-lg font-light text-text-muted">
                                —
                              </span>
                            </td>
                          );
                        }

                        const cell = cellFor(balance, type);
                        const total = cell.allocated + cell.carriedOver;
                        const low = cell.remaining <= 2;
                        return (
                          <td
                            key={type.id}
                            data-testid="balance-cell"
                            data-leave-type={type.label}
                            data-applicable="true"
                            data-remaining={cell.remaining}
                            className="px-5 py-3 text-center"
                          >
                            <span
                              className={`inline-flex flex-col items-center rounded-[var(--radius-card)] px-3 py-1.5 ${accent.chip}`}
                            >
                              <span
                                className={`text-base font-semibold tabular-nums ${
                                  low ? 'text-status-error' : accent.text
                                }`}
                              >
                                {cell.remaining}
                              </span>
                              <span className="text-[10px] tabular-nums text-text-muted">
                                / {total}
                              </span>
                            </span>
                            {cell.carriedOver > 0 && (
                              <span className="mt-0.5 block text-[10px] text-status-success">
                                +{cell.carriedOver} carried
                              </span>
                            )}
                          </td>
                        );
                      })}

                      <td className="px-5 py-3 text-center">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Edit balances for ${balance.employee?.fullName ?? 'this employee'}`}
                          onClick={() => openEditor(balance)}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-lg" data-testid="balance-modal">
            <div className="flex items-start justify-between gap-3 border-b border-surface-border-light px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-text-heading">Update allocations</h2>
                <p className="mt-0.5 text-sm text-text-muted">
                  {editing.employee?.fullName ?? '—'} · {year}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditing(null)}
                aria-label="Close"
                className="rounded-[var(--radius-button)] p-1 text-text-muted hover:bg-surface-border-light"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
              {Object.keys(editRows).length === 0 && (
                <p className="text-sm text-text-muted">
                  No tracked leave types apply to this employee.
                </p>
              )}
              {trackedTypes
                .filter((type) => editRows[type.label] !== undefined)
                .map((type, index) => (
                  <div
                    key={type.id}
                    className={`space-y-3 rounded-[var(--radius-card)] border border-surface-border p-4 ${accentFor(index).chip}`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${accentFor(index).dot}`}
                        aria-hidden
                      />
                      <p className="text-sm font-semibold text-text-heading">{type.label}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Input
                        label="Allocated (days)"
                        type="number"
                        min={0}
                        value={editRows[type.label].allocated}
                        onChange={(event) =>
                          setEditRows((previous) => ({
                            ...previous,
                            [type.label]: {
                              ...previous[type.label],
                              allocated: Number(event.target.value),
                            },
                          }))
                        }
                      />
                      <Input
                        label="Carried over (days)"
                        type="number"
                        min={0}
                        value={editRows[type.label].carriedOver}
                        onChange={(event) =>
                          setEditRows((previous) => ({
                            ...previous,
                            [type.label]: {
                              ...previous[type.label],
                              carriedOver: Number(event.target.value),
                            },
                          }))
                        }
                      />
                    </div>
                  </div>
                ))}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-surface-border-light px-5 py-3">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                data-testid="balance-modal-save"
                isLoading={updateTypeBalance.isPending || updateBalance.isPending}
                onClick={() => void saveEdits()}
              >
                Save changes
              </Button>
            </div>
          </Card>
        </div>
      )}

      {confirmReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md">
            <div className="border-b border-surface-border-light px-5 py-4">
              <h2 className="text-base font-semibold text-text-heading">
                Reset every allocation for {year}
              </h2>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-text-body">
                Every employee&rsquo;s allocation goes back to the library default. Custom
                allocations set by hand are overwritten.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-surface-border-light px-5 py-3">
              <Button variant="ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                isLoading={setDefaults.isPending}
                onClick={() => void resetToDefaults()}
              >
                Reset balances
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function LeaveBalancesPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <LeaveBalancesScreen />
    </ProtectedRoute>
  );
}
