import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCourseDto {
  @ApiProperty({ example: 'SEC-101' })
  @IsString()
  @MaxLength(50)
  code: string;

  @ApiProperty({ example: 'Information Security Awareness' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ description: 'A COURSE_CATEGORY library label' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  provider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  durationHours?: number;

  @ApiPropertyOptional({ description: 'Falls through to a session that sets no cost' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultCost?: number;

  @ApiPropertyOptional({
    description:
      'Months a certificate stays valid. Drives the expiry the vault surfaces; omit if it never expires.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  certValidMonths?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
