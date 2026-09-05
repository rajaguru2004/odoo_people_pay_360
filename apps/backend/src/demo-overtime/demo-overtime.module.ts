import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OvertimeModule } from '../overtime/overtime.module';
import { PayrollsModule } from '../payrolls/payrolls.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { DemoOvertimeService } from './demo-overtime.service';

/**
 * Singapore Overtime → Payroll demo seed. Depends on OvertimeModule (real
 * request classification), PayrollsModule (payroll generation) and
 * HolidaysModule (branch working-days), so it lives in its own module —
 * mirroring SampleDataModule — to avoid circular deps.
 */
@Module({
  imports: [PrismaModule, OvertimeModule, PayrollsModule, HolidaysModule],
  providers: [DemoOvertimeService],
  exports: [DemoOvertimeService],
})
export class DemoOvertimeModule {}
