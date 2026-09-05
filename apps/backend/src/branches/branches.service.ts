import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

const BRANCH_INCLUDE = {
  manager: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
  },
  _count: { select: { employees: true, departments: true } },
} satisfies Prisma.BranchInclude;

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(includeInactive = false) {
    return this.prisma.branch.findMany({
      where: includeInactive ? undefined : { isActive: true },
      include: BRANCH_INCLUDE,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: {
        ...BRANCH_INCLUDE,
        departments: {
          select: { id: true, code: true, name: true },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async create(dto: CreateBranchDto) {
    const clash = await this.prisma.branch.findUnique({
      where: { code: dto.code },
    });
    if (clash)
      throw new ConflictException(`Branch code ${dto.code} is already in use`);

    // A branch has to hang off a company. There is exactly one in this
    // deployment, created by the seed; resolving it here rather than asking the
    // caller for it keeps a company id out of a form nobody would know how to
    // fill in.
    const company = await this.prisma.company.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    if (!company)
      throw new BadRequestException(
        'No company exists yet. Run the seed before creating branches.',
      );

    await this.assertGeofenceComplete(dto);

    return this.prisma.branch.create({
      data: { ...dto, companyId: company.id },
      include: BRANCH_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateBranchDto) {
    const branch = await this.findOne(id);

    if (dto.code && dto.code !== branch.code) {
      const clash = await this.prisma.branch.findUnique({
        where: { code: dto.code },
      });
      if (clash)
        throw new ConflictException(`Branch code ${dto.code} is already in use`);
    }

    await this.assertGeofenceComplete({ ...branch, ...dto } as CreateBranchDto);

    return this.prisma.branch.update({
      where: { id },
      data: dto,
      include: BRANCH_INCLUDE,
    });
  }

  /**
   * Deactivates rather than deletes while anything still points at the branch.
   *
   * Attendance rows carry the branch they were captured at, deliberately, so a
   * hard delete would either orphan them or cascade away somebody's timesheet.
   * An empty branch is genuinely removable and is removed.
   */
  async remove(id: string) {
    const branch = await this.findOne(id);

    if (branch._count.employees > 0) {
      throw new BadRequestException(
        `${branch._count.employees} employee(s) are still assigned to this branch. Reassign them first.`,
      );
    }
    if (branch._count.departments > 0) {
      throw new BadRequestException(
        `${branch._count.departments} department(s) still sit under this branch. Move them first.`,
      );
    }

    const attendances = await this.prisma.attendance.count({
      where: { branchId: id },
    });
    if (attendances > 0) {
      await this.prisma.branch.update({
        where: { id },
        data: { isActive: false },
      });
      return { deleted: false, deactivated: true };
    }

    await this.prisma.branch.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }

  /**
   * A geofence needs a centre AND a radius to mean anything.
   *
   * Enabled with a missing coordinate is the dangerous half-state: the check-in
   * endpoint would read `geofencingEnabled` as true, find no centre to measure
   * from, and let every punch through — a fence that silently is not one.
   */
  private assertGeofenceComplete(dto: Partial<CreateBranchDto>) {
    if (!dto.geofencingEnabled) return;
    const missing = (['latitude', 'longitude', 'geofenceRadiusM'] as const).filter(
      (k) => dto[k] === null || dto[k] === undefined,
    );
    if (missing.length) {
      throw new BadRequestException(
        `Geofencing needs ${missing.join(', ')} before it can be switched on`,
      );
    }
  }
}
