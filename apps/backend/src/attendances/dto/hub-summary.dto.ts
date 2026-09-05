import { IsIn, IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DAY_KEY_PATTERN } from '../attendance-calendar.util';

export const HUB_PERIODS = ['today', 'week', 'month', 'year'] as const;
export type HubPeriod = (typeof HUB_PERIODS)[number];

export class HubSummaryDto {
  @ApiPropertyOptional({ enum: HUB_PERIODS, default: 'month' })
  @IsOptional()
  @IsIn(HUB_PERIODS, {
    message: `period must be one of ${HUB_PERIODS.join(', ')}`,
  })
  period?: HubPeriod;

  @ApiPropertyOptional({
    example: '2026-03-15',
    description: 'Any date inside the period being viewed. Defaults to today.',
  })
  @IsOptional()
  @Matches(DAY_KEY_PATTERN, { message: 'anchor must be YYYY-MM-DD' })
  anchor?: string;
}
