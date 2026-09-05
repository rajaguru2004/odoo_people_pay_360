import { NotFoundException } from '@nestjs/common';
import { assertInBranch, getScopedBranchIds } from './branch-scope.util';
import {
  BranchContext,
  runWithBranchStore,
  setBranchContext,
} from './branch-context';

/**
 * Object-level branch authorization (assertInBranch) — the guard that decides
 * whether a by-id read is visible to the caller.
 *
 * The critical, production-regression case: a record with NO branch
 * (branchId = null) is company-wide / unassigned. A GLOBAL caller who has only
 * *narrowed their view* to one branch must still see it (narrowing is a view
 * filter, not a security ceiling) — otherwise every company-wide payroll run
 * 404s. A non-global scoped caller must NOT see null-branch records (fail-closed).
 */
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';

/** Run `fn` with a given branch context installed on the ALS store. */
function within(ctx: BranchContext | null, fn: () => void): void {
  runWithBranchStore(() => {
    setBranchContext(ctx);
    fn();
  });
}

const allBranches: BranchContext = {
  effectiveBranchId: null,
  accessibleBranchIds: [],
  isAllBranches: true,
  isGlobal: true,
};
const globalNarrowedToA: BranchContext = {
  effectiveBranchId: A,
  accessibleBranchIds: [A, B],
  isAllBranches: false,
  isGlobal: true,
};
const scopedToA: BranchContext = {
  effectiveBranchId: A,
  accessibleBranchIds: [A],
  isAllBranches: false,
  isGlobal: false,
};
const scopedMultiNoNarrow: BranchContext = {
  effectiveBranchId: null,
  accessibleBranchIds: [A, B],
  isAllBranches: false,
  isGlobal: false,
};

describe('assertInBranch', () => {
  it('unscoped (no context) allows anything, including null', () => {
    within(null, () => {
      expect(() => assertInBranch(A)).not.toThrow();
      expect(() => assertInBranch(null)).not.toThrow();
      expect(() => assertInBranch(undefined)).not.toThrow();
    });
  });

  it('all-branches (global, not narrowed) allows anything, including null', () => {
    within(allBranches, () => {
      expect(() => assertInBranch(A)).not.toThrow();
      expect(() => assertInBranch(C)).not.toThrow();
      expect(() => assertInBranch(null)).not.toThrow();
    });
  });

  describe('global caller narrowed to branch A (view filter, not a ceiling)', () => {
    it('allows the narrowed branch', () => {
      within(globalNarrowedToA, () =>
        expect(() => assertInBranch(A)).not.toThrow(),
      );
    });

    it('404s another branch (no existence leak)', () => {
      within(globalNarrowedToA, () =>
        expect(() => assertInBranch(B)).toThrow(NotFoundException),
      );
    });

    it('ALLOWS a company-wide (null-branch) record — the production fix', () => {
      within(globalNarrowedToA, () =>
        expect(() => assertInBranch(null)).not.toThrow(),
      );
    });
  });

  describe('non-global caller scoped to branch A (fail-closed)', () => {
    it('allows its own branch', () => {
      within(scopedToA, () => expect(() => assertInBranch(A)).not.toThrow());
    });

    it('404s another branch', () => {
      within(scopedToA, () =>
        expect(() => assertInBranch(B)).toThrow(NotFoundException),
      );
    });

    it('404s a null-branch record (not entitled to company-wide data)', () => {
      within(scopedToA, () =>
        expect(() => assertInBranch(null)).toThrow(NotFoundException),
      );
    });
  });

  describe('non-global caller with a multi-branch envelope, not narrowed', () => {
    it('allows any branch inside the envelope', () => {
      within(scopedMultiNoNarrow, () => {
        expect(() => assertInBranch(A)).not.toThrow();
        expect(() => assertInBranch(B)).not.toThrow();
      });
    });

    it('404s a branch outside the envelope', () => {
      within(scopedMultiNoNarrow, () =>
        expect(() => assertInBranch(C)).toThrow(NotFoundException),
      );
    });

    it('404s a null-branch record (non-global)', () => {
      within(scopedMultiNoNarrow, () =>
        expect(() => assertInBranch(null)).toThrow(NotFoundException),
      );
    });
  });
});

describe('getScopedBranchIds', () => {
  it('null (no filter) for unscoped / all-branches callers', () => {
    within(null, () => expect(getScopedBranchIds()).toBeNull());
    within(allBranches, () => expect(getScopedBranchIds()).toBeNull());
  });

  it('the single narrowed branch when narrowed', () => {
    within(globalNarrowedToA, () => expect(getScopedBranchIds()).toEqual([A]));
  });

  it('the full envelope when not narrowed', () => {
    within(scopedMultiNoNarrow, () =>
      expect(getScopedBranchIds()).toEqual([A, B]),
    );
  });
});
