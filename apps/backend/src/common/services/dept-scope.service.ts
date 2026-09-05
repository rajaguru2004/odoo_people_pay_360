import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isDeptInManagerScope,
  managerDeptWhere,
} from './manager-scope.util';

export const DEPT_SCOPE_ERROR =
  'You do not have permission to perform this action outside your department.';

@Injectable()
export class DeptScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * If the requesting user is a MANAGER, verify that the target employee
   * belongs to one of the departments the manager heads.
   * Non-MANAGER roles (ADMIN, HR_MANAGER) pass through without any check.
   *
   * @param user         - The authenticated user from the JWT (req.user)
   * @param targetEmployeeId - The employee the action is being performed on
   */
  async verifyDeptScope(user: any, targetEmployeeId: string): Promise<void> {
    if (user.role !== 'MANAGER') return;

    const target = await this.prisma.employee.findUnique({
      where: { id: targetEmployeeId },
      select: { departmentId: true },
    });

    if (!target || !isDeptInManagerScope(user, target.departmentId)) {
      throw new ForbiddenException(DEPT_SCOPE_ERROR);
    }
  }

  /**
   * Verify that a given departmentId is one the manager heads.
   * Use this when the department is known directly (e.g., from route params).
   */
  verifyDeptId(user: any, departmentId: string): void {
    if (user.role !== 'MANAGER') return;

    if (!isDeptInManagerScope(user, departmentId)) {
      throw new ForbiddenException(DEPT_SCOPE_ERROR);
    }
  }

  /**
   * Returns a Prisma `where` clause fragment that filters employees to the
   * manager's departments. Returns empty object for other roles.
   */
  getDeptFilter(user: any): { departmentId?: { in: string[] } } {
    return managerDeptWhere(user);
  }
}
