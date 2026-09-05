import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { LibraryType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLibraryItemDto } from './dto/create-library-item.dto';
import { UpdateLibraryItemDto } from './dto/update-library-item.dto';
import { ListLibraryItemsDto } from './dto/list-library-items.dto';
import { seedLibraryDefaults } from './library-defaults';

/**
 * The admin-managed pick lists behind leave types and employment types.
 *
 * Two of them, not thirteen: a library value nothing reads is a value an
 * administrator can set and then wonder why nothing happened.
 */
@Injectable()
export class LibraryItemsService implements OnModuleInit {
  private readonly logger = new Logger(LibraryItemsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Seed the defaults on every boot.
   *
   * Idempotent, and a failure is logged rather than fatal: a container that
   * starts before `db push` has run must still come up, or the migration that
   * would fix it can never be applied.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.seedDefaults();
    } catch (e) {
      this.logger.warn(
        `Could not seed library defaults: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  async seedDefaults(): Promise<void> {
    await seedLibraryDefaults(this.prisma);
  }

  async findAll(query: ListLibraryItemsDto = {}) {
    const data = await this.prisma.libraryItem.findMany({
      where: {
        ...(query.type ? { libraryType: query.type } : {}),
        ...(query.activeOnly === undefined
          ? {}
          : { isActive: query.activeOnly }),
      },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
    return { success: true as const, data };
  }

  async findOne(id: string) {
    const item = await this.prisma.libraryItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Library item not found');
    return item;
  }

  async create(dto: CreateLibraryItemDto) {
    this.assertLeaveMetadataAllowed(dto, dto.libraryType);
    try {
      return await this.prisma.libraryItem.create({ data: dto });
    } catch (e) {
      throw this.mapWriteError(e, dto.label);
    }
  }

  async update(id: string, dto: UpdateLibraryItemDto) {
    const current = await this.findOne(id);
    this.assertLeaveMetadataAllowed(
      dto,
      dto.libraryType ?? current.libraryType,
    );
    try {
      return await this.prisma.libraryItem.update({ where: { id }, data: dto });
    } catch (e) {
      throw this.mapWriteError(e, dto.label ?? current.label);
    }
  }

  /**
   * Deactivate rather than delete.
   *
   * Every balance row, leave request and accrual record stores the LABEL, so
   * removing the row would leave a year of history naming a type the list no
   * longer offers. Deactivating takes it out of the picker and leaves the
   * history resolving.
   */
  async deactivate(id: string) {
    await this.findOne(id);
    return this.prisma.libraryItem.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /**
   * Leave metadata on an employment type would be read by nothing and would
   * mislead whoever set it.
   */
  private assertLeaveMetadataAllowed(
    dto: Partial<CreateLibraryItemDto>,
    libraryType: LibraryType,
  ) {
    if (libraryType === LibraryType.LEAVE_TYPE) return;
    const leaveOnly = (
      [
        'defaultDays',
        'requiresNoticeDays',
        'affectsBalance',
        'genderRestriction',
      ] as const
    ).filter((field) => dto[field] !== undefined && dto[field] !== null);
    if (leaveOnly.length) {
      throw new BadRequestException(
        `${leaveOnly.join(', ')} apply to LEAVE_TYPE items only, not ${libraryType}`,
      );
    }
  }

  private mapWriteError(e: unknown, label: string): Error {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      return new ConflictException(`"${label}" already exists in this library`);
    }
    return e as Error;
  }
}
