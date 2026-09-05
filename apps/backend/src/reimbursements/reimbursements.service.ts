import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import {
  managerDeptScope,
  isDeptInManagerScope,
} from '../common/services/manager-scope.util';
import { CreateReimbursementDto } from './dto/create-reimbursement.dto';
import { ApproveReimbursementDto } from './dto/approve-reimbursement.dto';
import { RejectReimbursementDto } from './dto/reject-reimbursement.dto';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class ReimbursementsService {
  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private settingsService: SystemSettingsService,
    private notifications: NotificationsService,
  ) {}

  private employeeInclude = {
    employee: {
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        email: true,
        departmentId: true,
        branchId: true,
        department: { select: { id: true, name: true } },
      },
    },
    approver: {
      select: {
        id: true,
        email: true,
        employee: { select: { fullName: true } },
      },
    },
    attachments: {
      where: { deletedAt: null },
      orderBy: { uploadedAt: 'desc' as const },
    },
  };

  /** BigInt attachment sizes are not JSON-serializable — convert to Number. */
  private serialize(reimbursement: any) {
    if (!reimbursement) return reimbursement;
    return {
      ...reimbursement,
      attachments: reimbursement.attachments?.map((a: any) => ({
        ...a,
        fileSize:
          a.fileSize !== null && a.fileSize !== undefined
            ? Number(a.fileSize)
            : null,
      })),
    };
  }

  /** Roles allowed to approve, as configured in Settings → Reimbursement. */
  private async getApproverRoles(): Promise<string[]> {
    const raw = await this.settingsService.getSetting(
      'reimbursement_approver_roles',
      'HR_MANAGER,ADMIN',
    );
    return raw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }

  /**
   * Configurable approver check — must live in the service because the static
   * @Roles decorator cannot read DB-backed settings. MANAGER approvers are
   * scoped to their own department.
   */
  private async assertApprover(user: any, employeeDepartmentId: string) {
    const roles = await this.getApproverRoles();
    if (!roles.includes(user.role)) {
      throw new ForbiddenException(
        'Your role is not configured to approve reimbursements',
      );
    }
    if (
      user.role === 'MANAGER' &&
      !isDeptInManagerScope(user, employeeDepartmentId)
    ) {
      throw new ForbiddenException(
        'You can only review reimbursements from your own department',
      );
    }
  }

  async create(employeeId: string, dto: CreateReimbursementDto) {
    const enabled = await this.settingsService.getSetting(
      'reimbursement_enabled',
      'true',
    );
    if (enabled === 'false') {
      throw new BadRequestException('Reimbursement module is disabled');
    }

    // An account with no employee record is an ordinary shape — an HR or ADMIN
    // login that administers but is not itself staff. Without this guard
    // `employeeId` is `undefined`, Prisma throws on `where: { id: undefined }`,
    // and the server reports its own fault for a perfectly valid request.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record, so it cannot file a reimbursement',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Branch guard: a scoped caller cannot create a request for an
    // out-of-branch employee (create is not auto-scoped for relation models).
    assertInBranch(employee.branchId);

    const typesRaw = await this.settingsService.getSetting(
      'reimbursement_types',
      'Travel,Per Diem,Training,Medical,Food,Office Supplies,Other',
    );
    const types = typesRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!types.includes(dto.type)) {
      throw new BadRequestException(
        `Invalid reimbursement type. Allowed: ${types.join(', ')}`,
      );
    }

    const expenseDate = new Date(dto.expenseDate);
    if (expenseDate.getTime() > Date.now()) {
      throw new BadRequestException('Expense date cannot be in the future');
    }

    const reimbursement = await this.prisma.reimbursement.create({
      data: {
        employeeId,
        type: dto.type,
        amount: dto.amount,
        expenseDate,
        description: dto.description ?? null,
        status: 'PENDING',
      },
      include: this.employeeInclude,
    });

    await this.notifyApprovers(reimbursement);

    return this.serialize(reimbursement);
  }

  /**
   * Create a claim on behalf of an already-approved parent request — a trip's
   * per-diem, a training fee.
   *
   * This is the seam that makes Travel and Training *extensions* of
   * reimbursements rather than parallel expense systems: the parent owns the
   * request and its multi-level approval, the money lands here, and everything
   * downstream is untouched. Payroll still picks the row up with
   * `status:'APPROVED', payrollItemId:null`, still back-links `payrollItemId`,
   * and `lockPayroll()` still flips it to PAID.
   *
   * Differs from `create()` in three deliberate ways:
   *   - skips the `reimbursement_types` setting check — the parent validated its
   *     own category, and a site that removed "Travel" from the chip list must
   *     not thereby break trip approval;
   *   - can be created already APPROVED, because the approval already happened
   *     upstream. Asking an approver to approve the same money twice is the
   *     duplication this design exists to avoid;
   *   - notifies approvers only when it lands PENDING.
   */
  async createFromSource(input: {
    employeeId: string;
    type: string;
    amount: number | Prisma.Decimal;
    expenseDate: Date;
    description?: string;
    sourceType: 'TRAVEL' | 'TRAINING';
    sourceId: string;
    budgetCategory?: string;
    status?: 'PENDING' | 'APPROVED';
    /** Required when status is APPROVED — who the upstream approval is credited to. */
    approverId?: string;
  }) {
    const status = input.status ?? 'APPROVED';
    if (status === 'APPROVED' && !input.approverId) {
      throw new BadRequestException(
        'An approved claim must record the approver it inherited approval from',
      );
    }

    const reimbursement = await this.prisma.reimbursement.create({
      data: {
        employeeId: input.employeeId,
        type: input.type,
        amount: input.amount as any,
        expenseDate: input.expenseDate,
        description: input.description ?? null,
        status,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        budgetCategory: input.budgetCategory ?? null,
        ...(status === 'APPROVED' && {
          approverId: input.approverId,
          approvedAt: new Date(),
          approverRemarks: `Auto-approved with the ${input.sourceType.toLowerCase()} request`,
        }),
      },
      include: this.employeeInclude,
    });

    if (status === 'PENDING') {
      await this.notifyApprovers(reimbursement);
    }

    return this.serialize(reimbursement);
  }

  /** Claims spawned by one parent request (a trip, a nomination). */
  async findBySource(sourceType: 'TRAVEL' | 'TRAINING', sourceId: string) {
    const rows = await this.prisma.reimbursement.findMany({
      where: { sourceType, sourceId },
      include: this.employeeInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  /**
   * Cancel the claims a parent request spawned, when that request is itself
   * cancelled or rejected after the fact.
   *
   * Never touches a claim already linked to a payroll item — that money is
   * mid-payout or paid, and reversing it belongs in payroll, not here.
   */
  async cancelBySource(sourceType: 'TRAVEL' | 'TRAINING', sourceId: string) {
    const result = await this.prisma.reimbursement.updateMany({
      where: {
        sourceType,
        sourceId,
        status: { in: ['PENDING', 'APPROVED'] },
        payrollItemId: null,
      },
      data: { status: 'CANCELLED' },
    });
    return result.count;
  }

  /**
   * Fan out an in-app notification to every user of the configured approver
   * roles. MANAGER recipients only when they belong to the requester's
   * department (matching pending-queue visibility).
   */
  private async notifyApprovers(reimbursement: any) {
    try {
      const roles = await this.getApproverRoles();
      if (roles.length === 0) return;

      const nonManagerRoles = roles.filter((r) => r !== 'MANAGER');
      const or: any[] = [];
      if (nonManagerRoles.length > 0) {
        or.push({ role: { in: nonManagerRoles } });
      }
      if (
        roles.includes('MANAGER') &&
        reimbursement.employee?.departmentId
      ) {
        or.push({
          role: 'MANAGER',
          employee: { departmentId: reimbursement.employee.departmentId },
        });
      }
      if (or.length === 0) return;

      const approvers = await this.prisma.user.findMany({
        where: { isActive: true, OR: or },
        select: { id: true },
      });
      await Promise.all(
        approvers.map((a) =>
          this.notifications.notifyUser(
            a.id,
            'New reimbursement request',
            `${reimbursement.employee.fullName} requested a ${reimbursement.type} reimbursement of ${Number(reimbursement.amount)}.`,
            'INFO',
            '/dashboard/reimbursements',
          ),
        ),
      );
    } catch {
      // Notification failure must not block the request itself.
    }
  }

  /**
   * Notify the requesting employee's user account of an approve/reject decision.
   *
   * `type` is what selects the WhatsApp template, so it must discriminate —
   * the generic 'INFO' this used to send resolved to no template, which is why
   * the decision arrived by email and in the portal but never on WhatsApp.
   */
  private async notifyRequester(
    employeeId: string,
    title: string,
    message: string,
    type: 'REIMBURSEMENT_APPROVED' | 'REIMBURSEMENT_REJECTED',
    waData?: Record<string, unknown>,
  ) {
    try {
      const user = await this.prisma.user.findFirst({
        where: { employeeId },
        select: { id: true },
      });
      if (user) {
        await this.notifications.notifyUser(
          user.id,
          title,
          message,
          type,
          '/dashboard/reimbursements',
          { waData },
        );
      }
    } catch {
      // Non-fatal.
    }
  }

  async findAll(status?: string, employeeId?: string) {
    const where: any = {};
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;

    const rows = await this.prisma.reimbursement.findMany({
      where,
      include: this.employeeInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  /**
   * Pending queue for the current approver. Enforces the configured approver
   * roles (Settings checkboxes) and department scope for MANAGER.
   */
  async findPending(user: any) {
    const roles = await this.getApproverRoles();
    if (!roles.includes(user.role)) {
      throw new ForbiddenException(
        'Your role is not configured to approve reimbursements',
      );
    }

    const where: any = { status: 'PENDING' };
    if (user.role === 'MANAGER') {
      const deptIds = managerDeptScope(user);
      if (deptIds.length === 0) return [];
      where.employee = { departmentId: { in: deptIds } };
    }

    const rows = await this.prisma.reimbursement.findMany({
      where,
      include: this.employeeInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  /**
   * One employee's own claims.
   *
   * The empty-id guard is load-bearing, not defensive noise: `findAll` treats an
   * undefined `employeeId` as "no filter", so an account with no employee record
   * asking for "my requests" was handed EVERY claim in the system — across
   * branches its own `/reimbursements` list is scoped away from. "My requests"
   * for somebody who is not an employee is an empty list, not the whole book.
   */
  async findByEmployee(employeeId: string) {
    if (!employeeId) return [];
    return this.findAll(undefined, employeeId);
  }

  async findOne(id: string, user?: any) {
    const reimbursement = await this.prisma.reimbursement.findUnique({
      where: { id },
      include: this.employeeInclude,
    });

    if (!reimbursement) {
      throw new NotFoundException('Reimbursement request not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(reimbursement.employee.branchId);

    if (user) {
      const isOwner = reimbursement.employeeId === user.employeeId;
      const isAdminOrHR = ['ADMIN', 'HR_MANAGER'].includes(user.role);
      const isDeptManager =
        user.role === 'MANAGER' &&
        isDeptInManagerScope(user, reimbursement.employee.departmentId);
      if (!isOwner && !isAdminOrHR && !isDeptManager) {
        throw new ForbiddenException(
          'You do not have permission to view this request',
        );
      }
    }

    return this.serialize(reimbursement);
  }

  async approve(id: string, user: any, dto?: ApproveReimbursementDto) {
    const reimbursement = await this.findOne(id);
    await this.assertApprover(user, reimbursement.employee.departmentId);

    // Race guard: two approvers clicking simultaneously — only the first
    // PENDING→APPROVED transition wins.
    const result = await this.prisma.reimbursement.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        approverId: user.id,
        approvedAt: new Date(),
        approverRemarks: dto?.remarks ?? null,
      },
    });
    if (result.count === 0) {
      throw new BadRequestException(
        'This request has already been processed by another approver',
      );
    }

    const approver = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { employee: { select: { fullName: true } } },
    });
    const approverName = approver?.employee?.fullName || 'Approver';

    await this.mailService.sendReimbursementApproved(
      reimbursement.employee.email,
      {
        employeeName: reimbursement.employee.fullName,
        type: reimbursement.type,
        amount: Number(reimbursement.amount).toFixed(2),
        expenseDate: reimbursement.expenseDate.toLocaleDateString('en-US'),
        approverName,
        remarks: dto?.remarks,
      },
    );

    await this.notifyRequester(
      reimbursement.employeeId,
      'Reimbursement approved',
      `Your ${reimbursement.type} reimbursement of ${Number(reimbursement.amount)} was approved. It will be included in your upcoming payroll.`,
      'REIMBURSEMENT_APPROVED',
      {
        reimbursementType: reimbursement.type,
        amount: Number(reimbursement.amount),
        status: 'Approved',
      },
    );

    return this.findOne(id);
  }

  async reject(id: string, user: any, dto: RejectReimbursementDto) {
    const reimbursement = await this.findOne(id);
    await this.assertApprover(user, reimbursement.employee.departmentId);

    const result = await this.prisma.reimbursement.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        approverId: user.id,
        approvedAt: new Date(),
        rejectedReason: dto.remarks,
      },
    });
    if (result.count === 0) {
      throw new BadRequestException(
        'This request has already been processed by another approver',
      );
    }

    const approver = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { employee: { select: { fullName: true } } },
    });
    const approverName = approver?.employee?.fullName || 'Approver';

    await this.mailService.sendReimbursementRejected(
      reimbursement.employee.email,
      {
        employeeName: reimbursement.employee.fullName,
        type: reimbursement.type,
        amount: Number(reimbursement.amount).toFixed(2),
        expenseDate: reimbursement.expenseDate.toLocaleDateString('en-US'),
        approverName,
        reason: dto.remarks,
      },
    );

    await this.notifyRequester(
      reimbursement.employeeId,
      'Reimbursement rejected',
      `Your ${reimbursement.type} reimbursement of ${Number(reimbursement.amount)} was rejected: ${dto.remarks}`,
      'REIMBURSEMENT_REJECTED',
      {
        reimbursementType: reimbursement.type,
        amount: Number(reimbursement.amount),
        status: 'Rejected',
        rejectionReason: dto.remarks,
      },
    );

    return this.findOne(id);
  }

  async cancel(id: string, employeeId: string) {
    const reimbursement = await this.findOne(id);

    if (reimbursement.employeeId !== employeeId) {
      throw new ForbiddenException(
        'You do not have permission to cancel this request',
      );
    }

    if (reimbursement.status !== 'PENDING') {
      throw new BadRequestException('Only pending requests can be cancelled');
    }

    return this.prisma.reimbursement.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }

  /**
   * The claim queue as four numbers.
   *
   * Branch scoping is not applied here by hand on purpose: `count` and
   * `aggregate` are in BRANCH_READ_ACTIONS, so the Prisma extension in
   * `PrismaService` scopes them the same way it scopes the list this summarises.
   * Filtering again here would be a second, divergent implementation of the
   * same rule.
   */
  async stats() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [pending, pendingSum, stale, approvedThisMonth, approvedSum] = await Promise.all([
      this.prisma.reimbursement.count({ where: { status: 'PENDING' } }),
      this.prisma.reimbursement.aggregate({
        where: { status: 'PENDING' },
        _sum: { amount: true },
      }),
      // Age, not size, is what makes an approval queue a problem.
      this.prisma.reimbursement.count({
        where: { status: 'PENDING', createdAt: { lt: weekAgo } },
      }),
      this.prisma.reimbursement.count({
        where: { status: 'APPROVED', updatedAt: { gte: monthStart } },
      }),
      this.prisma.reimbursement.aggregate({
        where: { status: 'APPROVED', updatedAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
    ]);

    return {
      success: true,
      data: {
        pendingCount: pending,
        pendingAmount: Number(pendingSum._sum.amount ?? 0),
        olderThan7Days: stale,
        approvedThisMonth,
        approvedAmountThisMonth: Number(approvedSum._sum.amount ?? 0),
      },
    };
  }
}
