import type { EmployeeStatus } from '@/types/employee';

/** The colour each status is drawn in, everywhere in the module. */
export const EMPLOYEE_STATUS_TONE: Record<
  EmployeeStatus,
  'success' | 'info' | 'warning' | 'error'
> = {
  ACTIVE: 'success',
  ON_LEAVE: 'info',
  SUSPENDED: 'warning',
  TERMINATED: 'error',
};

/**
 * Every status, in the order they are read in.
 *
 * One list, used by the filter select and by the stats bar, so the choices a
 * reader can make and the figures they are choosing between can never drift
 * apart.
 */
export const EMPLOYEE_STATUS_OPTIONS: ReadonlyArray<{
  value: EmployeeStatus;
  label: string;
}> = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'TERMINATED', label: 'Terminated' },
];

/** "ON_LEAVE" as "On leave", falling back to the raw value for anything new. */
export function employeeStatusLabel(status: EmployeeStatus): string {
  return (
    EMPLOYEE_STATUS_OPTIONS.find((option) => option.value === status)?.label ??
    status.replace(/_/g, ' ')
  );
}

export interface EmployeeFilters {
  search: string;
  /** Empty means every status. */
  status: '' | EmployeeStatus;
  departmentId: string;
  branchId: string;
}

export const EMPTY_EMPLOYEE_FILTERS: EmployeeFilters = {
  search: '',
  status: '',
  departmentId: '',
  branchId: '',
};

/**
 * How many narrowing choices are folded away behind the Filters button.
 *
 * The search box is deliberately not counted: it is visible on the toolbar with
 * its own text in it, so including it would put a badge on a button that hides
 * nothing.
 */
export function activeEmployeeFilterCount(filters: EmployeeFilters): number {
  let count = 0;
  if (filters.status) count += 1;
  if (filters.departmentId) count += 1;
  if (filters.branchId) count += 1;
  return count;
}

/**
 * The headcount above the list.
 *
 * `null` rather than `0` for a figure that has not arrived. Zero is a claim —
 * "nobody holds this status" — and a request that has not answered yet cannot
 * support it. The bar prints an em dash instead, which is the same choice the
 * People hub makes for the same reason.
 */
export interface EmployeeHeadcount {
  total: number | null;
  byStatus: Record<EmployeeStatus, number | null>;
}
