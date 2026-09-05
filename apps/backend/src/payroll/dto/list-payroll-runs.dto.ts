import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PayrollRunStatus } from '@prisma/client';
import { MAX_PAYROLL_YEAR, MIN_PAYROLL_YEAR } from '../payroll-period.util';

export class ListPayrollRunsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ enum: PayrollRunStatus })
  @IsOptional()
  @IsEnum(PayrollRunStatus)
  status?: PayrollRunStatus;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_PAYROLL_YEAR)
  @Max(MAX_PAYROLL_YEAR)
  year?: number;
}
