import {
  hasBlocker,
  resolveAttendanceCoverage,
  resolveContracts,
  resolvePopulation,
  resolveStructures,
} from './payroll-preflight.rules';

describe('resolvePopulation', () => {
  it('reports who was found', () => {
    const facts = resolvePopulation({ found: [{ id: 'a' }, { id: 'b' }] });
    expect(facts.foundIds).toEqual(['a', 'b']);
    expect(facts.isEmpty).toBe(false);
    expect(facts.emptyReason).toBeNull();
  });

  it('names the requested ids that matched nobody', () => {
    const facts = resolvePopulation({
      found: [{ id: 'a' }],
      requestedIds: ['a', 'ghost'],
    });
    expect(facts.unmatchedIds).toEqual(['ghost']);
  });

  it('tells an empty population apart from an all-unmatched one', () => {
    // Different mistakes, different messages: "nobody is active" vs "none of the
    // people you named exist".
    expect(resolvePopulation({ found: [] }).emptyReason).toBe('NO_EMPLOYEES');
    expect(
      resolvePopulation({ found: [], requestedIds: ['ghost'] }).emptyReason,
    ).toBe('ALL_UNMATCHED');
  });

  it('reports no unmatched ids when the caller named nobody', () => {
    expect(resolvePopulation({ found: [{ id: 'a' }] }).unmatchedIds).toEqual(
      [],
    );
  });
});

describe('resolveAttendanceCoverage', () => {
  it('names the employees with nothing captured', () => {
    const facts = resolveAttendanceCoverage({
      counts: [{ employeeId: 'a' }],
      employeeIds: ['a', 'b'],
    });
    expect(facts.employeesWithout).toEqual(['b']);
    expect(facts.runHasNone).toBe(false);
  });

  it('flags the run-level case separately', () => {
    // Nobody has attendance: LOP is zero for everyone and the run pays a full
    // month against a period that was never processed.
    const facts = resolveAttendanceCoverage({
      counts: [],
      employeeIds: ['a', 'b'],
    });
    expect(facts.runHasNone).toBe(true);
    expect(facts.employeesWithout).toEqual(['a', 'b']);
  });

  it('ignores duplicate rows for the same employee', () => {
    const facts = resolveAttendanceCoverage({
      counts: [{ employeeId: 'a' }, { employeeId: 'a' }],
      employeeIds: ['a'],
    });
    expect(facts.employeesWithAttendance.size).toBe(1);
    expect(facts.employeesWithout).toEqual([]);
  });
});

describe('resolveStructures', () => {
  it('separates no structure from a structure that pays nothing', () => {
    const facts = resolveStructures(
      ['a', 'b', 'c'],
      [
        { employeeId: 'b', lines: [{ type: 'DEDUCTION', amount: 50 }] },
        { employeeId: 'c', lines: [{ type: 'EARNING', amount: 500 }] },
      ],
    );
    expect(facts.withoutStructure).toEqual(['a']);
    expect(facts.withoutEarning).toEqual(['b']);
  });

  it('counts a zero earning line as no earning', () => {
    const facts = resolveStructures(
      ['a'],
      [{ employeeId: 'a', lines: [{ type: 'EARNING', amount: 0 }] }],
    );
    expect(facts.withoutEarning).toEqual(['a']);
  });
});

describe('resolveContracts', () => {
  it('names everyone with no active contract', () => {
    const facts = resolveContracts([
      { id: 'a', contracts: [{ status: 'ACTIVE' }] },
      { id: 'b', contracts: [{ status: 'TERMINATED' }] },
      { id: 'c', contracts: [] },
      { id: 'd' },
    ]);
    expect(facts.withoutActiveContract).toEqual(['b', 'c', 'd']);
  });
});

describe('hasBlocker', () => {
  it('is true only when something refuses the run', () => {
    expect(
      hasBlocker([{ code: 'X', severity: 'WARNING', message: 'careful' }]),
    ).toBe(false);
    expect(
      hasBlocker([
        { code: 'X', severity: 'WARNING', message: 'careful' },
        { code: 'Y', severity: 'BLOCKER', message: 'no' },
      ]),
    ).toBe(true);
  });
});
