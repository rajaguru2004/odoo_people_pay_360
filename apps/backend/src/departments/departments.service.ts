import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

const DEPARTMENT_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  manager: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
  },
  _count: { select: { employees: true } },
} satisfies Prisma.DepartmentInclude;

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(branchId?: string) {
    return this.prisma.department.findMany({
      where: branchId ? { branchId } : undefined,
      include: DEPARTMENT_INCLUDE,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const department = await this.prisma.department.findUnique({
      where: { id },
      include: DEPARTMENT_INCLUDE,
    });
    if (!department) throw new NotFoundException('Department not found');
    return department;
  }

  async create(dto: CreateDepartmentDto) {
    const clash = await this.prisma.department.findUnique({
      where: { code: dto.code },
    });
    if (clash)
      throw new ConflictException(
        `Department code ${dto.code} is already in use`,
      );
    return this.prisma.department.create({
      data: dto,
      include: DEPARTMENT_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateDepartmentDto) {
    await this.findOne(id);
    return this.prisma.department.update({
      where: { id },
      data: dto,
      include: DEPARTMENT_INCLUDE,
    });
  }

  /**
   * Refuses while employees are still assigned.
   *
   * `onDelete: SetNull` on the relation would happily orphan them instead, and
   * an employee with no department silently drops out of every departmental
   * report — a data-loss bug that looks like a reporting bug.
   */
  async remove(id: string) {
    const department = await this.findOne(id);
    if (department._count.employees > 0) {
      throw new BadRequestException(
        `${department._count.employees} employee(s) are still assigned to this department. Reassign them first.`,
      );
    }
    await this.prisma.department.delete({ where: { id } });
    return { deleted: true };
  }
}
