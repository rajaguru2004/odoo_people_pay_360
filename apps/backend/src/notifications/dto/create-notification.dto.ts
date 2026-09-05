import { IsString, IsOptional, IsEnum, IsUUID, IsObject, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { NotificationDecision } from '../notification-channel.sink';

export enum NotificationType {
  INFO = 'INFO',
  SUCCESS = 'SUCCESS',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  LEAVE_APPROVED = 'LEAVE_APPROVED',
  LEAVE_REJECTED = 'LEAVE_REJECTED',
  OVERTIME_APPROVED = 'OVERTIME_APPROVED',
  OVERTIME_REJECTED = 'OVERTIME_REJECTED',
  PAYROLL_GENERATED = 'PAYROLL_GENERATED',
  CONTRACT_EXPIRING = 'CONTRACT_EXPIRING',
  REWARD_RECEIVED = 'REWARD_RECEIVED',
  DISCIPLINE_ISSUED = 'DISCIPLINE_ISSUED',
  VISA_EXPIRING = 'VISA_EXPIRING',
  VISA_EXPIRED = 'VISA_EXPIRED',
  VISA_RENEWED = 'VISA_RENEWED',
  SUPERVISOR_ASSIGNED = 'SUPERVISOR_ASSIGNED',
  SUPERVISOR_UNASSIGNED = 'SUPERVISOR_UNASSIGNED',
  APPROVAL_REQUESTED = 'APPROVAL_REQUESTED',
  APPROVAL_STEP_APPROVED = 'APPROVAL_STEP_APPROVED',
  APPROVAL_REJECTED = 'APPROVAL_REJECTED',
  // Already emitted by bank-change.service.ts; `type` is a free-text VarChar(50)
  // in the database, so declaring them here needs no migration.
  BANK_CHANGE_APPROVED = 'BANK_CHANGE_APPROVED',
  BANK_CHANGE_REJECTED = 'BANK_CHANGE_REJECTED',
}

export class CreateNotificationDto {
  @ApiProperty({ description: 'User ID to receive notification' })
  @IsUUID()
  userId: string;

  @ApiProperty({
    description: 'Notification title',
    example: 'Leave Request Approved',
  })
  @IsString()
  title: string;

  @ApiProperty({
    description: 'Notification message',
    example: 'Your leave request has been approved',
  })
  @IsString()
  message: string;

  @ApiPropertyOptional({
    enum: NotificationType,
    default: NotificationType.INFO,
  })
  @IsEnum(NotificationType)
  @IsOptional()
  type?: NotificationType;

  @ApiPropertyOptional({
    description: 'Link to related resource',
    example: '/dashboard/leaves/123',
  })
  @IsString()
  @IsOptional()
  link?: string;

  // ---------------------------------------------------------------- WhatsApp
  // The three fields below are TRANSIENT. NotificationsService reads them to
  // decide whether to tee this notification to WhatsApp and never writes them
  // to Prisma. They exist here rather than as a separate call so that the ~60
  // existing notification call sites can opt in with one extra property.

  /**
   * Explicit WhatsApp template key from templates/whatsapp-template.registry.ts.
   * Required for any site that passes a generic INFO/SUCCESS/WARNING type,
   * which is most of them. No template resolved = no WhatsApp message.
   */
  @ApiPropertyOptional({ description: 'Transient. WhatsApp template key.' })
  @IsString()
  @IsOptional()
  waTemplate?: string;

  /** Structured context for the WhatsApp template. Transient. */
  @ApiPropertyOptional({ description: 'Transient. Template data for WhatsApp.' })
  @IsObject()
  @IsOptional()
  waData?: Record<string, unknown>;

  /** Opt this one notification out of WhatsApp entirely. Transient. */
  @ApiPropertyOptional({ description: 'Transient. Skip the WhatsApp channel.' })
  @IsBoolean()
  @IsOptional()
  suppressWhatsApp?: boolean;

  /**
   * Idempotency key for the WhatsApp outbox. Callers that already have a stable
   * identity for the event (e.g. the reminders engine) should pass one; others
   * get a content hash bucketed by hour. Transient.
   */
  @ApiPropertyOptional({ description: 'Transient. WhatsApp outbox dedupe key.' })
  @IsString()
  @IsOptional()
  waDedupeKey?: string;

  /**
   * What this notification is asking the recipient to DECIDE. Transient.
   *
   * Carries no authority — see NotificationDecision. Channels that can render
   * a tappable decision mint their own capability from it; channels that
   * cannot simply ignore it and send the link as before.
   */
  @ApiPropertyOptional({ description: 'Transient. Approve/reject subject.' })
  @IsObject()
  @IsOptional()
  decision?: NotificationDecision;
}

/** Optional trailing argument for notifyUser / notifyUsers. */
export interface NotifyOptions {
  waTemplate?: string;
  waData?: Record<string, unknown>;
  suppressWhatsApp?: boolean;
  waDedupeKey?: string;
  decision?: NotificationDecision;
}
