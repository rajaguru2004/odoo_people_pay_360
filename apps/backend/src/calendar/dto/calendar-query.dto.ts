import {
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CalendarRangeDto {
  @ApiProperty({ description: 'Start date (YYYY-MM-DD)' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date (YYYY-MM-DD)' })
  @IsDateString()
  endDate: string;
}

export class MyCalendarDto extends CalendarRangeDto {
  @ApiPropertyOptional({
    description:
      'Whose calendar to read. Honoured for ADMIN, HR and managers only, and a manager only inside the departments they head.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class CalendarStatsDto {
  @ApiProperty({ description: 'Month, 1-12' })
  // `@Type` is what makes `transform: true` coerce the query string into a
  // number. Without it `@IsInt()` rejects every real request, because query
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

  @ApiPropertyOptional({
    description: 'Whose month to count. Defaults to the caller.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}
