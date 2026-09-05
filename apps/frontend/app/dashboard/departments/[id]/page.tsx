'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import {
  Building2,
  GitPullRequestArrow,
  Layers,
  Mail,
  Pencil,
  User,
  Users,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ChangeRequestForm from '@/components/departments/ChangeRequestForm';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useDepartment } from '@/hooks/useDepartments';
import { useAuthStore } from '@/store/authStore';
import { fullName, initials } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
  ACTIVE: 'success',
  ON_LEAVE: 'warning',
  SUSPENDED: 'warning',
  TERMINATED: 'error',
};

function DepartmentDetailContent({ id }: { id: string }) {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_DEPARTMENTS');
  const [requesting, setRequesting] = useState(false);

  const { data, isLoading, isError } = useDepartment(id);
  const department = data?.data;

  usePageHeader(department?.name ?? 'Department', department?.code);

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading department…</Card>;
  }

  if (isError || !department) {
    return (
      <Card className="p-6 text-sm text-status-error">That department could not be read.</Card>
    );
  }

  const roster = department.employees ?? [];
  const children = department.children ?? [];
  const headcount = department._count?.employees ?? roster.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={department.isActive ? 'success' : 'error'}>
            {department.isActive ? 'Open' : 'Closed'}
          </Badge>
          {!department.managerId && <Badge tone="warning">No head</Badge>}
        </div>

        <div className="flex items-center gap-2">
          {/* A change request is the route for anything that needs a second
              pair of eyes; editing is the route for anything that does not. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRequesting((value) => !value)}
            aria-expanded={requesting}
          >
            <GitPullRequestArrow className="h-4 w-4" aria-hidden />
            Request a change
          </Button>
          {canManage && (
            <Link href={`/dashboard/departments/${id}/edit`}>
              <Button variant="outline" size="sm">
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Button>
            </Link>
          )}
        </div>
      </div>

      {department.description && (
        <p className="text-sm text-text-body">{department.description}</p>
      )}

      {requesting && (
        <Card>
          <CardHeader
            title="Request a change"
            subtitle="Raised for review rather than applied now — the reviewer sees your reason and the impact."
          />
          <CardBody>
            <ChangeRequestForm department={department} onDone={() => setRequesting(false)} />
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Headcount"
          value={headcount}
          icon={<Users className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Sub-units"
          value={children.length}
          icon={<Layers className="h-5 w-5" aria-hidden />}
        />
        <StatCard label="Teams" value={department._count?.teams ?? 0} />
        <StatCard
          label="Branch"
          value={department.branch?.name ?? 'Unassigned'}
          icon={<Building2 className="h-5 w-5" aria-hidden />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Head" subtitle="Who approves what this unit routes." />
          <CardBody>
            {department.manager ? (
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-primary/10 text-sm font-semibold text-brand-primary">
                  {initials(department.manager)}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-text-heading">
                    {fullName(department.manager)}
                  </p>
                  <p className="truncate text-sm text-text-muted">
                    {department.manager.position ?? department.manager.employeeCode}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-status-warning">
                Nobody heads this unit, so the {headcount} {headcount === 1 ? 'person' : 'people'}{' '}
                in it have no approver.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Placement" subtitle="Where this unit sits in the structure." />
          <CardBody>
            <dl className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-text-muted">Reports to</dt>
                <dd className="truncate text-end font-medium text-text-heading">
                  {department.parent ? (
                    <Link
                      href={`/dashboard/departments/${department.parent.id}`}
                      className="hover:text-brand-primary hover:underline"
                    >
                      {department.parent.name}
                    </Link>
                  ) : (
                    'Top level'
                  )}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-text-muted">Location</dt>
                <dd className="truncate text-end font-medium text-text-heading">
                  {department.branch ? (
                    <Link
                      href={`/dashboard/branches/${department.branch.id}`}
                      className="hover:text-brand-primary hover:underline"
                    >
                      {department.branch.name}
                    </Link>
                  ) : (
                    'Unassigned'
                  )}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-text-muted">Code</dt>
                <dd className="font-medium uppercase text-text-heading">{department.code}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Sub-units" subtitle={`${children.length} reporting to this one`} />
          <CardBody>
            {children.length > 0 ? (
              <ul className="space-y-2">
                {children.map((child) => (
                  <li key={child.id}>
                    <Link
                      href={`/dashboard/departments/${child.id}`}
                      className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-surface-border-light px-3 py-2 text-sm transition-colors hover:bg-surface-page"
                    >
                      <span className="truncate font-medium text-text-heading">{child.name}</span>
                      <span className="shrink-0 text-xs uppercase tracking-wide text-text-muted">
                        {child.code}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">Nothing reports to this unit.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Roster"
          subtitle={`${roster.length} on the books here`}
          action={
            <Link
              href={`/dashboard/employees?departmentId=${department.id}`}
              className="text-sm font-medium text-brand-primary hover:underline"
            >
              Open in directory
            </Link>
          }
        />
        {roster.length > 0 ? (
          // The table scrolls inside its own box so a long position name never
          // puts a scrollbar on the page.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-surface-border-light text-start text-xs uppercase tracking-wide text-text-muted">
                  <th scope="col" className="px-5 py-2.5 text-start font-medium">
                    Employee
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-start font-medium">
                    Position
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-start font-medium">
                    Work email
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-start font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {roster.map((employee) => (
                  <tr
                    key={employee.id}
                    className="border-b border-surface-border-light last:border-0"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/dashboard/employees/${employee.id}`}
                        className="flex items-center gap-2 font-medium text-text-heading hover:text-brand-primary"
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-primary">
                          {initials(employee)}
                        </span>
                        <span className="truncate">{fullName(employee)}</span>
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-text-body">{employee.position ?? '—'}</td>
                    <td className="px-5 py-3 text-text-body">
                      {employee.workEmail ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5 text-text-muted" aria-hidden />
                          <span className="truncate">{employee.workEmail}</span>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={STATUS_TONE[employee.status] ?? 'neutral'}>
                        {employee.status.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<User className="h-6 w-6" aria-hidden />}
            title="Nobody here yet"
            description="No employee is posted to this unit."
          />
        )}
      </Card>
    </div>
  );
}

export default function DepartmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  return (
    <ProtectedRoute requiredPermission="VIEW_DEPARTMENTS">
      <DepartmentDetailContent id={id} />
    </ProtectedRoute>
  );
}
