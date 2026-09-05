import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SalaryComponentType } from '@prisma/client';

export class CreateSalaryComponentDto {
  @ApiProperty({
    example: 'HRA',
    description:
      'Stable machine key. Uppercased on the way in — a payslip line joins on it, so it must not depend on how it was typed.',
  })
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z][A-Za-z0-9_]*$/, {
    message:
      'code must start with a letter and contain only letters, numbers and underscores',
  })
  code: string;

  @ApiProperty({ example: 'Housing Allowance' })
  @IsString()
  @MaxLength(160)
  name: string;

  @ApiProperty({ enum: SalaryComponentType })
  @IsEnum(SalaryComponentType)
  type: SalaryComponentType;

  @ApiPropertyOptional({
    default: false,
    description: 'Counts toward gratuity / end-of-service accrual.',
  })
  @IsOptional()
  @IsBoolean()
  isGratuityBase?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;

  @ApiPropertyOptional({
    default: 100,
    description: 'Display order on a payslip. Lower comes first.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sequence?: number;
}
