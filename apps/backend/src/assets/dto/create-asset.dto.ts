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

export class CreateAssetDto {
  @ApiProperty({
    example: 'LT-0042',
    description:
      'Asset tag. Unique WITHIN the branch — another branch may register the same tag.',
  })
  @IsString()
  @MaxLength(50)
  assetTag: string;

  @ApiProperty({ description: 'An ASSET_CATEGORY library label' })
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

  @ApiProperty({ description: 'The branch that owns the asset' })
  @IsUUID()
  branchId: string;

  @ApiPropertyOptional({ enum: AssetStatus, default: AssetStatus.AVAILABLE })
  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @ApiPropertyOptional({ example: '2026-01-15' })
  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @ApiPropertyOptional({ description: 'Money is thousandths here, never hundredths' })
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
