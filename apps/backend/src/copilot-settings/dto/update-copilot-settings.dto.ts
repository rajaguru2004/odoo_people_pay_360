import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** All fields optional — a PATCH-style update. Only provided fields change. */
export class UpdateCopilotSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() mcpEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() mcpAuditReads?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(500) mcpMaxItems?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() mcpLoopbackUrl?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() copilotEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() llmBaseUrl?: string;

  /** New plaintext API key. Encrypted before storage. Omit to keep the current key. */
  @ApiPropertyOptional() @IsOptional() @IsString() llmApiKey?: string;
  /** Set true to remove the stored API key (falls back to env). */
  @ApiPropertyOptional() @IsOptional() @IsBoolean() clearApiKey?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  models?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() modelOverride?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(20) maxIterations?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(120) pendingTtlMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(1000) rateLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1000) rateWindowMs?: number;
}
