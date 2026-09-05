import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ContractStatus,
  EmployeeStatus,
  Prisma,
  SalaryComponentType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import {
  CreateSalaryStructureDto,
  SalaryStructureLineDto,
} from './dto/create-salary-structure.dto';
import { UpdateSalaryStructureDto } from './dto/update-salary-structure.dto';
import { ListSalaryStructuresDto } from './dto/list-salary-structures.dto';

/** Money is `Decimal(18, 3)`, so three decimals is the storable precision. */
const MONEY_DP = 3;

const EMPLOYEE_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  status: true,
  branch: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

/**
 * Lines carry their component. A structure without it reads as a column of
 * amounts against uuids, which is unusable in the assignment register and
 * ambiguous everywhere else — the type is what decides which bucket the amount
 * lands in, and only the component knows it.
 */
const STRUCTURE_INCLUDE = {
  employee: { select: EMPLOYEE_SELECT },
  lines: {
    include: {
      component: {
        select: {
          id: true,
          code: true,
          name: true,
          type: true,
          sequence: true,
          isActive: true,
        },
      },
    },
    orderBy: [
      { component: { sequence: 'asc' } },
      { component: { code: 'asc' } },
    ],
  },
} satisfies Prisma.SalaryStructureInclude;

function round(value: number): number {
  const factor = 10 ** MONEY_DP;
  return Math.round(value * factor) / factor;
}

