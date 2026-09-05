import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import ProjectRolesManager from './ProjectRolesManager';
import type { PermissionCatalogItem, ProjectPermission, ProjectRole } from '@/types/project';

/**
 * The project permission matrix.
 *
 * It is TRANSPOSED against the way the data is shaped: permissions are rows,
 * roles are columns, and a cell is `role-matrix-cell-<roleSlug>-<PERMISSION_KEY>`.
 * Worth stating plainly, because reading the grid the other way round is how a
 * test ends up asserting the wrong cell and passing anyway.
 *
 * The screen is the only place a project's authority can be changed, so the
 * things that matter are: the grid is complete (a missing column is a role
 * nobody can configure, a missing row is a permission nobody can grant), a
 * change is visibly pending before it is saved, and the save carries the whole
 * intended set rather than a delta.
 */

vi.mock('@/services/projectRoleService', () => ({
  default: {
    getCatalog: vi.fn(),
    listRoles: vi.fn(),
    createRole: vi.fn(),
    updateRole: vi.fn(),
    deleteRole: vi.fn(),
    getMyPermissions: vi.fn(),
  },
}));

import projectRoleService from '@/services/projectRoleService';

const getCatalog = vi.mocked(projectRoleService.getCatalog);
const listRoles = vi.mocked(projectRoleService.listRoles);
const createRole = vi.mocked(projectRoleService.createRole);
const updateRole = vi.mocked(projectRoleService.updateRole);
const deleteRole = vi.mocked(projectRoleService.deleteRole);

const PROJECT_ID = 'p-1';

const ALL: ProjectPermission[] = [
  'PROJECT_EDIT', 'PROJECT_ARCHIVE', 'PROJECT_DELETE', 'MEMBER_MANAGE', 'ROLE_MANAGE',
  'TASK_CREATE', 'TASK_ASSIGN', 'TASK_EDIT', 'TASK_DELETE', 'TASK_STATUS_UPDATE',
  'SPRINT_MANAGE', 'STATUS_MANAGE',
];

/** The catalogue the server serves, grouped exactly as the matrix draws it. */
const CATALOG: PermissionCatalogItem[] = [
  { key: 'PROJECT_EDIT', group: 'Project', label: 'Edit project' },
  { key: 'PROJECT_ARCHIVE', group: 'Project', label: 'Archive / unarchive' },
  { key: 'PROJECT_DELETE', group: 'Project', label: 'Delete project' },
  { key: 'MEMBER_MANAGE', group: 'Members', label: 'Manage members' },
  { key: 'ROLE_MANAGE', group: 'Roles', label: 'Manage roles & permissions' },
  { key: 'TASK_CREATE', group: 'Tasks', label: 'Create tasks' },
  { key: 'TASK_ASSIGN', group: 'Tasks', label: 'Assign tasks' },
  { key: 'TASK_EDIT', group: 'Tasks', label: 'Edit tasks' },
  { key: 'TASK_DELETE', group: 'Tasks', label: 'Delete / archive tasks' },
  { key: 'TASK_STATUS_UPDATE', group: 'Tasks', label: 'Update task status' },
  { key: 'SPRINT_MANAGE', group: 'Sprints', label: 'Manage sprints' },
  { key: 'STATUS_MANAGE', group: 'Workflow', label: 'Manage status columns' },
];

const role = (over: Partial<ProjectRole> & Pick<ProjectRole, 'id' | 'slug' | 'name'>): ProjectRole => ({
  projectId: PROJECT_ID,
  description: null,
  color: '#64748B',
  isSystem: true,
  isDefault: false,
  permissions: [],
  sortOrder: 0,
  ...over,
});

/** The four seeded presets, as `GET /projects/:id/roles` returns them. */
const PRESETS: ProjectRole[] = [
  role({ id: 'r-owner', slug: 'owner', name: 'Owner', permissions: [...ALL], sortOrder: 0 }),
  role({
    id: 'r-manager', slug: 'manager', name: 'Manager', sortOrder: 1,
    permissions: ['TASK_CREATE', 'TASK_ASSIGN', 'TASK_EDIT', 'TASK_DELETE', 'TASK_STATUS_UPDATE', 'SPRINT_MANAGE', 'STATUS_MANAGE'],
  }),
  role({ id: 'r-member', slug: 'member', name: 'Member', isDefault: true, permissions: ['TASK_STATUS_UPDATE'], sortOrder: 2 }),
  role({ id: 'r-viewer', slug: 'viewer', name: 'Viewer', permissions: [], sortOrder: 3 }),
];

const CUSTOM = role({
  id: 'r-qa', slug: 'qa-reviewer', name: 'QA Reviewer', isSystem: false,
  permissions: ['TASK_EDIT'], sortOrder: 4,
});

