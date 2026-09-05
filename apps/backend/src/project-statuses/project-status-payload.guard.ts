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
 * Finding R33, the reorder half — the route a drag-and-drop client is most
 * likely to post a degenerate body to.
 *
 * `ProjectPermissionGuard` resolves this route from `body.items[0].id`; when
 * that is absent it threw *403 "Project context could not be resolved"*, so
 * `{items: []}`, `{}` and a non-array all answered a permission error and a
 * client-side typo was indistinguishable from a genuine denial.
 *
 * Declared BEFORE `ProjectPermissionGuard` on the controller, this guard turns
 * every unusable SHAPE into a 400 naming the offending key, and leaves every
 * well-formed request to the permission guard, which still answers 403.
 */
@Injectable()
export class ProjectStatusPayloadGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<ProjectPermissionMetadata>(
      PROJECT_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!meta) return true;

    const req = context.switchToHttp().getRequest();

    if (meta.from === 'body') {
      const value = req.body?.[meta.key];
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw new BadRequestException(`${meta.key} must be a UUID`);
      }
      return true;
    }

    if (meta.from === 'statusItems') {
      const items = req.body?.items;
      if (!Array.isArray(items)) {
        throw new BadRequestException('items must be an array');
      }
      if (items.length === 0) {
        throw new BadRequestException('items must contain at least one entry');
      }
      const firstId = items[0]?.id;
      if (typeof firstId !== 'string' || !UUID_RE.test(firstId)) {
        throw new BadRequestException('items.0.id must be a UUID');
      }
      return true;
    }

    return true;
  }
}
