import { IsDateString, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query validation for the calendar READ endpoints.
 *
 * These three routes documented `startDate` and `endDate` as `required: true` in
 * Swagger and enforced it nowhere — there was no DTO on the query at all. An
 * absent or unparseable range therefore became `new Date(undefined)`, an Invalid
 * Date, and a Prisma rejection the caller saw as a 500. Same family as the
 * missing `ParseUUIDPipe` on `:id`: an unvalidated input reaching the data layer
 * and failing there instead of at the door.
 */
export class CalendarRangeQueryDto {
  @ApiProperty({ description: 'Start date (YYYY-MM-DD)' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date (YYYY-MM-DD)' })
  @IsDateString()
  endDate: string;
}

export class MyCalendarQueryDto extends CalendarRangeQueryDto {
  @ApiPropertyOptional({
    description:
      'Employee to view. Honoured for ADMIN/HR/MANAGER only, and subject to branch and department scope.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class ConflictsQueryDto extends CalendarRangeQueryDto {
  @ApiProperty({ description: 'Employee ID' })
  @IsUUID()
  employeeId: string;
}

export class CalendarStatsQueryDto {
  @ApiProperty({ description: 'Month, 1-12' })
  // `@Type` is what makes `transform: true` coerce the query STRING into a
  // number; without it `@IsInt()` rejects every real request, since query
  // parameters arrive as strings.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @ApiProperty({ description: 'Four-digit year' })
  @Type(() => Number)
  @IsInt()
  @Min(1970)
  @Max(9999)
  year: number;
}
