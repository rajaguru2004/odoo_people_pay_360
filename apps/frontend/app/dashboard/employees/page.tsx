'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Search, Users } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { useBranches } from '@/hooks/useBranches';
import { useDebounce } from '@/hooks/useDebounce';
import { useDepartments } from '@/hooks/useDepartments';
import { useEmployees } from '@/hooks/useEmployees';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { EmployeeListQuery, EmployeeStatus } from '@/types/employee';

const STATUS_TONE: Record<EmployeeStatus, 'success' | 'info' | 'warning' | 'error'> = {
  ACTIVE: 'success',
  ON_LEAVE: 'info',
  SUSPENDED: 'warning',
  TERMINATED: 'error',
};

const STATUS_OPTIONS: Array<{ value: EmployeeStatus; label: string }> = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'TERMINATED', label: 'Terminated' },
];

type SortColumn = NonNullable<EmployeeListQuery['sortBy']>;

const PAGE_SIZE = 20;

/**
 * A column header that also sorts, with the direction stated for a screen
 * reader rather than only drawn as an arrow.
 *
 * Clicking the column already being sorted flips the direction; clicking a
 * different one starts it ascending, which is what a reader expects from every
 * other table they have used.
 */
function SortableHeader({
  column,
  label,
  active,
  order,
  onSort,
}: {
  column: SortColumn;
  label: string;
  active: boolean;
  order: 'asc' | 'desc';
  onSort: (column: SortColumn) => void;
}) {
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;

  return (
    <th
      scope="col"
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="px-5 py-3 text-start font-medium"
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1.5 uppercase tracking-wide transition-colors hover:text-text-body ${
          active ? 'text-text-body' : ''
        }`}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden />
      </button>
    </th>
  );
}

function EmployeeDirectory() {
  const role = useAuthStore((s) => s.user?.role);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [sortBy, setSortBy] = useState<SortColumn>('employeeCode');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);

  // Debounced so typing does not fire a request per keystroke.
  const debouncedSearch = useDebounce(search, 300);

  /**
   * Narrowing the list invalidates where the reader is in it.
   *
   * Done in the handler rather than in an effect on the query: an effect would
   * render page 4 of the new, shorter result first — an empty table that reads
   * as "no matches" — and only then correct itself.
   */
  const narrow = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const query = useMemo<EmployeeListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      search: debouncedSearch || undefined,
      status: (status || undefined) as EmployeeStatus | undefined,
      departmentId: departmentId || undefined,
      branchId: branchId || undefined,
      sortBy,
      sortOrder,
    }),
    [page, debouncedSearch, status, departmentId, branchId, sortBy, sortOrder],
  );

  const { data, isLoading, isError } = useEmployees(query);
  const departments = useDepartments();
  const branches = useBranches();

  const employees = data?.data ?? [];
  const total = data?.meta?.total;

  usePageHeader(
    'Employees',
    total === undefined ? undefined : `${total} record${total === 1 ? '' : 's'}`,
  );

  const handleSort = (column: SortColumn) =>
    narrow(() => {
      if (column === sortBy) {
        setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortBy(column);
        setSortOrder('asc');
      }
    });

  const filtered = Boolean(debouncedSearch || status || departmentId || branchId);

  return (
    <div className="space-y-5">
      {/* Hidden for a role that cannot create, exactly as the rail hides the
          nav entry. The server refuses the POST either way — this is about not
          offering an action that is going to be turned down. */}
      {hasPermission(role, 'CREATE_EMPLOYEE') && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href="/dashboard/employees/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New employee
            </Button>
          </Link>
        </div>
      )}

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Input
            value={search}
            onChange={(event) => narrow(() => setSearch(event.target.value))}
            aria-label="Search employees"
            placeholder="Name, code or work email"
            icon={<Search className="h-4 w-4" aria-hidden />}
          />
          <Select
            aria-label="Filter by department"
            placeholder="Every department"
            value={departmentId}
            onChange={(event) => narrow(() => setDepartmentId(event.target.value))}
          >
            {(departments.data?.data ?? []).map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by branch"
            placeholder="Every branch"
            value={branchId}
            onChange={(event) => narrow(() => setBranchId(event.target.value))}
          >
            {(branches.data?.data ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by status"
            placeholder="Every status"
            value={status}
            onChange={(event) => narrow(() => setStatus(event.target.value))}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading employees…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load the directory. Is the API running?
          </p>
        )}

        {!isLoading && !isError && employees.length === 0 && (
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden />}
            title={filtered ? 'No matches' : 'No records yet'}
            description={
              filtered
                ? 'Nothing matches that search. Try a different name, code or filter.'
                : 'Create the first employee record to get started.'
            }
          />
        )}

        {employees.length > 0 && (
          // The wrapper scrolls, not the page: a wide table must never force the
          // whole document into horizontal scroll on a phone.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <SortableHeader
                    column="employeeCode"
                    label="Code"
                    active={sortBy === 'employeeCode'}
                    order={sortOrder}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="firstName"
                    label="Name"
                    active={sortBy === 'firstName'}
                    order={sortOrder}
                    onSort={handleSort}
                  />
                  <th scope="col" className="px-5 py-3 text-start font-medium">
                    Department
                  </th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">
                    Branch
                  </th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">
                    Position
                  </th>
                  <SortableHeader
                    column="hireDate"
                    label="Hired"
                    active={sortBy === 'hireDate'}
                    order={sortOrder}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="status"
                    label="Status"
                    active={sortBy === 'status'}
                    order={sortOrder}
                    onSort={handleSort}
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {employees.map((employee) => (
                  <tr key={employee.id} className="hover:bg-surface-border-light/60">
                    <td className="px-5 py-3 font-medium text-text-heading">
                      {employee.employeeCode}
                    </td>
                    <td className="px-5 py-3">
                      {/* A real anchor rather than a row click handler, so the
                          record can be opened in a new tab from the list. */}
                      <Link
                        href={`/dashboard/employees/${employee.id}`}
                        className="font-medium text-brand-primary hover:underline"
                      >
                        {fullName(employee)}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-text-body">{employee.department?.name ?? '—'}</td>
                    <td className="px-5 py-3 text-text-body">{employee.branch?.name ?? '—'}</td>
                    <td className="px-5 py-3 text-text-body">{employee.position ?? '—'}</td>
                    <td className="px-5 py-3 text-text-body">{formatDateOnly(employee.hireDate)}</td>
                    <td className="px-5 py-3">
                      <Badge tone={STATUS_TONE[employee.status]}>
                        {employee.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>
    </div>
  );
}

export default function EmployeesPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_EMPLOYEES">
      <EmployeeDirectory />
    </ProtectedRoute>
  );
}
