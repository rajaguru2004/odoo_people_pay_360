import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ALL_PROJECT_PERMISSIONS,
  GLOBAL_ADMIN_ROLES,
  OWNER_ROLE_SLUG,
  ProjectPermission,
} from './permissions.constants';

/** Same shape `ProjectStatusPayloadGuard` uses — kept local, not exported. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProjectAccess {
  isGlobalAdmin: boolean;
  isOwner: boolean;
  roleSlug: string | null;
  permissions: string[];
}

export type ProjectIdSource =
  | 'param'
  | 'paramSlug'
  | 'query'
  | 'body'
  | 'task'
  | 'sprint'
  | 'status'
  | 'statusItems'
  | 'label'
  | 'taskComment'
  | 'taskAttachment'
  | 'taskDependency';

@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve a user's effective permission set within a project. */
  async getAccess(projectId: string, user: any): Promise<ProjectAccess> {
    if (GLOBAL_ADMIN_ROLES.includes(user?.role)) {
      return {
        isGlobalAdmin: true,
        isOwner: false,
        roleSlug: 'admin',
        permissions: [...ALL_PROJECT_PERMISSIONS],
      };
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });

    const employeeId = user?.employeeId ?? null;
    const member =
      project && employeeId
        ? await this.prisma.projectMember.findUnique({
            where: { projectId_employeeId: { projectId, employeeId } },
            include: { projectRole: true },
          })
        : null;

    const roleSlug = member?.projectRole?.slug ?? null;
    const isOwner =
      (!!project?.ownerId && project.ownerId === employeeId) ||
      roleSlug === OWNER_ROLE_SLUG;

    if (isOwner) {
      return {
        isGlobalAdmin: false,
        isOwner: true,
        roleSlug: roleSlug ?? OWNER_ROLE_SLUG,
        permissions: [...ALL_PROJECT_PERMISSIONS],
      };
    }

    return {
      isGlobalAdmin: false,
      isOwner: false,
      roleSlug,
      permissions: member?.projectRole?.permissions ?? [],
    };
  }

  async has(
    projectId: string,
    user: any,
    permission: ProjectPermission,
  ): Promise<boolean> {
    const access = await this.getAccess(projectId, user);
    return access.permissions.includes(permission);
  }

  /**
   * Locate the project id for a request based on the decorator's source.
   *
   * Every entity lookup is wrapped: a malformed uuid makes Prisma throw
   * (P2023), and a guard is not the right place to turn a payload problem into
   * a 500 — it answers "could not resolve" and lets the pipe or the handler
   * give the caller a real message.
   */
  async resolveProjectId(
    source: ProjectIdSource,
    key: string,
    req: any,
  ): Promise<string | null> {
    const fromReq = (k: string) =>
      req.params?.[k] ?? req.body?.[k] ?? req.query?.[k] ?? null;

    const safe = async <T>(fn: () => Promise<T | null>): Promise<T | null> => {
      try {
        return await fn();
      } catch {
        return null;
      }
    };

    switch (source) {
      case 'param':
        return req.params?.[key] ?? null;
      case 'paramSlug': {
        const slug = req.params?.[key] ?? null;
        if (!slug) return null;
        const p = await safe(() =>
          this.prisma.project.findFirst({
            where: { slug },
            select: { id: true },
          }),
        );
        return p?.id ?? null;
      }
      case 'query':
        return req.query?.[key] ?? null;
      case 'body':
        return req.body?.[key] ?? null;
      case 'task': {
        const id = fromReq(key);
        if (!id) return null;
        const t = await safe(() =>
          this.prisma.task.findUnique({
            where: { id },
            select: { projectId: true },
          }),
        );
        return t?.projectId ?? null;
      }
      case 'sprint': {
        const id = fromReq(key);
        if (!id) return null;
        const s = await safe(() =>
          this.prisma.sprint.findUnique({
            where: { id },
            select: { projectId: true },
          }),
        );
        return s?.projectId ?? null;
      }
      // A workflow status has no single project — see `resolveProjectIds`,
      // which is what the guard calls and what resolves these two sources.
      // Answering with ONE project here is the R7 defect itself, so this
      // method refuses to guess.
      case 'status':
      case 'statusItems':
        return null;
      case 'label': {
        const id = fromReq(key);
        if (!id) return null;
        const l = await safe(() =>
          this.prisma.label.findUnique({
            where: { id },
            select: { projectId: true },
          }),
        );
        return l?.projectId ?? null;
      }
      case 'taskComment': {
        const id = fromReq(key);
        if (!id) return null;
        const c = await safe(() =>
          this.prisma.taskComment.findUnique({
            where: { id },
            select: { task: { select: { projectId: true } } },
          }),
        );
        return c?.task?.projectId ?? null;
      }
      case 'taskAttachment': {
        const id = fromReq(key);
        if (!id) return null;
        const a = await safe(() =>
          this.prisma.taskAttachment.findUnique({
            where: { id },
            select: { task: { select: { projectId: true } } },
          }),
        );
        return a?.task?.projectId ?? null;
      }
      case 'taskDependency': {
        const id = fromReq(key);
        if (!id) return null;
        const d = await safe(() =>
          this.prisma.taskDependency.findUnique({
            where: { id },
            select: { dependentTask: { select: { projectId: true } } },
          }),
        );
        return d?.dependentTask?.projectId ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * Every project a request touches, not just the first one that matches.
   *
   * Finding R7 — `projectIdFromStatus()` used to resolve a workflow status to
   * its `workflowId` and then to *an arbitrary project using that workflow*
   * (an unordered `findFirst`). Workflows are shared between projects, so
   * "which project is this status in?" has no single answer, and the guard was
   * answering a question about a project the request never mentioned: a
   * principal holding STATUS_MANAGE on project A — and 403 on even READING
   * project B — could rename, recategorise, reorder and delete columns of B's
   * board, because Postgres happened to hand back A.
   *
   * The rule chosen: **a shared column is governed by EVERY project that uses
   * its workflow.** A status row is one object with many owners, so authority
   * over it is the intersection of their authorities, never the union.
   * `resolveProjectIds` therefore returns all of them and the guard demands
   * the permission on each. A caller who genuinely owns the whole workflow
   * (the sole project on it, or a global admin) is unaffected; a caller with
   * standing in only one of several co-owners is refused, which is the
   * conservative answer for a mutation whose blast radius is every board on
   * the workflow.
   *
   * Reorder is resolved from EVERY item, not `items[0]`: the transaction
   * writes all of them, so all of them are the subject of the request.
   */
  async resolveProjectIds(
    source: ProjectIdSource,
    key: string,
    req: any,
  ): Promise<string[] | null> {
    if (source === 'status') {
      const id = req.params?.[key] ?? req.body?.[key] ?? req.query?.[key] ?? null;
      return this.projectIdsFromStatuses(id ? [id] : []);
    }
    if (source === 'statusItems') {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      return this.projectIdsFromStatuses(items.map((it: any) => it?.id));
    }
    const single = await this.resolveProjectId(source, key, req);
    return single ? [single] : null;
  }

  /**
   * Every project governing the given status rows. `null` when the statuses
   * cannot be resolved at all (unknown id, malformed uuid, a workflow no
   * project uses) — the guard turns that into its own answer.
   *
   * Soft-deleted projects are excluded: a retired project must not be able to
   * freeze a workflow its live siblings still use.
   */
  private async projectIdsFromStatuses(
    statusIds: unknown[],
  ): Promise<string[] | null> {
    // Malformed entries are dropped rather than allowed to collapse the whole
    // resolution: a non-uuid identifies no status, it makes Prisma throw
    // (P2023), and the ValidationPipe behind this guard already answers it with
    // the 400 it is (finding R33 — a payload problem must not come back as a
    // permission error). Every WELL-FORMED id is still resolved and still
    // governs the decision.
    const ids = statusIds.filter(
      (id): id is string => typeof id === 'string' && UUID_RE.test(id),
    );
    if (ids.length === 0) return null;

    let workflowIds: string[];
    try {
      const statuses = await this.prisma.projectTaskStatus.findMany({
        where: { id: { in: ids } },
        select: { workflowId: true },
      });
      workflowIds = Array.from(
        new Set(statuses.map((s) => s.workflowId).filter(Boolean)),
      ) as string[];
    } catch {
      return null;
    }
    if (workflowIds.length === 0) return null;

    const projects = await this.prisma.project.findMany({
      where: { workflowId: { in: workflowIds }, deletedAt: null },
      select: { id: true },
    });
    if (projects.length === 0) return null;
    return Array.from(new Set(projects.map((p) => p.id)));
  }

  /**
   * Finding R51 — `ProjectVisibility.INTERNAL` means "visible to all
   * authenticated users", and PUBLIC more so, but the by-id door demanded
   * membership, so a user saw the card in their list and was refused when they
   * clicked it. This answers the READ door's question and nothing else: no
   * write consults it.
   */
  async isReadableByVisibility(projectId: string): Promise<boolean> {
    if (!projectId) return false;
    try {
      const project = await this.prisma.project.findFirst({
        where: {
          id: projectId,
          deletedAt: null,
          visibility: { in: ['INTERNAL', 'PUBLIC'] },
        },
        select: { id: true },
      });
      return !!project;
    } catch {
      return false;
    }
  }
}
