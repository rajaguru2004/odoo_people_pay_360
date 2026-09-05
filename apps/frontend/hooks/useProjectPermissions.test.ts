/**
 * @vitest-environment jsdom
 *
 * Layer 0 by assignment (`docs/…/plan §4.1` — "useProjectPermissions resolution
 * order"), and the file stays a `*.test.ts` so it runs in the fast `unit`
 * project. The one thing it cannot do without is a React dispatcher, so the
 * environment is overridden per-file rather than for the whole project: no
 * component renders here, no provider tree boots, and nothing in `test/setup.ts`
 * is needed. Everything asserted below is a rule about a data shape.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The gate every project-scoped control is drawn behind.
 *
 * The resolution itself happens server-side (`ProjectAccessService.getAccess`):
 * a global admin and an owner both come back holding all 12 keys, a member
 * comes back holding exactly its role's list, a viewer comes back holding none.
 * What this hook owns is the *client* half — what it does with that answer, and
 * more importantly what it does when it does not have one yet.
 *
 * That last case is the reason this file exists. `can()` runs on every render
 * of every project screen, and the first render always happens before the
 * `/my-permissions` request has come back. An optimistic default there would
 * paint Delete, Archive and Manage Roles for a viewer for as long as the
 * request takes, and every one of those clicks would be a 403 the user cannot
 * explain. So "loading grants nothing" is asserted explicitly, and so is
 * "a failed request grants nothing" — the shape an outsider's 403 arrives in.
 */

vi.mock('@/services/projectRoleService', () => ({
  default: {
    getMyPermissions: vi.fn(),
    getCatalog: vi.fn(),
    listRoles: vi.fn(),
    createRole: vi.fn(),
    updateRole: vi.fn(),
    deleteRole: vi.fn(),
  },
}));

import { renderHook, waitFor } from '@testing-library/react';
import projectRoleService from '@/services/projectRoleService';
import { useProjectPermissions } from './useProjectPermissions';
import type { ProjectAccess, ProjectPermission } from '@/types/project';

const getMyPermissions = vi.mocked(projectRoleService.getMyPermissions);

/**
 * The frontend mirror, as a runtime value.
 *
 * `ProjectPermission` is a type union and so is erased at runtime — this array
 * is the only executable copy of it. TypeScript pins one direction for free
 * (an entry that is not in the union does not compile); the drift block at the
 * bottom pins the other two: the union must contain nothing more than this, and
 * the backend catalogue must contain exactly this.
 */
const FRONTEND_PERMISSIONS: ProjectPermission[] = [
  'PROJECT_EDIT',
  'PROJECT_ARCHIVE',
  'PROJECT_DELETE',
  'MEMBER_MANAGE',
  'ROLE_MANAGE',
  'TASK_CREATE',
  'TASK_ASSIGN',
  'TASK_EDIT',
  'TASK_DELETE',
  'TASK_STATUS_UPDATE',
  'SPRINT_MANAGE',
  'STATUS_MANAGE',
];

/** The four seeded presets, from `rbac/permissions.constants.ts`. */
const MANAGER_PRESET: ProjectPermission[] = [
  'TASK_CREATE',
  'TASK_ASSIGN',
  'TASK_EDIT',
  'TASK_DELETE',
  'TASK_STATUS_UPDATE',
  'SPRINT_MANAGE',
  'STATUS_MANAGE',
];
const MEMBER_PRESET: ProjectPermission[] = ['TASK_STATUS_UPDATE'];
const VIEWER_PRESET: ProjectPermission[] = [];

const access = (over: Partial<ProjectAccess> = {}): ProjectAccess => ({
  isGlobalAdmin: false,
  isOwner: false,
  roleSlug: null,
  permissions: [],
  ...over,
});

