import {
  IsString,
  IsDateString,
  IsInt,
  Min,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateHolidayDto {
  @ApiProperty({ example: 'Lunar New Year', description: 'Holiday name' })
  @IsString()
  name: string;

  @ApiProperty({ example: '2026-02-17', description: 'Holiday date (YYYY-MM-DD)' })
  @IsDateString()
  date: string;

  @ApiProperty({
    example: 2026,
    required: false,
    description: 'Year (derived from date when omitted)',
  })
  @IsOptional()
  @IsInt()
  @Min(2020)
  year?: number;

  @ApiProperty({
    example: false,
    required: false,
    description: 'Rolls forward into each new year via copy-year',
  })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @ApiProperty({
    required: false,
    description: 'Branch this holiday applies to. Omit/null = all branches (company-wide).',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @ApiProperty({ required: false, description: 'Optional notes' })
  @IsOptional()
  @IsString()
  description?: string;
}
