'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { GitBranch, Network, Plus, Search, UserX, Users } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBranches } from '@/hooks/useBranches';
import { useDepartments } from '@/hooks/useDepartments';
import { useAuthStore } from '@/store/authStore';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { Department } from '@/types/department';

function DepartmentTile({ department }: { department: Department }) {
  const headcount = department._count?.employees ?? 0;
  const subUnits = department._count?.children ?? department.children?.length ?? 0;

  return (
    <Link
      href={`/dashboard/departments/${department.id}`}
      className="surface-panel group flex h-full flex-col gap-4 rounded-[var(--radius-card)] p-5 transition-all"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-card)] bg-brand-primary/10 text-brand-primary transition-colors group-hover:bg-brand-primary group-hover:text-text-on-brand">
          <Network className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-text-heading transition-colors group-hover:text-brand-primary">
            {department.name}
          </h3>
          <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-text-muted">
            {department.code}
          </p>
        </div>
        {!department.isActive && <Badge tone="error">Closed</Badge>}
      </div>

      <dl className="space-y-1.5 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-text-muted">Branch</dt>
          <dd className="truncate text-text-body">{department.branch?.name ?? 'Unassigned'}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-text-muted">Reports to</dt>
          <dd className="truncate text-text-body">{department.parent?.name ?? 'Top level'}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-text-muted">Head</dt>
          {/* A department with no head is not a blank field — the people in it
              have no approver, which is the whole point of flagging it. */}
          <dd
            className={`truncate ${department.manager ? 'text-text-body' : 'font-medium text-status-warning'}`}
          >
            {department.manager ? fullName(department.manager) : 'Nobody'}
          </dd>
        </div>
      </dl>

      <div className="mt-auto grid grid-cols-2 gap-3 border-t border-surface-border-light pt-3 text-sm">
        <div>
          <p className="text-xs text-text-muted">People</p>
          <p className="font-semibold tabular-nums text-text-heading">{headcount}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Sub-units</p>
          <p className="font-semibold tabular-nums text-text-heading">{subUnits}</p>
        </div>
      </div>
    </Link>
  );
}

function DepartmentsContent() {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_DEPARTMENTS');

  const [search, setSearch] = useState('');
  const [branchId, setBranchId] = useState('');
  const [headlessOnly, setHeadlessOnly] = useState(false);

  const branches = useBranches();
  const { data, isLoading, isError } = useDepartments(branchId ? { branchId } : {});
  const departments = useMemo(() => data?.data ?? [], [data]);

  usePageHeader('Departments', `${departments.length} units and who heads them`);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return departments.filter((department) => {
      if (headlessOnly && department.managerId) return false;
      if (!needle) return true;
      return [department.name, department.code, department.description]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle));
    });
  }, [departments, search, headlessOnly]);

  const stats = useMemo(
    () => ({
      total: departments.length,
      topLevel: departments.filter((department) => !department.parentId).length,
      headless: departments.filter((department) => !department.managerId).length,
      people: departments.reduce(
        (sum, department) => sum + (department._count?.employees ?? 0),
        0,
      ),
    }),
    [departments],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Link href="/dashboard/departments/tree">
          <Button variant="outline">
            <GitBranch className="h-4 w-4" aria-hidden />
            Chart view
          </Button>
        </Link>
        {canManage && (
          <Link href="/dashboard/departments/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New department
            </Button>
          </Link>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Units"
          value={stats.total}
          icon={<Network className="h-5 w-5" aria-hidden />}
        />
        <StatCard label="Top level" value={stats.topLevel} hint="Reporting to nobody" />
        <StatCard
          label="Without a head"
          value={stats.headless}
          hint="Nothing routed here has an approver"
          icon={<UserX className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="People placed"
          value={stats.people}
          icon={<Users className="h-5 w-5" aria-hidden />}
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="w-full sm:max-w-xs">
              <label htmlFor="department-search" className="sr-only">
                Search departments
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-text-muted"
                  aria-hidden
                />
                <input
                  id="department-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name or code"
                  className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card py-2 pe-3 ps-9 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                />
              </div>
            </div>

            <div className="w-full sm:w-56">
              <label
                htmlFor="department-branch"
                className="mb-1.5 block text-xs font-medium text-text-muted"
              >
                Branch
              </label>
              <select
                id="department-branch"
                value={branchId}
                onChange={(event) => setBranchId(event.target.value)}
                className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
              >
                <option value="">Every location</option>
                {(branches.data?.data ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <Button
            variant={headlessOnly ? 'primary' : 'outline'}
            size="sm"
            aria-pressed={headlessOnly}
            onClick={() => setHeadlessOnly((value) => !value)}
          >
            <UserX className="h-4 w-4" aria-hidden />
            Only without a head
          </Button>
        </div>
      </Card>

      {isLoading && <Card className="p-6 text-sm text-text-muted">Loading units…</Card>}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          The unit list could not be read. Is the API running?
        </Card>
      )}

      {!isLoading && !isError && filtered.length === 0 && (
        <Card>
          <EmptyState
            icon={<Network className="h-6 w-6" aria-hidden />}
            title="Nothing matches"
            description="No unit matches the current search and filters."
          />
        </Card>
      )}

      {filtered.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((department) => (
            <DepartmentTile key={department.id} department={department} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function DepartmentsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_DEPARTMENTS">
      <DepartmentsContent />
    </ProtectedRoute>
  );
}
