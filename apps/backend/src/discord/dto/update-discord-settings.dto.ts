import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { VERIFICATION_MODE } from '../../common/verification/verification.types';

/**
 * `botToken` is write-only: encrypted on write, never read back. The read
 * projection exposes only `botTokenConfigured` and a masked hint.
 */
export class UpdateDiscordSettingsDto {
  @ApiPropertyOptional({ description: 'Master switch. Off = nothing is sent.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Application ID. Not secret.' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  applicationId?: string;

  @ApiPropertyOptional({ description: 'Public key used to verify Discord signatures. Not secret.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  publicKey?: string;

  @ApiPropertyOptional({ description: 'Write-only. Encrypted at rest, never returned.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  botToken?: string;

  @ApiPropertyOptional({ description: 'Delete the stored token instead of replacing it.' })
  @IsOptional()
  @IsBoolean()
  clearBotToken?: boolean;

  @ApiPropertyOptional({ description: 'Accept slash commands from Discord.' })
  @IsOptional()
  @IsBoolean()
  inboundEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Allow commands that change data. Off = read-only pilot.' })
  @IsOptional()
  @IsBoolean()
  mutationsEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Let employees link their own Discord account.' })
  @IsOptional()
  @IsBoolean()
  linkingEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Deliver ESS notifications as Discord DMs.' })
  @IsOptional()
  @IsBoolean()
  notificationsEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Optional channel to mirror notifications into, mentioning the employee.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  announceChannelId?: string;

  @ApiPropertyOptional({
    description:
      'How attendance is verified over Discord when face-only attendance is on. See the ' +
      'WhatsApp equivalent for what each mode proves.',
    enum: Object.values(VERIFICATION_MODE),
  })
  @IsOptional()
  @IsIn(Object.values(VERIFICATION_MODE))
  attendanceVerification?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Superseded by attendanceVerification. Read only when no verification mode is stored.',
  })
  @IsOptional()
  @IsBoolean()
  attendanceFaceOverride?: boolean;

  @ApiPropertyOptional({
    description: 'How long a one-time verification link stays usable, in minutes.',
    minimum: 2,
    maximum: 60,
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(60)
  verificationLinkTtlMinutes?: number;

  @ApiPropertyOptional({
    description: 'Test recipient. While set, EVERY DM goes to this Discord user id instead.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  redirectAllTo?: string;
}
