import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { CONFLICT_POLICIES } from '../types/sync.types';

export class CreateIntegrationDto {
  @ApiProperty({ description: 'Branch this provider supplies attendance for' })
  @IsUUID()
  branchId: string;

  @ApiProperty({ example: 'fusion-analytics', description: 'Provider registry key' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provider: string;

  @ApiProperty({ example: 'Taageer Finance HO — Fusion' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  displayName: string;

  @ApiPropertyOptional({ default: false, description: 'Only enabled connections are synced by the cron' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ example: 'https://live.thefusionapps.com' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  baseUrl: string;

  @ApiPropertyOptional({ enum: ['header', 'bearer'], default: 'header' })
  @IsOptional()
  @IsIn(['header', 'bearer'])
  authScheme?: string;

  @ApiPropertyOptional({ example: 'x-analytics-trigger-key' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  authHeaderName?: string;

  /**
   * Write-only. Encrypted at rest and never returned. Omit on update to keep the
   * stored secret; use `clearAuthSecret` to remove it.
   */
  @ApiPropertyOptional({ description: 'Write-only. Omit to keep the existing secret.' })
  @IsOptional()
  @IsString()
  authSecret?: string;

  @ApiPropertyOptional({ description: 'Delete the stored secret' })
  @IsOptional()
  @IsBoolean()
  clearAuthSecret?: boolean;

  @ApiProperty({ example: 'TAGGER', description: "Branch id as the provider knows it" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  externalBranchId: string;

  @ApiPropertyOptional({ example: '10' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  externalTenantId?: string;

  @ApiPropertyOptional({ description: 'Provider-specific knobs, keys declared by its configSchema' })
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: CONFLICT_POLICIES, default: 'PROVIDER_WINS_SAFE' })
  @IsOptional()
  @IsIn(CONFLICT_POLICIES as unknown as string[])
  conflictPolicy?: string;

  @ApiPropertyOptional({ default: 15, minimum: 5, maximum: 1440 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  syncIntervalMinutes?: number;

  @ApiPropertyOptional({
    default: 3,
    minimum: 0,
    maximum: 31,
    description: 'Days of history each cron run re-reads so late punches correct an earlier ABSENT',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(31)
  lookbackDays?: number;

  @ApiPropertyOptional({ default: false, description: 'Also write ABSENT rows the provider reports' })
  @IsOptional()
  @IsBoolean()
  autoCreateAbsent?: boolean;
}

/** branchId and provider are immutable once created — changing either is a new connection. */
export class UpdateIntegrationDto extends PartialType(CreateIntegrationDto) {
  @ApiPropertyOptional({ readOnly: true })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ readOnly: true })
  @IsOptional()
  @IsString()
  provider?: string;
}
