import type { Department } from '@/types/department';

export type DepartmentStatusFilter = 'all' | 'open' | 'closed';
export type DepartmentHeadFilter = 'all' | 'headed' | 'headless';
export type DepartmentLevelFilter = 'all' | 'top' | 'sub';

export interface DepartmentFilters {
  search: string;
  status: DepartmentStatusFilter;
  branchId: string;
  head: DepartmentHeadFilter;
  level: DepartmentLevelFilter;
}

export const EMPTY_DEPARTMENT_FILTERS: DepartmentFilters = {
  search: '',
  status: 'open',
  branchId: '',
  head: 'all',
  level: 'all',
};

/**
 * How many narrowing choices are in force.
 *
 * Counted against the defaults, not against "nothing selected": a panel that
 * opens announcing one filter for its own starting position teaches the reader
 * to ignore the badge.
 */
export function activeDepartmentFilterCount(filters: DepartmentFilters): number {
  let count = 0;
  if (filters.status !== EMPTY_DEPARTMENT_FILTERS.status) count += 1;
  if (filters.branchId) count += 1;
  if (filters.head !== EMPTY_DEPARTMENT_FILTERS.head) count += 1;
  if (filters.level !== EMPTY_DEPARTMENT_FILTERS.level) count += 1;
  return count;
}

export function filterDepartments(
  departments: Department[],
  filters: DepartmentFilters,
): Department[] {
  const needle = filters.search.trim().toLowerCase();

  return departments.filter((department) => {
    if (filters.status === 'open' && !department.isActive) return false;
    if (filters.status === 'closed' && department.isActive) return false;
    if (filters.branchId && department.branchId !== filters.branchId) return false;
    if (filters.head === 'headed' && !department.managerId) return false;
    if (filters.head === 'headless' && department.managerId) return false;
    if (filters.level === 'top' && department.parentId) return false;
    if (filters.level === 'sub' && !department.parentId) return false;
    if (!needle) return true;

    return [department.name, department.code, department.description, department.branch?.name]
      .filter((field): field is string => !!field)
      .some((field) => field.toLowerCase().includes(needle));
  });
}

export interface DepartmentStats {
  total: number;
  topLevel: number;
  headless: number;
  people: number;
}

export function departmentStats(departments: Department[]): DepartmentStats {
  return {
    total: departments.length,
    topLevel: departments.filter((department) => !department.parentId).length,
    headless: departments.filter((department) => !department.managerId).length,
    people: departments.reduce(
      (sum, department) => sum + (department._count?.employees ?? 0),
      0,
    ),
  };
}
