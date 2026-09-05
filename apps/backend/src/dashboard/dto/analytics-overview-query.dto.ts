import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

/**
 * The only trend windows the dashboard offers, matching every other hub.
 *
 * An unoffered window is a 400, not a silent default: `months=7` quietly
 * answered as 6 gives the reader a chart whose axis says six months and whose
 * question was never asked.
 */
export class AnalyticsOverviewQueryDto {
  @ApiPropertyOptional({ enum: [6, 12], default: 6 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsIn([6, 12], { message: 'months must be 6 or 12' })
  months?: 6 | 12;
}
