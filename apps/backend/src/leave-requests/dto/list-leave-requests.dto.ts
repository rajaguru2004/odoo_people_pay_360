import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** The four states a leave request can be in. */
export const LEAVE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export class ListLeaveRequestsDto {
  @ApiPropertyOptional({ description: 'Restrict to one employee' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: LEAVE_STATUSES })
  @IsOptional()
  @IsIn(LEAVE_STATUSES)
  status?: LeaveStatus;

  @ApiPropertyOptional({ example: 'Annual Leave' })
  @IsOptional()
  @IsString()
  leaveType?: string;

  @ApiPropertyOptional({
    example: '2026-01-01',
    description: 'Starting on or after',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'Ending on or before',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  endDate?: string;

  @ApiPropertyOptional({ description: 'Match on the employee name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** The employee's own list: no employee filter, no paging. */
export class ListMyLeaveRequestsDto {
  @ApiPropertyOptional({ enum: LEAVE_STATUSES })
  @IsOptional()
  @IsIn(LEAVE_STATUSES)
  status?: LeaveStatus;

  @ApiPropertyOptional({ example: 'Annual Leave' })
  @IsOptional()
  @IsString()
  leaveType?: string;

  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsISO8601({ strict: true })
  endDate?: string;
}
