import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DAY_KEY_PATTERN } from '../../attendances/attendance-calendar.util';

/**
 * A closed date window, as every read on this module takes it.
 *
 * Both bounds are REQUIRED. A defaulted range is how a calendar screen silently
 * asks for a different month than the one it is drawing, and the row that then
 * fails to appear is blamed on the roster rather than on the query.
 */
export class ScheduleRangeDto {
  @ApiProperty({ example: '2026-03-01' })
  @Matches(DAY_KEY_PATTERN, { message: 'startDate must be YYYY-MM-DD' })
  startDate: string;

  @ApiProperty({ example: '2026-03-31' })
  @Matches(DAY_KEY_PATTERN, { message: 'endDate must be YYYY-MM-DD' })
  endDate: string;
}

/** The overview matrix, optionally narrowed to one branch or department. */
export class ScheduleOverviewDto extends ScheduleRangeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

/**
 * One employee's calendar.
 *
 * `employeeId` is OPTIONAL: a caller reading their OWN calendar supplies
 * nothing and the token decides. Only the three management roles may name
 * somebody else, and only then is the object-level check consulted — see
 * `SchedulesService.resolveCalendarTarget`.
 */
export class MyScheduleDto extends ScheduleRangeDto {
  @ApiPropertyOptional({
    description:
      'Whose calendar to read. Admin, HR and managers only; everyone else ' +
      'reads their own whatever they send.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

/** The month a stat tile is counting. */
export class ScheduleStatsDto {
  @ApiProperty({ example: 3, minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt({ message: 'month must be an integer between 1 and 12' })
  @Min(1)
  @Max(12)
  month: number;

  @ApiProperty({ example: 2026, minimum: 1970, maximum: 9999 })
  @Type(() => Number)
  @IsInt({ message: 'year must be a four-digit calendar year' })
  @Min(1970)
  @Max(9999)
  year: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

/** The conflict sweep for one person over a window. */
export class ScheduleConflictsDto extends ScheduleRangeDto {
  @ApiProperty()
  @IsUUID()
  employeeId: string;
}
