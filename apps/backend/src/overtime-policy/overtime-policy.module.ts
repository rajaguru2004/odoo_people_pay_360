import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { OvertimePolicyController } from './overtime-policy.controller';
import { OvertimePolicyService } from './overtime-policy.service';

@Module({
  imports: [PrismaModule, SystemSettingsModule],
  controllers: [OvertimePolicyController],
  providers: [OvertimePolicyService],
  exports: [OvertimePolicyService],
})
export class OvertimePolicyModule {}
