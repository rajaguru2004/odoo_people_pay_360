import { IsIn, IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DAY_KEY_PATTERN } from '../../attendances/attendance-calendar.util';

/**
 * No `today`, unlike the attendance hub.
 *
 * "Who is rostered today" is a calendar screen, not a dashboard question — a
 * scheduler opens this module to ask whether the coming week is covered, which
 * is why `week` leads and is the default.
 */
export const SCHEDULE_PERIODS = ['week', 'month', 'year'] as const;
export type SchedulePeriod = (typeof SCHEDULE_PERIODS)[number];

export class ScheduleHubSummaryDto {
  @ApiPropertyOptional({ enum: SCHEDULE_PERIODS, default: 'week' })
  @IsOptional()
  @IsIn(SCHEDULE_PERIODS, {
    message: `period must be one of ${SCHEDULE_PERIODS.join(', ')}`,
  })
  period?: SchedulePeriod;

  @ApiPropertyOptional({
    example: '2026-03-15',
    description:
      'Any date inside the period being viewed. Defaults to today; page with ' +
      'the prevAnchor/nextAnchor the response returns.',
  })
  @IsOptional()
  @Matches(DAY_KEY_PATTERN, { message: 'anchor must be YYYY-MM-DD' })
  anchor?: string;
}
