'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, Users } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import EmployeeCardView from '@/components/employees/EmployeeCardView';
import EmployeeFilterPanel from '@/components/employees/EmployeeFilterPanel';
import EmployeeStatsBar from '@/components/employees/EmployeeStatsBar';
import EmployeeTableView, {
  type EmployeeSortColumn,
} from '@/components/employees/EmployeeTableView';
import EmployeeViewSwitcher, {
  type EmployeeViewType,
} from '@/components/employees/EmployeeViewSwitcher';
import {
  employeeStatusLabel,
  EMPTY_EMPLOYEE_FILTERS,
  type EmployeeFilters,
} from '@/components/employees/employeeFacts';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { useBranches } from '@/hooks/useBranches';
import { useDebounce } from '@/hooks/useDebounce';
import { useDepartments } from '@/hooks/useDepartments';
import { useEmployees, useEmployeeStatusCounts } from '@/hooks/useEmployees';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import employeeService from '@/services/employeeService';
import { apiErrorMessage } from '@/utils/apiError';
import { datedStem, exportWorkbook } from '@/utils/exportSheet';
import { fullName } from '@/utils/formatters';
import { hasPermission } from '@/utils/permissions';
import type { Employee, EmployeeListQuery } from '@/types/employee';

const PAGE_SIZE = 20;

/** The API's own ceiling, so a page of the export is one request. */
const EXPORT_PAGE_SIZE = 200;

/**
 * How many rows an export will pull before it stops asking for more.
 *
 * A spreadsheet is written in the browser from rows fetched over the wire, so
 * an unbounded loop on a large workforce is a tab that appears to hang. The cap
 * is high enough that no realistic directory reaches it, and the export says so
 * when it does rather than quietly handing over a truncated file.
 */
const EXPORT_ROW_CAP = 2000;

