import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AssetStatus } from '@prisma/client';
import { ASSET_STATUSES } from '../assets.service';

export class QueryAssetsDto {
  @ApiPropertyOptional({ enum: ASSET_STATUSES })
  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Matches asset tag, name or serial number' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Only assets nobody currently holds' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unassignedOnly?: boolean;

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
