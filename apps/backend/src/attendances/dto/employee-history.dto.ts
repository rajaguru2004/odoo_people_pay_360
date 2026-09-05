import { IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DAY_KEY_PATTERN } from '../attendance-calendar.util';

export class EmployeeHistoryDto {
  @ApiPropertyOptional({
    example: '2026-03-01',
    description: 'Defaults to 30 days back',
  })
  @IsOptional()
  @Matches(DAY_KEY_PATTERN, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-03-31',
    description: 'Defaults to today',
  })
  @IsOptional()
  @Matches(DAY_KEY_PATTERN, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string;
}
