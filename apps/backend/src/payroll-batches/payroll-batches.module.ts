import { Module } from '@nestjs/common';
import { PayrollBatchesController } from './payroll-batches.controller';
import { PayrollBatchesService } from './payroll-batches.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PayrollBatchesController],
  providers: [PayrollBatchesService],
  exports: [PayrollBatchesService],
})
export class PayrollBatchesModule {}
