import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import {
  accrueForPeriod,
  entitlementAt,
  type GratuityRuleLike,
  type NationalityClass,
} from './gratuity-calculator';

/** A rule row as the calculator wants it — Decimals become numbers. */
function toRuleLike(r: {
  id: string;
  country: string;
  nationalityClass: string;
  fromYears: unknown;
  toYears: unknown;
  daysPerYear: unknown;
  basis: string;
  monthDays: unknown;
  employerShare: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isActive: boolean;
}): GratuityRuleLike {
  return {
    id: r.id,
    country: r.country,
    nationalityClass: r.nationalityClass,
    fromYears: Number(r.fromYears),
    toYears: r.toYears === null ? null : Number(r.toYears),
    daysPerYear: Number(r.daysPerYear),
    basis: r.basis,
    monthDays: Number(r.monthDays),
    employerShare: Number(r.employerShare),
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isActive: r.isActive,
  };
}

const CLASSES: NationalityClass[] = ['NATIONAL', 'GCC', 'EXPAT'];

@Injectable()
export class GratuityService {
  private readonly logger = new Logger(GratuityService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private features: PayrollFeaturesService,
  ) {}

  // ── Rules ────────────────────────────────────────────────────────────────

  async listRules(country?: string) {
    const rules = await this.prisma.gratuityRule.findMany({
      where: country ? { country: country.toUpperCase() } : {},
      orderBy: [
        { country: 'asc' },
        { nationalityClass: 'asc' },
        { fromYears: 'asc' },
        { effectiveFrom: 'asc' },
      ],
    });
    return { success: true, data: rules };
  }

  async createRule(dto: Record<string, unknown>, userId?: string) {
    const data = this.ruleData(dto);
    const rule = await this.prisma.gratuityRule.create({ data }).catch((e) => {
      throw this.explainRuleWriteFailure(e);
    });
    await this.audit.log({
      userId,
      action: 'GRATUITY_RULE_CREATED',
      resourceType: 'GratuityRule',
      resourceId: rule.id,
      newData: {
        country: rule.country,
        nationalityClass: rule.nationalityClass,
        band: `${Number(rule.fromYears)}-${rule.toYears === null ? 'open' : Number(rule.toYears)}`,
        daysPerYear: Number(rule.daysPerYear),
      },
    });
    return { success: true, data: rule };
  }

  async updateRule(id: string, dto: Record<string, unknown>, userId?: string) {
    const existing = await this.prisma.gratuityRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Gratuity rule not found');

    const rule = await this.prisma.gratuityRule
      .update({ where: { id }, data: this.ruleData(dto, true) })
      .catch((e) => {
        throw this.explainRuleWriteFailure(e);
      });
    await this.audit.log({
      userId,
      action: 'GRATUITY_RULE_UPDATED',
      resourceType: 'GratuityRule',
      resourceId: id,
      oldData: { daysPerYear: Number(existing.daysPerYear), isActive: existing.isActive },
      newData: { fields: Object.keys(dto) },
    });
    return { success: true, data: rule };
  }

  /**
   * Retire a rule rather than delete it.
   *
   * Accruals reference the rule they were computed under, and an accrual whose
   * rule has vanished cannot be explained to anyone who asks why it is what it
   * is. Deactivating also releases the overlap constraint, so a replacement can
   * be written for the same band.
   */
  async deactivateRule(id: string, userId?: string) {
    const existing = await this.prisma.gratuityRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Gratuity rule not found');

    const rule = await this.prisma.gratuityRule.update({
      where: { id },
      data: { isActive: false },
    });
    await this.audit.log({
      userId,
      action: 'GRATUITY_RULE_DEACTIVATED',
      resourceType: 'GratuityRule',
      resourceId: id,
      oldData: { isActive: true },
      newData: { isActive: false },
    });
    return { success: true, data: rule };
  }

  private ruleData(dto: Record<string, unknown>, partial = false) {
    const d: Record<string, unknown> = {};
    const set = (key: string, value: unknown) => {
      if (value !== undefined) d[key] = value;
    };
    set('country', typeof dto.country === 'string' ? dto.country.toUpperCase() : undefined);
    set('nationalityClass', dto.nationalityClass);
    set('fromYears', dto.fromYears);
    set('toYears', dto.toYears === undefined ? undefined : dto.toYears);
    set('daysPerYear', dto.daysPerYear);
    set('basis', dto.basis);
    set('monthDays', dto.monthDays);
    set('employerShare', dto.employerShare);
    set('effectiveFrom', dto.effectiveFrom ? new Date(String(dto.effectiveFrom)) : undefined);
    set(
      'effectiveTo',
      dto.effectiveTo === null
        ? null
        : dto.effectiveTo
          ? new Date(String(dto.effectiveTo))
          : undefined,
    );
    set('isActive', dto.isActive);
    set('notes', dto.notes);

    if (!partial) {
      for (const required of ['country', 'nationalityClass', 'fromYears', 'daysPerYear', 'effectiveFrom']) {
        if (d[required] === undefined) {
          throw new BadRequestException(`${required} is required`);
        }
      }
    }
    return d as never;
  }

