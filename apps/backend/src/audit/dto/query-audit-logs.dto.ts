import {
  IsOptional,
  IsString,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsUUID,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class QueryAuditLogsDto {
  @ApiProperty({ example: 1, required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ example: 20, required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 20;

  @ApiProperty({
    example: '11111111-1111-1111-1111-111111111111',
    required: false,
    description: 'Filter by user UUID who performed the action',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiProperty({
    example: 'Employee',
    required: false,
    description: 'Filter by resource type (e.g. Employee, Department)',
  })
  @IsOptional()
  @IsString()
  resourceType?: string;

  @ApiProperty({
    example: 'CREATE',
    required: false,
    description: 'Filter by action type (CREATE, UPDATE, DELETE)',
  })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiProperty({
    example: '2026-06-22T00:00:00.000Z',
    required: false,
    description: 'Start date range',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiProperty({
    example: '2026-06-22T23:59:59.999Z',
    required: false,
    description: 'End date range',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiProperty({
    example: 'admin@company.com',
    required: false,
    description: 'Search string matching user email, IP address, user agent, or resource ID',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
