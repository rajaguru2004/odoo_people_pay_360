import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { TrainingService } from './training.service';
import { TrainingController } from './training.controller';

/**
 * Nominations run through the shared approval engine, which already registers
 * TRAINING as a governable request type. With no chain configured the engine
 * reports `engaged: false` and this module settles the nomination itself.
 */
@Module({
  imports: [ApprovalsModule],
  controllers: [TrainingController],
  providers: [TrainingService],
  exports: [TrainingService],
})
export class TrainingModule {}
