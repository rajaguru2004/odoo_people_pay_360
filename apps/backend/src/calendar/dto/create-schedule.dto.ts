import {
  IsUUID,
  IsDateString,
  IsEnum,
  IsBoolean,
  IsOptional,
  IsString,
  IsNumber,
  IsPositive,
  Max,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Duplicated from `@prisma/client` rather than imported, so that the API's
 * accepted values are a deliberate choice rather than whatever the schema
 * happens to contain. `time-schedule.e2e-spec.ts` (SCH-API-54) asserts the two
 * agree, which is what makes the duplication safe.
 */
export enum ShiftType {
  MORNING = 'MORNING',
  AFTERNOON = 'AFTERNOON',
  FULL_DAY = 'FULL_DAY',
  NIGHT = 'NIGHT',
  CUSTOM = 'CUSTOM',
  FLEXIBLE = 'FLEXIBLE',
}

/** Nobody works more than a day in a day. The client caps at 24; so does this. */
export const MAX_REQUIRED_HOURS = 24;
/** Matches the cap the MCP shift tool applies (`mcp/tools/shifts.tools.ts:26`). */
export const MAX_NOTES_LENGTH = 500;

export class CreateScheduleDto {
  @ApiProperty({ description: 'Employee ID' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({ description: 'Schedule date (YYYY-MM-DD)' })
  @IsDateString()
  date: string;

  @ApiProperty({ enum: ShiftType, description: 'Shift type' })
  @IsEnum(ShiftType)
  shiftType: ShiftType;

  @ApiProperty({
    description: 'Start time (ISO 8601). Omitted for FLEXIBLE shifts.',
    required: false,
  })
  @ValidateIf((o: CreateScheduleDto) => o.shiftType !== ShiftType.FLEXIBLE)
  @IsDateString()
  startTime?: string;

  @ApiProperty({
    description: 'End time (ISO 8601). Omitted for FLEXIBLE shifts.',
    required: false,
  })
  @ValidateIf((o: CreateScheduleDto) => o.shiftType !== ShiftType.FLEXIBLE)
  @IsDateString()
  endTime?: string;

  @ApiProperty({
    description: 'Total working hours per day. Required for FLEXIBLE shifts.',
    required: false,
    maximum: MAX_REQUIRED_HOURS,
  })
  @ValidateIf((o: CreateScheduleDto) => o.shiftType === ShiftType.FLEXIBLE)
  @IsNumber()
  @IsPositive()
  // Without an upper bound the column decides: `Decimal(5,2)` overflows above
  // 999.99 and the caller gets a 500 instead of a validation error.
  @Max(MAX_REQUIRED_HOURS)
  requiredHours?: number;

  @ApiProperty({ description: 'Is work day', default: true })
  @IsBoolean()
  @IsOptional()
  isWorkDay?: boolean;

  @ApiProperty({ description: 'Notes', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(MAX_NOTES_LENGTH)
  notes?: string;
}