/** Renders the hook against one `/my-permissions` answer and settles it. */
async function withAccess(payload: ProjectAccess) {
  getMyPermissions.mockResolvedValue({ success: true, data: payload } as never);
  const view = renderHook(() => useProjectPermissions('p-1'));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

beforeEach(() => {
  getMyPermissions.mockReset();
});

describe('resolution order', () => {
  it('a global admin resolves to all 12 permissions', async () => {
    const { result } = await withAccess(
      access({ isGlobalAdmin: true, roleSlug: 'admin', permissions: [...FRONTEND_PERMISSIONS] }),
    );

    expect(result.current.isGlobalAdmin).toBe(true);
    expect(result.current.isOwner).toBe(false);
    expect([...result.current.permissions].sort()).toEqual([...FRONTEND_PERMISSIONS].sort());
    for (const p of FRONTEND_PERMISSIONS) expect(result.current.can(p)).toBe(true);
  });

  it('an owner resolves to all 12 permissions, without being a global admin', async () => {
    const { result } = await withAccess(
      access({ isOwner: true, roleSlug: 'owner', permissions: [...FRONTEND_PERMISSIONS] }),
    );

    expect(result.current.isOwner).toBe(true);
    expect(result.current.isGlobalAdmin).toBe(false);
    expect(result.current.roleSlug).toBe('owner');
    for (const p of FRONTEND_PERMISSIONS) expect(result.current.can(p)).toBe(true);
  });

  it('a manager resolves to exactly the manager preset — no project or member rights', async () => {
    const { result } = await withAccess(
      access({ roleSlug: 'manager', permissions: [...MANAGER_PRESET] }),
    );

    expect([...result.current.permissions].sort()).toEqual([...MANAGER_PRESET].sort());
    for (const p of MANAGER_PRESET) expect(result.current.can(p)).toBe(true);
    for (const p of ['PROJECT_EDIT', 'PROJECT_ARCHIVE', 'PROJECT_DELETE', 'MEMBER_MANAGE', 'ROLE_MANAGE'] as ProjectPermission[]) {
      expect(result.current.can(p)).toBe(false);
    }
  });

  it('a member resolves to exactly its role list and nothing adjacent', async () => {
    const { result } = await withAccess(
      access({ roleSlug: 'member', permissions: [...MEMBER_PRESET] }),
    );

    expect(result.current.permissions).toEqual(MEMBER_PRESET);
    expect(result.current.can('TASK_STATUS_UPDATE')).toBe(true);
    // The neighbouring task permissions are the easy mistake — moving a card is
    // not the same authority as creating, editing or deleting the card.
    expect(result.current.can('TASK_CREATE')).toBe(false);
    expect(result.current.can('TASK_EDIT')).toBe(false);
    expect(result.current.can('TASK_DELETE')).toBe(false);
    expect(result.current.can('TASK_ASSIGN')).toBe(false);
  });

  it('a viewer resolves to [] — every one of the 12 is refused', async () => {
    const { result } = await withAccess(
      access({ roleSlug: 'viewer', permissions: [...VIEWER_PRESET] }),
    );

    expect(result.current.permissions).toEqual([]);
    for (const p of FRONTEND_PERMISSIONS) expect(result.current.can(p)).toBe(false);
  });

  it('can() is false for a permission the list does not carry', async () => {
    const { result } = await withAccess(
      access({ roleSlug: 'custom', permissions: ['TASK_CREATE', 'TASK_EDIT'] }),
    );

    expect(result.current.can('TASK_CREATE')).toBe(true);
    expect(result.current.can('STATUS_MANAGE')).toBe(false);
    // An unknown key must deny rather than throw — a stale bundle asking about
    // a permission this server has never heard of is a real shape.
    expect(result.current.can('NOT_A_PERMISSION' as ProjectPermission)).toBe(false);
  });
});

describe('fail closed', () => {
  it('grants NOTHING while the request is still in flight', async () => {
    // The whole point. `can()` is called on the very first render, before any
    // answer exists; if it defaulted to true — or to "assume owner until told
    // otherwise" — every project screen would paint Delete, Archive and Manage
    // Roles for a viewer for the duration of the request.
    getMyPermissions.mockReturnValue(new Promise(() => {}) as never);

    const { result } = renderHook(() => useProjectPermissions('p-1'));

    expect(result.current.loading).toBe(true);
    expect(result.current.permissions).toEqual([]);
    expect(result.current.isOwner).toBe(false);
    expect(result.current.isGlobalAdmin).toBe(false);
    expect(result.current.roleSlug).toBeNull();
    for (const p of FRONTEND_PERMISSIONS) expect(result.current.can(p)).toBe(false);
  });

  it('grants nothing when the request fails — the shape an outsider gets', async () => {
    // A non-member hitting a PRIVATE project gets a rejection, and the hook
    // swallows it. Swallowing is fine; granting on it would not be.
    getMyPermissions.mockRejectedValue(new Error('Request failed with status code 403'));

    const { result } = renderHook(() => useProjectPermissions('p-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.permissions).toEqual([]);
    expect(result.current.isOwner).toBe(false);
    expect(result.current.isGlobalAdmin).toBe(false);
    for (const p of FRONTEND_PERMISSIONS) expect(result.current.can(p)).toBe(false);
  });

  it('grants nothing, and asks nothing, without a project id', async () => {
    const { result } = renderHook(() => useProjectPermissions(undefined));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getMyPermissions).not.toHaveBeenCalled();
    expect(result.current.permissions).toEqual([]);
    for (const p of FRONTEND_PERMISSIONS) expect(result.current.can(p)).toBe(false);
  });

  it('drops a permission that a refresh takes away, rather than keeping the old grant', async () => {
    // After ProjectRolesManager saves, the screens call refresh(). A revocation
    // that did not stick would leave the control painted until a full reload.
    getMyPermissions.mockResolvedValue({
      success: true,
      data: access({ roleSlug: 'custom', permissions: ['MEMBER_MANAGE'] }),
    } as never);

    const { result } = renderHook(() => useProjectPermissions('p-1'));
    await waitFor(() => expect(result.current.can('MEMBER_MANAGE')).toBe(true));

    getMyPermissions.mockResolvedValue({
      success: true,
      data: access({ roleSlug: 'custom', permissions: [] }),
    } as never);
    await result.current.refresh();

    await waitFor(() => expect(result.current.can('MEMBER_MANAGE')).toBe(false));
    expect(result.current.permissions).toEqual([]);
  });
});

/**
 * Drift guard — the frontend mirror against the backend catalogue.
 *
 * In the spirit of `utils/permissions.test.ts`. `types/project.ts` carries a
 * hand-written copy of `apps/backend/src/projects/rbac/permissions.constants.ts`
 * with a comment saying so and nothing enforcing it. A key added on the server
 * and forgotten here is a permission the matrix can never grant; a key removed
 * on the server and left here is a control the UI offers and the guard refuses.
 * Both are silent, which is exactly the class of bug this repo pins.
 */
describe('the frontend permission mirror', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  const backendKeys = (() => {
    const src = readFileSync(
      resolve(here, '../../backend/src/projects/rbac/permissions.constants.ts'),
      'utf8',
    );
    const block = src.match(/export const PROJECT_PERMISSIONS = \{([\s\S]*?)\} as const;/);
    if (!block) throw new Error('PROJECT_PERMISSIONS block not found in the backend constants');
    return [...block[1].matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]);
  })();

  const unionKeys = (() => {
    const src = readFileSync(resolve(here, '../types/project.ts'), 'utf8');
    const block = src.match(/export type ProjectPermission =([\s\S]*?);/);
    if (!block) throw new Error('ProjectPermission union not found in types/project.ts');
    return [...block[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  })();

  /**
   * Escape hatch for a disagreement that cannot be fixed in the same change.
   * It is empty, and adding to it is a decision to ship a permission that one
   * half of the system cannot express.
   */
  const KNOWN_DRIFT = new Set<string>([
    // Empty, and it should stay that way.
  ]);

  it('still matches the backend catalogue, key for key', () => {
    const missingHere = backendKeys.filter(
      (k) => !FRONTEND_PERMISSIONS.includes(k as ProjectPermission) && !KNOWN_DRIFT.has(k),
    );
    const missingThere = FRONTEND_PERMISSIONS.filter(
      (k) => !backendKeys.includes(k) && !KNOWN_DRIFT.has(k),
    );

    expect(missingHere, 'backend keys the frontend union has never heard of').toEqual([]);
    expect(missingThere, 'frontend keys the backend catalogue no longer defines').toEqual([]);
    expect(backendKeys).toHaveLength(12);
  });

  it('has no drift entry that has outlived its problem', () => {
    for (const key of KNOWN_DRIFT) {
      const agrees =
        backendKeys.includes(key) === FRONTEND_PERMISSIONS.includes(key as ProjectPermission);
      expect(agrees, `${key} is fixed — remove it from KNOWN_DRIFT`).toBe(false);
    }
  });

  it('keeps the runtime array and the ProjectPermission union in step', () => {
    // The other direction: a key added to the union but not to the array above
    // would slip past the backend comparison entirely, because the array is the
    // only thing this file can iterate at runtime.
    expect([...unionKeys].sort()).toEqual([...FRONTEND_PERMISSIONS].sort());
  });
});
