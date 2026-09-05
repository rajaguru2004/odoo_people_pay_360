import { Module } from '@nestjs/common';
import { TaskDashboardController } from './task-dashboard.controller';
import { TaskDashboardService } from './task-dashboard.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TaskDashboardController],
  providers: [TaskDashboardService],
  exports: [TaskDashboardService],
})
export class TaskDashboardModule {}
