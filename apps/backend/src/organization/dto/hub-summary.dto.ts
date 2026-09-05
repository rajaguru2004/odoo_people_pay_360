import { IsIn, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** The only trend windows the hub offers. */
export const HUB_SUMMARY_MONTHS = [6, 12] as const;

export class HubSummaryQueryDto {
  /**
   * Anything other than 6 or 12 is refused rather than defaulted.
   *
   * A silent fall back to six would answer a question nobody asked and give
   * the page no way to tell the reader that the period on screen is not the
   * period they requested.
   */
  @ApiPropertyOptional({
    enum: HUB_SUMMARY_MONTHS,
    default: 6,
    description: 'Length of the growth window, in months',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(HUB_SUMMARY_MONTHS, { message: 'months must be 6 or 12' })
  months?: number;
}
