import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AssetsModule } from '../assets/assets.module';
import { LettersModule } from '../letters/letters.module';
import { WorkplaceHubController } from './workplace-hub.controller';
import { WorkplaceHubService } from './workplace-hub.service';

/**
 * The Workplace hub reads across the asset register and the letter desk.
 */
@Module({
  imports: [PrismaModule, AssetsModule, LettersModule],
  controllers: [WorkplaceHubController],
  providers: [WorkplaceHubService],
  exports: [WorkplaceHubService],
})
export class WorkplaceModule {}
