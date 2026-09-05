import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LibraryType } from '@prisma/client';

export class CreateLibraryItemDto {
  @ApiProperty({ enum: LibraryType, example: 'POSITION' })
  @IsEnum(LibraryType)
  @IsNotEmpty()
  libraryType: LibraryType;

  @ApiProperty({ example: 'Senior Developer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    default: 0,
    description: 'Order weight within the list',
  })
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({
    example: 12,
    description: 'LEAVE_TYPE: days allocated per year',
  })
  @IsOptional()
  @IsInt()
  defaultDays?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'LEAVE_TYPE: is the leave paid',
  })
  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @ApiPropertyOptional({
    default: 0,
    description: 'LEAVE_TYPE: notice days required in advance',
  })
  @IsOptional()
  @IsInt()
  requiresNoticeDays?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'LEAVE_TYPE: whether it draws down the balance',
  })
  @IsOptional()
  @IsBoolean()
  affectsBalance?: boolean;

  @ApiPropertyOptional({
    example: 'FEMALE',
    nullable: true,
    description: 'LEAVE_TYPE: MALE, FEMALE, or null for everyone',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null) // null is a deliberate "clear it"
  @IsString()
  @MaxLength(10)
  genderRestriction?: string | null;

  @ApiPropertyOptional({
    example: 'DAILY',
    nullable: true,
    enum: ['MONTHLY', 'DAILY'],
    description:
      'EMPLOYMENT_TYPE only. The pay basis this type forces on everyone assigned it — ' +
      'DAILY makes their base pay a per-day rate. null leaves each employee their own.',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsIn(['MONTHLY', 'DAILY'])
  payBasis?: 'MONTHLY' | 'DAILY' | null;
}
