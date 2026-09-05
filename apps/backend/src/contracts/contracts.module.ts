import { DeductionCarryForwardModule } from '../payrolls/deduction-carry-forward.module';
import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ContractValidationService } from './contract-validation.service';
import { ContractHistoryService } from './contract-history.service';
import { TerminationRequestService } from './termination-request.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { AssetsModule } from '../assets/assets.module';
import { TimezoneModule } from '../common/timezone/timezone.module';

@Module({
  imports: [DeductionCarryForwardModule, 
    PrismaModule,
    MailModule,
    NotificationsModule,
    SystemSettingsModule,
    TimezoneModule,
    // ClearanceService — offboarding is blocked while assets are still held.
    AssetsModule,
  ],
  controllers: [ContractsController],
  providers: [
    ContractsService,
    ContractValidationService,
    ContractHistoryService,
    TerminationRequestService,
  ],
  exports: [
    ContractsService,
    ContractValidationService,
    ContractHistoryService,
    TerminationRequestService,
  ],
})
export class ContractsModule {}
