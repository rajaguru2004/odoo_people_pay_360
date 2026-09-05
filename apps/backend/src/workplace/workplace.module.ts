import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AssetsModule } from '../assets/assets.module';
import { LettersModule } from '../letters/letters.module';
import { WorkplaceHubController } from './workplace-hub.controller';
import { WorkplaceHubService } from './workplace-hub.service';

/**
 * The Workplace hub reads across the asset register, the letter desk and the
 * project tracker.
 *
 * `ProjectsModule` is deliberately NOT imported. `ProjectsService.getStats`
 * returns four of the five statuses and takes a `user` to build a visibility
 * predicate this route does not need — it is ADMIN/HR_MANAGER only, where that
 * predicate is the identity. Importing the module to then not use the one
 * method it offers would be misleading, so the project counts are read through
 * Prisma with the same base predicate `buildWhere` applies for those two roles.
 */
@Module({
  imports: [PrismaModule, AssetsModule, LettersModule],
  controllers: [WorkplaceHubController],
  providers: [WorkplaceHubService],
  exports: [WorkplaceHubService],
})
export class WorkplaceModule {}
