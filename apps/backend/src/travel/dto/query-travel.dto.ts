import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TRAVEL_TYPES } from './create-travel-request.dto';

/**
 * Every state a travel request can actually be in.
 *
 * `COMPLETED` used to be listed here and was never written by any code path —
 * it was offered in the screen's status filter, matched nothing, and made the
 * declared set disagree with the reachable one. Nothing marks a trip as having
 * happened today: there is no completion cron and no screen action for it.
 *
 * Removed rather than back-filled, so the contract is honest now. If trip
 * completion is built later, add the value back in the same change that writes
 * it — and `findOnTrip` will need it in its status list again.
 */
export const TRAVEL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;

export class QueryTravelDto {
  @ApiPropertyOptional({ enum: TRAVEL_STATUSES })
  @IsOptional()
  @IsIn(TRAVEL_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: TRAVEL_TYPES })
  @IsOptional()
  @IsIn(TRAVEL_TYPES as unknown as string[])
  travelType?: string;

  @ApiPropertyOptional({ description: 'Departure on/after this date' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Departure on/before this date' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
