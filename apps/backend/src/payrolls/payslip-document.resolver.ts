import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import {
  DocumentContextResolver,
  DocumentSubjectRequest,
  subjectKey,
} from '../documents/document-context.registry';
import { assertInBranch } from '../common/branch/branch-scope.util';
// Imported, never re-declared. A second list of "statuses an employee may see"
// would drift from the payslip API's, and the two would disagree about whether
// a particular run is visible — with the PDF being the one people keep.
import { EMPLOYEE_VISIBLE_PAYROLL_STATUSES } from './payrolls.service';

type Principal = { id?: string; role: string; employeeId?: string | null };

const money = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * Payslip data, for the document engine.
 *
 * Lives in `src/payrolls/` rather than in the engine because payroll owns both
 * the figures AND the rules about who may see them — in particular that a
 * DRAFT run is not a statement of pay. Putting that rule in the engine would
 * be a second copy of it, and the copy would drift.
 */
@Injectable()
export class PayslipDocumentResolver implements DocumentContextResolver {
  readonly typeKeys = ['PAYSLIP'] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  async assertMayRead(req: DocumentSubjectRequest, user: unknown): Promise<void> {
    const principal = user as Principal;
    if (!req.employeeId) throw new NotFoundException('Payslip not found');

    // Self-service is SELF only, checked against the token rather than against
    // anything the caller sent — verbatim the rule the payslip API applies.
    if (principal.role === 'EMPLOYEE' && principal.employeeId !== req.employeeId) {
      throw new ForbiddenException('You can only download your own payslip.');
    }
    // A manager has no business reading a subordinate's pay. The engine must
    // not become the way around that.
    if (principal.role === 'MANAGER') {
      throw new ForbiddenException('Payslips are not available to managers.');
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { branchId: true },
    });
    if (!employee) throw new NotFoundException('Payslip not found');
    await assertInBranch(employee.branchId);

