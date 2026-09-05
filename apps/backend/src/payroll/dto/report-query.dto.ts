import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAYROLL_YEAR, MIN_PAYROLL_YEAR } from '../payroll-period.util';

/** The two axes a cost report may be cut along. */
export const COST_GROUP_BY = ['department', 'branch'] as const;

export type CostGroupBy = (typeof COST_GROUP_BY)[number];

/**
 * A report always names the run it reports on.
 *
 * Required rather than "latest run" by default: a payroll register with no run
 * on it is a document nobody can file, and a reader who cannot see which run
 * produced a figure cannot check it.
 */
export class RunReportQueryDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The payroll run to report on. Must be APPROVED or PAID.',
  })
  @IsUUID('4', { message: 'runId must be a payroll run id' })
  runId!: string;
}

export class CostReportQueryDto extends RunReportQueryDto {
  @ApiPropertyOptional({
    enum: COST_GROUP_BY,
    default: 'department',
    description: 'Which organisational axis the totals are grouped along',
  })
  @IsOptional()
  @IsIn(COST_GROUP_BY, { message: 'groupBy must be department or branch' })
  groupBy?: CostGroupBy;
}

/**
 * Year-to-date is a CALENDAR year, named explicitly.
 *
 * Defaulted to the current year in the company clock rather than to "the last
 * twelve months": a payslip summary an employee takes to a bank has to line up
 * with the tax year they are being asked about.
 */
export class YtdReportQueryDto {
  @ApiPropertyOptional({
    minimum: MIN_PAYROLL_YEAR,
    maximum: MAX_PAYROLL_YEAR,
    description: 'Defaults to the current year in the company clock.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'year must be a whole number' })
  @Min(MIN_PAYROLL_YEAR, {
    message: `year must be between ${MIN_PAYROLL_YEAR} and ${MAX_PAYROLL_YEAR}`,
  })
  @Max(MAX_PAYROLL_YEAR, {
    message: `year must be between ${MIN_PAYROLL_YEAR} and ${MAX_PAYROLL_YEAR}`,
  })
  year?: number;
}
