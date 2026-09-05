/**
 * Supervisor scoping.
 *
 * A supervisor is an employee dynamically assigned over one or more other
 * employees (`Employee.supervisorId`). It is an APPROVAL RESPONSIBILITY, not an
 * RBAC role: a supervisor may hold any `User.role` (typically EMPLOYEE) and gains
 * no administrative permissions — only approval access for their assigned reports.
 *
 * `req.user.supervisedEmployeeIds` is populated per request by the JWT strategy
 * (see auth/strategies/jwt.strategy.ts) from the DB, so (re)assignments apply
 * immediately. These helpers are the single source of truth for turning it into a
 * scope, mirroring manager-scope.util.ts. Supervisor scope is orthogonal to and
 * composable with department-manager scope — the two are independent.
 */

/**
 * The set of employee ids a user supervises. Empty for users with no assignees.
 */
export function supervisorScope(user: any): string[] {
  const ids: string[] = user?.supervisedEmployeeIds ?? [];
  return ids;
}

/** Whether `employeeId` is one of the user's assigned supervisees. */
export function isInSupervisorScope(
  user: any,
  employeeId?: string | null,
): boolean {
  if (!employeeId) return false;
  return supervisorScope(user).includes(employeeId);
}

/**
 * A Prisma `where` fragment narrowing a query to a user's supervisees, keyed by
 * `employeeId`. Returns an impossible match (`{ employeeId: { in: [] } }`) when
 * the user supervises nobody, so it is fail-closed and safe to spread into a
 * relation filter. Callers that want "no narrowing" for privileged roles should
 * gate on role before spreading this.
 */
export function supervisorWhere(user: any): { employeeId: { in: string[] } } {
  return { employeeId: { in: supervisorScope(user) } };
}
