import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceStatus } from '@prisma/client';
import { DAY_KEY_PATTERN } from '../attendance-calendar.util';

export class CreateAttendanceDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiProperty({
    example: '2026-03-02',
    description: 'Day the work is attributed to',
  })
  @Matches(DAY_KEY_PATTERN, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional({
    example: '2026-03-02T04:00:00.000Z',
    description: 'An instant, not a wall clock',
  })
  @IsOptional()
  @IsISO8601()
  checkIn?: string;

  @ApiPropertyOptional({ example: '2026-03-02T13:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  checkOut?: string;

  @ApiPropertyOptional({
    enum: AttendanceStatus,
    description:
      'Only for a day with no punches. PRESENT, LATE and HALF_DAY are derived from the times.',
  })
  @IsOptional()
  @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
