import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class UpdateLeaveBalanceDto {
  @ApiPropertyOptional({
    example: 30,
    description: 'Annual leave days for the year',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  annualLeave?: number;

  @ApiPropertyOptional({
    example: 30,
    description: 'Sick leave days for the year',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  sickLeave?: number;
}

export class UpdateTypeBalanceDto {
  @ApiPropertyOptional({
    example: 30,
    description: 'Days allocated for this type',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  allocated: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'Days carried over from the previous year',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  carriedOver?: number;
}

export class SetDefaultAllocationDto {
  @ApiPropertyOptional({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;
}

export class AccrueLeaveDto {
  @ApiPropertyOptional({ example: 1, description: 'Days to credit' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  daysToAdd: number;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

export class ListAccrualHistoryDto {
  @ApiPropertyOptional({ description: 'Restrict to one employee' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({
    example: 3,
    description: 'Calendar month, 1-12. Needs `year` beside it.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({ example: 'Annual Leave' })
  @IsOptional()
  @IsString()
  leaveTypeKey?: string;
}
