'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Building2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import BranchCard from '@/components/branches/BranchCard';
import BranchFilterPanel from '@/components/branches/BranchFilterPanel';
import BranchStatsBar from '@/components/branches/BranchStatsBar';
import BranchTableView from '@/components/branches/BranchTableView';
import BranchViewSwitcher, {
  type BranchViewType,
} from '@/components/branches/BranchViewSwitcher';
import {
  branchCountries,
  branchLocation,
  branchStats,
  EMPTY_BRANCH_FILTERS,
  filterBranches,
  hasCompleteFence,
  officeWindow,
  weeklyOff,
  type BranchFilters,
} from '@/components/branches/branchFacts';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBranches } from '@/hooks/useBranches';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { datedStem, exportWorkbook } from '@/utils/exportSheet';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';

function BranchesContent() {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_DEPARTMENTS');

  const [view, setView] = useState<BranchViewType>('cards');
  const [filters, setFilters] = useState<BranchFilters>(EMPTY_BRANCH_FILTERS);
  const [exporting, setExporting] = useState(false);

  // Every branch, retired ones included, and the status FILTER decides what is
  // listed. Asking the API for the active ones only would make the stats bar
  // report a total that equals the active count on every deployment — the one
  // reading it exists to contradict.
  const { data, isLoading, isError } = useBranches(true);
  const branches = useMemo(() => data?.data ?? [], [data]);

  const filtered = useMemo(() => filterBranches(branches, filters), [branches, filters]);
  const stats = useMemo(() => branchStats(branches), [branches]);
  const countries = useMemo(() => branchCountries(branches), [branches]);

  usePageHeader('Branches', `${stats.total} location${stats.total === 1 ? '' : 's'}`);

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportWorkbook(datedStem('branches'), [
        {
          name: 'Branches',
          rows: filtered.map((branch) => ({
            Code: branch.code,
            Name: branch.name,
            Location: branchLocation(branch),
            Manager: branch.manager ? fullName(branch.manager) : null,
            People: branch._count?.employees ?? 0,
            Departments: branch._count?.departments ?? 0,
            // Blank rather than a made-up window: this branch works the company
            // calendar, and a copied default here would read as an override.
            'Office window': officeWindow(branch),
            'Weekly off': weeklyOff(branch),
            Timezone: branch.timezone,
            'Grace minutes': branch.graceMinutes,
            Geofence: hasCompleteFence(branch) ? 'Applies' : 'Off',
            'Fence radius (m)': hasCompleteFence(branch) ? branch.geofenceRadiusM : null,
            'CR number': branch.crNumber,
            'VAT number': branch.vatNumber,
            Status: branch.isActive ? 'Open' : 'Retired',
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
      {canManage && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href="/dashboard/branches/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New branch
            </Button>
          </Link>
        </div>
      )}

      <BranchStatsBar stats={stats} />

      <BranchFilterPanel
        filters={filters}
        onChange={setFilters}
        countries={countries}
        shown={filtered.length}
        total={branches.length}
        onExport={() => void handleExport()}
        exporting={exporting}
        trailing={<BranchViewSwitcher view={view} onChange={setView} />}
      />

      {isLoading && <Card className="p-6 text-sm text-text-muted">Loading locations…</Card>}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          The location list could not be read. Is the API running?
        </Card>
      )}

      {!isLoading && !isError && filtered.length === 0 && (
        <Card>
          <EmptyState
            icon={<Building2 className="h-6 w-6" aria-hidden />}
            title="Nothing matches"
            description="No location matches the current search and filters. A retired branch is only listed while the status filter asks for one."
          />
        </Card>
      )}

      {/* Exactly one view renders at a time. Keeping the other mounted behind a
          hidden class would print every branch name twice, which is a real
          problem for anyone reading the page with assistive technology. */}
      {filtered.length > 0 && view === 'cards' && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((branch) => (
            <BranchCard key={branch.id} branch={branch} />
          ))}
        </div>
      )}

      {filtered.length > 0 && view === 'table' && (
        <Card>
          <BranchTableView branches={filtered} />
        </Card>
      )}
    </div>
  );
}

export default function BranchesPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_DEPARTMENTS">
      <BranchesContent />
    </ProtectedRoute>
  );
}
