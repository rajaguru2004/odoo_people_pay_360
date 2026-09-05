import {
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DAY_KEY_PATTERN } from '../../attendances/attendance-calendar.util';

/**
 * No `employeeId`: a correction is always raised for the caller, resolved from
 * the principal. Accepting one would let anybody rewrite anybody's timesheet.
 */
export class CreateCorrectionDto {
  @ApiProperty({
    example: '2026-03-02',
    description: 'The day being corrected',
  })
  @Matches(DAY_KEY_PATTERN, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional({
    example: '2026-03-02T04:55:00.000Z',
    description: 'An instant. At least one of the two times is required.',
  })
  @IsOptional()
  @IsISO8601()
  requestedCheckIn?: string;

  @ApiPropertyOptional({ example: '2026-03-02T13:10:00.000Z' })
  @IsOptional()
  @IsISO8601()
  requestedCheckOut?: string;

  @ApiProperty({ example: 'The reader did not register my badge at the gate' })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason: string;
}
