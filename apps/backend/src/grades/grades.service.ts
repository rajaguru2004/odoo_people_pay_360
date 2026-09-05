import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';

/**
 * Grades, and the salary template each one carries.
 *
 * The template is exactly that: it pre-fills `SalaryComponent` rows on hire and
 * validates them on edit. `SalaryComponent` stays the only pay input the payroll
 * engine reads, which is what keeps grade out of the calculation and makes this
 * safe to add to a running system.
 */
@Injectable()
export class GradesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private features: PayrollFeaturesService,
  ) {}

  /**
   * A band whose ceiling sits under its floor matches nobody.
   *
   * `assign()` refuses any salary outside `[minSalary, maxSalary]`, so an
   * inverted band is a grade no employee can ever hold — it is accepted at
   * create time and then rejects every assignment, which reads as a bug in the
   * assignment screen rather than in the band somebody typed backwards.
   *
   * Only checked when BOTH ends are present: an open-ended band (a floor with
   * no ceiling, or neither) is legitimate and common.
   */
  private assertBand(min: unknown, max: unknown): void {
    if (min === undefined || min === null || min === '') return;
    if (max === undefined || max === null || max === '') return;
    const lo = Number(min);
    const hi = Number(max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    if (hi < lo) {
      throw new BadRequestException(
        `maxSalary (${hi}) is below minSalary (${lo}), so no salary could ever fall inside this grade.`,
      );
    }
  }

  private async assertEnabled() {
    const f = await this.features.resolve();
    if (!f.gradeEnabled) {
      throw new NotFoundException('Employee grades are not enabled');
    }
    return f;
  }

  async list(includeInactive = false) {
    const data = await this.prisma.grade.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: { components: true, _count: { select: { employees: true } } },
      orderBy: [{ level: 'asc' }, { code: 'asc' }],
    });
    return { success: true, data };
  }

  async create(dto: Record<string, unknown>, user: any) {
    await this.assertEnabled();
    const code = String(dto.code ?? '').trim().toUpperCase();
    const name = String(dto.name ?? '').trim();
    const level = Number(dto.level ?? 0);
    if (!code || !name) {
      throw new BadRequestException('code and name are required.');
    }
    if (!Number.isInteger(level) || level < 1) {
      throw new BadRequestException('level must be a whole number of 1 or more.');
    }
    this.assertBand(dto.minSalary, dto.maxSalary);

    const created = await this.prisma.grade
      .create({
        data: {
          code,
          name,
          level,
          minSalary: dto.minSalary ? new Prisma.Decimal(Number(dto.minSalary).toFixed(2)) : null,
          maxSalary: dto.maxSalary ? new Prisma.Decimal(Number(dto.maxSalary).toFixed(2)) : null,
          branchId: (dto.branchId as string) ?? null,
          description: (dto.description as string) ?? null,
        },
      })
      .catch((e) => {
        throw this.explain(e, code);
      });

    await this.audit.log({
      userId: user?.id,
      action: 'GRADE_CREATED',
      resourceType: 'Grade',
      resourceId: created.id,
      newData: { code, name, level },
    });
    return { success: true, data: created };
  }

  async update(id: string, dto: Record<string, unknown>, user: any) {
    await this.assertEnabled();
    const grade = await this.prisma.grade.findUnique({ where: { id } });
    if (!grade) throw new NotFoundException('Grade not found');

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = String(dto.name).trim();
    if (dto.level !== undefined) data.level = Number(dto.level);
    if (dto.minSalary !== undefined) {
      data.minSalary = dto.minSalary
        ? new Prisma.Decimal(Number(dto.minSalary).toFixed(2))
        : null;
    }
    if (dto.maxSalary !== undefined) {
      data.maxSalary = dto.maxSalary
        ? new Prisma.Decimal(Number(dto.maxSalary).toFixed(2))
        : null;
    }
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.isActive !== undefined) data.isActive = Boolean(dto.isActive);

    // Against the MERGED band, not the patch: moving one end past the other end
    // that is already on the row inverts the band just as effectively as
    // sending both at once.
    this.assertBand(
      dto.minSalary !== undefined ? dto.minSalary : grade.minSalary,
      dto.maxSalary !== undefined ? dto.maxSalary : grade.maxSalary,
    );

    const updated = await this.prisma.grade
      .update({ where: { id }, data })
      .catch((e) => {
        throw this.explain(e, grade.code);
      });

    await this.audit.log({
      userId: user?.id,
      action: 'GRADE_UPDATED',
      resourceType: 'Grade',
      resourceId: id,
      newData: { fields: Object.keys(data) },
    });
    return { success: true, data: updated };
  }

  /** Retire rather than delete: employees reference it, and history matters. */
  async deactivate(id: string, user: any) {
    await this.assertEnabled();
    const grade = await this.prisma.grade.findUnique({
      where: { id },
      include: { _count: { select: { employees: true } } },
    });
    if (!grade) throw new NotFoundException('Grade not found');

    const updated = await this.prisma.grade.update({
      where: { id },
      data: { isActive: false },
    });
    await this.audit.log({
      userId: user?.id,
      action: 'GRADE_DEACTIVATED',
      resourceType: 'Grade',
      resourceId: id,
      oldData: { isActive: true },
      newData: { isActive: false, employeesStillAssigned: grade._count.employees },
    });
    return { success: true, data: updated };
  }

  async setComponents(
    gradeId: string,
    components: Array<Record<string, unknown>>,
    user: any,
  ) {
    await this.assertEnabled();
    const grade = await this.prisma.grade.findUnique({ where: { id: gradeId } });
    if (!grade) throw new NotFoundException('Grade not found');

    for (const c of components ?? []) {
      const valueType = String(c.valueType ?? 'FIXED');
      if (!['FIXED', 'PERCENT_OF_BASIC'].includes(valueType)) {
        throw new BadRequestException(
          'valueType must be FIXED or PERCENT_OF_BASIC.',
        );
      }
      if (valueType === 'PERCENT_OF_BASIC' && Number(c.value) > 1000) {
        throw new BadRequestException(
          'A percentage above 1000 is almost always a rate entered as basis ' +
            'points, which would multiply the allowance by a hundred.',
        );
      }
    }

    const data = await this.prisma.$transaction(async (tx) => {
      // Replace wholesale: a partially-updated template silently produces a
      // different salary structure for the next hire than the one on screen.
      await tx.gradeSalaryComponent.deleteMany({ where: { gradeId } });
      if ((components ?? []).length > 0) {
        await tx.gradeSalaryComponent.createMany({
          data: components.map((c) => ({
            gradeId,
            componentType: String(c.componentType),
            valueType: String(c.valueType ?? 'FIXED'),
            value: new Prisma.Decimal(Number(c.value ?? 0).toFixed(4)),
            isMandatory: Boolean(c.isMandatory ?? false),
          })),
        });
      }
      return tx.grade.findUnique({ where: { id: gradeId }, include: { components: true } });
    });

    await this.audit.log({
      userId: user?.id,
      action: 'GRADE_COMPONENTS_SET',
      resourceType: 'Grade',
      resourceId: gradeId,
      newData: { count: (components ?? []).length },
    });
    return { success: true, data };
  }

  /**
   * Assign a grade, checking the salary sits inside its band.
   *
   * A WARNING rather than a refusal would be useless — the band is the whole
   * point of a grade — but the refusal names both figures so it can be acted on
   * rather than argued with.
   */
  async assign(employeeId: string, gradeId: string | null, user: any) {
    await this.assertEnabled();
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        employeeCode: true,
        departmentId: true,
        branchId: true,
        baseSalary: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, 'set the grade for');

    if (gradeId) {
      const grade = await this.prisma.grade.findUnique({ where: { id: gradeId } });
      if (!grade) throw new NotFoundException('Grade not found');
      if (!grade.isActive) {
        throw new BadRequestException(
          `${grade.code} has been retired, so nobody new can be put on it.`,
        );
      }
      const salary = Number(employee.baseSalary);
      if (grade.minSalary && salary < Number(grade.minSalary)) {
        throw new BadRequestException(
          `${employee.fullName}'s salary of ${salary} is below the ${grade.code} ` +
            `band, which starts at ${Number(grade.minSalary)}.`,
        );
      }
      if (grade.maxSalary && salary > Number(grade.maxSalary)) {
        throw new BadRequestException(
          `${employee.fullName}'s salary of ${salary} is above the ${grade.code} ` +
            `band, which ends at ${Number(grade.maxSalary)}.`,
        );
      }
    }

    const updated = await this.prisma.employee.update({
      where: { id: employeeId },
      data: { gradeId },
      select: { id: true, gradeId: true },
    });

    await this.audit.log({
      userId: user?.id,
      action: 'EMPLOYEE_GRADE_ASSIGNED',
      resourceType: 'Employee',
      resourceId: employeeId,
      branchId: employee.branchId,
      newData: { gradeId },
    });
    return { success: true, data: updated };
  }

  /**
   * What a grade's template would produce for a given basic.
   *
   * Read-only and deliberately not applied automatically: pre-filling a form is
   * helpful, silently rewriting somebody's salary structure is not.
   */
  async templateFor(gradeId: string, basic: number) {
    const grade = await this.prisma.grade.findUnique({
      where: { id: gradeId },
      include: { components: true },
    });
    if (!grade) throw new NotFoundException('Grade not found');

    const data = grade.components.map((c) => ({
      componentType: c.componentType,
      isMandatory: c.isMandatory,
      amount:
        c.valueType === 'PERCENT_OF_BASIC'
          ? Math.round(basic * (Number(c.value) / 100) * 100) / 100
          : Number(c.value),
      derivedFrom: c.valueType,
    }));
    return { success: true, data: { grade: grade.code, basic, components: data } };
  }

  private explain(e: unknown, code: string): Error {
    const err = e as { code?: string; message?: string };
    if (err?.code === 'P2002') {
      return new ConflictException(`A grade with code ${code} already exists.`);
    }
    if (String(err?.message ?? '').includes('grade_salary_band_ordered')) {
      return new BadRequestException(
        'The maximum salary is below the minimum, which would put every salary ' +
          'out of range for this grade.',
      );
    }
    return e as Error;
  }
}
