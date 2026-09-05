import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceStatus } from '@prisma/client';
import { DAY_KEY_PATTERN } from '../attendance-calendar.util';

/** One employee's mark. Each carries its own verdict — a roomful is rarely
 *  uniform, and forcing one status per batch means three passes over the list. */
export class BulkAttendanceEntryDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;

  @ApiPropertyOptional({
    enum: AttendanceStatus,
    description: 'Defaults to ABSENT when the entry carries no times',
  })
  @IsOptional()
  @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  @ApiPropertyOptional({ example: '2026-03-02T04:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  checkIn?: string;

  @ApiPropertyOptional({ example: '2026-03-02T13:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  checkOut?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** What the attendance-manager screen sends when it marks a roomful of people. */
export class BulkAttendanceDto {
  @ApiProperty({ example: '2026-03-02' })
  @Matches(DAY_KEY_PATTERN, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiProperty({ type: [BulkAttendanceEntryDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BulkAttendanceEntryDto)
  entries: BulkAttendanceEntryDto[];
}
