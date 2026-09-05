'use client';

import { Building2 } from 'lucide-react';
import { useDepartments } from '@/hooks/useDepartments';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { fullName } from '@/utils/formatters';

export default function DepartmentsPage() {
  const { data, isLoading, isError } = useDepartments();
  const departments = data?.data ?? [];

  // The heading lives in Topbar; a second one here would give the screen two.
  usePageHeader('Departments', 'Organisational units and who heads them.');

  return (
    <div className="space-y-5">
      {isLoading && <Card className="p-6 text-sm text-text-muted">Loading departments…</Card>}

      {isError && (
        <Card className="p-6 text-sm text-status-error">Could not load departments. Is the API running?</Card>
      )}

      {!isLoading && !isError && departments.length === 0 && (
        <Card>
          <EmptyState
            icon={<Building2 className="h-6 w-6" aria-hidden />}
            title="No departments yet"
            description="Seed data creates an Administration department — run npm run db:seed."
          />
        </Card>
      )}

      {departments.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {departments.map((department) => (
            <Card key={department.id} className="p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{department.code}</p>
              <h2 className="mt-1 text-base font-semibold text-text-heading">{department.name}</h2>
              <dl className="mt-3 space-y-1 text-sm text-text-body">
                <div className="flex justify-between gap-3">
                  <dt className="text-text-muted">Branch</dt>
                  <dd>{department.branch?.name ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-muted">Head</dt>
                  <dd>{fullName(department.manager)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-muted">Employees</dt>
                  <dd className="tabular-nums">{department._count?.employees ?? 0}</dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
