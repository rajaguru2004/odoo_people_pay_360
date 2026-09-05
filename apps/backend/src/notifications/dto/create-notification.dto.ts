import { IsString, IsOptional, IsEnum, IsUUID, IsObject } from 'class-validator';
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

  /**
   * What this notification is asking the recipient to DECIDE.
   *
   * TRANSIENT: NotificationsService reads it when teeing to delivery channels
   * and never writes it to Prisma.
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
  decision?: NotificationDecision;
}
