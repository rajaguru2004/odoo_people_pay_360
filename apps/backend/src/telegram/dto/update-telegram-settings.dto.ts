import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * `botToken` and `webhookSecret` are write-only: encrypted on write, never read
 * back. The read projection exposes only `*Configured` booleans and a masked
 * hint.
 */
export class UpdateTelegramSettingsDto {
  @ApiPropertyOptional({ description: 'Master switch. Off = nothing is sent.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Write-only. Encrypted at rest, never returned.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  botToken?: string;

  @ApiPropertyOptional({ description: 'Delete the stored token instead of replacing it.' })
  @IsOptional()
  @IsBoolean()
  clearBotToken?: boolean;

  @ApiPropertyOptional({ description: 'Accept updates on the Telegram webhook.' })
  @IsOptional()
  @IsBoolean()
  inboundEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Write-only. Handed to Telegram as secret_token; it echoes the value back on every ' +
      'update. Leave unset and POST /telegram/webhook/register to have one generated.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  webhookSecret?: string;

  @ApiPropertyOptional({ description: 'Let employees link their own Telegram account.' })
  @IsOptional()
  @IsBoolean()
  linkingEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Deliver ESS notifications as Telegram messages.' })
  @IsOptional()
  @IsBoolean()
  notificationsEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Ops group that receives login alerts. Negative id for a group/supergroup.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  alertChatId?: string;

  @ApiPropertyOptional({ description: 'Post a message to the alert chat on every login.' })
  @IsOptional()
  @IsBoolean()
  loginAlertsEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Also alert on failed logins (rate-limited per IP).' })
  @IsOptional()
  @IsBoolean()
  loginAlertFailures?: boolean;

  @ApiPropertyOptional({
    description:
      'Resolve the login IP to a country/city/ISP. Sends the IP to a third-party service.',
  })
  @IsOptional()
  @IsBoolean()
  loginAlertGeo?: boolean;

  @ApiPropertyOptional({ description: 'Geolocation endpoint. `{ip}` is substituted.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  geoLookupUrl?: string;

  @ApiPropertyOptional({
    description: 'CSV of roles to alert on, e.g. "ADMIN,HR_MANAGER". Empty = every role.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  loginAlertRoles?: string;

  @ApiPropertyOptional({
    description: 'Per-IP hourly cap on failed-login alerts, so the group cannot be spammed.',
    minimum: 1,
    maximum: 1000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  loginAlertFailureMaxPerHour?: number;

  @ApiPropertyOptional({
    description: 'Test recipient. While set, EVERY message goes to this chat id instead.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  redirectAllTo?: string;

  @ApiPropertyOptional({ description: 'How long sent rows are kept.', minimum: 1, maximum: 3650 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays?: number;
}
