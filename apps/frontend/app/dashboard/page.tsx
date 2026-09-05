'use client';

import { Building2, Users, Wallet } from 'lucide-react';
import { useEmployees } from '@/hooks/useEmployees';
import { useDepartments } from '@/hooks/useDepartments';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { StatCard } from '@/components/common/StatCard';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { formatCurrency, fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const currency = useBrandingStore((s) => s.branding.default_currency);

  const canSeePeople = hasPermission(user?.role, 'VIEW_EMPLOYEES');

  // `limit: 1` — this card wants the COUNT, which the list endpoint returns in
  // `meta.total`. Fetching a page of rows to call .length on would grow with the
  // headcount for a number the query already has.
  const employees = useEmployees(canSeePeople ? { limit: 1 } : {});
  const departments = useDepartments();

  const headcount = employees.data?.meta?.total ?? 0;
  const departmentCount = departments.data?.data?.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-heading">
          Welcome{user?.employee ? `, ${fullName(user.employee)}` : ''}
        </h1>
        <p className="mt-1 text-sm text-text-muted">Here is where your organisation stands today.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Headcount"
          value={canSeePeople ? headcount : '—'}
          hint={canSeePeople ? 'Across every branch' : 'Not available for your role'}
          icon={<Users className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Departments"
          value={departmentCount}
          icon={<Building2 className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Last payroll"
          value={formatCurrency(0, currency)}
          hint="No run has been posted yet"
          icon={<Wallet className="h-5 w-5" aria-hidden />}
        />
      </div>

      <Card>
        <CardHeader
          title="Getting started"
          subtitle="The base platform is wired end to end — build features on top of it."
        />
        <CardBody>
          <ol className="list-inside list-decimal space-y-2 text-sm text-text-body">
            <li>Add branches and departments under Organisation.</li>
            <li>Import or create employee records.</li>
            <li>Define salary components and per-employee structures.</li>
            <li>Run a payroll period and review the payslips it produces.</li>
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}
