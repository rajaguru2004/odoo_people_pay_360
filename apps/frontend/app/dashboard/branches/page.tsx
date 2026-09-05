'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Archive, Building2, MapPin, Navigation, Plus, Search, Users } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBranches } from '@/hooks/useBranches';
import { useAuthStore } from '@/store/authStore';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { Branch } from '@/types/branch';

/** ISO weekday numbers, 1 = Monday — the convention the API stores. */
const WEEKDAY_LABELS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

function officeWindow(branch: Branch): string | null {
  if (!branch.officeStartTime || !branch.officeEndTime) return null;
  return `${branch.officeStartTime} – ${branch.officeEndTime}`;
}

function BranchTile({ branch }: { branch: Branch }) {
  const staff = branch._count?.employees ?? 0;
  const units = branch._count?.departments ?? branch.departments?.length ?? 0;
  const where = [branch.city, branch.country].filter(Boolean).join(', ');
  const hours = officeWindow(branch);

  return (
    <Link
      href={`/dashboard/branches/${branch.id}`}
      className="surface-panel group flex h-full flex-col gap-4 rounded-[var(--radius-card)] p-5 transition-all"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-card)] bg-brand-primary/10 text-brand-primary transition-colors group-hover:bg-brand-primary group-hover:text-text-on-brand">
          <Building2 className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-text-heading transition-colors group-hover:text-brand-primary">
            {branch.name}
          </h3>
          <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-text-muted">
            {branch.code}
          </p>
        </div>
        {!branch.isActive && <Badge tone="error">Retired</Badge>}
      </div>

      {where && (
        <p className="flex items-center gap-1.5 text-sm text-text-body">
          <MapPin className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
          <span className="truncate">{where}</span>
        </p>
      )}

      {/* Occupancy first: it is the only figure on the card that changes
          without anybody editing the branch. */}
      <dl className="mt-auto grid grid-cols-3 gap-3 border-t border-surface-border-light pt-3 text-sm">
        <div>
          <dt className="text-xs text-text-muted">People</dt>
          <dd className="font-semibold tabular-nums text-text-heading">{staff}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">Units</dt>
          <dd className="font-semibold tabular-nums text-text-heading">{units}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-text-muted">Hours</dt>
          <dd className="truncate font-semibold tabular-nums text-text-heading">
            {hours ?? 'Company default'}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span>
          Manager: <span className="text-text-body">{fullName(branch.manager)}</span>
        </span>
        {branch.weeklyOffDays.length > 0 && (
          <span>
            · Off {branch.weeklyOffDays.map((day) => WEEKDAY_LABELS[day] ?? day).join(', ')}
          </span>
        )}
        {branch.geofencingEnabled && (
          <span className="inline-flex items-center gap-1 text-status-info">
            <Navigation className="h-3 w-3" aria-hidden />
            Geofenced
          </span>
        )}
      </div>
    </Link>
  );
}

function BranchesContent() {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_DEPARTMENTS');

  // A retired branch is hidden from this list and 404s on its detail route, so
  // without the toggle a branch switched off by mistake is unreachable from
  // anywhere in the UI.
  const [showRetired, setShowRetired] = useState(false);
  const [search, setSearch] = useState('');

  const { data, isLoading, isError } = useBranches(showRetired);
  const branches = useMemo(() => data?.data ?? [], [data]);

  usePageHeader('Branches', `${branches.length} locations`);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return branches;
    return branches.filter((branch) =>
      [branch.name, branch.code, branch.city, branch.country]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle)),
    );
  }, [branches, search]);

  const stats = useMemo(
    () => ({
      total: branches.length,
      active: branches.filter((branch) => branch.isActive).length,
      geofenced: branches.filter((branch) => branch.geofencingEnabled).length,
      staff: branches.reduce((sum, branch) => sum + (branch._count?.employees ?? 0), 0),
    }),
    [branches],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {canManage && (
          <Link href="/dashboard/branches/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New branch
            </Button>
          </Link>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Locations"
          value={stats.total}
          icon={<Building2 className="h-5 w-5" aria-hidden />}
        />
        <StatCard label="Open" value={stats.active} hint="Not retired" />
        <StatCard
          label="Geofenced"
          value={stats.geofenced}
          icon={<Navigation className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="People posted"
          value={stats.staff}
          icon={<Users className="h-5 w-5" aria-hidden />}
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full max-w-md">
            <label htmlFor="branch-search" className="sr-only">
              Search branches
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-text-muted"
                aria-hidden
              />
              <input
                id="branch-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name, code or city"
                className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card py-2 pe-3 ps-9 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
              />
            </div>
          </div>

          {canManage && (
            <Button
              variant={showRetired ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={showRetired}
              onClick={() => setShowRetired((value) => !value)}
            >
              <Archive className="h-4 w-4" aria-hidden />
              Include retired
            </Button>
          )}
        </div>
      </Card>

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
            description="No location matches that search, and a retired one is only listed while the toggle is on."
          />
        </Card>
      )}

      {filtered.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((branch) => (
            <BranchTile key={branch.id} branch={branch} />
          ))}
        </div>
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
