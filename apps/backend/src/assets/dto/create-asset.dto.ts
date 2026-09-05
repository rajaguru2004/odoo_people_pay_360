import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetStatus } from '@prisma/client';
import { ASSET_STATUSES } from '../assets.service';

export class CreateAssetDto {
  @ApiProperty({
    example: 'LT-0042',
    description:
      'Asset tag. Unique WITHIN the branch (R2) — another branch may register the same tag.',
  })
  @IsString()
  @MaxLength(50)
  assetTag: string;

  @ApiProperty({ description: 'LibraryItem ASSET_CATEGORY label' })
  @IsString()
  @MaxLength(100)
  category: string;

  @ApiProperty({ example: 'Dell Latitude 5540' })
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  serialNumber?: string;

  @ApiProperty({ description: 'Branch that owns the asset' })
  @IsUUID()
  branchId: string;

  // R15 — `AssetStatus` is a real PG enum now, so this is a second line of
  // defence with a better message rather than the only thing standing between
  // free text and the column.
  @ApiPropertyOptional({ enum: ASSET_STATUSES, default: 'AVAILABLE' })
  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @ApiPropertyOptional({ example: '2026-01-15' })
  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseCost?: number;

  @ApiPropertyOptional({ example: '2029-01-15' })
  @IsOptional()
  @IsDateString()
  warrantyExpiry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
