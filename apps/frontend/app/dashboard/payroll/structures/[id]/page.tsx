'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ComponentTypeBadge from '@/components/payroll/ComponentTypeBadge';
import SalaryStructureForm from '@/components/payroll/SalaryStructureForm';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useDeleteSalaryStructure,
  useSalaryStructure,
} from '@/hooks/useSalaryStructures';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName } from '@/utils/formatters';
import { toAmount } from '@/utils/payrollTotals';
import { hasPermission } from '@/utils/permissions';
import type { SalaryStructureLine } from '@/types/salaryStructure';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-body">{children || '—'}</dd>
    </div>
  );
}

/**
 * The three buckets, exactly as the calculator draws them.
 *
 * Employer contributions are recorded and never paid: outside gross, outside
 * deductions and outside net. Net floors at zero — deductions exceeding
 * earnings is a data problem, not a negative wage.
 */
function bucketise(lines: SalaryStructureLine[]) {
  let gross = 0;
  let deductions = 0;
  let employerCost = 0;

  for (const line of lines) {
    const amount = toAmount(line.amount);
    if (line.component?.type === 'EARNING') gross += amount;
    else if (line.component?.type === 'DEDUCTION') deductions += amount;
    else if (line.component?.type === 'EMPLOYER_CONTRIBUTION') employerCost += amount;
  }

  return { gross, deductions, net: Math.max(0, gross - deductions), employerCost };
}

function SalaryStructureDetail({ id }: { id: string }) {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { data, isLoading, isError, error } = useSalaryStructure(id);
  const removeStructure = useDeleteSalaryStructure();
  const structure = data?.data;

  usePageHeader(
    structure ? fullName(structure.employee) : 'Salary structure',
    structure
      ? `${structure.currency} · effective ${formatDateOnly(structure.effectiveFrom)}`
      : undefined,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the salary structure…</Card>;
  }

  if (isError || !structure) {
    return (
      <Card className="p-6 text-sm text-status-error">
        {(error as { message?: string } | null)?.message ??
          'Could not load this salary structure.'}
      </Card>
    );
  }

  const lines = structure.lines ?? [];
  const totals = bucketise(lines);
  const canManage = hasPermission(role, 'MANAGE_PAYROLL');
  // DELETE is ADMIN-only server-side, and refused outright once the employee has
  // a payslip. Offering it to anyone else would be a button that only ever
  // produces a 403.
  const canDelete = role === 'ADMIN';

  const handleDelete = async () => {
    try {
      await removeStructure.mutateAsync(structure.id);
      toast.success('Salary structure deleted');
      router.push('/dashboard/payroll/structures');
    } catch (err) {
      setConfirmingDelete(false);
      // The refusal names the payslip count. It is the whole answer, so it is
      // shown rather than replaced with a generic failure.
      toast.error(apiErrorMessage(err, 'Could not delete this salary structure'));
    }
  };

  if (editing) {
    return (
      <SalaryStructureForm
        structure={structure}
        onSaved={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <dl className="grid flex-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Employee">
            <Link
              href={`/dashboard/employees/${structure.employeeId}`}
              className="text-brand-primary hover:underline"
            >
              {fullName(structure.employee)}
            </Link>
          </Fact>
          <Fact label="Employee code">{structure.employee?.employeeCode}</Fact>
          <Fact label="Department">{structure.employee?.department?.name}</Fact>
          {/* Date only — never an instant parse. */}
          <Fact label="Effective from">{formatDateOnly(structure.effectiveFrom)}</Fact>
        </dl>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden />
              Edit
            </Button>
            {canDelete && !confirmingDelete && (
              <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
                <Trash2 className="h-4 w-4" aria-hidden />
                Delete
              </Button>
            )}
          </div>
        )}
      </Card>

      {confirmingDelete && (
        <Card className="border-status-error p-5">
          <p className="text-sm text-text-body">
            Deleting removes the only record of what {fullName(structure.employee)} was
            assigned. Payslips already generated keep their own amounts, and the
            server refuses the deletion outright once any exist.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="danger"
              isLoading={removeStructure.isPending}
              onClick={() => void handleDelete()}
            >
              Delete this structure
            </Button>
            <Button variant="outline" onClick={() => setConfirmingDelete(false)}>
              Keep it
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Total label="Gross" value={totals.gross} currency={structure.currency} />
        <Total label="Deductions" value={totals.deductions} currency={structure.currency} />
        <Total label="Net" value={totals.net} currency={structure.currency} emphasis />
        <Total
          label="Employer cost"
          value={totals.employerCost}
          currency={structure.currency}
        />
      </div>

      <Card>
        <CardHeader
          title="Lines"
          subtitle="Fixed amounts, in the order they print on a payslip."
        />
        {lines.length === 0 ? (
          <CardBody className="text-sm text-text-muted">
            This structure has no lines, so nothing would be paid from it.
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Code</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Component</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Type</th>
                  <th scope="col" className="px-5 py-3 text-end font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {lines.map((line) => (
                  <tr key={line.id} className="hover:bg-surface-border-light/60">
                    <td className="px-5 py-3 font-mono text-text-body">
                      {line.component?.code ?? '—'}
                    </td>
                    <td className="px-5 py-3 text-text-body">
                      {line.component?.name ?? '—'}
                      {line.component && !line.component.isActive && (
                        <span className="ms-2 text-xs text-status-warning">retired</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {line.component ? (
                        <ComponentTypeBadge type={line.component.type} short />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-5 py-3 text-end tabular-nums text-text-body">
                      {formatCurrency(line.amount, structure.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Total({
  label,
  value,
  currency,
  emphasis,
}: {
  label: string;
  value: number;
  currency: string;
  emphasis?: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <p
        className={
          emphasis
            ? 'mt-1 text-2xl font-semibold tabular-nums text-text-heading'
            : 'mt-1 text-xl font-medium tabular-nums text-text-body'
        }
      >
        {formatCurrency(value, currency)}
      </p>
    </Card>
  );
}

export default function SalaryStructurePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      <SalaryStructureDetail id={id} />
    </ProtectedRoute>
  );
}
