import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DepartmentChangeType } from '@prisma/client';

/** Trims first so a reason of pure whitespace cannot satisfy MinLength. */
const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateDepartmentChangeRequestDto {
  @ApiProperty({ enum: DepartmentChangeType })
  @IsEnum(DepartmentChangeType)
  changeType: DepartmentChangeType;

  @ApiProperty({ description: 'The department the change applies to' })
  @IsUUID()
  departmentId: string;

  @ApiProperty({
    minLength: 10,
    description:
      'Why the change is being asked for. The reviewer sees only this.',
  })
  @Transform(trimmed)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  reason: string;

  @ApiProperty({
    example: '2026-10-01',
    description: 'Date the change should take effect from',
  })
  @IsDateString()
  effectiveDate: string;

  @ApiPropertyOptional({ description: 'Required when changeType is MANAGER' })
  @IsOptional()
  @IsUUID()
  newManagerId?: string;

  @ApiPropertyOptional({ description: 'Required when changeType is PARENT' })
  @IsOptional()
  @IsUUID()
  newParentId?: string;

  @ApiPropertyOptional({
    minLength: 2,
    description: 'Required when changeType is RENAME',
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  newName?: string;
}
