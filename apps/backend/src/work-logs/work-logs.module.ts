import { Module } from '@nestjs/common';
import { WorkLogsController } from './work-logs.controller';
import { WorkLogsService } from './work-logs.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectRbacModule } from '../projects/rbac/project-rbac.module';

@Module({
  imports: [PrismaModule, ProjectRbacModule],
  controllers: [WorkLogsController],
  providers: [WorkLogsService],
  exports: [WorkLogsService],
})
export class WorkLogsModule {}
