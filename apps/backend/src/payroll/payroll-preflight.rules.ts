/**
 * The facts a payroll run's guards are built on.
 *
 * Pure: no Prisma, no Nest. Layer 0.
 *
 * Ported from HRM's file of the same name, whose design is the point: these
 * functions return DATA, never throws. `payroll-runs.service.ts` calls them and
 * raises its own exceptions with its own literal messages — messages the e2e
 * specs assert word for word — while the pre-flight endpoint calls the same
 * functions and renders findings. One definition of "is this run safe", two
 * presentations of it, and no possibility of the pre-flight saying "ready"
 * about a run that generation then refuses.
 */

export type FindingSeverity = 'BLOCKER' | 'WARNING';

export interface PreflightFinding {
  code: string;
  severity: FindingSeverity;
  employeeId?: string;
  employeeName?: string;
  message: string;
}

export interface PopulationInput {
  /** Employees the run actually found. */
  found: Array<{ id: string }>;
  /** Ids the caller asked for, when it named them. */
  requestedIds?: string[] | null;
}

export interface PopulationFacts {
  foundIds: string[];
  /** Ids that matched nobody. */
  unmatchedIds: string[];
  isEmpty: boolean;
  /** Set when the run would produce nothing, saying which case it is. */
  emptyReason: 'NO_EMPLOYEES' | 'ALL_UNMATCHED' | null;
}

/**
 * Who a run would pay, and who it was asked about but could not find.
 *
 * The distinction matters: a run naming only unknown employees is a mistake,
 * while a run over a population with nobody active in it is a different
 * mistake, and telling them apart is the difference between a useful message
 * and "0 items".
 */
export function resolvePopulation(input: PopulationInput): PopulationFacts {
  const foundIds = input.found.map((e) => e.id);
  const requested = input.requestedIds ?? null;
  const foundSet = new Set(foundIds);
  const unmatchedIds = requested
    ? requested.filter((id) => !foundSet.has(id))
    : [];

  const isEmpty = foundIds.length === 0;
  let emptyReason: PopulationFacts['emptyReason'] = null;
  if (isEmpty) {
    emptyReason =
      requested && requested.length > 0 ? 'ALL_UNMATCHED' : 'NO_EMPLOYEES';
  }
  return { foundIds, unmatchedIds, isEmpty, emptyReason };
}

export interface AttendanceCoverageInput {
  /** One row per employee that has ANY attendance captured in the period. */
  counts: Array<{ employeeId: string }>;
  employeeIds: string[];
}

export interface AttendanceCoverageFacts {
  employeesWithAttendance: Set<string>;
  employeesWithout: string[];
  /** Nobody at all has attendance — almost always an unprocessed period. */
  runHasNone: boolean;
}

/**
 * Who has attendance captured, and whether anybody does.
 *
 * The run-level case is separate because it means something different: one
 * employee with no attendance is a data gap for that person, while NOBODY
 * having attendance means the period was never processed, LOP is zero for
 * everyone, and the run quietly pays a full month against a month nobody
 * recorded. That is the expensive mistake, so it is a BLOCKER.
 */
export function resolveAttendanceCoverage(
  input: AttendanceCoverageInput,
): AttendanceCoverageFacts {
  const employeesWithAttendance = new Set(
    input.counts.map((c) => c.employeeId),
  );
  const employeesWithout = input.employeeIds.filter(
    (id) => !employeesWithAttendance.has(id),
  );
  return {
    employeesWithAttendance,
    employeesWithout,
    runHasNone: employeesWithAttendance.size === 0,
  };
}

export interface StructureLike {
  employeeId: string;
  lines?: Array<{ type?: string; amount?: unknown }>;
}

export interface StructureFacts {
  /** No salary structure at all. */
  withoutStructure: string[];
  /** A structure exists but nothing in it pays anything. */
  withoutEarning: string[];
}

/**
 * Who cannot be paid because nothing says what to pay them.
 *
 * Two cases, kept apart because the fix differs: one employee needs a structure
 * created, the other needs an earning line added to the one they have.
 */
export function resolveStructures(
  employeeIds: string[],
  structures: StructureLike[],
): StructureFacts {
  const byEmployee = new Map(structures.map((s) => [s.employeeId, s]));
  const withoutStructure: string[] = [];
  const withoutEarning: string[] = [];

  for (const id of employeeIds) {
    const structure = byEmployee.get(id);
    if (!structure) {
      withoutStructure.push(id);
      continue;
    }
    const pays = (structure.lines ?? []).some(
      (l) => l.type === 'EARNING' && Number(l.amount ?? 0) > 0,
    );
    if (!pays) withoutEarning.push(id);
  }

  return { withoutStructure, withoutEarning };
}

export interface ContractFacts {
  withoutActiveContract: string[];
}

/**
 * Who has no active contract.
 *
 * A WARNING, not a blocker: the structure still says what to pay, and refusing
 * the whole run over one lapsed record would strand everybody else. But an
 * employee with no contract is usually a renewal somebody forgot, and paying
 * them without saying so is how it stays forgotten.
 */
export function resolveContracts(
  employees: Array<{ id: string; contracts?: Array<{ status?: string }> }>,
): ContractFacts {
  return {
    withoutActiveContract: employees
      .filter(
        (e) => !(e.contracts ?? []).some((c) => (c.status ?? '') === 'ACTIVE'),
      )
      .map((e) => e.id),
  };
}

/** Does anything here refuse the run? */
export function hasBlocker(findings: PreflightFinding[]): boolean {
  return findings.some((f) => f.severity === 'BLOCKER');
}
