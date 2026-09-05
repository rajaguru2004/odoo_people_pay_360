import { Module } from '@nestjs/common';
import { PayrollAnalyticsController } from './payroll-analytics.controller';
import { PayrollAnalyticsService } from './payroll-analytics.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PayrollAnalyticsController],
  providers: [PayrollAnalyticsService],
  exports: [PayrollAnalyticsService],
})
export class PayrollAnalyticsModule {}
