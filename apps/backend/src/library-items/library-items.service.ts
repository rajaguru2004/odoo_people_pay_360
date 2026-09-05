import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { LibraryType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLibraryItemDto } from './dto/create-library-item.dto';
import { UpdateLibraryItemDto } from './dto/update-library-item.dto';
import { seedLibraryDefaults } from './library-defaults';

@Injectable()
export class LibraryItemsService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Self-heal on boot. Every screen that draws a pick list — grievance
   * categories, asset categories, document types, course categories — renders
   * an unusable empty dropdown when the table is bare, with no hint that the
   * fix lives in the library.
   */
  async onModuleInit() {
    await this.seedDefaults();
  }

  async seedDefaults() {
    return seedLibraryDefaults(this.prisma);
  }

  /**
   * `payBasis` decides what an employee's base pay MEANS, and only the
   * employment type does that. Set on a position or a leave type it would be
   * read by nothing, while implying to whoever set it that it had an effect.
   */
  private assertPayBasisAllowed(
    payBasis: string | null | undefined,
    libraryType: LibraryType,
  ) {
    if (payBasis && libraryType !== LibraryType.EMPLOYMENT_TYPE) {
      throw new BadRequestException(
        `payBasis applies to EMPLOYMENT_TYPE items only, not ${libraryType}.`,
      );
    }
  }

  async create(dto: CreateLibraryItemDto) {
    this.assertPayBasisAllowed(dto.payBasis, dto.libraryType);

    const existing = await this.prisma.libraryItem.findUnique({
      where: {
        libraryType_label: { libraryType: dto.libraryType, label: dto.label },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `"${dto.label}" already exists in ${dto.libraryType}`,
      );
    }

    return this.prisma.libraryItem.create({ data: dto });
  }

  async findAll(type?: LibraryType, activeOnly?: boolean) {
    const where: Prisma.LibraryItemWhereInput = {};
    if (type) where.libraryType = type;
    if (activeOnly !== undefined) where.isActive = activeOnly;

    return this.prisma.libraryItem.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.libraryItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Library item not found');
    return item;
  }

  async update(id: string, dto: UpdateLibraryItemDto) {
    const current = await this.findOne(id);
    const libraryType = dto.libraryType ?? current.libraryType;
    this.assertPayBasisAllowed(dto.payBasis, libraryType);

    // Only a label change can collide. Checking on `libraryType` alone would
    // run the query with `label: undefined`, so a PATCH that touched nothing
    // but `sortOrder` would match any other row in the same library and 409.
    if (dto.label) {
      const clash = await this.prisma.libraryItem.findFirst({
        where: { id: { not: id }, libraryType, label: dto.label },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(
          `"${dto.label}" already exists in ${libraryType}`,
        );
      }
    }

    return this.prisma.libraryItem.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.libraryItem.delete({ where: { id } });
    return { deleted: true };
  }
}
