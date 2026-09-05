'use client';

import { useState } from 'react';
import { Users } from 'lucide-react';
import { useEmployees } from '@/hooks/useEmployees';
import { useDebounce } from '@/hooks/useDebounce';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/common/EmptyState';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type { EmployeeStatus } from '@/types/employee';

const STATUS_TONE: Record<EmployeeStatus, 'success' | 'info' | 'warning' | 'error'> = {
  ACTIVE: 'success',
  ON_LEAVE: 'info',
  SUSPENDED: 'warning',
  TERMINATED: 'error',
};

export default function EmployeesPage() {
  const [search, setSearch] = useState('');
  // Debounced so typing does not fire a request per keystroke.
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, isError } = useEmployees({ search: debouncedSearch || undefined, limit: 20 });
  const employees = data?.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-heading">Employees</h1>
          <p className="mt-1 text-sm text-text-muted">
            {data?.meta ? `${data.meta.total} record(s)` : 'Loading…'}
          </p>
        </div>
        <div className="w-full sm:w-72">
          <Input
            placeholder="Search by name, code or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search employees"
          />
        </div>
      </div>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading employees…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">Could not load employees. Is the API running?</p>
        )}

        {!isLoading && !isError && employees.length === 0 && (
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden />}
            title="No employees yet"
            description={
              debouncedSearch
                ? 'Nothing matches that search.'
                : 'Create the first employee record to get started.'
            }
          />
        )}

        {employees.length > 0 && (
          // The wrapper scrolls, not the page: a wide table must never force the
          // whole document into horizontal scroll on a phone.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-surface-border-light text-start text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-5 py-3 text-start font-medium">Code</th>
                  <th className="px-5 py-3 text-start font-medium">Name</th>
                  <th className="px-5 py-3 text-start font-medium">Department</th>
                  <th className="px-5 py-3 text-start font-medium">Position</th>
                  <th className="px-5 py-3 text-start font-medium">Hired</th>
                  <th className="px-5 py-3 text-start font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {employees.map((employee) => (
                  <tr key={employee.id} className="hover:bg-surface-border-light/60">
                    <td className="px-5 py-3 font-medium text-text-heading">{employee.employeeCode}</td>
                    <td className="px-5 py-3 text-text-body">{fullName(employee)}</td>
                    <td className="px-5 py-3 text-text-body">{employee.department?.name ?? '—'}</td>
                    <td className="px-5 py-3 text-text-body">{employee.position ?? '—'}</td>
                    <td className="px-5 py-3 text-text-body">{formatDateOnly(employee.hireDate)}</td>
                    <td className="px-5 py-3">
                      <Badge tone={STATUS_TONE[employee.status]}>{employee.status.replace(/_/g, ' ')}</Badge>
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
