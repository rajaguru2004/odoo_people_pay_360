'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { RotateCcw, UserPlus } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import {
  useAccrueForEmployee,
  useLeaveAccrualHistory,
  useRunLeaveAccrual,
  useSetDefaultAllocations,
} from '@/hooks/useLeaveBalances';
import { useEmployees } from '@/hooks/useEmployees';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateTime } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';

const CURRENT_YEAR = new Date().getUTCFullYear();
const YEARS = [CURRENT_YEAR + 1, CURRENT_YEAR, CURRENT_YEAR - 1];

/**
 * Where entitlement is granted in bulk, and where every grant is on record.
 *
 * Three ways days reach a balance, and all three are here so nobody has to guess
 * which one moved a number:
 *
 *  1. **The monthly accrual**, which runs itself on the 1st in the COMPANY's
 *     timezone and can be run by hand from here. It is idempotent: an employee
 *     already credited for the month is skipped, so pressing the button twice
 *     credits nobody twice.
 *  2. **A reset to the library defaults**, which sets allocations and
 *     deliberately leaves `used` alone — changing an entitlement is not the same
 *     act as handing back leave already taken.
 *  3. **A manual credit** to one person, for a long-service award or a
 *     correction, which is written to the history below with a reason.
 */
function LeaveAllocationsContent() {
  const [year, setYear] = useState(CURRENT_YEAR);
  const [employeeId, setEmployeeId] = useState('');
  const [days, setDays] = useState('1');
  const [notes, setNotes] = useState('');

  const employees = useEmployees({ limit: 200 });
  const history = useLeaveAccrualHistory({ year });
  const runAccrual = useRunLeaveAccrual();
  const setDefaults = useSetDefaultAllocations();
  const accrueOne = useAccrueForEmployee();

  usePageHeader('Leave allocations', `Grants and accruals for ${year}`);

  const onRunAccrual = async () => {
    try {
      const result = await runAccrual.mutateAsync();
      toast.success(result.message ?? 'Accrual run.');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The accrual could not be run.'));
    }
  };

  const onResetDefaults = async () => {
    try {
      const result = await setDefaults.mutateAsync(year);
      toast.success(result.message ?? 'Allocations reset.');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The allocations could not be reset.'));
    }
  };

  const onCreditOne = async () => {
    const value = Number(days);
    if (!employeeId) {
      toast.error('Pick who the days are for.');
      return;
    }
    if (!Number.isInteger(value) || value < 1) {
      toast.error('Credit at least one whole day.');
      return;
    }
    try {
      await accrueOne.mutateAsync({
        employeeId,
        daysToAdd: value,
        notes: notes.trim() || undefined,
      });
      toast.success(`${value} day(s) credited.`);
      setNotes('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The days could not be credited.'));
    }
  };

  const records = history.data?.data ?? [];

  return (
    <div className="max-w-5xl space-y-5">
      <Card>
        <CardHeader
          title="Bulk"
          subtitle="Both of these are safe to repeat."
          action={
            <Select
              aria-label="Year"
              value={String(year)}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          }
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-[var(--radius-card)] border border-surface-border-light p-4">
            <p className="text-sm font-semibold text-text-heading">Monthly accrual</p>
            <p className="mt-1 text-sm text-text-muted">
              Credits one day of annual leave to every active employee for the
              current company month. Anyone already credited is skipped.
            </p>
            <Button
              className="mt-3"
              size="sm"
              isLoading={runAccrual.isPending}
              onClick={() => void onRunAccrual()}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Run it now
            </Button>
          </div>

          <div className="rounded-[var(--radius-card)] border border-surface-border-light p-4">
            <p className="text-sm font-semibold text-text-heading">
              Reset to the library defaults
            </p>
            <p className="mt-1 text-sm text-text-muted">
              Sets every allocation for {year} from the leave-type library. Days
              already taken are untouched.
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              isLoading={setDefaults.isPending}
              onClick={() => void onResetDefaults()}
            >
              Reset {year} allocations
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Credit one person"
          subtitle="A long-service award, or a correction to a balance."
        />
        <CardBody className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Select
              label="Employee"
              placeholder="Choose somebody"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              {(employees.data?.data ?? []).map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {fullName(employee)} · {employee.employeeCode}
                </option>
              ))}
            </Select>
          </div>
          <Input
            type="number"
            min={1}
            label="Days"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
          <div className="flex items-end">
            <Button
              className="w-full"
              isLoading={accrueOne.isPending}
              onClick={() => void onCreditOne()}
            >
              <UserPlus className="h-4 w-4" aria-hidden />
              Credit
            </Button>
          </div>
          <div className="sm:col-span-4">
            <Input
              label="Why (optional)"
              placeholder="Long-service award"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="History"
          subtitle={`Every credit made in ${year}, automatic or by hand.`}
        />
        {history.isError ? (
          <p className="p-6 text-sm text-status-error">
            {apiErrorMessage(history.error, 'The history could not be loaded.')}
          </p>
        ) : history.isLoading ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-surface-border/60" />
            ))}
          </div>
        ) : records.length === 0 ? (
          <EmptyState
            title="Nothing has been credited yet"
            description={`No accrual has run for ${year}.`}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-surface-border-light">
                  <th scope="col" className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-text-muted">Employee</th>
                  <th scope="col" className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-text-muted">Period</th>
                  <th scope="col" className="px-4 py-3 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">Days</th>
                  <th scope="col" className="px-4 py-3 text-end text-[11px] font-semibold uppercase tracking-wider text-text-muted">Balance</th>
                  <th scope="col" className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-text-muted">Kind</th>
                  <th scope="col" className="px-4 py-3 text-start text-[11px] font-semibold uppercase tracking-wider text-text-muted">When</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} className="border-b border-surface-border-light last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-heading">
                        {record.employee ? fullName(record.employee) : '—'}
                      </p>
                      <p className="text-xs text-text-muted">{record.notes ?? ''}</p>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-text-body">
                      {String(record.month).padStart(2, '0')}/{record.year}
                    </td>
                    <td className="px-4 py-3 text-end font-medium tabular-nums text-text-heading">
                      +{record.daysAdded}
                    </td>
                    <td className="px-4 py-3 text-end tabular-nums text-text-muted">
                      {record.balanceBefore} → {record.balanceAfter}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={record.accrualType === 'AUTO' ? 'neutral' : 'info'}>
                        {record.accrualType === 'AUTO' ? 'Automatic' : 'By hand'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {formatDateTime(record.createdAt)}
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

export default function LeaveAllocationsPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <LeaveAllocationsContent />
    </ProtectedRoute>
  );
}