    const item = await this.findItem(req, principal);
    if (!item) throw new NotFoundException('Payslip not found');
  }

  private onlyFinalized(principal: Principal): boolean {
    // A draft payslip is a figure HR is still working on, not a statement of
    // pay. Handing one to the employee as a PDF makes it look settled.
    return principal.role === 'EMPLOYEE';
  }

  /**
   * The payroll-side filter, built as a typed object rather than spread inline.
   *
   * Spreading into the relation position makes TypeScript pick between
   * PayrollWhereInput and PayrollRelationFilter and fail on the union; naming
   * the type once resolves it and keeps the `status` narrowing honest.
   */
  private payrollWhere(
    params: Record<string, unknown>,
    principal: Principal,
  ): Prisma.PayrollWhereInput {
    const where: Prisma.PayrollWhereInput = {};
    const month = Number(params.month);
    const year = Number(params.year);
    if (month && year) {
      where.month = month;
      where.year = year;
    }
    if (this.onlyFinalized(principal)) where.status = EMPLOYEE_VISIBLE_PAYROLL_STATUSES;
    return where;
  }

  private async findItem(req: DocumentSubjectRequest, principal: Principal) {
    return this.prisma.payrollItem.findFirst({
      where: {
        ...(req.subjectId ? { id: req.subjectId } : {}),
        ...(req.employeeId ? { employeeId: req.employeeId } : {}),
        payroll: this.payrollWhere(req.params, principal),
      },
      orderBy: { payroll: { createdAt: 'desc' } },
      select: { id: true },
    });
  }

  /**
   * One findMany for the whole batch.
   *
   * The `in` on employeeId is the entire point of the batch-shaped contract:
   * per-subject this would be N queries plus N relation loads, and a
   * 300-employee run would be measured in minutes.
   */
  async build(
    reqs: DocumentSubjectRequest[],
    user: unknown,
  ): Promise<Map<string, Record<string, unknown>>> {
    const principal = user as Principal;
    const out = new Map<string, Record<string, unknown>>();
    if (reqs.length === 0) return out;

    const employeeIds = reqs.map((r) => r.employeeId).filter((x): x is string => Boolean(x));
    const subjectIds = reqs.map((r) => r.subjectId).filter((x): x is string => Boolean(x));
    const [items, currency] = await Promise.all([
      this.prisma.payrollItem.findMany({
        where: {
          ...(subjectIds.length ? { id: { in: subjectIds } } : {}),
          ...(employeeIds.length ? { employeeId: { in: employeeIds } } : {}),
          payroll: this.payrollWhere(reqs[0].params, principal),
        },
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
              position: true,
              department: { select: { name: true } },
              branch: { select: { name: true } },
            },
          },
          payroll: { select: { month: true, year: true, status: true } },
          lines: {
            // `label` is SNAPSHOTTED at generation, so a payslip issued two
            // years ago keeps saying what it actually paid even after the
            // component was renamed. That is why the itemised path is preferred
            // over the column fallback below.
            select: { label: true, amount: true, bucket: true, category: true },
            orderBy: { displayOrder: 'asc' },
          },
        },
      }),
      this.settings.getSetting('currency_code', 'OMR'),
    ]);

    for (const item of items) {
      const ctx = this.toContext(item, currency);
      // Keyed both ways, because a caller may address a payslip by employee (a
      // bulk run over a period) or by item id (one row from a list).
      out.set(subjectKey({ employeeId: item.employeeId, subjectId: null, params: {} }), ctx);
      out.set(subjectKey({ employeeId: item.employeeId, subjectId: item.id, params: {} }), ctx);
      out.set(subjectKey({ employeeId: null, subjectId: item.id, params: {} }), ctx);
    }
    return out;
  }

  private toContext(item: any, currency: string): Record<string, unknown> {
    // Itemised lines when payroll_item_lines is in use; otherwise the columns,
    // which stay authoritative either way. Both shapes produce the same two
    // tables, so the template never has to know which one it got.
    const earningLines = item.lines?.filter((l: any) => l.category === 'EARNING') ?? [];
    const deductionLines = item.lines?.filter((l: any) => l.category === 'DEDUCTION') ?? [];

    const earnings = earningLines.length
      ? earningLines.map((l: any) => ({ label: l.label, amount: money(l.amount) }))
      : [
          // Plain labels, not settings reads. There are no admin-configurable
          // keys for these columns, and inventing key names the registry does
          // not carry would produce a constant that merely LOOKS configurable —
          // the admin could never change it and nothing would say so. The
          // configurable path is the itemised one above, whose labels are
          // snapshotted per payslip.
          { label: 'Basic salary', amount: money(item.baseSalary) },
          { label: 'Allowances', amount: money(item.allowances) },
          { label: 'Overtime', amount: money(item.overtimePay) },
          { label: 'Bonus', amount: money(item.bonus) },
          { label: 'Food allowance', amount: money(item.foodAllowance) },
          { label: 'Site allowance', amount: money(item.siteAllowance) },
          { label: 'Leave encashment', amount: money(item.leaveEncashment) },
          { label: 'End-of-service', amount: money(item.gratuityPayout) },
        ].filter((r) => r.amount !== 0);

    const deductions = deductionLines.length
      ? deductionLines.map((l: any) => ({ label: l.label, amount: money(l.amount) }))
      : [
          { label: 'Deductions', amount: money(item.deduction) },
          { label: 'Insurance', amount: money(item.insurance) },
          { label: 'Tax', amount: money(item.tax) },
          { label: 'Garnishment', amount: money(item.garnishment) },
          { label: 'Other recovery', amount: money(item.otherRecovery) },
        ].filter((r) => r.amount !== 0);

    const totalEarnings = earnings.reduce((a: number, r: any) => a + r.amount, 0);
    const totalDeductions = deductions.reduce((a: number, r: any) => a + r.amount, 0);
    const periodLabel = new Date(Date.UTC(item.payroll.year, item.payroll.month - 1, 1))
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    return {
      employeeName: item.employee.fullName,
      employeeCode: item.employee.employeeCode,
      position: item.employee.position ?? '',
      department: item.employee.department?.name ?? '',
      branchName: item.employee.branch?.name ?? '',
      periodLabel,
      month: item.payroll.month,
      year: item.payroll.year,
      workedDays: money(item.actualWorkDays),
      lopDays: Math.max(0, money(item.workDays) - money(item.actualWorkDays)),
      baseSalary: money(item.baseSalary),
      grossSalary: totalEarnings,
      earnings,
      deductions,
      totalEarnings,
      totalDeductions,
      netPay: money(item.netSalary),
      currency,
      // The template calls {{words netPay currency}}; the resolver does not
      // precompute it, because a helper is where formatting belongs.
      paymentMethod: '',
      bankName: '',
      accountNumber: '',
    };
  }

  /** Every employee with a payslip in the period — the bulk expansion. */
  async expand(params: Record<string, unknown>): Promise<DocumentSubjectRequest[]> {
    const month = Number(params.month);
    const year = Number(params.year);
    const payrollId = params.payrollId as string | undefined;

    const items = await this.prisma.payrollItem.findMany({
      where: payrollId
        ? { payrollId }
        : { payroll: { month, year } },
      select: { id: true, employeeId: true },
      orderBy: { employee: { employeeCode: 'asc' } },
    });
    return items.map((i) => ({
      employeeId: i.employeeId,
      subjectId: i.id,
      params: { month, year },
    }));
  }
}
