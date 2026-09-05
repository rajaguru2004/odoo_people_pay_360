import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProjectRbacModule } from '../projects/rbac/project-rbac.module';
import { WorkLogsModule } from '../work-logs/work-logs.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [PrismaModule, NotificationsModule, ProjectRbacModule, WorkLogsModule, MailModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
