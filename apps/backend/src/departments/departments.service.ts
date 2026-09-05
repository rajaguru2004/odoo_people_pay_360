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
  parent: { select: { id: true, code: true, name: true } },
  manager: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true, position: true },
  },
  _count: { select: { employees: true, children: true, teams: true } },
} satisfies Prisma.DepartmentInclude;

/** A department with its subtree attached — what the org chart walks. */
export interface DepartmentNode {
  id: string;
  code: string;
  name: string;
  managerId: string | null;
  manager: { id: string; firstName: string; lastName: string } | null;
  branch: { id: string; name: string } | null;
  employees: number;
  teams: number;
  children: DepartmentNode[];
}

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(branchId?: string, includeInactive = false) {
    return this.prisma.department.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        ...(includeInactive ? {} : { isActive: true }),
      },
      include: DEPARTMENT_INCLUDE,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const department = await this.prisma.department.findUnique({
      where: { id },
      include: {
        ...DEPARTMENT_INCLUDE,
        children: {
          select: { id: true, code: true, name: true, isActive: true },
          orderBy: { name: 'asc' },
        },
        employees: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            position: true,
            workEmail: true,
            status: true,
          },
          orderBy: { employeeCode: 'asc' },
        },
      },
    });
    if (!department) throw new NotFoundException('Department not found');
    return department;
  }

  /**
   * The whole hierarchy, assembled in ONE query rather than one per level.
   *
   * A recursive fetch is `depth` round trips and cannot know its own depth in
   * advance. Reading every row once and linking them in memory is a single
   * query whatever the shape, and it is also the only version that can DETECT a
   * cycle — a recursive fetch would simply not terminate on one.
   */
  async tree(branchId?: string): Promise<DepartmentNode[]> {
    const rows = await this.prisma.department.findMany({
      where: { isActive: true, ...(branchId ? { branchId } : {}) },
      select: {
        id: true,
        code: true,
        name: true,
        parentId: true,
        managerId: true,
        manager: { select: { id: true, firstName: true, lastName: true } },
        branch: { select: { id: true, name: true } },
        _count: { select: { employees: true, teams: true } },
      },
      orderBy: { name: 'asc' },
    });

    const nodes = new Map<string, DepartmentNode>(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          code: r.code,
          name: r.name,
          managerId: r.managerId,
          manager: r.manager,
          branch: r.branch,
          employees: r._count.employees,
          teams: r._count.teams,
          children: [],
        },
      ]),
    );

    const roots: DepartmentNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id)!;
      // A parent outside the result set (filtered out by branch, or deactivated)
      // makes this node a root here. Dropping it instead would hide a department
      // that exists, which is worse than showing it one level too high.
      const parent = row.parentId ? nodes.get(row.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  /**
   * The governance numbers the Organisation hub is built on.
   *
   * `spanOfControl` counts DIRECT REPORTS, not department size: a head with
   * forty people in their department but four direct reports is not the
   * bottleneck the number is looking for.
   */
  async structureStats() {
    const [departments, supervisorGroups, employeeNames] = await Promise.all([
      this.prisma.department.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          managerId: true,
          parentId: true,
          _count: { select: { employees: { where: { status: 'ACTIVE' } } } },
        },
      }),
      this.prisma.employee.groupBy({
        by: ['supervisorId'],
        where: { status: 'ACTIVE', supervisorId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.employee.findMany({
        where: { supervisees: { some: {} } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      }),
    ]);

    const byId = new Map(employeeNames.map((e) => [e.id, e]));

    const spanOfControl = supervisorGroups
      .map((g) => {
        const person = g.supervisorId ? byId.get(g.supervisorId) : undefined;
        return {
          supervisorId: g.supervisorId,
          name: person
            ? [person.firstName, person.lastName].filter(Boolean).join(' ')
            : 'Unknown',
          department: person?.department?.name ?? null,
          reports: g._count._all,
        };
      })
      .sort((a, b) => b.reports - a.reports);

    return {
      total: departments.length,
      withoutHead: departments.filter((d) => !d.managerId).length,
      rootCount: departments.filter((d) => !d.parentId).length,
      maxDepth: await this.maxDepth(),
      spanOfControl,
    };
  }

  async create(dto: CreateDepartmentDto) {
    const clash = await this.prisma.department.findUnique({
      where: { code: dto.code },
    });
    if (clash)
      throw new ConflictException(
        `Department code ${dto.code} is already in use`,
      );

    if (dto.parentId) await this.assertExists(dto.parentId, 'Parent department');

    return this.prisma.department.create({
      data: dto,
      include: DEPARTMENT_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateDepartmentDto) {
    const current = await this.findOne(id);

    if (dto.code && dto.code !== current.code) {
      const clash = await this.prisma.department.findUnique({
        where: { code: dto.code },
      });
      if (clash)
        throw new ConflictException(
          `Department code ${dto.code} is already in use`,
        );
    }

    if (dto.parentId) {
      if (dto.parentId === id)
        throw new BadRequestException(
          'A department cannot sit inside itself',
        );
      await this.assertExists(dto.parentId, 'Parent department');
      await this.assertNoHierarchyCycle(id, dto.parentId);
    }

    return this.prisma.department.update({
      where: { id },
      // `parentId: null` has to survive as an explicit null — Prisma reads it as
      // "clear the column", which is exactly the detach-to-root case.
      data: dto as Prisma.DepartmentUpdateInput,
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
    if (department._count.children > 0) {
      throw new BadRequestException(
        `${department._count.children} sub-department(s) still sit under this one. Move them first.`,
      );
    }
    await this.prisma.department.delete({ where: { id } });
    return { deleted: true };
  }

  private async assertExists(id: string, label: string) {
    const found = await this.prisma.department.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException(`${label} not found`);
  }

  /** Walk up from the proposed parent; meeting `id` means a cycle. */
  private async assertNoHierarchyCycle(id: string, parentId: string) {
    const seen = new Set<string>();
    let cursor: string | null = parentId;

    while (cursor && !seen.has(cursor)) {
      if (cursor === id) {
        throw new BadRequestException(
          'That parent already sits below this department',
        );
      }
      seen.add(cursor);
      const next: { parentId: string | null } | null =
        await this.prisma.department.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = next?.parentId ?? null;
    }
  }

  /** Depth of the deepest branch of the tree, 1 for a flat organisation. */
  private async maxDepth(): Promise<number> {
    const rows = await this.prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, parentId: true },
    });
    const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));

    let deepest = 0;
    for (const row of rows) {
      let depth = 1;
      const seen = new Set<string>([row.id]);
      let cursor = row.parentId;
      // `seen` is the cycle guard. A cycle cannot be created through the API,
      // but a row written by hand or by an import can carry one, and walking it
      // without a guard hangs the request rather than returning a wrong number.
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        depth += 1;
        cursor = parentOf.get(cursor) ?? null;
      }
      deepest = Math.max(deepest, depth);
    }
    return deepest;
  }
}
