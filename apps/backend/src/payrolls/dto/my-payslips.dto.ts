import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** The earliest year worth asking for; anything below it is a typo. */
const FIRST_PAYROLL_YEAR = 2000;
const LAST_PAYROLL_YEAR = 2100;

export class ListMyPayslipsDto {
  @ApiPropertyOptional({
    description: 'Calendar year. Omitted, the most recent payslips are served.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(FIRST_PAYROLL_YEAR)
  @Max(LAST_PAYROLL_YEAR)
  year?: number;
}

export class YtdSummaryDto {
  @ApiPropertyOptional({ description: 'Defaults to the current year.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(FIRST_PAYROLL_YEAR)
  @Max(LAST_PAYROLL_YEAR)
  year?: number;
}
