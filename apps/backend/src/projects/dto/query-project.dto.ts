import {
  IsOptional,
  IsEnum,
  IsUUID,
  IsString,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class QueryProjectDto {
  @ApiProperty({
    required: false,
    enum: ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'],
  })
  @IsOptional()
  @IsEnum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'])
  status?: string;

  @ApiProperty({ required: false, enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] })
  @IsOptional()
  @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
  priority?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({
    required: false,
    description: 'Search by name or projectCode',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  isArchived?: boolean;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number;

  // R52: an out-of-range limit was silently clamped to 200 by `findAll`, so the
  // caller was told `limit: 200` for a request it never made. `page=0` has
  // always been refused; this makes the pair consistent.
  @ApiProperty({ required: false, default: 20, maximum: 200 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;

  @ApiProperty({ required: false, default: 'createdAt' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiProperty({ required: false, default: 'desc', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
