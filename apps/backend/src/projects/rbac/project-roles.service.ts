import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateProjectRoleDto,
  UpdateProjectRoleDto,
} from './dto/project-role.dto';
import { OWNER_ROLE_SLUG } from './permissions.constants';

@Injectable()
export class ProjectRolesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(projectId: string) {
    const roles = await this.prisma.projectRole.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return { success: true, data: roles };
  }

  private slugify(name: string) {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }

  private async uniqueSlug(projectId: string, base: string) {
    const root = base || 'role';
    let slug = root;
    let i = 2;
    while (
      await this.prisma.projectRole.findUnique({
        where: { projectId_slug: { projectId, slug } },
      })
    ) {
      slug = `${root}-${i++}`;
    }
    return slug;
  }

  async create(projectId: string, dto: CreateProjectRoleDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    let permissions = dto.permissions ?? [];
    if ((!dto.permissions || dto.permissions.length === 0) && dto.copyFromRoleId) {
      const src = await this.prisma.projectRole.findFirst({
        where: { id: dto.copyFromRoleId, projectId },
      });
      if (!src) throw new BadRequestException('copyFromRoleId not found in project');
      permissions = src.permissions;
    }

    const slug = await this.uniqueSlug(projectId, this.slugify(dto.name));
    const max = await this.prisma.projectRole.aggregate({
      where: { projectId },
      _max: { sortOrder: true },
    });

    const role = await this.prisma.projectRole.create({
      data: {
        projectId,
        name: dto.name,
        slug,
        description: dto.description,
        color: dto.color,
        isSystem: false,
        isDefault: false,
        permissions,
        sortOrder: (max._max.sortOrder ?? 0) + 1,
      },
    });
    return { success: true, message: 'Role created', data: role };
  }

  async update(projectId: string, roleId: string, dto: UpdateProjectRoleDto) {
    const role = await this.prisma.projectRole.findFirst({
      where: { id: roleId, projectId },
    });
    if (!role) throw new NotFoundException('Role not found');

    const permissions = dto.permissions;
    // The OWNER role always retains full control — say so, rather than
    // force-restoring the twelve behind a 200 that reports a write that never
    // happened (finding R11). A caller told `success: true` for a discarded
    // change has no way to know the restriction did not land.
    if (role.slug === OWNER_ROLE_SLUG && permissions !== undefined) {
      throw new BadRequestException(
        'The owner role always holds every project permission and its permissions cannot be changed.',
      );
    }

    const updated = await this.prisma.projectRole.update({
      where: { id: roleId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(permissions !== undefined && { permissions }),
      },
    });
    return { success: true, message: 'Role updated', data: updated };
  }

  async remove(projectId: string, roleId: string) {
    const role = await this.prisma.projectRole.findFirst({
      where: { id: roleId, projectId },
    });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem)
      throw new BadRequestException('System roles cannot be deleted');

    const inUse = await this.prisma.projectMember.count({
      where: { projectId, roleId },
    });
    if (inUse > 0)
      throw new ConflictException(
        `Role is assigned to ${inUse} member(s). Reassign them before deleting.`,
      );

    await this.prisma.projectRole.delete({ where: { id: roleId } });
    return { success: true, message: 'Role deleted' };
  }
}