function EmployeeDirectory() {
  const role = useAuthStore((s) => s.user?.role);

  const [view, setView] = useState<EmployeeViewType>('table');
  const [filters, setFilters] = useState<EmployeeFilters>(EMPTY_EMPLOYEE_FILTERS);
  const [sortBy, setSortBy] = useState<EmployeeSortColumn>('employeeCode');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  // Debounced so typing does not fire a request per keystroke.
  const debouncedSearch = useDebounce(filters.search, 300);

  /**
   * Narrowing the list invalidates where the reader is in it.
   *
   * Done in the handler rather than in an effect on the query: an effect would
   * render page 4 of the new, shorter result first — an empty table that reads
   * as "no matches" — and only then correct itself.
   */
  const narrow = (next: EmployeeFilters) => {
    setFilters(next);
    setPage(1);
  };

  /** Everything except the status, which the stats bar deliberately ignores. */
  const scope = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      departmentId: filters.departmentId || undefined,
      branchId: filters.branchId || undefined,
    }),
    [debouncedSearch, filters.departmentId, filters.branchId],
  );

  const query = useMemo<EmployeeListQuery>(
    () => ({
      ...scope,
      page,
      limit: PAGE_SIZE,
      status: filters.status || undefined,
      sortBy,
      sortOrder,
    }),
    [scope, page, filters.status, sortBy, sortOrder],
  );

  const { data, isLoading, isError } = useEmployees(query);
  const headcount = useEmployeeStatusCounts(scope);
  const departments = useDepartments();
  const branches = useBranches();

  const employees = data?.data ?? [];
  const total = data?.meta?.total;

  usePageHeader(
    'Employees',
    total === undefined ? undefined : `${total} record${total === 1 ? '' : 's'}`,
  );

  const handleSort = (column: EmployeeSortColumn) => {
    if (column === sortBy) {
      setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortOrder('asc');
    }
    setPage(1);
  };

  /**
   * Write out everything the filters currently match, not the page on screen.
   *
   * The list is paginated server-side, so exporting `employees` would hand over
   * twenty rows and call it the directory. The pages are pulled in sequence
   * rather than in parallel: the loop has to read each response's `totalPages`
   * before it knows whether to ask for another.
   */
  const handleExport = async () => {
    setExporting(true);
    try {
      const rows: Employee[] = [];
      let current = 1;
      let pages = 1;

      do {
        const response = await employeeService.list({
          ...query,
          page: current,
          limit: EXPORT_PAGE_SIZE,
        });
        rows.push(...(response.data ?? []));
        pages = response.meta?.totalPages ?? 1;
        current += 1;
      } while (current <= pages && rows.length < EXPORT_ROW_CAP);

      const capped = rows.length >= EXPORT_ROW_CAP && current <= pages;

      await exportWorkbook(datedStem('employees'), [
        {
          name: 'Employees',
          rows: rows.map((employee) => ({
            Code: employee.employeeCode,
            'First name': employee.firstName,
            'Last name': employee.lastName,
            Position: employee.position,
            Department: employee.department?.name,
            Branch: employee.branch?.name,
            Status: employeeStatusLabel(employee.status),
            'Work email': employee.workEmail,
            'Personal email': employee.personalEmail,
            Phone: employee.phone,
            // Date-only columns, written as the stored calendar day. Putting
            // one through an instant parse on the way to a cell moves it a day
            // west of Greenwich.
            'Hire date': employee.hireDate?.slice(0, 10),
            'Exit date': employee.exitDate?.slice(0, 10),
            'Date of birth': employee.dateOfBirth?.slice(0, 10),
            Gender: employee.gender,
            Nationality: employee.nationality,
            'National ID': employee.nationalId,
            'Line manager': employee.manager ? fullName(employee.manager) : null,
            Supervisor: employee.supervisor ? fullName(employee.supervisor) : null,
            Timezone: employee.timezone,
            Address: employee.address,
          })),
        },
      ]);

      if (capped) {
        toast.warning(
          `The export stopped at ${EXPORT_ROW_CAP} rows. Narrow the filters to reach the rest.`,
        );
      }
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The export could not be written'));
    } finally {
      setExporting(false);
    }
  };

  const filtered = Boolean(
    debouncedSearch || filters.status || filters.departmentId || filters.branchId,
  );

  // The pager draws nothing for a single page, so the card around it in the
  // grid view would otherwise be an empty bordered strip under the last row.
  const showPager = (data?.meta?.totalPages ?? 1) > 1;

  return (
    <div className="space-y-5">
      {/* Hidden for a role that cannot create, exactly as the rail hides the
          nav entry. The server refuses the POST either way — this is about not
          offering an action that is going to be turned down. */}
      {hasPermission(role, 'CREATE_EMPLOYEE') && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link href="/dashboard/employees/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              New employee
            </Button>
          </Link>
        </div>
      )}

      <EmployeeStatsBar headcount={headcount} />

      <EmployeeFilterPanel
        filters={filters}
        onChange={narrow}
        departments={departments.data?.data ?? []}
        branches={branches.data?.data ?? []}
        onExport={() => void handleExport()}
        exporting={exporting}
        trailing={<EmployeeViewSwitcher view={view} onChange={setView} />}
      />

      {isLoading && (
        <Card className="p-6 text-sm text-text-muted">Loading employees…</Card>
      )}

      {isError && (
        <Card className="p-6 text-sm text-status-error">
          Could not load the directory. Is the API running?
        </Card>
      )}

      {!isLoading && !isError && employees.length === 0 && (
        <Card>
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden />}
            title={filtered ? 'No matches' : 'No records yet'}
            description={
              filtered
                ? 'Nothing matches that search. Try a different name, code or filter.'
                : 'Create the first employee record to get started.'
            }
          />
        </Card>
      )}

      {/* Exactly one view renders at a time. Keeping the other mounted behind a
          hidden class would print every name twice, which is a real problem for
          anyone reading the page with assistive technology. */}
      {employees.length > 0 && view === 'table' && (
        <Card>
          <EmployeeTableView
            employees={employees}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSort={handleSort}
          />
          <Pagination meta={data?.meta} onPageChange={setPage} />
        </Card>
      )}

      {employees.length > 0 && view === 'cards' && (
        <div className="space-y-5">
          <EmployeeCardView employees={employees} />
          {showPager && (
            <Card>
              <Pagination meta={data?.meta} onPageChange={setPage} />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

export default function EmployeesPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_EMPLOYEES">
      <EmployeeDirectory />
    </ProtectedRoute>
  );
}