const cell = (slug: string, perm: ProjectPermission) =>
  screen.getByTestId(`role-matrix-cell-${slug}-${perm}`) as HTMLInputElement;

const matrix = () => screen.getByTestId('role-matrix');

/** Mounts the matrix and waits for the first load to finish. */
async function mount(roles: ProjectRole[] = PRESETS) {
  listRoles.mockResolvedValue({ success: true, data: roles } as never);
  getCatalog.mockResolvedValue({ success: true, data: CATALOG } as never);
  const view = renderWithProviders(<ProjectRolesManager projectId={PROJECT_ID} />, { role: 'ADMIN' });
  await waitFor(() => expect(screen.getByTestId('role-matrix')).toBeInTheDocument());
  return view;
}

beforeEach(() => {
  getCatalog.mockReset();
  listRoles.mockReset();
  createRole.mockReset();
  updateRole.mockReset();
  deleteRole.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('the grid', () => {
  it('draws a column per role and a row per permission', async () => {
    await mount();

    for (const r of PRESETS) {
      expect(screen.getByTestId(`role-header-${r.slug}`)).toHaveTextContent(r.name);
    }
    for (const item of CATALOG) {
      expect(screen.getByTestId(`role-permission-row-${item.key}`)).toBeInTheDocument();
    }
    // 12 × 4 cells, and no more: a stray column would be a role the backend
    // never sent.
    expect(matrix().querySelectorAll('input[type="checkbox"]')).toHaveLength(12 * 4);
  });

  it('checks exactly the permissions each role already holds', async () => {
    await mount();

    expect(cell('member', 'TASK_STATUS_UPDATE').checked).toBe(true);
    expect(cell('member', 'TASK_CREATE').checked).toBe(false);
    expect(cell('member', 'PROJECT_EDIT').checked).toBe(false);

    expect(cell('manager', 'SPRINT_MANAGE').checked).toBe(true);
    expect(cell('manager', 'MEMBER_MANAGE').checked).toBe(false);

    for (const p of ALL) expect(cell('viewer', p).checked).toBe(false);
  });

  it('shows nothing pending before anything is touched', async () => {
    await mount();

    expect(screen.queryByTestId('role-dirty-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('role-save')).toBeDisabled();
  });
});

describe('editing and saving', () => {
  it('marks the form dirty when a cell is toggled', async () => {
    const { user } = await mount();

    await user.click(cell('member', 'TASK_CREATE'));

    expect(cell('member', 'TASK_CREATE').checked).toBe(true);
    expect(screen.getByTestId('role-dirty-count')).toHaveTextContent('1 role changed');
    expect(screen.getByTestId('role-save')).toBeEnabled();
  });

  it('counts dirty ROLES, not dirty cells', async () => {
    const { user } = await mount();

    await user.click(cell('member', 'TASK_CREATE'));
    await user.click(cell('member', 'TASK_EDIT'));
    expect(screen.getByTestId('role-dirty-count')).toHaveTextContent('1 role changed');

    await user.click(cell('viewer', 'TASK_STATUS_UPDATE'));
    expect(screen.getByTestId('role-dirty-count')).toHaveTextContent('2 roles changed');
  });

  it('goes clean again when a toggle is undone', async () => {
    // The set comparison has to be by content, not by "was touched" — otherwise
    // a user who fixes their own mistake still sends a pointless write.
    const { user } = await mount();

    await user.click(cell('member', 'TASK_CREATE'));
    await user.click(cell('member', 'TASK_CREATE'));

    expect(screen.queryByTestId('role-dirty-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('role-save')).toBeDisabled();
  });

  it('saves the WHOLE intended permission set for the dirty role, and only that role', async () => {
    // The endpoint replaces `permissions` wholesale; sending only the newly
    // ticked key would silently strip everything the role already had.
    const { user } = await mount();
    updateRole.mockResolvedValue({ success: true, data: {} } as never);

    await user.click(cell('member', 'TASK_CREATE'));
    await user.click(screen.getByTestId('role-save'));

    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1));
    const [projectId, roleId, payload] = updateRole.mock.calls[0];
    expect(projectId).toBe(PROJECT_ID);
    expect(roleId).toBe('r-member');
    expect([...(payload.permissions ?? [])].sort()).toEqual(['TASK_CREATE', 'TASK_STATUS_UPDATE']);
  });

  it('sends a removal as the reduced set', async () => {
    const { user } = await mount();
    updateRole.mockResolvedValue({ success: true, data: {} } as never);

    await user.click(cell('manager', 'STATUS_MANAGE'));
    await user.click(screen.getByTestId('role-save'));

    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1));
    expect(updateRole.mock.calls[0][2].permissions).not.toContain('STATUS_MANAGE');
    expect(updateRole.mock.calls[0][2].permissions).toContain('SPRINT_MANAGE');
  });

  it('surfaces a refused save instead of pretending it worked', async () => {
    const { user } = await mount();
    updateRole.mockRejectedValue({ message: 'Role does not belong to this project' });

    await user.click(cell('member', 'TASK_CREATE'));
    await user.click(screen.getByTestId('role-save'));

    await waitFor(() =>
      expect(screen.getByTestId('role-error')).toHaveTextContent('Role does not belong to this project'),
    );
  });
});

describe('which roles may be deleted', () => {
  it('offers no delete control on a system preset', async () => {
    // All four presets are `isSystem` — the backend refuses to delete them, so
    // the control must not be drawn at all rather than 400 on click.
    await mount();

    for (const r of PRESETS) {
      expect(screen.getByTestId(`role-header-${r.slug}`)).toHaveTextContent('Preset');
      expect(screen.queryByTestId(`role-delete-${r.slug}`)).not.toBeInTheDocument();
    }
  });

  it('offers delete on a custom role, behind a confirmation', async () => {
    const { user } = await mount([...PRESETS, CUSTOM]);
    deleteRole.mockResolvedValue({ success: true, data: null } as never);

    expect(screen.queryByTestId('role-delete-qa-reviewer')).toBeInTheDocument();
    await user.click(screen.getByTestId('role-delete-qa-reviewer'));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(deleteRole).toHaveBeenCalledWith(PROJECT_ID, 'r-qa'));
  });

  it('does not delete when the confirmation is dismissed', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const { user } = await mount([...PRESETS, CUSTOM]);

    await user.click(screen.getByTestId('role-delete-qa-reviewer'));

    expect(deleteRole).not.toHaveBeenCalled();
  });
});

