import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { ListEmployeesDto } from './dto/list-employees.dto';

const EMPLOYEE_INCLUDE = {
  department: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, code: true, name: true } },
  manager: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
  },
} satisfies Prisma.EmployeeInclude;

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListEmployeesDto) {
    const { page, limit, skip, take } = resolvePagination(query);
    const insensitive = Prisma.QueryMode.insensitive;

    const where: Prisma.EmployeeWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.search
        ? {
            OR: [
              { employeeCode: { contains: query.search, mode: insensitive } },
              { firstName: { contains: query.search, mode: insensitive } },
              { lastName: { contains: query.search, mode: insensitive } },
              { workEmail: { contains: query.search, mode: insensitive } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        include: EMPLOYEE_INCLUDE,
        skip,
        take,
        orderBy: { employeeCode: 'asc' },
      }),
      this.prisma.employee.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  async findOne(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: EMPLOYEE_INCLUDE,
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  async create(dto: CreateEmployeeDto) {
    const existing = await this.prisma.employee.findUnique({
      where: { employeeCode: dto.employeeCode },
    });
    if (existing)
      throw new ConflictException(
        `Employee code ${dto.employeeCode} is already in use`,
      );

    return this.prisma.employee.create({
      data: this.toData(dto),
      include: EMPLOYEE_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateEmployeeDto) {
    await this.findOne(id);

    // A cycle here (A reports to B, B reports to A) would make every org-chart
    // walk and every approval-chain walk non-terminating. The one-hop self
    // check is the cheap half; the walk below catches the rest.
    if (dto.managerId) {
      if (dto.managerId === id)
        throw new BadRequestException(
          'An employee cannot report to themselves',
        );
      await this.assertNoReportingCycle(id, dto.managerId);
    }

    return this.prisma.employee.update({
      where: { id },
      data: this.toData(dto),
      include: EMPLOYEE_INCLUDE,
    });
  }

  /** Soft-exit. The record stays: payslips reference it and must keep resolving. */
  async terminate(id: string, exitDate?: string) {
    await this.findOne(id);
    return this.prisma.employee.update({
      where: { id },
      data: {
        status: 'TERMINATED',
        exitDate: exitDate ? new Date(exitDate) : new Date(),
      },
      include: EMPLOYEE_INCLUDE,
    });
  }

  /** Walk up from the proposed manager; meeting `employeeId` means a cycle. */
  private async assertNoReportingCycle(employeeId: string, managerId: string) {
    const seen = new Set<string>();
    let cursor: string | null = managerId;

    while (cursor && !seen.has(cursor)) {
      if (cursor === employeeId) {
        throw new BadRequestException(
          'That manager reports (directly or indirectly) to this employee',
        );
      }
      seen.add(cursor);
      // The explicit annotation breaks the circular inference between `cursor`
      // (narrowed by the loop condition) and the row it is reassigned from.
      const next: { managerId: string | null } | null =
        await this.prisma.employee.findUnique({
          where: { id: cursor },
          select: { managerId: true },
        });
      cursor = next?.managerId ?? null;
    }
  }

  private toData<T extends CreateEmployeeDto | UpdateEmployeeDto>(dto: T) {
    const { hireDate, ...rest } = dto;
    return {
      ...rest,
      ...(hireDate ? { hireDate: new Date(hireDate) } : {}),
    };
  }
}
