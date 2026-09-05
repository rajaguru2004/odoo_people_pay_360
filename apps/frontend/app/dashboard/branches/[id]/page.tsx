'use client';

import { use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Building2,
  Clock,
  Crosshair,
  MapPin,
  Navigation,
  Pencil,
  Trash2,
  User,
  Users,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { StatCard } from '@/components/common/StatCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBranch, useDeleteBranch } from '@/hooks/useBranches';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';

const WEEKDAY_LABELS: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-surface-border-light py-2 last:border-0">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="text-sm font-medium text-text-heading text-end">{value}</dd>
    </div>
  );
}

function BranchDetailContent({ id }: { id: string }) {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_DEPARTMENTS');

  const { data, isLoading, isError } = useBranch(id);
  const branch = data?.data;
  const deleteBranch = useDeleteBranch();

  // Declared above the early returns so the hook order never changes; it falls
  // back to the section name until the record has loaded.
  usePageHeader(branch?.name ?? 'Branch', branch?.code);

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading branch…</Card>;
  }

  if (isError || !branch) {
    return (
      <Card className="p-6 text-sm text-status-error">
        That branch could not be read. It may have been retired.
      </Card>
    );
  }

  const handleDelete = async () => {
    if (!window.confirm(`Retire ${branch.name}? Attendance history keeps resolving.`)) return;
    try {
      const result = await deleteBranch.mutateAsync(id);
      toast.success(result.data?.deleted ? `${branch.name} deleted` : `${branch.name} retired`);
      router.push('/dashboard/branches');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The branch could not be removed'));
    }
  };

  /**
   * The office window as ONE wall clock, printed once.
   *
   * Start and end are not two independent facts to the reader — "when is this
   * place open" is a single question, and splitting the answer across two rows
   * makes them scan for the other half.
   */
  const officeWindow =
    branch.officeStartTime && branch.officeEndTime
      ? `${branch.officeStartTime} – ${branch.officeEndTime}`
      : 'Company default';

  const offDays = branch.weeklyOffDays.length
    ? branch.weeklyOffDays.map((day) => WEEKDAY_LABELS[day] ?? String(day)).join(', ')
    : 'Company default';

  const address = [
    branch.addressLine,
    branch.city,
    branch.state,
    branch.postalCode,
    branch.country,
  ].filter(Boolean);

  const departments = branch.departments ?? [];
  const headcount = branch._count?.employees ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Badge tone={branch.isActive ? 'success' : 'error'}>
          {branch.isActive ? 'Open' : 'Retired'}
        </Badge>

        {canManage && (
          <div className="flex items-center gap-2">
            <Link href={`/dashboard/branches/${id}/edit`}>
              <Button variant="outline" size="sm">
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Button>
            </Link>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              isLoading={deleteBranch.isPending}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Retire
            </Button>
          </div>
        )}
      </div>

      {branch.description && <p className="text-sm text-text-body">{branch.description}</p>}

      {/* The office window is deliberately NOT repeated here: it is one wall
          clock, and printing it twice on a page invites the reader to check
          whether the two agree. It belongs with the rest of the calendar. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Headcount"
          value={headcount}
          hint="People posted here"
          icon={<Users className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Departments"
          value={departments.length}
          icon={<Building2 className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Geofence"
          value={branch.geofencingEnabled ? 'On' : 'Off'}
          hint={
            branch.geofenceRadiusM != null ? `${branch.geofenceRadiusM} m radius` : 'No radius set'
          }
          icon={<Navigation className="h-5 w-5" aria-hidden />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Working calendar"
            subtitle="Anything unset here follows the company setting."
          />
          <CardBody>
            <dl>
              <Row label="Timezone" value={branch.timezone ?? 'Company default'} />
              <Row
                label="Office window"
                value={
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <Clock className="h-4 w-4 text-text-muted" aria-hidden />
                    {officeWindow}
                  </span>
                }
              />
              <Row
                label="Grace"
                value={
                  branch.graceMinutes != null
                    ? `${branch.graceMinutes} minutes`
                    : 'Company default'
                }
              />
              <Row label="Weekly off" value={offDays} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Address" subtitle="Where the location physically is." />
          <CardBody>
            {address.length > 0 ? (
              <p className="flex items-start gap-2 text-sm text-text-body">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden />
                <span>{address.join(', ')}</span>
              </p>
            ) : (
              <p className="text-sm text-text-muted">No address recorded.</p>
            )}

            <dl className="mt-4">
              <Row label="Phone" value={branch.phone ?? '—'} />
              <Row label="Email" value={branch.email ?? '—'} />
              <Row label="CR number" value={branch.crNumber ?? '—'} />
              <Row label="VAT number" value={branch.vatNumber ?? '—'} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Manager" subtitle="Who signs for this location." />
          <CardBody>
            {branch.manager ? (
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-primary/10 text-brand-primary">
                  <User className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-text-heading">
                    {fullName(branch.manager)}
                  </p>
                  <p className="truncate text-sm text-text-muted">
                    {branch.manager.position ?? branch.manager.employeeCode}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                Nobody manages this location yet, so nothing routed by branch has an approver.
              </p>
            )}

            <dl className="mt-4">
              <Row
                label="Fence centre"
                value={
                  branch.latitude != null && branch.longitude != null ? (
                    <span className="inline-flex items-center gap-1.5 tabular-nums">
                      <Crosshair className="h-4 w-4 text-text-muted" aria-hidden />
                      {branch.latitude}, {branch.longitude}
                    </span>
                  ) : (
                    'Not set'
                  )
                }
              />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Units here"
            subtitle={`${departments.length} reporting to this location`}
          />
          <CardBody>
            {departments.length > 0 ? (
              <ul className="space-y-2">
                {departments.map((department) => (
                  <li key={department.id}>
                    <Link
                      href={`/dashboard/departments/${department.id}`}
                      className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-surface-border-light px-3 py-2 text-sm transition-colors hover:bg-surface-page"
                    >
                      <span className="truncate font-medium text-text-heading">
                        {department.name}
                      </span>
                      <span className="shrink-0 text-xs uppercase tracking-wide text-text-muted">
                        {department.code}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">No department sits at this location.</p>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

export default function BranchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  return (
    <ProtectedRoute requiredPermission="VIEW_DEPARTMENTS">
      <BranchDetailContent id={id} />
    </ProtectedRoute>
  );
}
