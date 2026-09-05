/**
 * The facts a payroll run's guards are built on.
 *
 * Pure: no Prisma, no Nest. Layer 0.
 *
 * These functions return DATA, never throws, and that is the whole design.
 * `payrolls.service.ts` calls them and raises its own exceptions with its own
 * literal messages — messages that e2e specs assert on word for word — while the
 * pre-flight calls the same functions and renders findings. One definition of
 * "is this run safe", two presentations of it, and no possibility of the
 * pre-flight saying "ready" about a run that generation then refuses.
 */

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
 * The distinction matters: a run naming only unknown employees is a mistake
 * (G23), while a run over a branch with nobody in it is a different mistake, and
 * telling them apart is the difference between a useful message and "0 items".
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
 * employee with no attendance is a data gap for that person, while NOBODY having
 * attendance means the period was never processed, and paying everyone a full
 * month off the back of that is the expensive mistake.
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

export interface ContractFacts {
  withoutActiveContract: string[];
}

/**
 * Who has no active contract.
 *
 * Today this only waives PF, silently. Surfacing it is the point: an employee
 * with no contract is usually a record somebody forgot to renew, and the
 * consequence reaches their statutory deductions.
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

export interface SalaryFacts {
  withoutAnyPay: string[];
}

/** Who would be paid nothing at all, because no rate exists anywhere. */
export function resolveSalary(
  employees: Array<{
    id: string;
    baseSalary?: unknown;
    components?: Array<{ componentType: string; amount: unknown }>;
  }>,
): SalaryFacts {
  return {
    withoutAnyPay: employees
      .filter((e) => {
        const base = Number(e.baseSalary ?? 0);
        const fromComponents = (e.components ?? [])
          .filter((c) => c.componentType !== 'PAYROLL_CONFIG')
          .reduce((a, c) => a + Number(c.amount ?? 0), 0);
        return base <= 0 && fromComponents <= 0;
      })
      .map((e) => e.id),
  };
}
