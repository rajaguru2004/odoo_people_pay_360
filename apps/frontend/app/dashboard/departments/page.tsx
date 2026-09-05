'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { GitBranch, Network, Plus } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import DepartmentCardView from '@/components/departments/DepartmentCardView';
import DepartmentFilterPanel from '@/components/departments/DepartmentFilterPanel';
import DepartmentStatsBar from '@/components/departments/DepartmentStatsBar';
import DepartmentTableView from '@/components/departments/DepartmentTableView';
import DepartmentViewSwitcher, {
  type DepartmentViewType,
} from '@/components/departments/DepartmentViewSwitcher';
import {
  departmentStats,
  EMPTY_DEPARTMENT_FILTERS,
  filterDepartments,
  type DepartmentFilters,
} from '@/components/departments/departmentFacts';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBranches } from '@/hooks/useBranches';
import { useDepartments } from '@/hooks/useDepartments';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { datedStem, exportWorkbook } from '@/utils/exportSheet';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';

function DepartmentsContent() {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_DEPARTMENTS');

  const [view, setView] = useState<DepartmentViewType>('cards');
  const [filters, setFilters] = useState<DepartmentFilters>(EMPTY_DEPARTMENT_FILTERS);
  const [exporting, setExporting] = useState(false);

  const branches = useBranches();
  // Every unit, closed ones included, with the STATUS filter deciding what is
  // listed. Asking the API for the open ones only would make the bar above the
  // list report a total it can never contradict.
  const { data, isLoading, isError } = useDepartments({ includeInactive: true });
  const departments = useMemo(() => data?.data ?? [], [data]);

  const filtered = useMemo(
    () => filterDepartments(departments, filters),
    [departments, filters],
  );
  const stats = useMemo(() => departmentStats(departments), [departments]);

  usePageHeader('Departments', `${stats.total} units and who heads them`);

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportWorkbook(datedStem('departments'), [
        {
          name: 'Departments',
          rows: filtered.map((department) => ({
            Code: department.code,
            Name: department.name,
            'Reports to': department.parent?.name,
            Branch: department.branch?.name,
            // Blank rather than "Nobody": the cell is a name column, and a word
            // in it would sort and filter alongside the real names.
            Head: department.manager ? fullName(department.manager) : null,
            People: department._count?.employees ?? 0,
            'Sub-units': department._count?.children ?? 0,
            Teams: department._count?.teams ?? 0,
            Description: department.description,
            Status: department.isActive ? 'Open' : 'Closed',
          })),
        },
      ]);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The export could not be written'));
    } finally {
      setExporting(false);
    }
  };

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

      <DepartmentStatsBar stats={stats} />

      <DepartmentFilterPanel
        filters={filters}
        onChange={setFilters}
        branches={branches.data?.data ?? []}
        shown={filtered.length}
        total={departments.length}
        onExport={() => void handleExport()}
        exporting={exporting}
        trailing={<DepartmentViewSwitcher view={view} onChange={setView} />}
      />

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

      {/* Exactly one view is mounted. Keeping the other behind a hidden class
          would put every unit name on the page twice, which is a real problem
          for anyone reading it with assistive technology. */}
      {filtered.length > 0 && view === 'cards' && <DepartmentCardView departments={filtered} />}

      {filtered.length > 0 && view === 'table' && (
        <Card>
          <DepartmentTableView departments={filtered} />
        </Card>
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
