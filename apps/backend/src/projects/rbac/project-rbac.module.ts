import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectAccessService } from './project-access.service';
import { ProjectPermissionGuard } from './project-permission.guard';

/**
 * Shared module exposing project-scoped RBAC primitives.
 * Imported by every module whose controllers use @RequireProjectPermission.
 */
@Module({
  imports: [PrismaModule],
  providers: [ProjectAccessService, ProjectPermissionGuard],
  exports: [ProjectAccessService, ProjectPermissionGuard],
})
export class ProjectRbacModule {}
