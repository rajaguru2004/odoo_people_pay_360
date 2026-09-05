import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LibraryType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateLibraryItemDto {
  @ApiProperty({ enum: LibraryType, example: LibraryType.LEAVE_TYPE })
  @IsEnum(LibraryType)
  libraryType: LibraryType;

  @ApiProperty({ example: 'Study Leave' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'LEAVE_TYPE only: days allocated for a fresh year.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  defaultDays?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @ApiPropertyOptional({
    example: 3,
    description:
      'Minimum days between filing and the first day off. 0 means it may be filed for today.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  requiresNoticeDays?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'False for unpaid leave: recorded, writes attendance, costs no entitlement.',
  })
  @IsOptional()
  @IsBoolean()
  affectsBalance?: boolean;

  @ApiPropertyOptional({
    enum: ['MONTHLY', 'DAILY'],
    nullable: true,
    description:
      'EMPLOYMENT_TYPE only: the pay basis this type forces on anyone assigned ' +
      "it. null leaves the choice with the employee's own record.",
  })
  @IsOptional()
  // As with genderRestriction, null is an explicit "clear it".
  @ValidateIf((_o, value) => value !== null)
  @IsIn(['MONTHLY', 'DAILY'])
  payBasis?: 'MONTHLY' | 'DAILY' | null;

  @ApiPropertyOptional({
    enum: ['MALE', 'FEMALE'],
    nullable: true,
    description: 'null means the type is available to everybody.',
  })
  @IsOptional()
  // null is a deliberate "clear the restriction", not a missing value.
  @ValidateIf((_o, value) => value !== null)
  @IsIn(['MALE', 'FEMALE'])
  genderRestriction?: 'MALE' | 'FEMALE' | null;
}
