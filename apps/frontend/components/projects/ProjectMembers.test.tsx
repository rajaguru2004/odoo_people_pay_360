import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderWithProviders, screen, waitFor, within } from '@/test/render';
import ProjectMembers from './ProjectMembers';
import type { ProjectAccess, ProjectMember, ProjectRole } from '@/types/project';

/**
 * The project roster.
 *
 * Unusually for a layer-1 spec, this file stubs `lib/axios` rather than the
 * services on top of it — deliberately, and only here. `projectService`'s
 * `roleBody` dispatcher decides between `{ roleId }` and `{ role }` from a
 * single string argument, and the roster is the screen that feeds it in anger.
 * Stubbing `projectService` would replace exactly the code under test:
 * `updateMemberRole` would record its argument and the dispatch would never
 * run. `services/projectService.test.ts` pins the regex in isolation; this file
 * pins what the roster actually hands it, and therefore what goes on the wire.
 *
 * The stakes are asymmetric, which is what makes it worth the extra plumbing.
 * A role id sent down the `{ role }` branch is an unknown slug, and an unknown
 * slug is finding R50: the server answers 201, quietly assigns the project
 * default role, and tells the caller nothing. A demotion that reports success.
 */

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import axiosInstance from '@/lib/axios';

const get = vi.mocked(axiosInstance.get);
const post = vi.mocked(axiosInstance.post);
const patch = vi.mocked(axiosInstance.patch);
const del = vi.mocked(axiosInstance.delete);

const PROJECT_ID = 'p-1';

/** Role ids are real UUIDs — the whole point of the dispatch. */
const ROLE_IDS = {
  owner: '11111111-1111-4111-8111-111111111111',
  manager: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
};

const role = (slug: keyof typeof ROLE_IDS, name: string, isDefault = false): ProjectRole => ({
  id: ROLE_IDS[slug],
  projectId: PROJECT_ID,
  name,
  slug,
  description: null,
  color: '#64748B',
  isSystem: true,
  isDefault,
  permissions: [],
  sortOrder: 0,
});

const ROLES: ProjectRole[] = [
  role('owner', 'Owner'),
  role('manager', 'Manager'),
  role('member', 'Member', true),
  role('viewer', 'Viewer'),
];

const member = (id: string, empId: string, fullName: string, slug: keyof typeof ROLE_IDS): ProjectMember => ({
  id,
  projectId: PROJECT_ID,
  employeeId: empId,
  role: slug.toUpperCase() as ProjectMember['role'],
  roleId: ROLE_IDS[slug],
  projectRole: {
    id: ROLE_IDS[slug],
    name: slug[0].toUpperCase() + slug.slice(1),
    slug,
    color: '#0EA5E9',
    permissions: [],
    isSystem: true,
    isDefault: slug === 'member',
  },
  joinedAt: '2026-01-01T00:00:00.000Z',
  employee: { id: empId, fullName, employeeCode: empId.toUpperCase(), email: `${empId}@company.com` },
});

const MEMBERS: ProjectMember[] = [
  member('m-1', 'e-1', 'Aisha Rahman', 'owner'),
  member('m-2', 'e-2', 'Bilal Haddad', 'member'),
];

const DIRECTORY = [
  { id: 'e-1', fullName: 'Aisha Rahman', employeeCode: 'EMP001' },
  { id: 'e-2', fullName: 'Bilal Haddad', employeeCode: 'EMP002' },
  { id: 'e-3', fullName: 'Carla Nunes', employeeCode: 'EMP003' },
];

const MANAGE: ProjectAccess = {
  isGlobalAdmin: true,
  isOwner: false,
  roleSlug: 'admin',
  permissions: ['MEMBER_MANAGE'],
};
const READ_ONLY: ProjectAccess = {
  isGlobalAdmin: false,
  isOwner: false,
  roleSlug: 'viewer',
  permissions: [],
};

