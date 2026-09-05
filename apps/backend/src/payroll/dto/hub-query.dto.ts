import { IsIn, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The only trend windows the payroll hub offers.
 *
 * Six or twelve months, matching the Organisation hub, because the two pages
 * sit under the same stepper and a third length would give the reader two
 * charts that look alike and count different things.
 */
export const PAYROLL_HUB_MONTHS = [6, 12] as const;

export type PayrollHubMonths = (typeof PAYROLL_HUB_MONTHS)[number];

export class PayrollHubQueryDto {
  /**
   * Anything other than 6 or 12 is refused rather than defaulted.
   *
   * A silent fall back to six answers a question nobody asked, and leaves the
   * page no way to tell the reader that the window on screen is not the window
   * they requested.
   */
  @ApiPropertyOptional({
    enum: PAYROLL_HUB_MONTHS,
    default: 6,
    description: 'Length of the payroll trend window, in months',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(PAYROLL_HUB_MONTHS, { message: 'months must be 6 or 12' })
  months?: number;
}
