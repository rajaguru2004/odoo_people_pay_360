import {
  resolveAttendanceCoverage,
  resolveContracts,
  resolvePopulation,
  resolveSalary,
} from './payroll-preflight.rules';

/**
 * These functions exist so that `create()` and the pre-flight cannot disagree
 * about whether a run is safe. The cases below are therefore about the FACTS,
 * not about any message: the messages stay in `payrolls.service.ts`, word for
 * word, because e2e specs assert them.
 */
describe('payroll pre-flight rules', () => {
  describe('who a run would pay', () => {
    it('reports the employees it found', () => {
      const f = resolvePopulation({ found: [{ id: 'a' }, { id: 'b' }] });
      expect(f.foundIds).toEqual(['a', 'b']);
      expect(f.isEmpty).toBe(false);
      expect(f.emptyReason).toBeNull();
    });

    it('names ids that matched nobody', () => {
      const f = resolvePopulation({
        found: [{ id: 'a' }],
        requestedIds: ['a', 'ghost'],
      });
      expect(f.unmatchedIds).toEqual(['ghost']);
      expect(f.isEmpty).toBe(false);
    });

    it('tells "named only unknown people" apart from "branch is empty"', () => {
      // Two different mistakes. A run naming only unknown employees is G23; a
      // run over an empty branch is a different problem, and "0 items" for both
      // helps nobody.
      expect(
        resolvePopulation({ found: [], requestedIds: ['ghost'] }).emptyReason,
      ).toBe('ALL_UNMATCHED');
      expect(resolvePopulation({ found: [] }).emptyReason).toBe('NO_EMPLOYEES');
    });

    it('reports no unmatched ids when the caller named nobody', () => {
      const f = resolvePopulation({ found: [{ id: 'a' }], requestedIds: null });
      expect(f.unmatchedIds).toEqual([]);
    });
  });

  describe('attendance coverage', () => {
    it('separates the whole-run case from the per-employee one', () => {
      // Nobody having attendance means the period was never processed, and
      // paying everyone a full month off the back of that is the expensive
      // mistake. One person missing is a data gap for that person.
      const none = resolveAttendanceCoverage({ counts: [], employeeIds: ['a', 'b'] });
      expect(none.runHasNone).toBe(true);

      const some = resolveAttendanceCoverage({
        counts: [{ employeeId: 'a' }],
        employeeIds: ['a', 'b'],
      });
      expect(some.runHasNone).toBe(false);
      expect(some.employeesWithout).toEqual(['b']);
    });

    it('does not count an employee twice for many attendance rows', () => {
      const f = resolveAttendanceCoverage({
        counts: [{ employeeId: 'a' }, { employeeId: 'a' }],
        employeeIds: ['a'],
      });
      expect(f.employeesWithAttendance.size).toBe(1);
      expect(f.employeesWithout).toEqual([]);
    });

    it('reports an empty run as having none, not as fully covered', () => {
      expect(
        resolveAttendanceCoverage({ counts: [], employeeIds: [] }).runHasNone,
      ).toBe(true);
    });
  });

  describe('contracts', () => {
    it('finds employees with no ACTIVE contract', () => {
      const f = resolveContracts([
        { id: 'a', contracts: [{ status: 'ACTIVE' }] },
        { id: 'b', contracts: [{ status: 'TERMINATED' }] },
        { id: 'c', contracts: [] },
        { id: 'd' },
      ]);
      expect(f.withoutActiveContract).toEqual(['b', 'c', 'd']);
    });
  });

  describe('pay', () => {
    it('finds employees who would be paid nothing at all', () => {
      const f = resolveSalary([
        { id: 'a', baseSalary: 1000 },
        { id: 'b', baseSalary: 0, components: [{ componentType: 'BASIC', amount: 900 }] },
        { id: 'c', baseSalary: 0, components: [] },
        { id: 'd', baseSalary: 0, components: [{ componentType: 'PAYROLL_CONFIG', amount: 0 }] },
      ]);
      // `c` and `d` have no rate anywhere; `d`'s only component is config, not money.
      expect(f.withoutAnyPay).toEqual(['c', 'd']);
    });
  });
});