/** Routes the four GETs the roster fires on mount. */
function routeGets(opts: { members?: ProjectMember[]; roles?: ProjectRole[]; access?: ProjectAccess } = {}) {
  const members = opts.members ?? MEMBERS;
  const roles = opts.roles ?? ROLES;
  const accessPayload = opts.access ?? MANAGE;

  get.mockImplementation((url: string) => {
    if (url === `/projects/${PROJECT_ID}/members`) {
      return Promise.resolve({ success: true, data: members }) as never;
    }
    if (url === `/projects/${PROJECT_ID}/roles`) {
      return Promise.resolve({ success: true, data: roles }) as never;
    }
    if (url === `/projects/${PROJECT_ID}/my-permissions`) {
      return Promise.resolve({ success: true, data: accessPayload }) as never;
    }
    if (url === '/employees/directory') {
      return Promise.resolve({ success: true, data: DIRECTORY }) as never;
    }
    return Promise.reject(new Error(`unrouted GET ${url}`));
  });
}

async function mount(opts?: Parameters<typeof routeGets>[0]) {
  routeGets(opts);
  const view = renderWithProviders(<ProjectMembers projectId={PROJECT_ID} />, { role: 'ADMIN' });
  await waitFor(() => expect(screen.getByTestId('member-table')).toBeInTheDocument());
  return view;
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
  post.mockResolvedValue({ success: true, data: [] } as never);
  patch.mockResolvedValue({ success: true, data: {} } as never);
  del.mockResolvedValue({ success: true, data: null } as never);
});

describe('the roster', () => {
  it('renders a row per member, with the person and their role', async () => {
    await mount();

    const rows = screen.getAllByTestId(/^member-row-/);
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('member-row-m-1')).toHaveTextContent('Aisha Rahman');
    expect(screen.getByTestId('member-row-m-1')).toHaveTextContent('e-1@company.com');
    expect(screen.queryByTestId('member-empty')).not.toBeInTheDocument();
  });

  it('offers a role select per row, pre-selected on the member\'s current role', async () => {
    await mount();

    const select = screen.getByTestId('member-role-select-m-2') as HTMLSelectElement;
    expect(select.value).toBe(ROLE_IDS.member);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Owner', 'Manager', 'Member', 'Viewer',
    ]);
  });

  it('states its emptiness rather than rendering a bare table', async () => {
    await mount({ members: [] });

    expect(screen.getByTestId('member-empty')).toHaveTextContent('No members yet');
    expect(screen.queryAllByTestId(/^member-row-/)).toHaveLength(0);
  });

  it('projects read-only for a user without MEMBER_MANAGE', async () => {
    // The server refuses the write anyway; this is about not advertising a
    // control that will 403. The role still has to be legible, so it renders as
    // text instead of a select.
    await mount({ access: READ_ONLY });

    expect(screen.queryByTestId('member-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('member-role-select-m-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('member-remove-m-2')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('member-row-m-2')).getByText('Member')).toBeInTheDocument();
  });
});

