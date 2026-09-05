import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceStatus } from '@prisma/client';

/**
 * `date` and `employeeId` are absent on purpose: moving a row to another day or
 * another person is not an edit, it is a different row, and the unique
 * constraint on the pair is what would break first.
 */
export class UpdateAttendanceDto {
  @ApiPropertyOptional({
    example: '2026-03-02T04:00:00.000Z',
    description: 'Send null to clear the punch',
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  checkIn?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsISO8601()
  checkOut?: string | null;

  @ApiPropertyOptional({
    enum: AttendanceStatus,
    description:
      'Only meaningful on a day with no punches — with a check-in the times decide.',
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
