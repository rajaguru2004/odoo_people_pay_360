import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { HUB_PERIODS, type HubPeriod } from '../../common/hub/hub-range.util';
import { DAY_KEY_PATTERN } from '../../attendances/attendance-calendar.util';

/**
 * The hub's window.
 *
 * Both fields are validated rather than defaulted-on-nonsense: `months=7` or
 * `anchor=2026-13-45` is refused with a 400, because a page that quietly
 * answered for a different period has no way to show its reader that it did.
 */
export class LeaveHubSummaryDto {
  @ApiPropertyOptional({ enum: HUB_PERIODS, default: 'month' })
  @IsOptional()
  @IsIn(HUB_PERIODS, {
    message: 'period must be one of today|week|month|year',
  })
  period?: HubPeriod;

  @ApiPropertyOptional({
    example: '2026-08-15',
    description:
      'Any date inside the period being viewed. Defaults to today; page with the prevAnchor/nextAnchor the response returns.',
  })
  @IsOptional()
  @Matches(DAY_KEY_PATTERN, { message: 'anchor must be a YYYY-MM-DD date' })
  anchor?: string;
}