describe('changing a role — the dispatch in anger', () => {
  it('PATCHes { roleId }, because the select carries a role UUID', async () => {
    // The assertion the whole file is built around: what reaches the wire, not
    // what reached the service. `{ roleId }` is the branch that 400s on a bad
    // id; `{ role }` is the branch that 201s and silently demotes (R50).
    const { user } = await mount();

    await user.selectOptions(screen.getByTestId('member-role-select-m-2'), ROLE_IDS.manager);

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/members/m-2`, {
      roleId: ROLE_IDS.manager,
    });
    const body = patch.mock.calls[0][1] as Record<string, unknown>;
    expect('role' in body, 'the slug branch must not be taken for a role id').toBe(false);
  });

  it('re-reads the roster after the change, so the row shows what the server holds', async () => {
    const { user } = await mount();

    await user.selectOptions(screen.getByTestId('member-role-select-m-2'), ROLE_IDS.viewer);

    await waitFor(() =>
      expect(get.mock.calls.filter((c) => c[0] === `/projects/${PROJECT_ID}/members`)).toHaveLength(2),
    );
  });

  it('adds a member with the selected role id, defaulting to the project default role', async () => {
    const { user } = await mount();

    // The add-role selector opens on the `isDefault` role rather than the first
    // in the list — opening on Owner would be one mis-click from full control.
    expect((screen.getByTestId('member-add-role') as HTMLSelectElement).value).toBe(ROLE_IDS.member);

    await user.selectOptions(screen.getByTestId('member-add-employee'), 'e-3');
    await user.selectOptions(screen.getByTestId('member-add-role'), ROLE_IDS.viewer);
    await user.click(screen.getByTestId('member-add'));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/members`, {
      employeeIds: ['e-3'],
      roleId: ROLE_IDS.viewer,
    });
  });

  it('offers only people who are not already members', async () => {
    await mount();

    const select = screen.getByTestId('member-add-employee') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain('e-3');
    expect(values).not.toContain('e-1');
    expect(values).not.toContain('e-2');
  });
});

/**
 * R50 — an unknown role string is a 201 that says nothing.
 *
 * `POST /projects/:id/members { role: 'SUPREME_LEADER' }` answers 201 and
 * assigns the project's default role. No 400, no warning, no field in the
 * response saying the requested role was not honoured. Confirmed as
 * `PRJ-API-26`.
 *
 * The question for this screen is whether it could ever be the caller. It
 * cannot: every role control here is a `<select>` whose option values come from
 * `GET /projects/:id/roles`, so the only strings it can emit are ids of roles
 * that belong to this project — which take the `{ roleId }` branch and would
 * 400 loudly if they did not.
 *
 * Recorded rather than assumed, because it is one refactor away from being
 * untrue, and because the roster is NOT the only writer: `NewProjectModal`
 * posts the hard-coded literal `'MEMBER'`, which survives only because
 * `resolveMemberRole` lower-cases before matching a slug.
 */
