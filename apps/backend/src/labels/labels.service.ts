import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LabelsService {
  constructor(private prisma: PrismaService) {}

  /**
   * `@@unique([projectId, name])` is real, but P2002 was never caught, so the
   * API answered a bare 500 where the same collision elsewhere in the codebase
   * is a 409 (finding R60/R61).
   */
  private conflictOnDuplicateName(e: any, name?: string): never {
    if (e?.code === 'P2002') {
      throw new ConflictException(
        `A label named "${name}" already exists in this project`,
      );
    }
    throw e;
  }

  async findAll(projectId: string) {
    if (!projectId) throw new BadRequestException('projectId is required');
    const labels = await this.prisma.label.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    return { success: true, data: labels };
  }

  async create(data: { name: string; color?: string; projectId: string }) {
    try {
      const label = await this.prisma.label.create({
        data: {
          name: data.name,
          color: data.color || '#64748B',
          projectId: data.projectId,
        },
      });
      return { success: true, message: 'Label created', data: label };
    } catch (e: any) {
      this.conflictOnDuplicateName(e, data.name);
    }
  }

  async update(id: string, data: { name?: string; color?: string }) {
    const existing = await this.prisma.label.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Label not found');
    try {
      const label = await this.prisma.label.update({ where: { id }, data });
      return { success: true, message: 'Label updated', data: label };
    } catch (e: any) {
      this.conflictOnDuplicateName(e, data.name ?? existing.name);
    }
  }

  async remove(id: string) {
    const existing = await this.prisma.label.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Label not found');
    await this.prisma.label.delete({ where: { id } });
    return { success: true, message: 'Label deleted' };
  }
}
