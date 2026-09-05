import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import { CreateSalaryComponentDto } from './dto/create-salary-component.dto';
import { UpdateSalaryComponentDto } from './dto/update-salary-component.dto';
import { ListSalaryComponentsDto } from './dto/list-salary-components.dto';

/**
 * The salary-component catalogue — the rule editor.
 *
 * A component IS the salary rule in this design: `type` says which bucket it
 * lands in, `isTaxable` and `isGratuityBase` say how the rest of the system
 * must treat it, and `sequence` says where it prints. There is no separate rule
 * model because the engine reads exactly these properties and nothing else.
 *
 * There is no delete. A component behind a payslip line has to keep resolving —
 * `PayslipLine.componentId` declares `onDelete: SetNull` for exactly that
 * reason — so retirement is deactivation, the same idiom users and contracts
 * already follow.
 */
@Injectable()
export class SalaryComponentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Uppercased so `hra` and `HRA` cannot become two rules for one allowance. */
  private normaliseCode(code: string): string {
    return code.trim().toUpperCase();
  }

  async findAll(query: ListSalaryComponentsDto) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.SalaryComponentWhereInput = {};
    if (query.type) where.type = query.type;
    if (query.isActive !== undefined)
      where.isActive = query.isActive === 'true';
    if (query.search?.trim()) {
      const search = query.search.trim();
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.salaryComponent.findMany({
        where,
        orderBy: [{ sequence: 'asc' }, { code: 'asc' }],
        skip,
        take,
        include: { _count: { select: { structureLines: true } } },
      }),
      // Counted in the database, never from the length of a page.
      this.prisma.salaryComponent.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  async findOne(id: string) {
    const component = await this.prisma.salaryComponent.findUnique({
      where: { id },
      include: {
        _count: { select: { structureLines: true, payslipLines: true } },
      },
    });
    if (!component) throw new NotFoundException('Salary component not found');
    return { success: true as const, data: component };
  }

  async create(dto: CreateSalaryComponentDto) {
    const code = this.normaliseCode(dto.code);
    const clash = await this.prisma.salaryComponent.findUnique({
      where: { code },
    });
    // Answered as a sentence rather than as a Prisma unique-constraint error,
    // because the person reading it is a payroll clerk, not a DBA.
    if (clash) {
      throw new ConflictException(
        `A salary component with the code ${code} already exists.`,
      );
    }

    const data = await this.prisma.salaryComponent.create({
      data: {
        code,
        name: dto.name.trim(),
        type: dto.type,
        isGratuityBase: dto.isGratuityBase ?? false,
        isTaxable: dto.isTaxable ?? true,
        sequence: dto.sequence ?? 100,
      },
    });

    return {
      success: true as const,
      data,
      message: 'Salary component created',
    };
  }

  async update(id: string, dto: UpdateSalaryComponentDto) {
    const existing = await this.prisma.salaryComponent.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Salary component not found');

    const data = await this.prisma.salaryComponent.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        isGratuityBase: dto.isGratuityBase,
        isTaxable: dto.isTaxable,
        sequence: dto.sequence,
      },
    });

    return {
      success: true as const,
      data,
      message: 'Salary component updated',
    };
  }

  /**
   * Retire a component.
   *
   * Deactivating leaves every structure line and payslip line intact and simply
   * stops the component being offered for a new one. A component that has
   * already paid somebody is part of a legal record; erasing it would leave a
   * payslip nobody can explain.
   */
  async deactivate(id: string) {
    const existing = await this.prisma.salaryComponent.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Salary component not found');

    const inUse = await this.prisma.salaryStructureLine.count({
      where: { componentId: id },
    });

    const data = await this.prisma.salaryComponent.update({
      where: { id },
      data: { isActive: false },
    });

    return {
      success: true as const,
      data,
      message: inUse
        ? `Salary component deactivated. ${inUse} existing salary ${inUse === 1 ? 'structure still uses' : 'structures still use'} it and are unchanged.`
        : 'Salary component deactivated',
    };
  }

  /** Put a retired component back into the catalogue. */
  async activate(id: string) {
    const existing = await this.prisma.salaryComponent.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Salary component not found');

    const data = await this.prisma.salaryComponent.update({
      where: { id },
      data: { isActive: true },
    });

    return {
      success: true as const,
      data,
      message: 'Salary component reactivated',
    };
  }
}
