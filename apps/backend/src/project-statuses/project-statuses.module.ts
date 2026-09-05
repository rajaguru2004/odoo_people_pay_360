import { Module } from '@nestjs/common';
import { ProjectStatusesController } from './project-statuses.controller';
import { ProjectStatusesService } from './project-statuses.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectRbacModule } from '../projects/rbac/project-rbac.module';

@Module({
  imports: [PrismaModule, ProjectRbacModule],
  controllers: [ProjectStatusesController],
  providers: [ProjectStatusesService],
  exports: [ProjectStatusesService],
})
export class ProjectStatusesModule {}
