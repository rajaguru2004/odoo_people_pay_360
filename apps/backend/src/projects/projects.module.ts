import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectRbacModule } from './rbac/project-rbac.module';
import { ProjectRolesController } from './rbac/project-roles.controller';
import { ProjectRolesService } from './rbac/project-roles.service';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, ProjectRbacModule, MailModule, NotificationsModule],
  controllers: [ProjectsController, ProjectRolesController],
  providers: [ProjectsService, ProjectRolesService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
