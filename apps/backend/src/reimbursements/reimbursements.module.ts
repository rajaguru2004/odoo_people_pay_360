import { Module } from '@nestjs/common';
import { ReimbursementsController } from './reimbursements.controller';
import { ReimbursementsService } from './reimbursements.service';
import { ReimbursementAttachmentsController } from './reimbursement-attachments.controller';
import { ReimbursementAttachmentsService } from './reimbursement-attachments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    SystemSettingsModule,
    NotificationsModule,
    StorageModule,
  ],
  controllers: [ReimbursementsController, ReimbursementAttachmentsController],
  providers: [ReimbursementsService, ReimbursementAttachmentsService],
  exports: [ReimbursementsService, ReimbursementAttachmentsService],
})
export class ReimbursementsModule {}
