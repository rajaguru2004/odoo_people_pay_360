import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The role-argument dispatcher in `projectService`.
 *
 * Every member write takes ONE `roleOrId` string and has to decide, on its own,
 * whether the caller meant a `ProjectRole` row id or a legacy role slug — the
 * backend reads `{ roleId }` and `{ role }` down two different branches of
 * `ProjectsService.resolveMemberRole()`, and they do not fall back to each
 * other in the direction you would hope:
 *
 *   - `{ roleId: <not in this project> }` → 400 "Role does not belong to this project"
 *   - `{ role: <unknown slug> }`          → **201**, silently demoted to the
 *                                            project's default role (finding R50)
 *
 * So a mis-dispatch is not symmetric. Sending a real role id down the `role`
 * branch produces a 201 that assigns the wrong role and says nothing, which is
 * the failure nobody notices. That is why the regex earns a test of its own
 * rather than being trusted by eye.
 *
 * `roleBody` is module-private, so it is exercised through the two public
 * methods that use it — which also pins the URLs and the rest of the payload.
 */

vi.mock('@/lib/axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import axiosInstance from '@/lib/axios';
import projectService from './projectService';

const post = vi.mocked(axiosInstance.post);
const patch = vi.mocked(axiosInstance.patch);

const PROJECT_ID = 'p-1';
const MEMBER_ID = 'm-1';

/** A canonical v4 UUID, the shape `ProjectRole.id` always takes. */
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** What `addMember` put in the request body for this role argument. */
async function addMemberBody(roleOrId?: string) {
  post.mockResolvedValue({ data: {} } as never);
  await projectService.addMember(PROJECT_ID, ['e-1'], roleOrId);
  return post.mock.calls.at(-1)![1] as Record<string, unknown>;
}

/** What `updateMemberRole` put in the request body for this role argument. */
async function updateMemberBody(roleOrId: string) {
  patch.mockResolvedValue({ data: {} } as never);
  await projectService.updateMemberRole(PROJECT_ID, MEMBER_ID, roleOrId);
  return patch.mock.calls.at(-1)![1] as Record<string, unknown>;
}

beforeEach(() => {
  post.mockReset();
  patch.mockReset();
});

describe('roleBody — uuid vs slug dispatch', () => {
  it('sends a UUID as roleId', async () => {
    expect(await addMemberBody(UUID)).toEqual({ employeeIds: ['e-1'], roleId: UUID });
  });

  it('sends a slug as role', async () => {
    // The four seeded presets are lower-case slugs: owner, manager, member, viewer.
    expect(await addMemberBody('manager')).toEqual({ employeeIds: ['e-1'], role: 'manager' });
  });

  it('matches an upper-case UUID too — the regex is /i', async () => {
    // Not academic: ids pasted from pgAdmin or a log line arrive upper-cased,
    // and the lower-case-only reading of this regex would route a genuine role
    // id down the `role` branch, where an unknown slug is silently demoted to
    // the default role with a 201 (R50).
    const upper = UUID.toUpperCase();
    expect(await addMemberBody(upper)).toEqual({ employeeIds: ['e-1'], roleId: upper });
  });

  it('matches a mixed-case UUID', async () => {
    const mixed = '3F2504e0-4F89-41d3-9A0c-0305E82C3301';
    expect(await addMemberBody(mixed)).toEqual({ employeeIds: ['e-1'], roleId: mixed });
  });

  it('omits the role entirely when the argument is undefined', async () => {
    // Nothing sent means "use the project default" — a deliberate branch, not
    // an accident, and it must not become `{ role: undefined }`.
    const body = await addMemberBody(undefined);
    expect(body).toEqual({ employeeIds: ['e-1'] });
    expect('role' in body).toBe(false);
    expect('roleId' in body).toBe(false);
  });

  it('omits the role for an empty string, rather than sending role: ""', async () => {
    // `''` is falsy, and an empty `role` would be an unknown slug — a 201 that
    // silently assigns the default role instead of an obvious 400.
    expect(await addMemberBody('')).toEqual({ employeeIds: ['e-1'] });
  });

  describe('strings that only LOOK like a uuid go down the slug branch', () => {
    const NEAR_MISSES: [string, string][] = [
      ['3f2504e0-4f89-41d3-9a0c-0305e82c330', 'one hex digit short in the final group'],
      ['3f2504e0-4f89-41d3-9a0c-0305e82c33011', 'one hex digit too many'],
      ['3f2504e0-4f89-41d3-9a0c-0305e82c330g', 'g is not a hex digit'],
      ['3f2504e04f8941d39a0c0305e82c3301', 'no hyphens'],
      ['{3f2504e0-4f89-41d3-9a0c-0305e82c3301}', 'brace-wrapped — the regex is anchored'],
      [' 3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'leading whitespace — also anchored'],
      ['3f2504e0-4f89-41d3-9a0c-0305e82c3301 ', 'trailing whitespace'],
    ];

    for (const [value, why] of NEAR_MISSES) {
      it(`treats "${value}" as a slug (${why})`, async () => {
        expect(await addMemberBody(value)).toEqual({ employeeIds: ['e-1'], role: value });
      });
    }
  });

  it('routes the legacy upper-case preset names NewProjectModal still sends', async () => {
    // `NewProjectModal.submit()` hard-codes the string 'MEMBER'. It survives
    // only because `resolveMemberRole` lower-cases before matching the slug —
    // an implementation detail of the server, pinned here so a change to
    // either side shows up as a failing case rather than as members silently
    // landing on the default role.
    expect(await addMemberBody('MEMBER')).toEqual({ employeeIds: ['e-1'], role: 'MEMBER' });
  });
});

describe('the requests the dispatcher rides on', () => {
  it('addMember posts to the project members collection with the id list intact', async () => {
    post.mockResolvedValue({ data: {} } as never);
    await projectService.addMember(PROJECT_ID, ['e-1', 'e-2'], UUID);

    expect(post).toHaveBeenCalledWith('/projects/p-1/members', {
      employeeIds: ['e-1', 'e-2'],
      roleId: UUID,
    });
  });

  it('updateMemberRole patches the member and sends the role body ALONE', async () => {
    // The whole body is the dispatcher's output here — there is no other field
    // to dilute a wrong branch, so this endpoint is where a mis-dispatch lands
    // squarely on the member's effective permissions.
    expect(await updateMemberBody(UUID)).toEqual({ roleId: UUID });
    expect(patch).toHaveBeenCalledWith('/projects/p-1/members/m-1', { roleId: UUID });
  });

  it('updateMemberRole refuses an empty role instead of sending a role-resetting PATCH', async () => {
    // REGRESSION LOCK (R70, fixed). `updateMemberRole` types `roleOrId` as
    // required, but an empty string still reached the wire as `{}` — and the
    // server's `resolveMemberRole` reads an absent role as "use the project
    // default", so "change this member's role" silently became "reset this
    // member to Member", and answered 200. The caller had no way to tell.
    //
    // An empty argument here is always a caller bug, never an instruction, so
    // the service refuses rather than sending a request whose meaning is the
    // opposite of its name.
    await expect(updateMemberBody('')).rejects.toThrow(/role is required/i);
    await expect(updateMemberBody('   ')).rejects.toThrow(/role is required/i);
  });

  it('a real role still goes through, so the guard has not swallowed the feature', async () => {
    // The control the pin never had: refusing '' is only correct if the two
    // legitimate shapes still reach the wire untouched.
    expect(await updateMemberBody('55555555-5555-4555-8555-555555555555')).toEqual({
      roleId: '55555555-5555-4555-8555-555555555555',
    });
    expect(await updateMemberBody('viewer')).toEqual({ role: 'viewer' });
  });
});
