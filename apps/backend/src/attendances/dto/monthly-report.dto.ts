import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One calendar month of the whole workforce.
 *
 * Month and year rather than a free date range: the grid this feeds has a
 * column per day and a stepper that walks a month at a time, so a range of
 * arbitrary length would produce a table with no natural width and a header
 * nobody could label.
 */
export class MonthlyReportDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 12,
    description: 'Defaults to the current month in the company clock.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'month must be a whole number' })
  @Min(1, { message: 'month must be between 1 and 12' })
  @Max(12, { message: 'month must be between 1 and 12' })
  month?: number;

  @ApiPropertyOptional({
    minimum: 2000,
    maximum: 2100,
    description: 'Defaults to the current year in the company clock.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'year must be a whole number' })
  @Min(2000, { message: 'year must be between 2000 and 2100' })
  @Max(2100, { message: 'year must be between 2000 and 2100' })
  year?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({
    description: 'Matches employee code, name or department name',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
