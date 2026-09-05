import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ShiftType } from '@prisma/client';
import { DAY_KEY_PATTERN } from '../../attendances/attendance-calendar.util';

const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Lays one shift pattern over a date range for a set of people. */
export class BulkWorkScheduleDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  employeeIds: string[];

  @ApiProperty({ example: '2026-03-01' })
  @Matches(DAY_KEY_PATTERN, { message: 'startDate must be YYYY-MM-DD' })
  startDate: string;

  @ApiProperty({ example: '2026-03-31' })
  @Matches(DAY_KEY_PATTERN, { message: 'endDate must be YYYY-MM-DD' })
  endDate: string;

  @ApiPropertyOptional({
    example: [1, 2, 3, 4],
    description:
      'ISO weekdays the pattern applies to, 1 = Monday. Empty means every day in the range.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays?: number[];

  @ApiPropertyOptional({ enum: ShiftType, default: ShiftType.FULL_DAY })
  @IsOptional()
  @IsEnum(ShiftType)
  shiftType?: ShiftType;

  @ApiPropertyOptional({ example: '22:00' })
  @IsOptional()
  @Matches(WALL_CLOCK, { message: 'startTime must be HH:MM' })
  startTime?: string;

  @ApiPropertyOptional({ example: '06:00' })
  @IsOptional()
  @Matches(WALL_CLOCK, { message: 'endTime must be HH:MM' })
  endTime?: string;

  @ApiPropertyOptional({ example: 8 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(24)
  requiredHours?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isWorkDay?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Replace a day that is already rostered instead of leaving it alone',
  })
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
