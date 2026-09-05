import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { DashboardAlertService } from './dashboard-alert.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TimezoneModule } from '../common/timezone/timezone.module';

@Module({
  imports: [PrismaModule, TimezoneModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardAlertService],
  exports: [DashboardService, DashboardAlertService],
})
export class DashboardModule {}
