import {
  managerDeptScope,
  isDeptInManagerScope,
  managerDeptWhere,
} from './manager-scope.util';

describe('manager-scope util (multi-department manager authority)', () => {
  describe('managerDeptScope', () => {
    it('returns every managed department when the user heads several', () => {
      const user = {
        role: 'MANAGER',
        departmentId: 'dept-a',
        managedDepartmentIds: ['dept-a', 'dept-b', 'dept-c'],
      };
      expect(managerDeptScope(user)).toEqual(['dept-a', 'dept-b', 'dept-c']);
    });

    it('is byte-for-byte identical to the old behavior for a single-department manager', () => {
      const user = {
        role: 'MANAGER',
        departmentId: 'dept-a',
        managedDepartmentIds: ['dept-a'],
      };
      expect(managerDeptScope(user)).toEqual(['dept-a']);
    });

    it('falls back to the home department when managedDepartmentIds is empty', () => {
      const user = {
        role: 'MANAGER',
        departmentId: 'dept-a',
        managedDepartmentIds: [],
      };
      expect(managerDeptScope(user)).toEqual(['dept-a']);
    });

    it('falls back to the home department when managedDepartmentIds is absent (old token)', () => {
      const user = { role: 'MANAGER', departmentId: 'dept-a' };
      expect(managerDeptScope(user)).toEqual(['dept-a']);
    });

    it('returns an empty scope when there is neither a managed set nor a home department', () => {
      expect(managerDeptScope({ role: 'MANAGER' })).toEqual([]);
      expect(managerDeptScope(undefined)).toEqual([]);
    });
  });

  describe('isDeptInManagerScope', () => {
    const multiMgr = {
      role: 'MANAGER',
      departmentId: 'dept-a',
      managedDepartmentIds: ['dept-a', 'dept-b'],
    };

    it('accepts any department the manager heads', () => {
      expect(isDeptInManagerScope(multiMgr, 'dept-a')).toBe(true);
      expect(isDeptInManagerScope(multiMgr, 'dept-b')).toBe(true);
    });

    it('rejects a department the manager does not head', () => {
      expect(isDeptInManagerScope(multiMgr, 'dept-z')).toBe(false);
    });

    it('rejects a null/undefined department id', () => {
      expect(isDeptInManagerScope(multiMgr, null)).toBe(false);
      expect(isDeptInManagerScope(multiMgr, undefined)).toBe(false);
    });
  });

  describe('managerDeptWhere', () => {
    it('narrows to the full managed set for a MANAGER', () => {
      const user = {
        role: 'MANAGER',
        departmentId: 'dept-a',
        managedDepartmentIds: ['dept-a', 'dept-b'],
      };
      expect(managerDeptWhere(user)).toEqual({
        departmentId: { in: ['dept-a', 'dept-b'] },
      });
    });

    it('returns no narrowing for ADMIN / HR_MANAGER (full visibility preserved)', () => {
      expect(managerDeptWhere({ role: 'ADMIN', departmentId: 'dept-a' })).toEqual(
        {},
      );
      expect(
        managerDeptWhere({ role: 'HR_MANAGER', departmentId: 'dept-a' }),
      ).toEqual({});
    });

    it('denies (empty IN) a MANAGER with no scope rather than leaking all rows', () => {
      expect(managerDeptWhere({ role: 'MANAGER' })).toEqual({
        departmentId: { in: [] },
      });
    });
  });
});
