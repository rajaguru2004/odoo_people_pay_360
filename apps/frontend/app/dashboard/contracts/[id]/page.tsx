'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { UserMinus } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import TerminationForm from '@/components/contracts/TerminationForm';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { useContract } from '@/hooks/useContracts';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { daysUntilDate, expiryLabel, expiryTone } from '@/utils/contractExpiry';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { ContractStatus } from '@/types/contract';
import type { RequestStatus } from '@/types/common';

const STATUS_TONE: Record<ContractStatus, 'neutral' | 'success' | 'warning' | 'error' | 'info'> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  EXPIRED: 'warning',
  TERMINATED: 'error',
  RENEWED: 'info',
};

const REQUEST_TONE: Record<RequestStatus, 'neutral' | 'success' | 'warning' | 'error'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

function humanise(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-body">{children || '—'}</dd>
    </div>
  );
}

function ContractDetail({ id }: { id: string }) {
  const role = useAuthStore((s) => s.user?.role);
  const [requesting, setRequesting] = useState(false);

  const { data, isLoading, isError } = useContract(id);
  const contract = data?.data;

  usePageHeader(
    contract?.contractNumber ?? 'Contract',
    contract ? `${fullName(contract.employee)} · ${humanise(contract.contractType)}` : undefined,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the contract…</Card>;
  }

  if (isError || !contract) {
    return <Card className="p-6 text-sm text-status-error">Could not load this contract.</Card>;
  }

  const terminations = contract.terminations ?? [];
  const pending = terminations.find((request) => request.status === 'PENDING');
  const days = contract.status === 'ACTIVE' ? daysUntilDate(contract.endDate) : null;
  const tone = expiryTone(days);
  const canTerminate =
    hasPermission(role, 'TERMINATE_EMPLOYEE') && contract.status !== 'TERMINATED';

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={STATUS_TONE[contract.status]}>{humanise(contract.status)}</Badge>
          <span className="text-sm text-text-body">
            {formatDateOnly(contract.startDate)} –{' '}
            {contract.endDate ? formatDateOnly(contract.endDate) : 'open ended'}
          </span>
          {days !== null && (
            <span
              className={
                tone === 'error'
                  ? 'text-sm font-semibold text-status-error'
                  : tone === 'warning'
                    ? 'text-sm font-semibold text-status-warning'
                    : 'text-sm text-text-muted'
              }
            >
              {expiryLabel(days)}
            </span>
          )}
        </div>

        {canTerminate && !pending && !requesting && (
          <Button variant="danger" onClick={() => setRequesting(true)}>
            <UserMinus className="h-4 w-4" aria-hidden />
            Request termination
          </Button>
        )}
        {pending && (
          // The API allows one live request per contract, so offering the action
          // again would only produce a 409 the user cannot do anything about.
          <p className="text-sm text-status-warning">
            A termination request is already awaiting a decision.
          </p>
        )}
      </Card>

      {requesting && (
        <TerminationForm
          contractId={contract.id}
          onDone={() => setRequesting(false)}
          onCancel={() => setRequesting(false)}
        />
      )}

      <Card>
        <CardHeader title="Terms" subtitle="What was agreed, and what it costs." />
        <CardBody>
          <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Employee">
              {contract.employee ? (
                <Link
                  href={`/dashboard/employees/${contract.employeeId}`}
                  className="text-brand-primary hover:underline"
                >
                  {fullName(contract.employee)}
                </Link>
              ) : null}
            </Fact>
            <Fact label="Contract type">{humanise(contract.contractType)}</Fact>
            <Fact label="Work type">{humanise(contract.workType)}</Fact>
            <Fact label="Probation ends">{formatDateOnly(contract.probationEndDate)}</Fact>
            <Fact label="Hours per week">
              <span className="tabular-nums">{contract.workHoursPerWeek}</span>
            </Fact>
            {/* Decimal string in, currency-aware formatting out — parseFloat and
                a fixed two places would round every OMR figure. */}
            <Fact label="Salary">
              <span className="tabular-nums">
                {formatCurrency(contract.salary, contract.currency)}
              </span>
            </Fact>
            <Fact label="Notice period">
              <span className="tabular-nums">{contract.noticePeriodDays} days</span>
            </Fact>
            <Fact label="Annual leave">
              <span className="tabular-nums">{contract.annualLeaveDays} days</span>
            </Fact>
            {contract.terms && (
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Additional terms
                </dt>
                <dd className="mt-1 whitespace-pre-line text-sm text-text-body">
                  {contract.terms}
                </dd>
              </div>
            )}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Termination history"
          subtitle="Requests raised against this contract, whatever was decided."
        />
        {terminations.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-text-muted">Nothing has been raised.</p>
        ) : (
          <ul className="divide-y divide-surface-border-light">
            {terminations.map((request) => (
              <li key={request.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={REQUEST_TONE[request.status]}>{humanise(request.status)}</Badge>
                  <span className="text-sm font-medium text-text-heading">
                    {humanise(request.category)}
                  </span>
                  <span className="text-sm text-text-muted">
                    notice {formatDateOnly(request.noticeDate)} · last day{' '}
                    {formatDateOnly(request.terminationDate)}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-text-body">{request.reason}</p>
                {request.reviewNote && (
                  <p className="mt-1 text-sm text-text-muted">
                    Reviewer: {request.reviewNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function ContractPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <ProtectedRoute requiredPermission="VIEW_EMPLOYEES">
      <ContractDetail id={id} />
    </ProtectedRoute>
  );
}
