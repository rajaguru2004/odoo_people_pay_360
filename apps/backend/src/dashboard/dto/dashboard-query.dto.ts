import { IsIn, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The only thing the main dashboard is allowed to ask for.
 *
 * Everything else about the payload is decided by WHO is asking, not by what
 * they asked for: a section the caller may not see is absent, and no query
 * parameter can add one. Keeping the surface to a single window length is what
 * makes that true — a `departmentId` here would be a slicer an employee could
 * point at somebody else's team.
 */

/** The only trend windows the dashboard offers, matching every other hub. */
export const DASHBOARD_MONTHS = [6, 12] as const;

export type DashboardMonths = (typeof DASHBOARD_MONTHS)[number];

/** What the page opens on when nothing is asked for. */
export const DEFAULT_DASHBOARD_MONTHS: DashboardMonths = 12;

export class DashboardOverviewQueryDto {
  /**
   * An unoffered window is a 400, never a silent default.
   *
   * A page that quietly answered for twelve months when it was asked for seven
   * has no way to tell the reader it did that, and the reader has no way to
   * find out.
   */
  @ApiPropertyOptional({
    enum: DASHBOARD_MONTHS,
    default: DEFAULT_DASHBOARD_MONTHS,
    description: 'Length of the trend windows, in months',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(DASHBOARD_MONTHS, { message: 'months must be 6 or 12' })
  months?: number;
}