  /**
   * Turn the overlap constraint into a sentence.
   *
   * The database refusal is `gratuity_rule_no_overlap`, which tells an admin
   * nothing about what they did. What they did is write a second rule covering
   * service years and dates a rule already covers, which would make the
   * entitlement depend on row order.
   */
  private explainRuleWriteFailure(e: unknown): Error {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('gratuity_rule_no_overlap')) {
      return new BadRequestException(
        'Another active rule already covers part of this service band for the ' +
          'same country and nationality class, over overlapping dates. Two ' +
          'overlapping rules would make an entitlement depend on which row was ' +
          'read first. Narrow the band, set an end date on the existing rule, ' +
          'or deactivate it.',
      );
    }
    if (message.includes('gratuity_rule_band_ordered')) {
      return new BadRequestException(
        'The band ends before it starts: `toYears` must be greater than `fromYears`.',
      );
    }
    if (message.includes('gratuity_rule_employer_share_fraction')) {
      return new BadRequestException(
        '`employerShare` is a fraction between 0 and 1. Use 0 where a state fund ' +
          'carries the benefit and 1 where the employer bears all of it.',
      );
    }
    return e as Error;
  }

  // ── Entitlement ──────────────────────────────────────────────────────────

  /**
   * What one employee would receive if they left on `asOf`.
   *
   * The question HR is asked constantly, and the reason the self-service view
   * is worth building: it is read-only and it costs nothing to answer.
   */
  async entitlementFor(employeeId: string, user: unknown, asOf?: Date) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        employeeCode: true,
        departmentId: true,
        branchId: true,
        startDate: true,
        baseSalary: true,
        profile: { select: { nationalityCode: true, nationalityClass: true } },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, 'view end-of-service benefit for');

    const features = await this.features.resolve();
    const at = asOf ?? new Date();
    const country = (employee.profile?.nationalityCode ?? '').toUpperCase();
    const settings = await this.prisma.systemSetting.findUnique({
      where: { key: 'payroll_country' },
    });
    const payrollCountry = (settings?.value ?? 'IN').toUpperCase();

    const rules = await this.prisma.gratuityRule.findMany({
      where: { country: payrollCountry, isActive: true },
    });

    const components = await this.prisma.salaryComponent.findMany({
      where: { employeeId, isActive: true },
      select: { componentType: true, amount: true },
    });
    const basic = components
      .filter((c) => c.componentType === 'BASIC')
      .reduce((a, c) => a + Number(c.amount), 0);
    const gross = components
      .filter((c) => c.componentType !== 'PAYROLL_CONFIG')
      .reduce((a, c) => a + Number(c.amount), 0);

    const result = entitlementAt(
      {
        employmentStart: employee.startDate,
        asOf: at,
        monthlyBasic: basic > 0 ? basic : Number(employee.baseSalary),
        monthlyGross: gross > 0 ? gross : Number(employee.baseSalary),
        nationalityClass:
          (employee.profile?.nationalityClass as NationalityClass | null) ?? null,
        country: payrollCountry,
        serviceYearDays: features.eosbServiceYearDays,
      },
      rules.map(toRuleLike),
    );

    const accrued = await this.prisma.gratuityAccrual.aggregate({
      where: { employeeId, status: 'ACCRUED' },
      _sum: { amount: true },
    });

    return {
      success: true,
      data: {
        employeeId,
        employeeCode: employee.employeeCode,
        fullName: employee.fullName,
        asOf: at,
        country: payrollCountry,
        nationalityCode: country || null,
        nationalityClass: employee.profile?.nationalityClass ?? null,
        ...result,
        /** What the ledger has actually set aside, which may lag the entitlement. */
        provisioned: Number(accrued._sum.amount ?? 0),
      },
    };
  }

  // ── The payroll seam ─────────────────────────────────────────────────────

  /**
   * Write the month's provision for every employee in a locked run.
   *
   * Called from inside `applyLock`'s transaction, so the provision moves in the
   * same commit as the money it accompanies. Idempotent through the unique index
   * on (employeeId, payrollId): a re-lock after an unlock cannot double it.
   */
  async accrueForPayroll(
    tx: Prisma.TransactionClient,
    payrollId: string,
    serviceYearDays: number,
  ): Promise<{ accrued: number; skipped: number }> {
    const payroll = await tx.payroll.findUnique({
      where: { id: payrollId },
      select: { id: true, month: true, year: true, branchId: true },
    });
    if (!payroll?.branchId) return { accrued: 0, skipped: 0 };

    const items = await tx.payrollItem.findMany({
      where: { payrollId },
      select: {
        employeeId: true,
        baseSalary: true,
        allowances: true,
        employee: {
          select: {
            startDate: true,
            profile: { select: { nationalityClass: true } },
          },
        },
      },
    });
    if (items.length === 0) return { accrued: 0, skipped: 0 };

    const setting = await tx.systemSetting.findUnique({
      where: { key: 'payroll_country' },
    });
    const country = (setting?.value ?? 'IN').toUpperCase();
    const rules = (
      await tx.gratuityRule.findMany({ where: { country, isActive: true } })
    ).map(toRuleLike);
    if (rules.length === 0) return { accrued: 0, skipped: items.length };

    const periodStart = new Date(Date.UTC(payroll.year, payroll.month - 1, 1));
    const periodEnd = new Date(Date.UTC(payroll.year, payroll.month, 0));

    let accrued = 0;
    let skipped = 0;

    for (const item of items) {
      const cls = item.employee.profile?.nationalityClass as
        | NationalityClass
        | null
        | undefined;
      const result = accrueForPeriod(
        {
          employmentStart: item.employee.startDate,
          periodStart,
          asOf: periodEnd,
          monthlyBasic: Number(item.baseSalary),
          monthlyGross: Number(item.baseSalary) + Number(item.allowances),
          nationalityClass: cls ?? null,
          country,
          serviceYearDays,
        },
        rules,
      );

      // An employee whose class nobody recorded is skipped and reported, not
      // silently accrued at the expatriate rate.
      if (result.refusal || result.amount <= 0) {
        skipped += 1;
        continue;
      }

      const band = result.bands[result.bands.length - 1];
      const figures = {
          basisAmount: new Prisma.Decimal(
            (band?.basis === 'GROSS'
              ? Number(item.baseSalary) + Number(item.allowances)
              : Number(item.baseSalary)
            ).toFixed(2),
          ),
          serviceYears: new Prisma.Decimal(result.serviceYears.toFixed(4)),
          daysAccrued: new Prisma.Decimal(
            result.bands
              .reduce((a, b) => a + b.yearsInBand * b.daysPerYear, 0)
              .toFixed(4),
          ),
          amount: new Prisma.Decimal(result.amount.toFixed(2)),
          employerShare: new Prisma.Decimal((band?.employerShare ?? 1).toFixed(4)),
          ruleId: band?.ruleId ?? null,
          workingJson: {
            serviceYears: result.serviceYears,
            openingEntitlement: result.openingEntitlement,
            closingEntitlement: result.grossEntitlement,
            bands: result.bands,
            lines: result.workingLines,
          } as never,
          status: 'ACCRUED',
          reversedAt: null,
      };

      // Upsert, not create.
      //
      // The unique index on (employeeId, payrollId) is what stops a re-lock
      // doubling a reported liability — but on its own it turns the second lock
      // into a 500. Unlocking a run and locking it again is an ordinary
      // correction, not an error, so the provision is RECOMPUTED and the
      // previously REVERSED row is reinstated with the new figures. One row per
      // employee per run, always, whatever order the lifecycle ran in.
      await tx.gratuityAccrual.upsert({
        where: {
          employeeId_payrollId: { employeeId: item.employeeId, payrollId },
        },
        create: {
          employeeId: item.employeeId,
          branchId: payroll.branchId,
          payrollId,
          month: payroll.month,
          year: payroll.year,
          ...figures,
        },
        update: figures,
      });
      accrued += 1;
    }

    return { accrued, skipped };
  }

  /**
   * Undo the provision a run wrote.
   *
   * Flips to REVERSED and stamps the time; it never deletes. Same reasoning as
   * the loan ledger this sits beside: after a reversal there must still be a
   * record that the provision was once made, or the audit trail says the money
   * never moved.
   */
  async reverseForPayroll(
    tx: Prisma.TransactionClient,
    payrollId: string,
  ): Promise<number> {
    const res = await tx.gratuityAccrual.updateMany({
      where: { payrollId, status: 'ACCRUED' },
      data: { status: 'REVERSED', reversedAt: new Date() },
    });
    return res.count;
  }

  /**
   * Has any provision from this run already been paid out in a settlement?
   *
   * Checked BEFORE a transaction opens, because unlocking a run whose provision
   * a settlement has already consumed would leave the settlement standing on a
   * reversed accrual. Mirrors the existing "a later run already recovered
   * against these loans" guard on unlock.
   */
  async settledAccrualCount(payrollId: string): Promise<number> {
    return this.prisma.gratuityAccrual.count({
      where: { payrollId, status: 'SETTLED' },
    });
  }

  /** The liability, by branch, that Finance plans against. */
  async liability(branchId?: string, asOf?: Date) {
    const rows = await this.prisma.gratuityAccrual.groupBy({
      by: ['branchId'],
      where: {
        status: 'ACCRUED',
        ...(branchId ? { branchId } : {}),
        ...(asOf ? { createdAt: { lte: asOf } } : {}),
      },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return {
      success: true,
      data: rows.map((r) => ({
        branchId: r.branchId,
        provisioned: Number(r._sum.amount ?? 0),
        accrualCount: r._count._all,
      })),
    };
  }

  /** Every accrual for one employee, newest first. */
  async accrualsFor(employeeId: string, user: unknown) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, departmentId: true, branchId: true, fullName: true, employeeCode: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, 'view gratuity accruals for');

    const data = await this.prisma.gratuityAccrual.findMany({
      where: { employeeId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return { success: true, data };
  }

  /** The three classes a rule can be written for, for a settings form. */
  nationalityClasses() {
    return { success: true, data: CLASSES };
  }
}
