import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { RemindersService } from './reminders.service';
import { RemindersScheduler } from './reminders.scheduler';
import { REMINDER_SOURCES } from './reminder-source';
import { LegalDocumentReminderSource } from './sources/legal-document-reminder.source';
import { ContractReminderSource } from './sources/contract-reminder.source';
import { AssetWarrantyReminderSource } from './sources/asset-warranty-reminder.source';
import { TrainingCertificateReminderSource } from './sources/training-certificate-reminder.source';

/**
 * Registering a new expiring entity:
 *   1. add `sources/<thing>-reminder.source.ts` implementing `ReminderSource`
 *   2. add the class to `providers` and to the `REMINDER_SOURCES` factory below
 *
 * Sources read Prisma directly rather than going through their domain service.
 * They are read-only projections, and it keeps the module graph a tree — a
 * source living in its domain module would make that module and this one
 * mutually dependent.
 */
@Module({
  imports: [
    PrismaModule,
    MailModule,
    NotificationsModule,
    SystemSettingsModule,
    TimezoneModule,
  ],
  providers: [
    RemindersService,
    RemindersScheduler,
    LegalDocumentReminderSource,
    ContractReminderSource,
    AssetWarrantyReminderSource,
    TrainingCertificateReminderSource,
    {
      provide: REMINDER_SOURCES,
      useFactory: (...sources: unknown[]) => sources,
      inject: [
        LegalDocumentReminderSource,
        ContractReminderSource,
        AssetWarrantyReminderSource,
        TrainingCertificateReminderSource,
      ],
    },
  ],
  exports: [RemindersService],
})
export class RemindersModule {}
