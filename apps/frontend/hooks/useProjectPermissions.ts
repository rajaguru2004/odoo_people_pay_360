'use client';

import { useCallback, useEffect, useState } from 'react';
import projectRoleService from '@/services/projectRoleService';
import type { ProjectAccess, ProjectPermission } from '@/types/project';

/**
 * Resolve the current user's permission set within a project and expose a
 * `can(permission)` gate. Drives all project-scoped UI gating. Mirrors the
 * backend ProjectPermissionGuard — backend remains the source of truth.
 */
export function useProjectPermissions(projectId?: string) {
  const [access, setAccess] = useState<ProjectAccess | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setAccess(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = (await projectRoleService.getMyPermissions(projectId)) as any;
      setAccess(res.data as ProjectAccess);
    } catch {
      setAccess(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const can = useCallback(
    (permission: ProjectPermission) =>
      !!access && access.permissions.includes(permission),
    [access],
  );

  return {
    can,
    permissions: access?.permissions ?? [],
    isOwner: access?.isOwner ?? false,
    isGlobalAdmin: access?.isGlobalAdmin ?? false,
    roleSlug: access?.roleSlug ?? null,
    loading,
    refresh,
  };
}
