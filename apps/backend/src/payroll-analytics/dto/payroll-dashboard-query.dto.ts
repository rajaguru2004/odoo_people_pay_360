import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * What the analytics filter row may ask for.
 *
 * An unoffered window is a 400, not a silent default. `months=7` coerced to 6
 * would answer for a period nobody asked about, and the page has no way to show
 * the reader that it did — the axis would simply say six months and be wrong
 * about which question it answered.
 */
export class PayrollDashboardQueryDto {
  @ApiPropertyOptional({ enum: [6, 12], default: 6 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsIn([6, 12], { message: 'months must be 6 or 12' })
  months?: 6 | 12;

  /**
   * `YYYY-MM`. Omitted, the server resolves the latest LOCKED run's period —
   * the page opens on money that is final rather than on a draft that will move.
   */
  @ApiPropertyOptional({ example: '2026-08' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be YYYY-MM' })
  period?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4', { message: 'departmentId must be a uuid' })
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  employmentType?: string;
}
