import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GrievancesController } from './grievances.controller';
import { GrievancesService } from './grievances.service';

/**
 * The complement to Disciplines: warnings flow HR→employee, grievances flow
 * employee→HR. Deliberately not on the approval engine — a grievance is a case
 * with a handler and a trail, not a chain of approvers.
 */
@Module({
  imports: [PrismaModule, AuditModule, NotificationsModule],
  controllers: [GrievancesController],
  providers: [GrievancesService],
  exports: [GrievancesService],
})
export class GrievancesModule {}
