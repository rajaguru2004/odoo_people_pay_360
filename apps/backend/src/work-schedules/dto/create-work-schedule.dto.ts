import {
  IsBoolean,
  IsEnum,
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

/** "HH:MM", 24-hour. Anything else is refused rather than coerced. */
const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateWorkScheduleDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: '2026-03-02' })
  @Matches(DAY_KEY_PATTERN, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional({ enum: ShiftType, default: ShiftType.FULL_DAY })
  @IsOptional()
  @IsEnum(ShiftType)
  shiftType?: ShiftType;

  @ApiPropertyOptional({
    example: '22:00',
    description:
      "Wall clock in the employee's zone. Unset inherits the branch.",
  })
  @IsOptional()
  @Matches(WALL_CLOCK, { message: 'startTime must be HH:MM' })
  startTime?: string;

  @ApiPropertyOptional({ example: '06:00' })
  @IsOptional()
  @Matches(WALL_CLOCK, { message: 'endTime must be HH:MM' })
  endTime?: string;

  @ApiPropertyOptional({
    example: 8,
    description: 'Overrides the window length',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(24)
  requiredHours?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'False rosters the day OFF for this one person',
  })
  @IsOptional()
  @IsBoolean()
  isWorkDay?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
