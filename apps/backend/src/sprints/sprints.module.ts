import { Module } from '@nestjs/common';
import { SprintsController } from './sprints.controller';
import { SprintsService } from './sprints.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectRbacModule } from '../projects/rbac/project-rbac.module';

@Module({
  imports: [PrismaModule, ProjectRbacModule],
  controllers: [SprintsController],
  providers: [SprintsService],
  exports: [SprintsService],
})
export class SprintsModule {}
