import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Principal } from '../../auth/auth.service';

/**
 * Which departments a caller may see other people's requests in.
 *
 * `null` means "no narrowing" — ADMIN, HR and payroll read the whole workforce.
 * An array means the caller is a MANAGER and the answer is scoped to it; an
 * EMPTY array is a real answer meaning "this manager runs nothing", and the
 * caller then sees nobody but themselves rather than everybody.
 *
 * A manager's scope is the departments they actually MANAGE
 * (`Department.managerId`), not the one they happen to sit in. Those are
 * different claims: an engineer and their department head share a
 * `departmentId`, and reading the scope off that column would hand every member
 * of a department the whole department's leave reasons.
 */
export async function managerDepartmentIds(
  prisma: PrismaService,
  user: Pick<Principal, 'role' | 'employeeId'>,
): Promise<string[] | null> {
  if (user.role !== 'MANAGER') return null;
  if (!user.employeeId) return [];

  const managed = await prisma.department.findMany({
    where: { managerId: user.employeeId },
    select: { id: true },
  });
  return managed.map((d) => d.id);
}

/** True when `departmentId` falls inside a resolved manager scope. */
export function isInManagerScope(
  scope: string[] | null,
  departmentId: string | null | undefined,
): boolean {
  if (scope === null) return true;
  if (!departmentId) return false;
  return scope.includes(departmentId);
}

/** The subject of a request, as far as access control is concerned. */
export interface RequestSubject {
  id: string;
  departmentId: string | null;
  /** Who signs this person's leave and timesheet. */
  supervisorId?: string | null;
}

/**
 * May this caller see, or decide, a request belonging to `subject`?
 *
 * Four ways in, in the order a reader would ask them:
 *
 *   1. It is their own request.
 *   2. They are the SUPERVISOR named on the employee's record. This is the whole
 *      single-approver model: a supervisor typically holds no elevated role, so
 *      without this the person the system asks to decide cannot open the thing
 *      they are deciding.
 *   3. They manage the employee's department.
 *   4. They hold a company-wide role.
 *
 * `scope` is the result of {@link managerDepartmentIds} — `null` for a
 * company-wide role, which is why case 4 is expressed as `scope === null`.
 */
export function canAccessRequestOf(
  user: Pick<Principal, 'role' | 'employeeId'>,
  subject: RequestSubject,
  scope: string[] | null,
): boolean {
  if (user.employeeId && subject.id === user.employeeId) return true;
  if (user.employeeId && subject.supervisorId === user.employeeId) return true;
  // An EMPLOYEE holds no company-wide role, so the two tests above are the ONLY
  // ways in for them. Falling through to the `scope === null` branch below —
  // which is true for every role that is not a MANAGER — would have let any
  // colleague read anybody's leave reason by walking request ids.
  if (user.role === 'EMPLOYEE') return false;
  if (scope === null) return true;
  return isInManagerScope(scope, subject.departmentId);
}

export function assertCanAccessRequestOf(
  user: Pick<Principal, 'role' | 'employeeId'>,
  subject: RequestSubject,
  scope: string[] | null,
  action = 'view',
): void {
  if (!canAccessRequestOf(user, subject, scope)) {
    throw new ForbiddenException(
      `You do not have permission to ${action} this request`,
    );
  }
}
