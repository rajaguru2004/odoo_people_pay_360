import {
  supervisorScope,
  isInSupervisorScope,
  supervisorWhere,
} from './supervisor-scope.util';

describe('supervisor-scope util (data-driven approval authority)', () => {
  describe('supervisorScope', () => {
    it('returns the assigned supervisees', () => {
      const user = { supervisedEmployeeIds: ['e1', 'e2'] };
      expect(supervisorScope(user)).toEqual(['e1', 'e2']);
    });

    it('returns an empty scope when there are no supervisees or no user', () => {
      expect(supervisorScope({})).toEqual([]);
      expect(supervisorScope(undefined)).toEqual([]);
    });
  });

  describe('isInSupervisorScope', () => {
    const sup = { supervisedEmployeeIds: ['e1', 'e2'] };

    it('accepts an assigned supervisee', () => {
      expect(isInSupervisorScope(sup, 'e1')).toBe(true);
    });

    it('rejects a non-supervisee', () => {
      expect(isInSupervisorScope(sup, 'e9')).toBe(false);
    });

    it('rejects a null/undefined employee id', () => {
      expect(isInSupervisorScope(sup, null)).toBe(false);
      expect(isInSupervisorScope(sup, undefined)).toBe(false);
    });
  });

  describe('supervisorWhere', () => {
    it('narrows to the supervisee set', () => {
      const user = { supervisedEmployeeIds: ['e1', 'e2'] };
      expect(supervisorWhere(user)).toEqual({ employeeId: { in: ['e1', 'e2'] } });
    });

    it('is fail-closed (empty IN) for a user who supervises nobody', () => {
      expect(supervisorWhere({})).toEqual({ employeeId: { in: [] } });
    });
  });
});
