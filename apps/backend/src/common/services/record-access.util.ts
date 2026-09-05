import { ForbiddenException } from '@nestjs/common';
import { assertInBranch } from '../branch/branch-scope.util';
import { isDeptInManagerScope } from './manager-scope.util';

/**
 * Object-level authorization for "may this caller see or act on records
 * belonging to THIS employee".
 *
 * Every by-id and by-employee door in Leave, Overtime, Leave Balances and Leave
 * Attachments needs the same three-part answer, and before this helper existed
 * each module answered it differently — or, more often, not at all:
 *
 *   - `OvertimeService.findByEmployee` checked the department.
 *   - `LeaveRequestsService.findByEmployee` checked nothing, one module away.
 *   - `LeaveBalancesService` checked neither the department nor the branch.
 *   - `LeaveAttachmentsService.remove` checked properly; its own `upload` and
 *     `findByLeaveRequest` did not.
 *
 * The rule, in the order the checks must run:
 *
 *   1. **Branch first, as a 404.** `assertInBranch` refuses with NotFound rather
 *      than Forbidden so a scoped caller cannot learn that an employee exists in
 *      a branch they cannot reach. Answering 403 here would turn every by-id
 *      door into an existence oracle.
 *   2. **ADMIN and HR_MANAGER** may then reach anyone inside that envelope.
 *   3. **MANAGER** may reach only the departments they head.
 *   4. **Everyone else** may reach only their own records.
 *
 * @param user      the request principal (`req.user`)
 * @param employee  the SUBJECT of the record — its own id, department and branch
 * @param action    used only to phrase the refusal ("view", "act on", …)
 */
export function assertCanAccessEmployeeRecord(
  user: any,
  employee: {
    id: string;
    departmentId?: string | null;
    branchId?: string | null;
  },
  action = 'view',
): void {
  // 0. Your OWN record, first and unconditionally.
  //
  //    Before the branch check, deliberately: the active branch is a VIEW
  //    filter chosen in the picker, not a statement about who you are. A user
  //    whose own employee record sits in a branch other than the selected one
  //    must still be able to read their own requests — otherwise
  //    `/leave-requests/my-requests` 404s for anyone browsing another branch,
  //    which is exactly what the route matrix caught.
  if (user?.employeeId && user.employeeId === employee.id) return;

  // 1. Branch — 404, deliberately, and before anything that could leak.
  assertInBranch(employee.branchId);

  const role = user?.role;

  // 2. Company-wide roles.
  if (role === 'ADMIN' || role === 'HR_MANAGER') return;

  // 3. Managers, within the departments they actually head.
  if (role === 'MANAGER') {
    if (isDeptInManagerScope(user, employee.departmentId)) return;
    throw new ForbiddenException(
      'You do not have permission to view employees outside your department.',
    );
  }

  // 4. Everyone else is refused. (Reading your OWN record was admitted at step
  //    0; a supervisor's authority to APPROVE is granted per step by the
  //    approval engine, not here — this guard is about reading and editing a
  //    record, not deciding it.)
  throw new ForbiddenException(
    `You do not have permission to ${action} this employee's records.`,
  );
}

/**
 * Whether the caller may file or edit a record ON BEHALF OF `employeeId`.
 *
 * Filing for yourself is always allowed. Filing for somebody else is an HR
 * privilege: without this check, `employeeId = dto.employeeId || userEmployeeId`
 * lets any authenticated employee book leave against a colleague — and the days
 * come out of the colleague's balance.
 */
export function assertCanActOnBehalfOf(
  user: any,
  targetEmployeeId: string,
): void {
  if (user?.employeeId && user.employeeId === targetEmployeeId) return;
  if (user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') return;
  throw new ForbiddenException(
    'You do not have permission to file requests for another employee.',
  );
}
