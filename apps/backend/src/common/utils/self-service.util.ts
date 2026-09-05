/**
 * Who may only write to their own employee record.
 *
 * MANAGER belongs here, not in the privileged set: a manager is also an employee
 * and must be able to maintain their own profile and documents, but managing the
 * team does not imply the right to edit a colleague's bank details. Read access
 * is separate — managers keep department-scoped reads.
 *
 * Lifted out of EmployeesController so the profile-template layer resolves the
 * SAME notion of "self". Two copies of this predicate would let the form show a
 * field the write path then refuses, or vice versa.
 */
export const SELF_SERVICE_WRITE_ROLES = ['EMPLOYEE', 'MANAGER'];

/** True when this user may only write to their own employee record. */
export function isSelfServiceOnly(user: { role?: string } | null | undefined): boolean {
  return SELF_SERVICE_WRITE_ROLES.includes(user?.role ?? '');
}

/** What per-field permission checks are evaluated against. */
export interface FieldActor {
  role: string;
  isSelf: boolean;
}

/**
 * Build the actor for a request, from the authenticated user and the employee
 * being written to.
 *
 * One helper because three routes derived this by hand and a fourth forgot to
 * derive it at all. `isSelf` is deliberately narrow: it means "a self-service
 * role acting on its own record", so an ADMIN editing their own employee row is
 * still an ADMIN and keeps privileged fields.
 *
 * An absent role yields `EMPLOYEE`, the least privileged value — a malformed
 * token must not be read as a privileged caller.
 */
export function actorFor(
  user: { role?: string; employeeId?: string } | null | undefined,
  targetEmployeeId?: string,
): FieldActor {
  return {
    role: user?.role ?? 'EMPLOYEE',
    isSelf:
      isSelfServiceOnly(user) &&
      Boolean(targetEmployeeId) &&
      user?.employeeId === targetEmployeeId,
  };
}

/**
 * For writes with no human behind them — seeders, backfills, internal jobs.
 *
 * Field permissions exist to constrain people, and a migration script has no
 * role to evaluate. Passing this is an explicit statement that the caller is
 * trusted; the point is that it appears in the code, rather than being implied
 * by an omitted argument the way it used to be.
 */
export const SYSTEM_ACTOR: FieldActor = { role: 'ADMIN', isSelf: false };
