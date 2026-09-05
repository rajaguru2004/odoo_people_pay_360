import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SupervisorsService } from './supervisors.service';
import { SupervisorsController } from './supervisors.controller';

@Module({
  imports: [PrismaModule, AuditModule, NotificationsModule],
  controllers: [SupervisorsController],
  providers: [SupervisorsService],
  exports: [SupervisorsService],
})
export class SupervisorsModule {}