describe('the create-role modal', () => {
  it('will not submit without a name', async () => {
    const { user } = await mount();

    await user.click(screen.getByTestId('role-create'));
    expect(screen.getByTestId('role-create-modal')).toBeInTheDocument();
    expect(screen.getByTestId('role-create-submit')).toBeDisabled();

    // Whitespace is not a name.
    await user.type(screen.getByTestId('role-create-name'), '   ');
    expect(screen.getByTestId('role-create-submit')).toBeDisabled();
    expect(createRole).not.toHaveBeenCalled();
  });

  it('creates with the trimmed name, the chosen colour and an optional template', async () => {
    const { user } = await mount();
    createRole.mockResolvedValue({ success: true, data: {} } as never);

    await user.click(screen.getByTestId('role-create'));
    await user.type(screen.getByTestId('role-create-name'), '  QA Reviewer  ');
    await user.selectOptions(screen.getByTestId('role-create-copy-from'), 'r-manager');
    await user.click(screen.getByTestId('role-create-submit'));

    await waitFor(() => expect(createRole).toHaveBeenCalledTimes(1));
    expect(createRole.mock.calls[0][1]).toMatchObject({
      name: 'QA Reviewer',
      copyFromRoleId: 'r-manager',
    });
    expect(createRole.mock.calls[0][1].color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('keeps the modal open and states the reason when the create is refused', async () => {
    const { user } = await mount();
    createRole.mockRejectedValue({ message: 'A role with that name already exists' });

    await user.click(screen.getByTestId('role-create'));
    await user.type(screen.getByTestId('role-create-name'), 'Manager');
    await user.click(screen.getByTestId('role-create-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('role-create-error')).toHaveTextContent('already exists'),
    );
    expect(screen.getByTestId('role-create-modal')).toBeInTheDocument();
  });
});

/**
 * FE-C-04 — R11, the owner role's silently discarded write.
 *
 * At the API (`PRJ-API-46a`): `ProjectRolesService.update()` force-restores all
 * 12 permissions whenever `slug === 'owner'`, then answers 200 with
 * `success: true` and echoes the full set back. The row never changed. The
 * control case `PRJ-API-46b` proves the `member` system role IS editable, so
 * this is the owner branch specifically, not general immutability.
 *
 * The question this file has to answer is whether the matrix can ever put a
 * user in front of that lie. It cannot, and the reason is worth pinning: the
 * owner column's checkboxes are rendered `disabled` and forced `checked`, and
 * `dirtyRoleIds` filters `!isOwner(r)` before anything is sent. Two independent
 * guards, both keyed on the same `slug === 'owner'` the server uses.
 *
 * R67 was the second half of the story, and the one that bit: `save()` treated
 * a resolved promise as success and never compared what it sent with what came
 * back, so for ANY role the server chose to discard, the matrix reverted the
 * user's change on reload and said nothing at all. It compares now.
 */
describe('FE-C-04 — the owner column against R11', () => {
  it('renders the owner column as fully granted and not editable', async () => {
    await mount();

    for (const p of ALL) {
      const c = cell('owner', p);
      expect(c.checked).toBe(true);
      expect(c).toBeDisabled();
    }
  });

  it('cannot be dirtied, so the discarded write is never attempted', async () => {
    const { user } = await mount();

    // A disabled input swallows the click; asserted rather than assumed,
    // because `toggle()` would happily mutate the draft if it ever fired.
    await user.click(cell('owner', 'PROJECT_DELETE'));

    expect(cell('owner', 'PROJECT_DELETE').checked).toBe(true);
    expect(screen.queryByTestId('role-dirty-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('role-save')).toBeDisabled();
    expect(updateRole).not.toHaveBeenCalled();
  });

  it('leaves the owner out of a save driven by another role', async () => {
    // The belt to the disabled braces: even with the owner column somehow
    // dirtied, `dirtyRoleIds` excludes it from the payload.
    const { user } = await mount();
    updateRole.mockResolvedValue({ success: true, data: {} } as never);

    await user.click(cell('member', 'TASK_CREATE'));
    await user.click(screen.getByTestId('role-save'));

    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1));
    expect(updateRole.mock.calls.map((c) => c[1])).not.toContain('r-owner');
  });
});

/**
 * R67 — FIXED. A resolved promise is not a saved change.
 *
 * The R11 response shape applied to a role the UI DOES let you edit: 200,
 * `success: true`, and the role echoed back holding exactly what it held
 * before. `save()` used to await it, treat resolution as success and re-read —
 * so the tick fell silently back off, the dirty marker cleared (the screen's
 * only "saved" signal), and no error appeared anywhere. "200 OK" and "your
 * change was applied" were being treated as the same fact, and R11 proves they
 * are not.
 *
 * `save()` now diffs the permission set it sent against the one that came back
 * and reports the disagreement. The two cases below are the two halves that
 * matter: it must speak up when the sets differ, and it must NOT invent a
 * failure when the endpoint simply says nothing it can compare.
 */
describe('R67 — comparing what was sent with what came back', () => {
  it('reports a write the server discarded instead of going quiet', async () => {
    const { user } = await mount();
    updateRole.mockResolvedValue({
      success: true,
      message: 'Role updated',
      data: { ...PRESETS[2], permissions: ['TASK_STATUS_UPDATE'] },
    } as never);
    // The re-read the server would give: unchanged.
    listRoles.mockResolvedValue({ success: true, data: PRESETS } as never);

    await user.click(cell('member', 'PROJECT_EDIT'));
    expect(cell('member', 'PROJECT_EDIT').checked).toBe(true);

    await user.click(screen.getByTestId('role-save'));
    await waitFor(() => expect(updateRole).toHaveBeenCalled());

    // The user is told, and told WHICH role did not take.
    await waitFor(() => expect(screen.getByTestId('role-error')).toBeInTheDocument());
    expect(screen.getByTestId('role-error')).toHaveTextContent('Member');
    // The reverted tick is still the truth of what the server holds, so it
    // stays reverted — the message is what stops it reading as a save.
    expect(cell('member', 'PROJECT_EDIT').checked).toBe(false);
  });

  it('stays quiet when the server confirms the set it was sent', async () => {
    // The control. A save that really took must not draw an error, or the
    // signal is worthless.
    const { user } = await mount();
    const applied = { ...PRESETS[2], permissions: ['TASK_STATUS_UPDATE', 'PROJECT_EDIT'] };
    updateRole.mockResolvedValue({ success: true, data: applied } as never);
    listRoles.mockResolvedValue({ success: true, data: [...PRESETS.slice(0, 2), applied, PRESETS[3]] } as never);

    await user.click(cell('member', 'PROJECT_EDIT'));
    await user.click(screen.getByTestId('role-save'));

    await waitFor(() => expect(updateRole).toHaveBeenCalled());
    await waitFor(() => expect(cell('member', 'PROJECT_EDIT').checked).toBe(true));
    expect(screen.queryByTestId('role-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('role-dirty-count')).not.toBeInTheDocument();
  });

  it('claims nothing either way when the response carries no permissions', async () => {
    // `{ success: true, data: {} }` is a shape this endpoint really answers
    // with. There is nothing to compare, so inventing a failure from it would
    // be the same mistake as inventing a success — the screen says nothing.
    const { user } = await mount();
    updateRole.mockResolvedValue({ success: true, data: {} } as never);

    await user.click(cell('member', 'TASK_CREATE'));
    await user.click(screen.getByTestId('role-save'));

    await waitFor(() => expect(updateRole).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('role-dirty-count')).not.toBeInTheDocument());
    expect(screen.queryByTestId('role-error')).not.toBeInTheDocument();
  });
});
