import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PROJECT_PERMISSION_KEY,
  ProjectPermissionMetadata,
} from '../projects/rbac/require-project-permission.decorator';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Finding R33 — guards run before pipes, so a payload problem used to surface as
 * a permission error: `POST /sprints` with no `projectId` answered
 * *403 "Project context could not be resolved"* and never reached `@IsUUID()`.
 *
 * This guard is declared BEFORE `ProjectPermissionGuard` on the controller, so
 * it gets the first look at the body. It answers 400 for the shapes that cannot
 * possibly carry a project context — absent, non-string, or not a uuid — and
 * stays out of the way otherwise. A well-formed id that simply resolves to
 * nothing the caller may touch is still a genuine denial, and still 403.
 */
@Injectable()
export class SprintPayloadGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<ProjectPermissionMetadata>(
      PROJECT_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!meta || meta.from !== 'body') return true;

    const req = context.switchToHttp().getRequest();
    const value = req.body?.[meta.key];
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new BadRequestException(`${meta.key} must be a UUID`);
    }
    return true;
  }
}
