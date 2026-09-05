import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProjectAccessService } from './project-access.service';
import {
  PROJECT_PERMISSION_KEY,
  ProjectPermissionMetadata,
} from './require-project-permission.decorator';

@Injectable()
export class ProjectPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ProjectAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<ProjectPermissionMetadata>(
      PROJECT_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No project-permission requirement on this route → not our concern.
    if (!meta) return true;

    const req = context.switchToHttp().getRequest();

    /**
     * Finding R7 — a request may be about MORE THAN ONE project. A workflow
     * status is shared by every project on its workflow, so the guard resolves
     * all of them and demands the permission on each: authority over a shared
     * object is the intersection of its owners' authorities, never the union.
     * Every other source still resolves to exactly one project, so this loop
     * runs once and behaves as before.
     */
    const projectIds = await this.access.resolveProjectIds(
      meta.from,
      meta.key,
      req,
    );
    if (!projectIds || projectIds.length === 0) {
      // `next` routes are ones whose handler already answers this case better
      // (404 for an absent task, 400 from the ValidationPipe). See
      // ProjectPermissionOnMissing.
      if (meta.onMissing === 'next') return true;
      throw new ForbiddenException('Project context could not be resolved');
    }
    const shared = projectIds.length > 1;

    let firstAccess = null as Awaited<
      ReturnType<typeof this.access.getAccess>
    > | null;

    for (const projectId of projectIds) {
      const access = await this.access.getAccess(projectId, req.user);
      if (!firstAccess) firstAccess = access;

      const isMember =
        access.isGlobalAdmin || access.isOwner || access.roleSlug !== null;

      if (meta.permissions.length === 0) {
        // Membership-only check — any project member, owner, or global admin.
        // Finding R51: on a READ door (`meta.visibility`) an INTERNAL or PUBLIC
        // project is readable by any authenticated user, because that is what
        // those visibilities mean and what the LIST has always shown. PRIVATE
        // is untouched, and no write door sets this flag.
        if (!isMember) {
          if (
            meta.visibility &&
            (await this.access.isReadableByVisibility(projectId))
          ) {
            continue;
          }
          throw new ForbiddenException('You must be a member of this project');
        }
      } else {
        const ok = meta.permissions.every((p) => access.permissions.includes(p));
        if (!ok) {
          throw new ForbiddenException(
            shared
              ? 'This workflow is shared with other projects. Managing a shared ' +
                'status column requires the same permission on every project ' +
                'that uses the workflow.'
              : 'You do not have permission to perform this action in this project',
          );
        }
      }
    }

    // Expose for downstream handlers/services if needed. On a shared workflow
    // this is the access for the first governing project; every other one
    // cleared the same bar to get here.
    req.projectAccess = firstAccess;
    return true;
  }
}
