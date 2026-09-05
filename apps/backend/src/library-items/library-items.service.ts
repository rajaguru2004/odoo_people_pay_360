import { Injectable, OnModuleInit, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { LibraryType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLibraryItemDto } from './dto/create-library-item.dto';
import { UpdateLibraryItemDto } from './dto/update-library-item.dto';
import { seedLibraryDefaults } from './library-defaults';

@Injectable()
export class LibraryItemsService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {} // Trigger restart

  async onModuleInit() {
    await this.seedDefaultPositions();
  }

  /**
   * Create every default library item (positions, leave types, employment types
   * with their pay basis, ...). Kept in `library-defaults.ts` so `prisma/seed.ts`
   * — which has no Nest container — can create the same rows.
   *
   * Name retained for the `POST /library-items/seed` endpoint that calls it.
   */
  async seedDefaultPositions() {
    return seedLibraryDefaults(this.prisma);
  }

  async create(createLibraryItemDto: CreateLibraryItemDto) {
    const existing = await this.prisma.libraryItem.findUnique({
      where: {
        libraryType_label: {
          libraryType: createLibraryItemDto.libraryType,
          label: createLibraryItemDto.label,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `Item with label "${createLibraryItemDto.label}" already exists in ${createLibraryItemDto.libraryType}`,
      );
    }

    this.assertPayBasisAllowed(
      createLibraryItemDto.payBasis,
      createLibraryItemDto.libraryType,
    );
    this.assertPerDiemRateAllowed(
      createLibraryItemDto.perDiemRate,
      createLibraryItemDto.libraryType,
    );
    this.assertLoanPolicyAllowed(
      createLibraryItemDto.loanDeductionPolicy,
      createLibraryItemDto.libraryType,
    );

    return this.prisma.libraryItem.create({
      data: createLibraryItemDto,
    });
  }

  /**
   * payBasis drives what an employee's baseSalary MEANS, and only the employment
   * type does that. Setting it on a Position or Leave Type would be read by
   * nothing and would mislead whoever set it.
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

  /**
   * Same reasoning as payBasis: a rate on a Position or a Leave Type would be
   * read by nothing, and would mislead whoever set it.
   */
  private assertPerDiemRateAllowed(
    perDiemRate: number | null | undefined,
    libraryType: LibraryType,
  ) {
    if (
      perDiemRate !== undefined &&
      perDiemRate !== null &&
      libraryType !== LibraryType.PER_DIEM_DESTINATION
    ) {
      throw new BadRequestException(
        `perDiemRate applies to PER_DIEM_DESTINATION items only, not ${libraryType}.`,
      );
    }
  }

  /**
   * Same reasoning again: payroll reads `loanDeductionPolicy` only off the
   * LEAVE_TYPE of an approved leave, so setting it on a Position or an
   * Employment Type would change nothing and imply that it had.
   */
  private assertLoanPolicyAllowed(
    policy: string | null | undefined,
    libraryType: LibraryType,
  ) {
    if (policy && libraryType !== LibraryType.LEAVE_TYPE) {
      throw new BadRequestException(
        `loanDeductionPolicy applies to LEAVE_TYPE items only, not ${libraryType}.`,
      );
    }
  }

  async findAll(type?: LibraryType, activeOnly?: boolean) {
    const where: any = {};
    if (type) {
      where.libraryType = type;
    }
    if (activeOnly !== undefined) {
      where.isActive = activeOnly;
    }

    return this.prisma.libraryItem.findMany({
      where,
      orderBy: [
        { sortOrder: 'asc' },
        { label: 'asc' },
      ],
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.libraryItem.findUnique({
      where: { id },
    });
    if (!item) {
      throw new NotFoundException(`Library item with ID "${id}" not found`);
    }
    return item;
  }

  async update(id: string, updateLibraryItemDto: UpdateLibraryItemDto) {
    const current = await this.findOne(id); // Throws if not found

    this.assertPayBasisAllowed(
      updateLibraryItemDto.payBasis,
      updateLibraryItemDto.libraryType ?? current.libraryType,
    );
    this.assertPerDiemRateAllowed(
      updateLibraryItemDto.perDiemRate,
      updateLibraryItemDto.libraryType ?? current.libraryType,
    );
    this.assertLoanPolicyAllowed(
      updateLibraryItemDto.loanDeductionPolicy,
      updateLibraryItemDto.libraryType ?? current.libraryType,
    );

    // Only a label change can collide. Guarding on libraryType alone would run
    // the check with `label: undefined` — a PATCH that only sets payBasis would
    // then match any other row in the same library and 409 spuriously.
    if (updateLibraryItemDto.label) {
      // Check if another item with same type and label exists
      const existing = await this.prisma.libraryItem.findFirst({
        where: {
          id: { not: id },
          libraryType: updateLibraryItemDto.libraryType ?? current.libraryType,
          label: updateLibraryItemDto.label,
        },
      });
      if (existing) {
        throw new ConflictException(
          `Item with label "${updateLibraryItemDto.label}" already exists in ${updateLibraryItemDto.libraryType || 'same library'}`,
        );
      }
    }

    return this.prisma.libraryItem.update({
      where: { id },
      data: updateLibraryItemDto,
    });
  }

  async remove(id: string) {
    await this.findOne(id); // Throws if not found
    return this.prisma.libraryItem.delete({
      where: { id },
    });
  }
}
