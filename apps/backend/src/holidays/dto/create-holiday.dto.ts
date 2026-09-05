import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DAY_KEY_PATTERN } from '../../attendances/attendance-calendar.util';

export class CreateHolidayDto {
  @ApiProperty({ example: 'National Day' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: '2026-11-18' })
  @Matches(DAY_KEY_PATTERN, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional({
    description: 'Leave unset for a company-wide holiday every branch observes',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Falls on the same date each year — the next calendar copies it',
  })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
