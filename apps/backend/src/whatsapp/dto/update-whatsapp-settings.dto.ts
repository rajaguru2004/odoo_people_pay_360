import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Length,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { INTERACTIVE_MODES } from '../whatsapp.types';
import { VERIFICATION_MODE } from '../../common/verification/verification.types';

/**
 * Admin settings write payload.
 *
 * `apiKey` is write-only: it is encrypted on write and never read back. The read
 * projection (WhatsAppPublicConfig) exposes only `apiKeyConfigured` and
 * `apiKeyMasked`, so a client can tell whether a key is set without learning it.
 */
export class UpdateWhatsAppSettingsDto {
  @ApiPropertyOptional({ description: 'Master kill switch. Off = nothing is ever sent.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 'https://whatsapp.example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'Evolution instance name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  instanceName?: string;

  @ApiPropertyOptional({ description: 'Write-only. Encrypted at rest, never returned.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @ApiPropertyOptional({ description: 'Delete the stored key instead of replacing it.' })
  @IsOptional()
  @IsBoolean()
  clearApiKey?: boolean;

  @ApiPropertyOptional({ description: 'Ops alert recipient, E.164 or bare digits.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  adminNumber?: string;

  @ApiPropertyOptional({ description: 'ISO-3166 alpha-2 fallback when a branch has no country.' })
  @IsOptional()
  @IsString()
  @Length(0, 2)
  defaultRegion?: string;

  @ApiPropertyOptional({ description: 'Base URL used to build deep links in messages.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  appBaseUrl?: string;

  @ApiPropertyOptional({
    description:
      'Public base address of THIS API as the WhatsApp service sees it, e.g. ' +
      'https://api.hrm.example.com. The inbound callback URL is derived from it. ' +
      'Not the portal address — the two are different hosts in every deployment here.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  publicApiUrl?: string;

  @ApiPropertyOptional({ description: 'Minimum gap between two sends, ms. Anti-ban throttle.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60_000)
  minGapMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  maxPerMinute?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(120_000)
  timeoutMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;

  @ApiPropertyOptional({ description: 'Require explicit consent before delivering.' })
  @IsOptional()
  @IsBoolean()
  requireOptIn?: boolean;

  @ApiPropertyOptional({ description: 'Require the number to exist on WhatsApp before delivering.' })
  @IsOptional()
  @IsBoolean()
  requireVerified?: boolean;

  @ApiPropertyOptional({ description: 'Allow untemplated notifications through as plain text.' })
  @IsOptional()
  @IsBoolean()
  allowGenericFallback?: boolean;

  @ApiPropertyOptional({
    description:
      'Template keys the admin has switched off. Send the full list; omitting the field leaves it unchanged. Unknown keys are dropped.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  disabledTemplates?: string[];

  @ApiPropertyOptional({ description: 'Render and queue, but mark SKIPPED instead of sending.' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({ description: 'Accept and act on incoming WhatsApp messages.' })
  @IsOptional()
  @IsBoolean()
  inboundEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Allow employees to link a number themselves.' })
  @IsOptional()
  @IsBoolean()
  enrollmentEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Allow actions that change data. Off = read-only pilot mode.',
  })
  @IsOptional()
  @IsBoolean()
  mutationsEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Allow approving/rejecting requests from WhatsApp.' })
  @IsOptional()
  @IsBoolean()
  approvalsEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Require a PIN before showing pay or balances.' })
  @IsOptional()
  @IsBoolean()
  requirePinForSensitive?: boolean;

  @ApiPropertyOptional({
    description:
      'How long Approve / Reject buttons on a notification stay usable, in minutes. ' +
      'An approval arriving in the evening should still be tappable next morning.',
    minimum: 5,
    maximum: 20160,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(20160)
  approvalTokenTtlMinutes?: number;

  // ─────────────────────────────────────────────────────────── rate ceilings
  // Guards against a runaway client, not a ration on an employee. 0 = no limit.

  @ApiPropertyOptional({
    description:
      'Inbound messages accepted from one phone per 5 minutes. 0 = unlimited. ' +
      'Flood protection for UNIDENTIFIED senders — it runs before we know who they are.',
    minimum: 0,
    maximum: 100000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  ratePerPhone5Min?: number;

  @ApiPropertyOptional({
    description: 'Messages accepted from one linked employee per hour. 0 = unlimited.',
    minimum: 0,
    maximum: 100000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  ratePerUserHour?: number;

  @ApiPropertyOptional({
    description:
      'Changes (check in/out, requests) one employee may make per 10 minutes. 0 = unlimited.',
    minimum: 0,
    maximum: 100000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  rateMutations10Min?: number;

  @ApiPropertyOptional({
    description:
      "How much of a reply is tappable. 'auto' = a sectioned menu list plus buttons for " +
      "confirmations, falling back to text. 'buttons' = never a list, the recovery setting " +
      "if list rendering regresses. 'poll' = menus as native polls, which render on personal " +
      "accounts too. 'text' = nothing tappable.",
    enum: INTERACTIVE_MODES,
  })
  @IsOptional()
  @IsIn(INTERACTIVE_MODES as unknown as string[])
  interactiveMode?: string;

  @ApiPropertyOptional({
    description:
      'How attendance is verified over WhatsApp when face-only attendance is on. ' +
      "OFF = attendance cannot be recorded from chat. IDENTITY_ONLY = the linked number " +
      'is accepted as identity proof. SELFIE_IN_CHAT = the employee sends a photo, matched ' +
      'against their registered face; this proves the photo is of them but cannot prove ' +
      'they took it just now. SECURE_LINK = a one-time link captures a live camera frame ' +
      'and location in one step.',
    enum: Object.values(VERIFICATION_MODE),
  })
  @IsOptional()
  @IsIn(Object.values(VERIFICATION_MODE))
  attendanceVerification?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Superseded by attendanceVerification. Still accepted, and still read when no ' +
      'verification mode has been stored, so an existing install keeps its behaviour.',
  })
  @IsOptional()
  @IsBoolean()
  attendanceFaceOverride?: boolean;

  @ApiPropertyOptional({
    description: 'Accepted selfie punches per employee per day.',
    minimum: 1,
    maximum: 50,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  selfieDailyCap?: number;

  @ApiPropertyOptional({
    description: 'How long a photo has to arrive after the bot asks for one, in seconds.',
    minimum: 30,
    maximum: 900,
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(900)
  selfieChallengeSeconds?: number;

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
    description:
      'Who to point somebody at when the bot cannot help — a name, a number or an email. ' +
      'Shown only after several unrecognised messages in a row.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supportContact?: string;

  @ApiPropertyOptional({
    description:
      'Start of quiet hours, HH:MM. Outbound updates are HELD until the window ends, never ' +
      'dropped. Replies to somebody who messaged you are never held. Empty disables it.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^$|^([01]\d|2[0-3]):[0-5]\d$/, { message: 'quietHoursStart must be HH:MM or empty' })
  quietHoursStart?: string;

  @ApiPropertyOptional({ description: 'End of quiet hours, HH:MM. Empty disables it.' })
  @IsOptional()
  @IsString()
  @Matches(/^$|^([01]\d|2[0-3]):[0-5]\d$/, { message: 'quietHoursEnd must be HH:MM or empty' })
  quietHoursEnd?: string;

  @ApiPropertyOptional({
    description: 'Template keys that go out during quiet hours anyway.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(60)
  quietHoursOverrideTemplates?: string[];

  @ApiPropertyOptional({
    description: 'Action keys switched off. Send the full list; omitting leaves it unchanged.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  actionDenylist?: string[];

  @ApiPropertyOptional({
    description:
      'Test recipient. While set, EVERY message goes to this number instead of the employee, ' +
      'and the opt-in / verified checks are skipped because no employee can be reached. ' +
      'Send an empty string to clear it.',
    example: '+919952982836',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  redirectAllTo?: string;

  @ApiPropertyOptional({
    description:
      'Reach employees on the number already held on their HR record, without each of them ' +
      'opting in first. This is the admin-governed model: switching the channel on is the ' +
      'decision. Someone who has explicitly opted out is never re-enrolled.',
  })
  @IsOptional()
  @IsBoolean()
  autoEnroll?: boolean;

  @ApiPropertyOptional({
    description:
      'Carbon copy: send one EXTRA copy of every message to a watcher, without taking ' +
      'delivery away from the employee. A copy is also emitted for a recipient the system ' +
      'could not reach, which is what makes it useful for diagnosing "nobody got anything".',
  })
  @IsOptional()
  @IsBoolean()
  carbonCopyEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Watcher number for the carbon copy. Send an empty string to clear it.',
    example: '+917603941558',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  carbonCopyTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays?: number;

  @ApiPropertyOptional({ description: 'Queued rows older than this are dropped, not sent late.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  staleHours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  drainBatchSize?: number;
}