describe('R50 — can this screen send an unknown role?', () => {
  it('emits only role ids that came from this project, never a free-text role', async () => {
    await mount();

    const selects = [
      screen.getByTestId('member-add-role'),
      screen.getByTestId('member-role-select-m-1'),
      screen.getByTestId('member-role-select-m-2'),
    ] as HTMLSelectElement[];

    const known = new Set(ROLES.map((r) => r.id));
    for (const select of selects) {
      expect(select.tagName).toBe('SELECT');
      for (const option of Array.from(select.options)) {
        expect(known.has(option.value), `${option.value} is not a role of this project`).toBe(true);
        expect(option.value).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      }
    }
  });

  /**
   * R71 — a project with no roles explains itself instead of offering a dead
   * control.
   *
   * The degenerate case the screen had no state for. `GET /roles` comes back
   * empty — a project created before the presets were seeded, or a role list
   * this caller may not read — so there was nothing to pick: an empty
   * `<select>` with zero options, `selectedRoleId` stuck at `''`, and an Add
   * button disabled for ever with nothing said. Not posting a blank role was
   * right (the server reads an absent role as "use the default", which is
   * finding R70), but the user was left holding a control that could not be
   * operated and no reason why.
   */
  it('names the missing-roles state rather than rendering a control that cannot work', async () => {
    await mount({ roles: [] });

    const explanation = screen.getByTestId('member-add-no-roles');
    expect(explanation).toBeVisible();
    // Not just "something went wrong": the remedy is the point, because adding
    // a member is not answerable until the project has a role to give them.
    expect(explanation).toHaveTextContent(/Roles & permissions/i);

    // The dead controls are gone, not merely disabled.
    expect(screen.queryByTestId('member-add-role')).not.toBeInTheDocument();
    expect(screen.queryByTestId('member-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('member-add-employee')).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    // The roster itself still renders — the people are legible even when the
    // role vocabulary is not. A select with zero options could not show the
    // role a member already holds, so those fall back to text too.
    expect(screen.getByTestId('member-row-m-2')).toHaveTextContent('Bilal Haddad');
    expect(screen.queryByTestId('member-role-select-m-2')).not.toBeInTheDocument();
  });
});

/**
 * Removing a member — R68 and R69, both fixed.
 *
 * R68: `remove()` used to fire on the first click. `ProjectRolesManager.removeRole`
 * — the sibling control on the next tab — has always guarded its delete behind
 * `confirm()`, and this is the same class of irreversible action against a
 * person: `ProjectMember.employeeId` is `onDelete: Cascade`, so there is no
 * tombstone and nothing to restore from. A mis-click ended someone's access to
 * a PRIVATE project with no undo and no prompt.
 *
 * R69: the OWNER membership row was removable from here, while `NewProjectModal`
 * explicitly excludes `role !== 'OWNER'` when it diffs the member list —
 * dropping it leaves a project only a global admin can edit. Same membership,
 * two screens, two rules. They agree now: the roster draws no remove control on
 * the owner's row at all.
 */
describe('removing a member', () => {
  it('asks first, as deleting a role does, and removes on confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user } = await mount();

    await user.click(screen.getByTestId('member-remove-m-2'));

    expect(confirmSpy).toHaveBeenCalled();
    // The prompt names the person, because "are you sure?" against the wrong
    // row is the mistake it exists to catch.
    expect(confirmSpy.mock.calls[0][0]).toContain('Bilal Haddad');

    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/members/m-2`);
    // The row vanishes on the re-read.
    await waitFor(() =>
      expect(get.mock.calls.filter((c) => c[0] === `/projects/${PROJECT_ID}/members`)).toHaveLength(2),
    );
  });

  it('sends nothing when the confirmation is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { user } = await mount();

    await user.click(screen.getByTestId('member-remove-m-2'));

    expect(del).not.toHaveBeenCalled();
    expect(get.mock.calls.filter((c) => c[0] === `/projects/${PROJECT_ID}/members`)).toHaveLength(1);
  });

  it("offers no remove control on the OWNER's membership row", async () => {
    // `NewProjectModal` protects the same membership when it diffs; this screen
    // must not be the back door. The row is still legible — it is the control
    // that is absent, not the person.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mount();

    expect(screen.getByTestId('member-row-m-1')).toHaveTextContent('Aisha Rahman');
    expect(screen.queryByTestId('member-remove-m-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('member-remove-owner-locked-m-1')).toBeInTheDocument();
    // …and the one member who may be removed still has theirs.
    expect(screen.getByTestId('member-remove-m-2')).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });
});

/**
 * R70 — `updateMemberRole(id, memberId, '')` builds `{}`.
 *
 * `roleBody('')` returns `{}` for any falsy argument, and the server reads an
 * absent role as "use the project default" — so "change this member's role"
 * becomes "reset them to Member", answered 200 with nothing said. The fix
 * belongs in `services/projectService.ts`, which should refuse to build an
 * empty body for an explicit role change rather than leave every caller to
 * remember; this screen guards its own end of it in the meantime.
 */
describe('R70 — an empty role is never sent as "use the default"', () => {
  it('sends nothing when the select somehow yields an empty value', async () => {
    const { user } = await mount();
    const select = screen.getByTestId('member-role-select-m-2') as HTMLSelectElement;

    // A real browser cannot offer '' here — every option is a role id. This is
    // the state a restored form, a cleared select or a roleless project would
    // produce, and the one the server silently reinterprets.
    await user.selectOptions(select, ROLE_IDS.viewer);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    patch.mockClear();
    fireEvent.change(select, { target: { value: '' } });

    expect(patch).not.toHaveBeenCalled();
  });
});
