'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, Search, Wallet, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import SalaryStructureTable from '@/components/payroll/SalaryStructureTable';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { useBranches } from '@/hooks/useBranches';
import { useDebounce } from '@/hooks/useDebounce';
import { useDepartments } from '@/hooks/useDepartments';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useSalaryComponents } from '@/hooks/useSalaryComponents';
import { useSalaryStructures } from '@/hooks/useSalaryStructures';
import { useAuthStore } from '@/store/authStore';
import { hasPermission } from '@/utils/permissions';
import type { SalaryStructureListQuery } from '@/types/salaryStructure';

const PAGE_SIZE = 20;

/**
 * The assignment register.
 *
 * `SalaryStructure.employeeId` is `@unique`, so there is exactly one structure
 * per person and ASSIGNING one IS creating theirs. That is why the button says
 * "Assign a structure" rather than "New structure", and why the empty state
 * talks about people rather than about records: a reader looking for a
 * catalogue of reusable templates will not find one here, and should be told so
 * rather than left hunting.
 */
function SalaryStructuresList() {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_PAYROLL');

  const [search, setSearch] = useState('');
  const [branchId, setBranchId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(search, 300);

  // Narrowing resets the page in the same handler. Left to an effect, the
  // reader sees page 4 of a shorter result — an empty table that reads as "no
  // matches" — before it corrects itself.
  const narrow = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const query = useMemo<SalaryStructureListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
      ...(branchId ? { branchId } : {}),
      ...(departmentId ? { departmentId } : {}),
    }),
    [page, debouncedSearch, branchId, departmentId],
  );

  const { data, isLoading, isError, error } = useSalaryStructures(query);
  const branches = useBranches();
  const departments = useDepartments(branchId ? { branchId } : {});

  // Counted in the database and read off the envelope, never from the length of
  // a page: a register of twenty rows is not the size of the payroll.
  const assigned = useSalaryStructures({ page: 1, limit: 1 });
  const catalogue = useSalaryComponents({ page: 1, limit: 1 });
  const activeCatalogue = useSalaryComponents({ page: 1, limit: 1, isActive: true });

  const structures = data?.data ?? [];
  const total = data?.meta?.total;

  usePageHeader(
    'Salary structures',
    total === undefined
      ? undefined
      : `${total} employee${total === 1 ? '' : 's'} assigned`,
  );

  const filtered = Boolean(debouncedSearch.trim() || branchId || departmentId);

  return (
    <div className="space-y-5">
      {canManage && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href="/dashboard/payroll/salary-components">
            <Button variant="outline">Salary rules</Button>
          </Link>
          <Link href="/dashboard/payroll/structures/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              Assign a structure
            </Button>
          </Link>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Employees assigned" value={assigned.data?.meta?.total} />
        <Stat label="Components in the catalogue" value={catalogue.data?.meta?.total} />
        <Stat label="Still active" value={activeCatalogue.data?.meta?.total} />
      </div>

      <Card className="space-y-4 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full lg:max-w-md">
            <Input
              value={search}
              onChange={(event) => narrow(() => setSearch(event.target.value))}
              aria-label="Search salary structures"
              placeholder="Employee code, first or last name"
              icon={<Search className="h-4 w-4" aria-hidden />}
            />
          </div>

          <div className="grid w-full gap-3 sm:grid-cols-2 lg:w-auto lg:min-w-[26rem]">
            <Select
              label="Branch"
              placeholder="Every branch"
              value={branchId}
              onChange={(event) =>
                narrow(() => {
                  setBranchId(event.target.value);
                  // The department list is scoped to the branch, so a
                  // department chosen under the old one would filter to nothing.
                  setDepartmentId('');
                })
              }
            >
              {(branches.data?.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </Select>

            <Select
              label="Department"
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
          </div>
        </div>

        {filtered && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-border-light pt-3">
            <p className="text-sm text-text-muted">
              Showing{' '}
              <span className="font-medium tabular-nums text-text-body">
                {structures.length}
              </span>{' '}
              of{' '}
              {/* An em dash while the count is unknown: "of 0" would read as an
                  empty register rather than an answer that has not arrived. */}
              <span className="font-medium tabular-nums text-text-body">{total ?? '—'}</span>
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                narrow(() => {
                  setSearch('');
                  setBranchId('');
                  setDepartmentId('');
                })
              }
            >
              <X className="h-4 w-4" aria-hidden />
              Clear filters
            </Button>
          </div>
        )}
      </Card>

      {isLoading && (
        <Card className="p-6 text-sm text-text-muted">Loading salary structures…</Card>
      )}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          {/* The interceptor rejects with a FLAT object, so the server's own
              sentence is on `message` and nowhere else. */}
          {(error as { message?: string } | null)?.message ??
            'Could not load salary structures.'}
        </Card>
      )}

      {!isLoading && !isError && structures.length === 0 && (
        <Card>
          <EmptyState
            icon={<Wallet className="h-6 w-6" aria-hidden />}
            title={filtered ? 'No matches' : 'Nobody has been assigned yet'}
            description={
              filtered
                ? 'Nothing matches that search. Try a different name, code, branch or department.'
                : 'Each employee has one salary structure, so assigning one means creating theirs. Nobody can be paid until they have one.'
            }
            action={
              !filtered && canManage ? (
                <Link href="/dashboard/payroll/structures/new">
                  <Button>
                    <Plus className="h-4 w-4" aria-hidden />
                    Assign a structure
                  </Button>
                </Link>
              ) : undefined
            }
          />
        </Card>
      )}

      {structures.length > 0 && (
        <Card>
          <SalaryStructureTable structures={structures} />
          <Pagination meta={data?.meta} onPageChange={setPage} />
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
      {/* An em dash until the figure arrives. A 0 would be a claim. */}
      <p className="mt-1 text-2xl font-semibold tabular-nums text-text-heading">
        {value ?? '—'}
      </p>
    </Card>
  );
}

export default function SalaryStructuresPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      <SalaryStructuresList />
    </ProtectedRoute>
  );
}
