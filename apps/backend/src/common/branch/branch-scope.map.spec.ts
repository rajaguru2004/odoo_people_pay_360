import {
  BRANCH_SCOPE,
  BRANCH_READ_ACTIONS,
  BRANCH_WRITE_MANY_ACTIONS,
  buildBranchWhere,
  isDirectRule,
} from './branch-scope.map';

describe('branch-scope.map', () => {
  describe('buildBranchWhere', () => {
    it('direct → scalar branchId predicate', () => {
      expect(buildBranchWhere('direct', ['a', 'b'])).toEqual({
        branchId: { in: ['a', 'b'] },
      });
    });

    it('relation → nested employee.branchId predicate', () => {
      expect(buildBranchWhere('relation', ['a'])).toEqual({
        employee: { branchId: { in: ['a'] } },
      });
    });

    it('path → folds a nested to-one chain from the innermost branchId out', () => {
      expect(buildBranchWhere({ path: ['contract', 'employee'] }, ['a'])).toEqual({
        contract: { employee: { branchId: { in: ['a'] } } },
      });
    });

    it('fail-closed: an empty id list matches nothing', () => {
      expect(buildBranchWhere('direct', [])).toEqual({ branchId: { in: [] } });
      expect(buildBranchWhere('relation', [])).toEqual({
        employee: { branchId: { in: [] } },
      });
    });
  });

  describe('isDirectRule', () => {
    it('is true only for the direct rule', () => {
      expect(isDirectRule('direct')).toBe(true);
      expect(isDirectRule('relation')).toBe(false);
      expect(isDirectRule({ path: ['contract', 'employee'] })).toBe(false);
    });
  });

  describe('registry coverage', () => {
    it('scopes the previously-leaking models', () => {
      expect(BRANCH_SCOPE.AdvanceLoanRequest).toBe('relation');
      expect(BRANCH_SCOPE.TerminationRequest).toEqual({
        path: ['contract', 'employee'],
      });
      expect(BRANCH_SCOPE.AdvanceLoanDeduction).toEqual({
        path: ['request', 'employee'],
      });
      expect(BRANCH_SCOPE.Payroll).toBe('direct');
      expect(BRANCH_SCOPE.PayrollBatch).toBe('direct');
    });

    it('scopes the payment-critical bank models', () => {
      // Previously absent from the registry entirely, so a branch-scoped HR
      // manager could list every pending bank change company-wide.
      expect(BRANCH_SCOPE.EmployeeBankDetail).toBe('relation');
      expect(BRANCH_SCOPE.BankChangeRequest).toBe('relation');
    });

    it('leaves bank reference data unscoped', () => {
      // Bank and CountryBankingField are global reference lists, not per-branch
      // records — scoping them would hide the bank picker from every branch.
      expect(BRANCH_SCOPE.Bank).toBeUndefined();
      expect(BRANCH_SCOPE.CountryBankingField).toBeUndefined();
    });

    it('keeps read and bulk-write action sets disjoint', () => {
      for (const a of BRANCH_WRITE_MANY_ACTIONS) {
        expect(BRANCH_READ_ACTIONS.has(a)).toBe(false);
      }
      // updateMany/deleteMany must not be auto-scoped as reads (scalar-only where).
      expect(BRANCH_READ_ACTIONS.has('updateMany')).toBe(false);
      expect(BRANCH_READ_ACTIONS.has('deleteMany')).toBe(false);
    });
  });
});

describe("'direct-or-global' rule", () => {
  it('matches the branch OR a company-wide (NULL) row', () => {
    // The bug this exists to prevent: a plain `branchId IN (...)` never matches
    // NULL, so a company-wide training session was invisible from every branch
    // the instant it was created.
    expect(buildBranchWhere('direct-or-global', ['b1', 'b2'])).toEqual({
      OR: [{ branchId: { in: ['b1', 'b2'] } }, { branchId: null }],
    });
  });

  it('still fails closed for a caller with no accessible branches', () => {
    // Company-wide rows stay visible — they belong to nobody in particular —
    // but no branch-owned row leaks through.
    expect(buildBranchWhere('direct-or-global', [])).toEqual({
      OR: [{ branchId: { in: [] } }, { branchId: null }],
    });
  });

  it('is NOT treated as a direct rule', () => {
    // isDirectRule drives create-stamping. Stamping the active branch onto a
    // deliberately company-wide row would silently narrow it to one branch.
    expect(isDirectRule('direct-or-global')).toBe(false);
  });
});
