import {
  IsArray,
  ArrayNotEmpty,
  ArrayMaxSize,
  ValidateNested,
  IsUUID,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ShiftType,
  MAX_REQUIRED_HOURS,
  MAX_NOTES_LENGTH,
} from './create-schedule.dto';

/**
 * The largest batch the endpoint will accept in one request.
 *
 * Matches the threshold `BulkScheduleModal.tsx:252` already warns the user
 * about, so the client's warning and the server's refusal describe the same
 * boundary. Rows are processed sequentially with a conflict query each and no
 * transaction, so an unbounded array is unbounded work.
 */
export const MAX_BULK_SCHEDULES = 500;

class BulkScheduleItem {
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
  @ValidateIf((o: BulkScheduleItem) => o.shiftType !== ShiftType.FLEXIBLE)
  @IsDateString()
  startTime?: string;

  @ApiProperty({
    description: 'End time (ISO 8601). Omitted for FLEXIBLE shifts.',
    required: false,
  })
  @ValidateIf((o: BulkScheduleItem) => o.shiftType !== ShiftType.FLEXIBLE)
  @IsDateString()
  endTime?: string;

  @ApiProperty({
    description: 'Total working hours per day. Required for FLEXIBLE shifts.',
    required: false,
    maximum: MAX_REQUIRED_HOURS,
  })
  @ValidateIf((o: BulkScheduleItem) => o.shiftType === ShiftType.FLEXIBLE)
  @IsNumber()
  @IsPositive()
  @Max(MAX_REQUIRED_HOURS)
  requiredHours?: number;

  @ApiProperty({ description: 'Is work day', default: true, required: false })
  // Absent from this DTO until now, while the service hardcoded `isWorkDay:
  // true` — so a rostered non-working day was expressible through single create
  // and not through bulk, which is the door a whole month gets built with.
  @IsBoolean()
  @IsOptional()
  isWorkDay?: boolean;

  @ApiProperty({ description: 'Notes', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(MAX_NOTES_LENGTH)
  notes?: string;
}

export class BulkCreateScheduleDto {
  @ApiProperty({
    type: [BulkScheduleItem],
    description: 'Array of schedules to create',
    maxItems: MAX_BULK_SCHEDULES,
  })
  @IsArray()
  // An empty array is a no-op request, not a server fault: without this the
  // service computes its leave window with `Math.min(...[])` — `Infinity` — and
  // hands Prisma an Invalid Date.
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_BULK_SCHEDULES)
  @ValidateNested({ each: true })
  @Type(() => BulkScheduleItem)
  schedules: BulkScheduleItem[];
}
