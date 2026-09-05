'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { FileText, Plus, Search } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { useContracts } from '@/hooks/useContracts';
import { useDebounce } from '@/hooks/useDebounce';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { daysUntilDate, expiryLabel, expiryTone } from '@/utils/contractExpiry';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { ContractListQuery, ContractStatus, ContractType } from '@/types/contract';

const STATUS_TONE: Record<ContractStatus, 'neutral' | 'success' | 'warning' | 'error' | 'info'> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  EXPIRED: 'warning',
  TERMINATED: 'error',
  RENEWED: 'info',
};

const STATUS_OPTIONS: ContractStatus[] = ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'RENEWED'];

const TYPE_OPTIONS: ContractType[] = [
  'PERMANENT',
  'FIXED_TERM',
  'PROBATION',
  'PART_TIME',
  'INTERNSHIP',
  'CONSULTANT',
];

const PAGE_SIZE = 20;

/** Title case from a SCREAMING_SNAKE enum, for a column the reader has to scan. */
function humanise(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

function ContractsList() {
  const role = useAuthStore((s) => s.user?.role);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [contractType, setContractType] = useState('');
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(search, 300);

  // Narrowing the list resets the page in the same handler. Left to an effect,
  // the reader sees page 4 of the shorter result — an empty table that reads as
  // "no matches" — before it corrects itself.
  const narrow = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const query = useMemo<ContractListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      search: debouncedSearch || undefined,
      status: (status || undefined) as ContractStatus | undefined,
      contractType: (contractType || undefined) as ContractType | undefined,
    }),
    [page, debouncedSearch, status, contractType],
  );

  const { data, isLoading, isError } = useContracts(query);
  const contracts = data?.data ?? [];
  const total = data?.meta?.total;

  usePageHeader(
    'Contracts',
    total === undefined ? undefined : `${total} contract${total === 1 ? '' : 's'}`,
  );

  const filtered = Boolean(debouncedSearch || status || contractType);

  return (
    <div className="space-y-5">
      {hasPermission(role, 'EDIT_EMPLOYEE') && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href="/dashboard/contracts/terminations">
            <Button variant="outline">Terminations queue</Button>
          </Link>
          <Link href="/dashboard/contracts/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New contract
            </Button>
          </Link>
        </div>
      )}

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="xl:col-span-2">
            <Input
              value={search}
              onChange={(event) => narrow(() => setSearch(event.target.value))}
              aria-label="Search contracts"
              placeholder="Contract number, employee code or name"
              icon={<Search className="h-4 w-4" aria-hidden />}
            />
          </div>
          <Select
            aria-label="Filter by contract status"
            placeholder="Every status"
            value={status}
            onChange={(event) => narrow(() => setStatus(event.target.value))}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by contract type"
            placeholder="Every type"
            value={contractType}
            onChange={(event) => narrow(() => setContractType(event.target.value))}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading contracts…</p>}

        {isError && (
          <p className="p-6 text-sm text-status-error">
            Could not load contracts. Is the API running?
          </p>
        )}

        {!isLoading && !isError && contracts.length === 0 && (
          <EmptyState
            icon={<FileText className="h-6 w-6" aria-hidden />}
            title={filtered ? 'No matches' : 'Nothing on file'}
            description={
              filtered
                ? 'Nothing matches that search. Try a different number, name or filter.'
                : 'Draft a contract against an existing employee record.'
            }
          />
        )}

        {contracts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Number</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Employee</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Type</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Term</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Salary</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Expiry</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {contracts.map((contract) => {
                  // The list endpoint does not compute a countdown — only the
                  // expiry report does — so it is worked out here from the term.
                  const days =
                    contract.status === 'ACTIVE' ? daysUntilDate(contract.endDate) : null;
                  const tone = expiryTone(days);

                  return (
                    <tr key={contract.id} className="hover:bg-surface-border-light/60">
                      <td className="px-5 py-3">
                        <Link
                          href={`/dashboard/contracts/${contract.id}`}
                          className="font-medium text-brand-primary hover:underline"
                        >
                          {contract.contractNumber}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {contract.employee ? (
                          <Link
                            href={`/dashboard/employees/${contract.employeeId}`}
                            className="hover:underline"
                          >
                            {fullName(contract.employee)}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {humanise(contract.contractType)}
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {formatDateOnly(contract.startDate)} –{' '}
                        {contract.endDate ? formatDateOnly(contract.endDate) : 'open ended'}
                      </td>
                      {/* A decimal STRING from the API. formatCurrency reads the
                          decimal count from the contract's own currency, which is
                          three for OMR and two for AED. */}
                      <td className="px-5 py-3 tabular-nums text-text-body">
                        {formatCurrency(contract.salary, contract.currency)}
                      </td>
                      <td className="px-5 py-3">
                        {days === null ? (
                          <span className="text-text-muted">—</span>
                        ) : (
                          <span
                            className={
                              tone === 'error'
                                ? 'font-semibold text-status-error'
                                : tone === 'warning'
                                  ? 'font-semibold text-status-warning'
                                  : 'text-text-body'
                            }
                          >
                            {expiryLabel(days)}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={STATUS_TONE[contract.status]}>
                          {humanise(contract.status)}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>
    </div>
  );
}

export default function ContractsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_EMPLOYEES">
      <ContractsList />
    </ProtectedRoute>
  );
}
