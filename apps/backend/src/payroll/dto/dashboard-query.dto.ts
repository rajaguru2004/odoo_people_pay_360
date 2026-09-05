import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The analytics page's slicers.
 *
 * Every one is validated and an unoffered value is a 400, never a silent
 * default. A page that quietly answered for six months when it was asked for
 * seven has no way to tell the reader it did that, and the reader has no way to
 * find out.
 */

/** The only trend windows the dashboard offers, matching the hub's. */
export const DASHBOARD_MONTHS = [6, 12] as const;

export type DashboardMonths = (typeof DASHBOARD_MONTHS)[number];

/**
 * The literal a slicer uses to mean "the rows with no value at all".
 *
 * `Employee.departmentId` and `Employee.employmentType` are both nullable, and
 * those employees are not a rounding error — they are usually the ones somebody
 * needs to go and fix. Filtering them has to be expressible, so it gets a word
 * rather than being reachable only by leaving the filter off.
 */
export const UNASSIGNED = 'unassigned';

/** `YYYY-MM`. The month itself is range-checked in the service. */
export const PERIOD_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A uuid, or the literal `unassigned`. */
const UUID_OR_UNASSIGNED =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|unassigned)$/;

export class PayrollDashboardQueryDto {
  @ApiPropertyOptional({
    enum: DASHBOARD_MONTHS,
    default: 12,
    description: 'Length of the trend window, in months',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(DASHBOARD_MONTHS, { message: 'months must be 6 or 12' })
  months?: number;

  /**
   * The focus period, defaulting to the latest LOCKED run rather than to the
   * current month.
   *
   * A dashboard that opened on an unrun month would show a page of em dashes to
   * a reader who has done nothing wrong. The latest locked run is the most
   * recent period there is anything true to say about.
   */
  @ApiPropertyOptional({
    example: '2026-08',
    description:
      'Focus period as YYYY-MM. Defaults to the latest APPROVED or PAID run.',
  })
  @IsOptional()
  @Matches(PERIOD_KEY_PATTERN, { message: 'period must be YYYY-MM' })
  period?: string;

  @ApiPropertyOptional({
    description: `A department id, or "${UNASSIGNED}" for employees in none.`,
  })
  @IsOptional()
  @Matches(UUID_OR_UNASSIGNED, {
    message: `departmentId must be a department id or "${UNASSIGNED}"`,
  })
  departmentId?: string;

  /**
   * An EMPLOYMENT_TYPE library LABEL, not an id.
   *
   * `Employee.employmentType` stores the label — see the note on that column —
   * so the filter matches what is actually in the row. Validated for length
   * only: the set is admin-configurable through the library screen, and a
   * hard-coded enum here would 400 a category HR added this morning.
   */
  @ApiPropertyOptional({
    example: 'Monthly Staff',
    description: `An employment-type label, or "${UNASSIGNED}" for employees with none.`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'employmentType must be 100 characters or fewer' })
  employmentType?: string;
}
