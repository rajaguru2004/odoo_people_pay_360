import { SetMetadata } from '@nestjs/common';
import { ProjectPermission } from './permissions.constants';
import { ProjectIdSource } from './project-access.service';

export const PROJECT_PERMISSION_KEY = 'project_permission';

/**
 * What the guard does when it cannot work out which project a request is about
 * — no id supplied, a malformed one, a row that does not exist, or an entity
 * that carries no project at all.
 *
 *  · `deny`  (default) — 403. The safe answer wherever the id is the subject of
 *    the request and its absence can only mean a bad call.
 *  · `next`  — hand the request on. Used where the HANDLER already refuses the
 *    same case with a better message (404 "Task not found", 400 from the
 *    ValidationPipe), so denying here would replace a real answer with a
 *    permission error. Nothing project-scoped is exposed by it: with no project
 *    resolved there is nothing for the guard to protect, and the handler's own
 *    rules still run.
 */
export type ProjectPermissionOnMissing = 'deny' | 'next';

export interface RequireProjectPermissionOptions {
  /** Where to find the project id in the request. Default: param 'id'. */
  from?: ProjectIdSource;
  /** The param/body key holding the id (or entity id for lookups). */
  key?: string;
  /** Behaviour when no project can be resolved. Default: 'deny'. */
  onMissing?: ProjectPermissionOnMissing;
}

export interface ProjectPermissionMetadata {
  permissions: ProjectPermission[];
  from: ProjectIdSource;
  key: string;
  onMissing: ProjectPermissionOnMissing;
  /**
   * READ doors only. When set, a non-member is still admitted if the project's
   * `visibility` is INTERNAL or PUBLIC — see `RequireProjectRead` and finding
   * R51. Never set on a route that writes.
   */
  visibility: boolean;
}

/**
 * Require one or more project-scoped permissions on the resolved project.
 * Enforced by ProjectPermissionGuard. Global admins and the project owner bypass.
 */
export const RequireProjectPermission = (
  permissions: ProjectPermission | ProjectPermission[],
  opts: RequireProjectPermissionOptions = {},
) =>
  SetMetadata<string, ProjectPermissionMetadata>(PROJECT_PERMISSION_KEY, {
    permissions: Array.isArray(permissions) ? permissions : [permissions],
    from: opts.from ?? 'param',
    key: opts.key ?? 'id',
    onMissing: opts.onMissing ?? 'deny',
    visibility: false,
  });

/**
 * Require only project membership (any role). Use on read-only project-scoped
 * endpoints where the permission is "you must be a member" not a specific action.
 *
 * This is the STRICT door: visibility is not consulted, so a non-member is
 * refused whatever the project's visibility says. Use `RequireProjectRead` for
 * routes that serve the project's own record.
 */
export const RequireProjectMembership = (
  opts: RequireProjectPermissionOptions = {},
) =>
  SetMetadata<string, ProjectPermissionMetadata>(PROJECT_PERMISSION_KEY, {
    permissions: [],
    from: opts.from ?? 'param',
    key: opts.key ?? 'id',
    onMissing: opts.onMissing ?? 'deny',
    visibility: false,
  });

/**
 * Finding R51 — the READ door for a project's own record.
 *
 * `buildWhere()` has always put every INTERNAL and PUBLIC project into every
 * authenticated user's list, while `@RequireProjectMembership` refused the same
 * user 403 when they opened it: a card that cannot be clicked, and in the
 * browser an "Access Denied" modal stacked over a "project not found" panel —
 * two wrong explanations, neither of them "you are not a member".
 *
 * `INTERNAL` means "visible to all authenticated users" and `PUBLIC` more so,
 * so the DOOR was what disagreed with the product, not the list. This decorator
 * admits any authenticated user to an INTERNAL or PUBLIC project and keeps
 * PRIVATE membership-only.
 *
 * It widens READ and nothing else. Every write keeps
 * `@RequireProjectPermission`, which never consults visibility, so a caller who
 * can now open an INTERNAL project still cannot edit it, archive it, delete it
 * or touch its members — and `my-permissions` truthfully reports the empty
 * permission set that refusal rests on.
 */
export const RequireProjectRead = (
  opts: RequireProjectPermissionOptions = {},
) =>
  SetMetadata<string, ProjectPermissionMetadata>(PROJECT_PERMISSION_KEY, {
    permissions: [],
    from: opts.from ?? 'param',
    key: opts.key ?? 'id',
    onMissing: opts.onMissing ?? 'deny',
    visibility: true,
  });
