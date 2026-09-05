'use client';

import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ComponentTypeBadge from '@/components/payroll/ComponentTypeBadge';
import SalaryComponentForm from '@/components/payroll/SalaryComponentForm';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useActivateSalaryComponent,
  useDeactivateSalaryComponent,
  useSalaryComponent,
} from '@/hooks/useSalaryComponents';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { hasPermission } from '@/utils/permissions';
import type { ApiResponse } from '@/types/api';
import type { SalaryComponent } from '@/types/salaryStructure';

/** `GET /salary-components/:id` counts what is behind the row. */
type ComponentDetail = SalaryComponent & {
  _count?: { structureLines?: number; payslipLines?: number };
};

function SalaryComponentDetail({ id }: { id: string }) {
  const role = useAuthStore((s) => s.user?.role);
  const canManage = hasPermission(role, 'MANAGE_SALARY_COMPONENTS');

  const { data, isLoading, isError, error } = useSalaryComponent(id);
  const deactivate = useDeactivateSalaryComponent();
  const activate = useActivateSalaryComponent();

  const component = data?.data as ComponentDetail | undefined;

  usePageHeader(
    component?.code ?? 'Salary component',
    component ? component.name : undefined,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the component…</Card>;
  }

  if (isError || !component) {
    return (
      <Card className="p-6 text-sm text-status-error">
        {(error as { message?: string } | null)?.message ??
          'Could not load this salary component.'}
      </Card>
    );
  }

  const toggle = async () => {
    try {
      // The shared mutation helper is generic over its VARIABLES only, so its
      // result is typed `unknown`; the service it wraps resolves the envelope.
      const result = (await (component.isActive
        ? deactivate.mutateAsync(component.id)
        : activate.mutateAsync(component.id))) as ApiResponse<SalaryComponent>;
      // The server's own sentence names how many structures still use it, which
      // is the fact the reader needs next.
      toast.success(
        result.message ??
          (component.isActive
            ? 'Salary component deactivated'
            : 'Salary component reactivated'),
      );
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not change this component'));
    }
  };

  const structureLines = component._count?.structureLines;
  const payslipLines = component._count?.payslipLines;

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-lg font-semibold text-text-heading">
            {component.code}
          </span>
          <ComponentTypeBadge type={component.type} />
          {component.isActive ? (
            <Badge tone="success">Active</Badge>
          ) : (
            <Badge tone="warning">Retired</Badge>
          )}
          {component.createdAt && (
            <span className="text-sm text-text-muted">
              Added {formatDateOnly(component.createdAt)}
            </span>
          )}
        </div>

        {canManage && (
          // Retirement, never deletion. There is no DELETE on this resource: a
          // component behind a payslip line has to keep resolving.
          <Button
            variant="outline"
            isLoading={deactivate.isPending || activate.isPending}
            onClick={() => void toggle()}
          >
            {component.isActive ? 'Deactivate' : 'Activate'}
          </Button>
        )}
      </Card>

      {(structureLines !== undefined || payslipLines !== undefined) && (
        <Card className="p-5 text-sm text-text-muted">
          {/* Counts from the database. An em dash where none arrived, because a
              0 would claim nothing depends on this component. */}
          <span className="font-medium tabular-nums text-text-body">
            {structureLines ?? '—'}
          </span>{' '}
          salary structure{structureLines === 1 ? '' : 's'} and{' '}
          <span className="font-medium tabular-nums text-text-body">
            {payslipLines ?? '—'}
          </span>{' '}
          payslip line{payslipLines === 1 ? '' : 's'} point at this component.
          Retiring it leaves every one of them untouched and simply stops it being
          offered for a new structure.
        </Card>
      )}

      {canManage ? (
        <SalaryComponentForm component={component} />
      ) : (
        <Card className="p-6 text-sm text-text-muted">
          You can read this component but not change it.
        </Card>
      )}
    </div>
  );
}

export default function SalaryComponentPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      <SalaryComponentDetail id={id} />
    </ProtectedRoute>
  );
}
