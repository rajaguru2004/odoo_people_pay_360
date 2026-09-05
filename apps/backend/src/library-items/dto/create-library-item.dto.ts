import { IsEnum, IsString, IsNotEmpty, IsOptional, IsBoolean, IsInt, IsIn, IsNumber, Min, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { LibraryType } from '@prisma/client';

export class CreateLibraryItemDto {
  @ApiProperty({
    enum: LibraryType,
    example: 'POSITION',
    description: 'Type of library this item belongs to',
  })
  @IsEnum(LibraryType)
  @IsNotEmpty()
  libraryType: LibraryType;

  @ApiProperty({
    example: 'Senior Developer',
    description: 'Display label of the library item',
  })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiProperty({
    example: true,
    required: false,
    description: 'Whether the item is active and selectable',
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({
    example: 0,
    required: false,
    description: 'Order weight for sorting',
  })
  @IsInt()
  @IsOptional()
  sortOrder?: number;

  @ApiProperty({ example: 12, required: false, description: 'Default days allocated per year' })
  @IsInt()
  @IsOptional()
  defaultDays?: number;

  @ApiProperty({ example: true, required: false, description: 'Is the leave type paid' })
  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;

  @ApiProperty({ example: 0, required: false, description: 'Required notice days in advance' })
  @IsInt()
  @IsOptional()
  requiresNoticeDays?: number;

  @ApiProperty({ example: true, required: false, description: 'Whether this leave type affects the balance' })
  @IsBoolean()
  @IsOptional()
  affectsBalance?: boolean;

  @ApiProperty({ example: 'FEMALE', required: false, description: 'Gender restriction: MALE, FEMALE, or null for all genders' })
  @IsString()
  @IsOptional()
  genderRestriction?: string | null;

  @ApiProperty({
    example: 'DAILY',
    required: false,
    nullable: true,
    enum: ['MONTHLY', 'DAILY'],
    description:
      'EMPLOYMENT_TYPE only. The pay basis this employment type forces on every ' +
      'employee assigned to it — DAILY makes their baseSalary a PER-DAY rate. ' +
      'null leaves it unspecified, so each employee keeps their own salaryType.',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null) // null is a deliberate "clear the flag"
  @IsIn(['MONTHLY', 'DAILY'])
  payBasis?: 'MONTHLY' | 'DAILY' | null;

  @ApiProperty({
    example: 50,
    required: false,
    description:
      'PER_DIEM_DESTINATION only: daily allowance for this destination. Snapshotted onto a travel request at submit, never read live.',
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  perDiemRate?: number;
}
