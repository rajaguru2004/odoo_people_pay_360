import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PayrollRunStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toDayKey } from '../attendances/attendance-calendar.util';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import { periodLabel } from './payroll-period.util';
import type { Principal } from '../auth/auth.service';
import type { ListPayslipsDto } from './dto/list-payslips.dto';

/** Roles entitled to read anybody's payslip. */
const MANAGEMENT_ROLES: UserRole[] = [
  UserRole.ADMIN,
  UserRole.HR_MANAGER,
  UserRole.PAYROLL_OFFICER,
];

/**
 * What an employee is allowed to see of their own pay.
 *
 * A draft figure is still being corrected, and an employee who reads one and
 * then reads a different approved figure has been told two different things
 * about the same month.
 */
const SELF_VISIBLE_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.PAID,
];

const PAYSLIP_INCLUDE = {
  lines: { orderBy: [{ sequence: 'asc' }, { code: 'asc' }] },
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: true,
      branch: { select: { id: true, name: true } },
      department: { select: { id: true, name: true } },
    },
  },
  payrollRun: {
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      status: true,
      currency: true,
      paidAt: true,
      approvedAt: true,
    },
  },
} satisfies Prisma.PayslipInclude;

type PayslipRow = Prisma.PayslipGetPayload<{ include: typeof PAYSLIP_INCLUDE }>;

@Injectable()
export class PayslipsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The period label is formatted here so the browser does no calendar maths. */
  private decorate(row: PayslipRow) {
    return {
      ...row,
      payrollRun: {
        ...row.payrollRun,
        periodLabel: periodLabel(row.payrollRun.periodStart),
        periodStart: toDayKey(row.payrollRun.periodStart),
        periodEnd: toDayKey(row.payrollRun.periodEnd),
      },
    };
  }

  /**
   * Somebody's own payslip, or a management role.
   *
   * Enforced here rather than with `@Roles` on the route because the answer
   * depends on WHOSE payslip it is, which a decorator cannot see. The same
   * reasoning `attendances.service.ts` uses, and the same shape.
   */
  private assertMayRead(employeeId: string, user: Principal) {
    if (MANAGEMENT_ROLES.includes(user.role)) return;
    if (user.employeeId && user.employeeId === employeeId) return;
    throw new ForbiddenException(
      'You do not have permission to view this payslip',
    );
  }

  private ownEmployeeId(user: Principal): string {
    if (!user.employeeId) {
      throw new ForbiddenException(
        'Your account is not linked to an employee record, so it has no payslips.',
      );
    }
    return user.employeeId;
  }

  // ------------------------------------------------------------ self-service

  async findMine(user: Principal, query: ListPayslipsDto) {
    const { page, limit, skip, take } = resolvePagination(query);
    const where: Prisma.PayslipWhereInput = {
      employeeId: this.ownEmployeeId(user),
      payrollRun: { status: { in: SELF_VISIBLE_STATUSES } },
    };

    const [rows, total] = await Promise.all([
      this.prisma.payslip.findMany({
        where,
        include: PAYSLIP_INCLUDE,
        orderBy: { payrollRun: { periodStart: 'desc' } },
        skip,
        take,
      }),
      this.prisma.payslip.count({ where }),
    ]);

    return paginated(
      rows.map((r) => this.decorate(r)),
      total,
      page,
      limit,
    );
  }

  async findMineOne(id: string, user: Principal) {
    const row = await this.prisma.payslip.findFirst({
      where: {
        id,
        employeeId: this.ownEmployeeId(user),
        payrollRun: { status: { in: SELF_VISIBLE_STATUSES } },
      },
      include: PAYSLIP_INCLUDE,
    });
    // A 404 rather than a 403: an employee asking for an id that is not theirs
    // should not learn from the answer that it exists.
    if (!row) throw new NotFoundException('Payslip not found');
    return { success: true as const, data: this.decorate(row) };
  }

  // -------------------------------------------------------------- privileged

  async findAll(query: ListPayslipsDto, settledOnly = false) {
    const { page, limit, skip, take } = resolvePagination(query);
    const where: Prisma.PayslipWhereInput = {};
    if (query.runId) where.payrollRunId = query.runId;
    if (query.employeeId) where.employeeId = query.employeeId;
    // `settledOnly` is passed by the self-serving caller, not decided here: a
    // payroll role listing the same employee is entitled to the draft rows.
    if (settledOnly) {
      where.payrollRun = { status: { in: SELF_VISIBLE_STATUSES } };
    }

    const [rows, total] = await Promise.all([
      this.prisma.payslip.findMany({
        where,
        include: PAYSLIP_INCLUDE,
        orderBy: [
          { payrollRun: { periodStart: 'desc' } },
          { payslipNumber: 'asc' },
        ],
        skip,
        take,
      }),
      this.prisma.payslip.count({ where }),
    ]);

    return paginated(
      rows.map((r) => this.decorate(r)),
      total,
      page,
      limit,
    );
  }

  async findOne(id: string, user: Principal) {
    const row = await this.prisma.payslip.findUnique({
      where: { id },
      include: PAYSLIP_INCLUDE,
    });
    if (!row) throw new NotFoundException('Payslip not found');
    this.assertMayRead(row.employeeId, user);

    // An employee reading their own row still only sees a settled one.
    if (
      !MANAGEMENT_ROLES.includes(user.role) &&
      !SELF_VISIBLE_STATUSES.includes(row.payrollRun.status)
    ) {
      throw new NotFoundException('Payslip not found');
    }

    return { success: true as const, data: this.decorate(row) };
  }

  /**
   * One employee's payslips.
   *
   * Passing the run-status narrowing through is what makes this route agree
   * with `findMine` and `findOne`. Without it, an employee asking for their OWN
   * id here read the draft figures those two exist to hide — the same answer,
   * about the same month, differing by which door it was asked through.
   */
  async findByEmployee(
    employeeId: string,
    user: Principal,
    query: ListPayslipsDto,
  ) {
    this.assertMayRead(employeeId, user);
    const settledOnly = !MANAGEMENT_ROLES.includes(user.role);
    return this.findAll({ ...query, employeeId }, settledOnly);
  }
}