@Injectable()
export class SalaryStructuresService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The assignment register.
   *
   * Each row answers the only question the screen is asked — who is on what,
   * and how much does it come to — so the gross is summed here rather than left
   * for the browser to add up out of a nested lines array.
   */
  async findAll(query: ListSalaryStructuresDto) {
    const { page, limit, skip, take } = resolvePagination(query);
    const insensitive = Prisma.QueryMode.insensitive;
    const search = query.search?.trim();

    const employeeWhere: Prisma.EmployeeWhereInput = {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(search
        ? {
            OR: [
              { employeeCode: { contains: search, mode: insensitive } },
              { firstName: { contains: search, mode: insensitive } },
              { lastName: { contains: search, mode: insensitive } },
            ],
          }
        : {}),
    };

    const where: Prisma.SalaryStructureWhereInput =
      Object.keys(employeeWhere).length > 0 ? { employee: employeeWhere } : {};

    const [rows, total] = await Promise.all([
      this.prisma.salaryStructure.findMany({
        where,
        include: {
          employee: { select: EMPLOYEE_SELECT },
          lines: {
            select: { amount: true, component: { select: { type: true } } },
          },
        },
        skip,
        take,
        orderBy: { employee: { employeeCode: 'asc' } },
      }),
      // Counted in the database, never from the length of a page.
      this.prisma.salaryStructure.count({ where }),
    ]);

    const data = rows.map((row) => {
      const { lines, ...rest } = row;
      return {
        ...rest,
        lineCount: lines.length,
        grossPay: round(
          lines
            .filter(
              (line) => line.component.type === SalaryComponentType.EARNING,
            )
            .reduce((total, line) => total + Number(line.amount), 0),
        ),
      };
    });

    return paginated(data, total, page, limit);
  }

  /**
   * One employee's structure. The 404 says which employee has nothing rather
   * than "not found", because the caller already knows the id it sent and needs
   * to know whether the gap is the structure or the employee.
   */
  async findByEmployee(employeeId: string) {
    const structure = await this.prisma.salaryStructure.findUnique({
      where: { employeeId },
      include: STRUCTURE_INCLUDE,
    });
    if (!structure) {
      throw new NotFoundException(
        'This employee has no salary structure yet. Create one before running payroll for them.',
      );
    }
    return { success: true as const, data: structure };
  }

  async findOne(id: string) {
    const structure = await this.prisma.salaryStructure.findUnique({
      where: { id },
      include: STRUCTURE_INCLUDE,
    });
    if (!structure) throw new NotFoundException('Salary structure not found');
    return { success: true as const, data: structure };
  }

  async create(dto: CreateSalaryStructureDto) {
    const employee = await this.loadAssignableEmployee(dto.employeeId);

    const existing = await this.prisma.salaryStructure.findUnique({
      where: { employeeId: dto.employeeId },
      select: { id: true },
    });
    // A second structure would give the same person two definitions of their
    // pay with nothing to choose between them, and `employeeId` is `@unique`
    // anyway — so the answer is the route that edits the one they have.
    if (existing) {
      throw new ConflictException(
        `${employee.firstName} ${employee.lastName} already has a salary structure. Update it with PATCH /salary-structures/${existing.id} instead of creating a second one.`,
      );
    }

    await this.assertLinesAreUsable(dto.lines);
    const currency = await this.resolveCurrency(dto.employeeId, dto.currency);

    // Both halves or neither. A structure row with no lines pays nothing and
    // silently passes pre-flight as "has a structure", which is worse than the
    // create having failed outright.
    const structure = await this.prisma.$transaction(async (tx) => {
      const created = await tx.salaryStructure.create({
        data: {
          employeeId: dto.employeeId,
          currency,
          effectiveFrom: new Date(dto.effectiveFrom),
        },
      });

      await tx.salaryStructureLine.createMany({
        data: dto.lines.map((line) => ({
          structureId: created.id,
          componentId: line.componentId,
          amount: line.amount,
        })),
      });

      return tx.salaryStructure.findUnique({
        where: { id: created.id },
        include: STRUCTURE_INCLUDE,
      });
    });

    return {
      success: true as const,
      data: structure,
      message: 'Salary structure created',
    };
  }

  /**
   * Replaces the line set wholesale.
   *
   * A merge cannot express a removal, and a pay revision that drops an
   * allowance is exactly the case this screen exists for. The delete and the
   * insert share one transaction: a structure left line-less between the two
   * writes is an employee who would be paid nothing.
   */
  async update(id: string, dto: UpdateSalaryStructureDto) {
    const current = await this.prisma.salaryStructure.findUnique({
      where: { id },
      select: { id: true, employeeId: true, currency: true },
    });
    if (!current) throw new NotFoundException('Salary structure not found');

    if (dto.lines) await this.assertLinesAreUsable(dto.lines);

    const currency =
      dto.currency !== undefined
        ? await this.resolveCurrency(current.employeeId, dto.currency)
        : current.currency;

    const lines = dto.lines;
    const structure = await this.prisma.$transaction(async (tx) => {
      if (lines) {
        await tx.salaryStructureLine.deleteMany({ where: { structureId: id } });
        await tx.salaryStructureLine.createMany({
          data: lines.map((line) => ({
            structureId: id,
            componentId: line.componentId,
            amount: line.amount,
          })),
        });
      }

      await tx.salaryStructure.update({
        where: { id },
        data: {
          currency,
          // `undefined` is Prisma's "leave this column alone", so an untouched
          // date stays put.
          effectiveFrom: dto.effectiveFrom
            ? new Date(dto.effectiveFrom)
            : undefined,
        },
      });

      return tx.salaryStructure.findUnique({
        where: { id },
        include: STRUCTURE_INCLUDE,
      });
    });

    return {
      success: true as const,
      data: structure,
      message: 'Salary structure updated',
    };
  }

  /**
   * Deleting is only allowed while the structure has never paid anybody.
   *
   * A payslip snapshots its own lines, so removing the structure would not
   * corrupt one — but it would remove the only record of what the employee was
   * assigned, and every later question ("why was August this much?") is asked
   * against that. Refused as a sentence naming the count, so the reader knows
   * why rather than merely that.
   */
  async remove(id: string) {
    const structure = await this.prisma.salaryStructure.findUnique({
      where: { id },
      select: { id: true, employeeId: true },
    });
    if (!structure) throw new NotFoundException('Salary structure not found');

    const payslips = await this.prisma.payslip.count({
      where: { employeeId: structure.employeeId },
    });
    if (payslips > 0) {
      throw new BadRequestException(
        `This employee has ${payslips} payslip${payslips === 1 ? '' : 's'} already, so their salary structure cannot be deleted. Edit its lines instead — the payslips keep the amounts they were generated with.`,
      );
    }

    await this.prisma.salaryStructure.delete({ where: { id } });

    return {
      success: true as const,
      data: { id },
      message: 'Salary structure deleted',
    };
  }

  /** The employee must exist, and must still be employed. */
  private async loadAssignableEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, firstName: true, lastName: true, status: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.status === EmployeeStatus.TERMINATED) {
      throw new BadRequestException(
        `${employee.firstName} ${employee.lastName} has been terminated, so a salary structure can no longer be assigned to them.`,
      );
    }
    return employee;
  }

  /**
   * Every rule the line set has to satisfy, each answered as a sentence: a raw
   * unique-constraint error tells a payroll clerk nothing they can act on.
   */
  private async assertLinesAreUsable(lines: SalaryStructureLineDto[]) {
    if (lines.length === 0) {
      throw new BadRequestException(
        'A salary structure must have at least one earning line.',
      );
    }

    const seen = new Set<string>();
    for (const line of lines) {
      // Caught here rather than at the `@@unique([structureId, componentId])`
      // index, so the message can name the component that was sent twice.
      if (seen.has(line.componentId)) {
        throw new ConflictException(
          'The same salary component appears twice in this structure. Each component may only be listed once — combine the two amounts into a single line.',
        );
      }
      seen.add(line.componentId);
    }

    const components = await this.prisma.salaryComponent.findMany({
      where: { id: { in: [...seen] } },
      select: { id: true, code: true, name: true, type: true, isActive: true },
    });
    const byId = new Map(components.map((c) => [c.id, c]));

    const missing = [...seen].filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `${missing.length === 1 ? 'A salary component' : `${missing.length} salary components`} in this structure no longer exist: ${missing.join(', ')}.`,
      );
    }

    const retired = components.filter((c) => !c.isActive);
    if (retired.length > 0) {
      throw new BadRequestException(
        `${retired.map((c) => c.code).join(', ')} ${retired.length === 1 ? 'has' : 'have'} been retired from the salary component catalogue and cannot be added to a structure.`,
      );
    }

    // An earning of zero is not an earning: the structure would compute a gross
    // of nothing and produce a payslip that pays the employee nothing at all.
    const paysSomething = lines.some(
      (line) =>
        byId.get(line.componentId)?.type === SalaryComponentType.EARNING &&
        Number(line.amount) > 0,
    );
    if (!paysSomething) {
      throw new BadRequestException(
        'A salary structure must have at least one earning line.',
      );
    }
  }

  /**
   * The structure and the contract have to agree.
   *
   * Two currencies against one employee is not a rounding problem — the run
   * totals in one and the contract promises the other, and nothing in the
   * system can say which of the two the employee is owed. Named in both so the
   * reader can see which one is wrong.
   */
  private async resolveCurrency(
    employeeId: string,
    supplied: string | undefined,
  ): Promise<string> {
    const currency = (supplied ?? 'OMR').trim().toUpperCase();

    const contract = await this.prisma.contract.findFirst({
      where: { employeeId, status: ContractStatus.ACTIVE },
      select: { currency: true },
      orderBy: { startDate: 'desc' },
    });

    if (contract && contract.currency.toUpperCase() !== currency) {
      throw new BadRequestException(
        `This employee's active contract is in ${contract.currency}, but the salary structure was submitted in ${currency}. Both must use the same currency.`,
      );
    }

    return currency;
  }
}
