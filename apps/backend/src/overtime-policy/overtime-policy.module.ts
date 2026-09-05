import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OvertimePolicyService } from './overtime-policy.service';
import { OvertimePolicyController } from './overtime-policy.controller';

@Module({
  imports: [PrismaModule, SystemSettingsModule, NotificationsModule],
  controllers: [OvertimePolicyController],
  providers: [OvertimePolicyService],
  exports: [OvertimePolicyService],
})
export class OvertimePolicyModule {}
