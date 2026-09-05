import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AssetStatus } from '@prisma/client';

/**
 * The status an asset takes on return.
 *
 * A deliberate SUBSET of `AssetStatus`, not the whole enum: ASSIGNED is derived
 * from custody and cannot be the outcome of closing that custody. `satisfies`
 * keeps the subset honest — a value that is not a real status stops compiling —
 * while still allowing it to be narrower than the enum.
 */
export const RETURN_STATUSES = [
  'AVAILABLE',
  'IN_REPAIR',
  'LOST',
  'RETIRED',
] as const satisfies readonly AssetStatus[];

export class ReturnAssetDto {
  @ApiPropertyOptional({ description: 'Defaults to today' })
  @IsOptional()
  @IsDateString()
  returnedAt?: string;

  @ApiPropertyOptional({ example: 'Good', description: 'Condition on return' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  conditionIn?: string;

  @ApiPropertyOptional({
    enum: RETURN_STATUSES,
    default: 'AVAILABLE',
    description: 'A damaged or missing item must not re-enter the assignable pool',
  })
  @IsOptional()
  @IsIn(RETURN_STATUSES as unknown as string[])
  assetStatus?: (typeof RETURN_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
