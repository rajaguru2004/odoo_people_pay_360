import { Module } from '@nestjs/common';
import { TaskCommentsController } from './task-comments.controller';
import { TaskCommentsService } from './task-comments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectRbacModule } from '../projects/rbac/project-rbac.module';

@Module({
  imports: [PrismaModule, ProjectRbacModule],
  controllers: [TaskCommentsController],
  providers: [TaskCommentsService],
  exports: [TaskCommentsService],
})
export class TaskCommentsModule {}
