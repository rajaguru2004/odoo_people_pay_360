import { PrismaService } from '../prisma/prisma.service';

/**
 * Keeps the MANAGER role tied to actually heading something.
 *
 * Headship is what makes a user a MANAGER here: assigning a head promotes them,
 * and losing their last department has to demote them. Both the change-request
 * approval and an ordinary department delete can be the moment someone stops
 * heading anything, so the rule lives here rather than in either of them.
 *
 * Without it, a user kept `role = 'MANAGER'` with no active department — at
 * which point `managedDepartments` resolves empty and `managerDeptScope` falls
 * back to their HOME department. Authority did not end, it moved somewhere
 * nobody granted.
 *
 * ADMIN and HR_MANAGER are untouched: their authority never came from headship.
 */
export async function demoteIfHeadsNothing(
  prisma: PrismaService,
  employeeId: string | null | undefined,
): Promise<void> {
  if (!employeeId) return;

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: { user: true },
  });
  if (employee?.user?.role !== 'MANAGER') return;

  const stillHeads = await prisma.department.count({
    where: { managerId: employeeId, isActive: true },
  });
  if (stillHeads > 0) return;

  await prisma.user.update({
    where: { id: employee.user.id },
    data: { role: 'EMPLOYEE' },
  });
}
