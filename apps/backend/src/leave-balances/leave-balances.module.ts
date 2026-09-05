import { Module } from '@nestjs/common';
import { LeaveBalancesService } from './leave-balances.service';
import { LeaveBalancesController } from './leave-balances.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { TimezoneModule } from '../common/timezone/timezone.module';

@Module({
  imports: [PrismaModule, TimezoneModule],
  controllers: [LeaveBalancesController],
  providers: [LeaveBalancesService],
  exports: [LeaveBalancesService],
})
export class LeaveBalancesModule {}
