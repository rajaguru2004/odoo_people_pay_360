/**
 * One person on the supervisor link.
 *
 * `fullName` is joined server-side. Employee records store `firstName` and
 * `lastName` separately everywhere else and the browser joins them, but these
 * rows are trimmed projections of a person rather than employee records, and
 * shipping two columns so the screen can join them again buys nothing. The
 * parts stay beside it for the avatar initials.
 */
export interface SuperviseeCard {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  position: string | null;
  status: string;
  department: { id: string; name: string } | null;
}

/** The same card under the name the supervisor screens read it by. */
export type SupervisedEmployee = SuperviseeCard;

/**
 * NOTE: there is deliberately no bare-array alias for a supervisor's reports.
 *
 * `GET /supervisors/reports/:supervisorId` answers `{ count, data }`, not an
 * array — see `SupervisedTeam` below. An alias shaped like the array was
 * present here briefly and had no consumers; anything that had adopted it would
 * have compiled cleanly and then failed at runtime on `.map` of an object.
 */

/**
 * What the `/supervisors` list routes actually answer with.
 *
 * The count travels beside the rows rather than being read off `data.length`:
 * these endpoints are not paginated, and keeping the field is what lets a
 * caller show "signs for 12" without holding all twelve.
 */
/**
 * A supervisor's reports.
 *
 * The rows ARE the payload — `{ success, data: [...], meta: { count } }`, the
 * same envelope as every other list in the system. The count is read from
 * `meta`, which is where the envelope carries it, so these endpoints do not
 * become the only ones whose rows sit two levels deep.
 */
export type SupervisedTeam = SuperviseeCard[];

export interface AssignSupervisorPayload {
  employeeId: string;
  supervisorId: string;
}

export interface BulkAssignSupervisorPayload {
  employeeIds: string[];
  supervisorId: string;
}
