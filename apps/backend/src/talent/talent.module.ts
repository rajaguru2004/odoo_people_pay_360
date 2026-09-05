import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { GrievancesModule } from '../grievances/grievances.module';
import { TrainingModule } from '../training/training.module';
import { AppraisalModule } from '../appraisal/appraisal.module';
import { TalentHubController } from './talent-hub.controller';
import { TalentHubService } from './talent-hub.service';

/**
 * The Talent hub reads across grievances, training, appraisal, rewards and
 * disciplines.
 *
 * Rewards and disciplines are read through Prisma directly rather than through
 * their services: `RewardsService.findAll` / `DisciplinesService.findAll` take
 * an `employeeId` and a page, and no date range at all, so there is nothing
 * there to reuse for a windowed count. Importing those modules to then not use
 * them would be misleading.
 */
@Module({
  imports: [PrismaModule, GrievancesModule, TrainingModule, AppraisalModule],
  controllers: [TalentHubController],
  providers: [TalentHubService],
  exports: [TalentHubService],
})
export class TalentModule {}
