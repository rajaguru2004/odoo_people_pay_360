/**
 * Multi-department manager scoping.
 *
 * A manager (user.role === 'MANAGER') may head more than one department. Their
 * managerial authority — approving leave/overtime/attendance, viewing dashboards,
 * timesheets, reimbursements, loans, tasks, etc. — must cover EVERY department
 * they manage, not just their own home department.
 *
 * `req.user.managedDepartmentIds` is populated per request by the JWT strategy
 * (see auth/strategies/jwt.strategy.ts). These helpers are the single source of
 * truth for turning it into a scope. For a manager who heads exactly one
 * department (every manager before this feature) the scope is `[homeDept]`, so
 * behavior is identical to the previous single-department code.
 */

/**
 * The set of department ids a manager is authorized to act within.
 *
 * Falls back to the user's own `departmentId` when `managedDepartmentIds` is
 * absent or empty (e.g. a role=MANAGER user currently between assignments, or an
 * old token) so authority never silently widens or fully disappears.
 */
export function managerDeptScope(user: any): string[] {
  const managed: string[] = user?.managedDepartmentIds ?? [];
  if (managed.length > 0) {
    return managed;
  }
  return user?.departmentId ? [user.departmentId] : [];
}

/**
 * Whether `departmentId` is inside a manager's authority scope. Non-department
 * ids (null/undefined) are never in scope.
 */
export function isDeptInManagerScope(user: any, departmentId?: string | null): boolean {
  if (!departmentId) return false;
  return managerDeptScope(user).includes(departmentId);
}

/**
 * A Prisma `where` fragment that narrows a query to a manager's departments.
 * Returns `{}` (no narrowing) for non-MANAGER roles (ADMIN, HR_MANAGER, …), so
 * it is safe to spread into any `where` unconditionally.
 *
 * Usage:  where.employee = managerDeptWhere(user);            // relation filter
 *         where = { ...where, ...managerDeptWhere(user) };    // direct filter
 */
export function managerDeptWhere(user: any): { departmentId?: { in: string[] } } {
  if (user?.role !== 'MANAGER') {
    return {};
  }
  return { departmentId: { in: managerDeptScope(user) } };
}
