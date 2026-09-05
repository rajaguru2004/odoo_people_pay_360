import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Edit the headline entitlement for one employee-year.
 *
 * Both fields optional, but the service refuses an empty body: without that
 * check an empty PATCH reached Prisma as `undefined` for every field, changed
 * nothing, and answered 200 — indistinguishable from a successful update.
 */
export class UpdateBalanceDto {
  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsInt()
  @Min(0)
  annualLeave?: number;

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sickLeave?: number;
}
