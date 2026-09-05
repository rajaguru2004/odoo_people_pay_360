import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BankService } from './bank.service';
import { BankChangeService } from './bank-change.service';
import { BankingConfigService } from './banking-config.service';
import { BankController } from './bank.controller';
import { BankChangeController } from './bank-change.controller';
import { BankingConfigController } from './banking-config.controller';

@Module({
  imports: [PrismaModule, AuditModule, NotificationsModule, ApprovalsModule],
  controllers: [BankController, BankChangeController, BankingConfigController],
  providers: [BankService, BankChangeService, BankingConfigService],
  exports: [BankService, BankChangeService, BankingConfigService],
})
export class BankDetailsModule {}
