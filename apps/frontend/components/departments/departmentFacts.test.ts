import { describe, expect, it } from 'vitest';
import {
  activeDepartmentFilterCount,
  departmentStats,
  EMPTY_DEPARTMENT_FILTERS,
  filterDepartments,
} from './departmentFacts';
import type { Department } from '@/types/department';

function department(overrides: Partial<Department> & { code: string }): Department {
  return {
    id: overrides.code.toLowerCase(),
    name: overrides.code,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const OPS = department({
  code: 'OPS',
  name: 'Operations',
  managerId: 'e1',
  branchId: 'b1',
  _count: { employees: 4, children: 1, teams: 0 },
});
const MAINT = department({
  code: 'MAINT',
  name: 'Maintenance',
  parentId: 'ops',
  managerId: 'e2',
  branchId: 'b1',
  _count: { employees: 3, children: 0, teams: 0 },
});
const ADMIN = department({
  code: 'ADMIN',
  name: 'Administration',
  _count: { employees: 2, children: 0, teams: 0 },
});
const CLOSED = department({ code: 'OLD', name: 'Old Unit', isActive: false });

const ROWS = [OPS, MAINT, ADMIN, CLOSED];

describe('filterDepartments', () => {
  it('hides a closed unit until the status filter asks for one', () => {
    expect(filterDepartments(ROWS, EMPTY_DEPARTMENT_FILTERS).map((d) => d.code)).toEqual([
      'OPS',
      'MAINT',
      'ADMIN',
    ]);
    expect(
      filterDepartments(ROWS, { ...EMPTY_DEPARTMENT_FILTERS, status: 'closed' }),
    ).toEqual([CLOSED]);
  });

  it('separates the units nobody is in charge of', () => {
    expect(
      filterDepartments(ROWS, { ...EMPTY_DEPARTMENT_FILTERS, head: 'headless' }),
    ).toEqual([ADMIN]);
  });

  it('separates top-level units from the ones that report upward', () => {
    expect(
      filterDepartments(ROWS, { ...EMPTY_DEPARTMENT_FILTERS, level: 'sub' }),
    ).toEqual([MAINT]);
    expect(
      filterDepartments(ROWS, { ...EMPTY_DEPARTMENT_FILTERS, level: 'top' }).map((d) => d.code),
    ).toEqual(['OPS', 'ADMIN']);
  });

  it('searches the branch name as well as the unit', () => {
    const withBranch = department({
      code: 'FIN',
      branch: { id: 'b2', code: 'SOH', name: 'Sohar Plant' },
    });
    expect(
      filterDepartments([...ROWS, withBranch], {
        ...EMPTY_DEPARTMENT_FILTERS,
        search: 'sohar',
      }),
    ).toEqual([withBranch]);
  });

  it('counts only the choices folded behind the button', () => {
    expect(activeDepartmentFilterCount(EMPTY_DEPARTMENT_FILTERS)).toBe(0);
    expect(activeDepartmentFilterCount({ ...EMPTY_DEPARTMENT_FILTERS, search: 'ops' })).toBe(0);
    expect(
      activeDepartmentFilterCount({
        ...EMPTY_DEPARTMENT_FILTERS,
        head: 'headless',
        level: 'top',
        branchId: 'b1',
      }),
    ).toBe(3);
  });
});

describe('departmentStats', () => {
  it('reports the units, the roots, the headless ones and the people placed', () => {
    expect(departmentStats([OPS, MAINT, ADMIN])).toEqual({
      total: 3,
      topLevel: 2,
      headless: 1,
      people: 9,
    });
  });
});
