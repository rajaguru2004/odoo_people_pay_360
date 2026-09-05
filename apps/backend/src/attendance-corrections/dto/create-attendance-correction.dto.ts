import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class CreateAttendanceCorrectionDto {
  @ApiProperty({ example: '2026-01-15', description: 'Date to be adjusted' })
  // Calendar date ONLY. `@IsDateString()` alone accepts a full ISO timestamp,
  // and the service parses this with `date.split('-')` — so '2026-01-15T00:00:00.000Z'
  // yielded Number('15T00:00:00.000Z') = NaN, an Invalid Date, and a raw Prisma
  // error surfaced to the caller as a 500. Constraining the shape here is the
  // honest fix: the field has always meant a day, not an instant.
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be a calendar date in YYYY-MM-DD format',
  })
  @IsDateString()
  @IsNotEmpty()
  date: string;

  @ApiProperty({
    example: '2026-01-15T08:30:00Z',
    description: 'Proposed check-in time',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  requestedCheckIn?: string;

  @ApiProperty({
    example: '2026-01-15T17:30:00Z',
    description: 'Proposed check-out time',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  requestedCheckOut?: string;

  @ApiProperty({
    example: 'Forgot to check-in due to urgent meeting',
    description: 'Reason for adjustment',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
