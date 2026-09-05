'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ContractCardView from '@/components/contracts/ContractCardView';
import ContractFilterPanel from '@/components/contracts/ContractFilterPanel';
import ContractStatsBar from '@/components/contracts/ContractStatsBar';
import ContractTableView from '@/components/contracts/ContractTableView';
import ContractViewSwitcher, {
  type ContractViewType,
} from '@/components/contracts/ContractViewSwitcher';
import {
  EMPTY_CONTRACT_FILTERS,
  humanise,
  toContractQuery,
  type ContractFilters,
} from '@/components/contracts/contractFacts';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { useContracts } from '@/hooks/useContracts';
import contractService from '@/services/contractService';
import { useDebounce } from '@/hooks/useDebounce';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { DEFAULT_EXPIRY_WINDOW_DAYS, daysUntilDate, expiryLabel } from '@/utils/contractExpiry';
import { datedStem, exportWorkbook } from '@/utils/exportSheet';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { ContractListQuery } from '@/types/contract';

const PAGE_SIZE = 20;

/** One row is enough: these queries are read for their `meta.total`, not their rows. */
const COUNT_ONLY: ContractListQuery = { page: 1, limit: 1 };

/** The whole filtered set, for the spreadsheet. 200 is the API's ceiling. */
const EXPORT_LIMIT = 200;

function ContractsList() {
  const role = useAuthStore((s) => s.user?.role);
  const [view, setView] = useState<ContractViewType>('table');
  const [filters, setFilters] = useState<ContractFilters>(EMPTY_CONTRACT_FILTERS);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const debouncedSearch = useDebounce(filters.search, 300);

  // Narrowing the list resets the page in the same handler. Left to an effect,
  // the reader sees page 4 of the shorter result — an empty table that reads as
  // "no matches" — before it corrects itself.
  const narrow = (next: ContractFilters) => {
    setFilters(next);
    setPage(1);
  };

  const query = useMemo<ContractListQuery>(
    () => ({
      ...toContractQuery({ ...filters, search: debouncedSearch }),
      page,
      limit: PAGE_SIZE,
    }),
    [filters, debouncedSearch, page],
  );

  const { data, isLoading, isError } = useContracts(query);

  // Work type is not a parameter the contracts endpoint accepts, so it narrows
  // the page that came back. That makes it a filter over the current page
  // rather than the whole set — hence the count beside it reads "shown", and
  // the stats bar above is counted separately by the API.
  const contracts = useMemo(() => {
    const rows = data?.data ?? [];
    if (!filters.workType) return rows;
    return rows.filter((contract) => contract.workType === filters.workType);
  }, [data, filters.workType]);

  // Four figures the page of rows cannot answer: counting a page of twenty and
  // calling it the contract book is how a stats bar ends up lying. Each of
  // these asks the API for one row and reads the total off the envelope.
  const totalCount = useContracts(COUNT_ONLY);
  const activeCount = useContracts({ ...COUNT_ONLY, status: 'ACTIVE' });
  const expiredCount = useContracts({ ...COUNT_ONLY, status: 'EXPIRED' });
  const expiringCount = useContracts({
    ...COUNT_ONLY,
    status: 'ACTIVE',
    expiringWithinDays: DEFAULT_EXPIRY_WINDOW_DAYS,
  });

  const total = data?.meta?.total;

  usePageHeader(
    'Contracts',
    total === undefined ? undefined : `${total} contract${total === 1 ? '' : 's'}`,
  );

  const filtered =
    Boolean(debouncedSearch) ||
    Boolean(filters.status) ||
    Boolean(filters.contractType) ||
    Boolean(filters.workType) ||
    Boolean(filters.expiringWithinDays);

  const handleExport = async () => {
    setExporting(true);
    try {
      // The filtered set, not the page on screen: an export that stops at
      // twenty rows is the kind of file somebody reconciles against and only
      // notices the truncation afterwards.
      const all = await contractService.list({ ...query, page: 1, limit: EXPORT_LIMIT });
      const rows = filters.workType
        ? all.data.filter((contract) => contract.workType === filters.workType)
        : all.data;

      await exportWorkbook(datedStem('contracts'), [
        {
          name: 'Contracts',
          rows: rows.map((contract) => {
            const days = contract.status === 'ACTIVE' ? daysUntilDate(contract.endDate) : null;

            return {
              Number: contract.contractNumber,
              Employee: contract.employee ? fullName(contract.employee) : null,
              'Employee code': contract.employee?.employeeCode,
              Department: contract.employee?.department?.name,
              Type: humanise(contract.contractType),
              'Work type': humanise(contract.workType),
              Status: humanise(contract.status),
              'Start date': formatDateOnly(contract.startDate),
              // Blank, not a word: a permanent contract has no end date, and a
              // cell reading "open ended" cannot be sorted with the real ones.
              'End date': contract.endDate ? formatDateOnly(contract.endDate) : null,
              'Probation ends': contract.probationEndDate
                ? formatDateOnly(contract.probationEndDate)
                : null,
              // The decimal STRING the API sent, untouched. Rounding it here to
              // two places would silently lose a third of every OMR figure.
              Salary: contract.salary,
              Currency: contract.currency,
              'Hours per week': contract.workHoursPerWeek,
              'Notice period (days)': contract.noticePeriodDays,
              'Annual leave (days)': contract.annualLeaveDays,
              Expiry: days === null ? null : expiryLabel(days),
            };
          }),
        },
      ]);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The export could not be written'));
    } finally {
      setExporting(false);
    }
  };

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

      <ContractStatsBar
        stats={{
          total: totalCount.data?.meta?.total,
          active: activeCount.data?.meta?.total,
          expired: expiredCount.data?.meta?.total,
          expiringSoon: expiringCount.data?.meta?.total,
        }}
        expiryWindowDays={DEFAULT_EXPIRY_WINDOW_DAYS}
      />

      <ContractFilterPanel
        filters={filters}
        onChange={narrow}
        shown={contracts.length}
        total={total}
        onExport={() => void handleExport()}
        exporting={exporting}
        trailing={<ContractViewSwitcher view={view} onChange={setView} />}
      />

      {isLoading && <Card className="p-6 text-sm text-text-muted">Loading contracts…</Card>}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          Could not load contracts. Is the API running?
        </Card>
      )}

      {!isLoading && !isError && contracts.length === 0 && (
        <Card>
          <EmptyState
            icon={<FileText className="h-6 w-6" aria-hidden />}
            title={filtered ? 'No matches' : 'Nothing on file'}
            description={
              filtered
                ? 'Nothing matches that search. Try a different number, name or filter.'
                : 'Draft a contract against an existing employee record.'
            }
          />
        </Card>
      )}

      {/* Exactly one view is mounted. Keeping the other behind a hidden class
          would put every contract number on the page twice. */}
      {contracts.length > 0 && view === 'table' && (
        <Card>
          <ContractTableView contracts={contracts} />
          <Pagination meta={data?.meta} onPageChange={setPage} />
        </Card>
      )}

      {contracts.length > 0 && view === 'cards' && (
        <>
          <ContractCardView contracts={contracts} />
          {/* The pager needs a card of its own out here, and only when there is
              a page to move to — `Pagination` draws nothing for a single page,
              which would otherwise leave an empty panel under the grid. */}
          {(data?.meta?.totalPages ?? 1) > 1 && (
            <Card>
              <Pagination meta={data?.meta} onPageChange={setPage} />
            </Card>
          )}
        </>
      )}
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
