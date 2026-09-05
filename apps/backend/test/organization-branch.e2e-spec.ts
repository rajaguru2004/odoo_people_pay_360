import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupOrgFixtures, OrgFixtures, bearer } from './utils/org-fixtures';
import { SystemSettingsService } from '../src/system-settings/system-settings.service';
import { HolidaysService } from '../src/holidays/holidays.service';

/**
 * Branch, end to end.
 *
 * `multi-branch.e2e-spec.ts` proves the branch SCOPING engine — that a row
 * belonging to one branch is invisible from another. This suite is about the
 * branch record itself: who may create, read, change and remove one, what the
 * server refuses and with which words, and what a branch's own configuration
 * changes downstream (office hours, the weekly-off calendar).
 *
 * Two things here are deliberately pinning tests rather than assertions of
 * correct behaviour. Each is marked `KNOWN GAP` with the reason and a
 * `it.failing` twin naming the behaviour we want, so the day it is fixed the
 * suite goes red and the pin gets removed.
 */
describe('Organization — Branch (e2e)', () => {
  let ctx: E2EContext;
  let fx: OrgFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };
  const codesOf = (res: any) => rowsOf(res).map((b: any) => b.code);

  /** Branches created by a test, removed hard in afterAll. */
  const created: string[] = [];
  const create = async (token: string, payload: Record<string, unknown>) => {
    const res = await ctx
      .http()
      .post('/branches')
      .set(bearer(token))
      .send(payload);
    if (res.status === 201 && res.body?.data?.id)
      created.push(res.body.data.id);
    return res;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupOrgFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (ctx && created.length) {
      await ctx.prisma.branch.deleteMany({ where: { id: { in: created } } });
    }
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Read ──────────────────────────────────────────────────────────────────
  describe('reading branches', () => {
    it('BR-API-01 lists only active branches, ordered by code, with manager and staff count', async () => {
      const res = await ctx.http().get('/branches').set(bearer(fx.admin.token));
      expect(res.status).toBe(200);

      const rows = rowsOf(res);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((b: any) => b.isActive)).toBe(true);

      // Ordered by code — asserted on the three fixture branches only. Comparing
      // the whole list against a JavaScript sort would encode the wrong
      // collation: Postgres orders `E2E-BR2` before `E2E-BR-X` (its collation
      // weights punctuation after alphanumerics), while JS compares code points
      // and puts `-` first. These three differ in a single letter, so every
      // collation agrees about them.
      const codes = rows.map((b: any) => b.code);
      const fixtureOrder = codes.filter(
        (c: string) => c.startsWith(`ORG-`) && c.endsWith(fx.runId),
      );
      expect(fixtureOrder).toEqual([
        fx.branchAcode,
        fx.branchBcode,
        fx.branchCcode,
      ]);

      const mine = rows.find((b: any) => b.code === fx.branchAcode);
      expect(mine).toBeDefined();
      expect(mine._count).toHaveProperty('employees');
      expect(mine).toHaveProperty('manager');
    });

    it('BR-API-02 admits ADMIN, HR and MANAGER; refuses EMPLOYEE and anonymous', async () => {
      const get = (token?: string) => {
        const r = ctx.http().get('/branches');
        return token ? r.set(bearer(token)) : r;
      };

      expect((await get(fx.admin.token)).status).toBe(200);
      expect((await get(fx.hr.token)).status).toBe(200);
      expect((await get(fx.deptManager.token)).status).toBe(200);
      expect((await get(fx.employee.token)).status).toBe(403);
      expect((await get()).status).toBe(401);
    });

    it('BR-API-03 reads one by id; unknown id is 404 and does not leak', async () => {
      const ok = await ctx
        .http()
        .get(`/branches/${fx.branchA}`)
        .set(bearer(fx.admin.token));
      expect(ok.status).toBe(200);
      expect(ok.body.data.code).toBe(fx.branchAcode);

      const missing = await ctx
        .http()
        .get('/branches/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token));
      expect(missing.status).toBe(404);
    });

    it('BR-API-03b refuses a malformed id as bad input, not as a server fault', async () => {
      // ParseUUIDPipe, added because `:id` used to reach Prisma unparsed and
      // throw — client input decided whether the server reported a fault of its
      // own, which is an availability and noise problem, not cosmetics.
      const res = await ctx
        .http()
        .get('/branches/not-a-uuid')
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(400);
    });
  });

  // ── Create ────────────────────────────────────────────────────────────────
  describe('creating a branch', () => {
    it('BR-API-04 accepts code and name alone, and leaves config inheriting', async () => {
      const res = await create(fx.admin.token, {
        code: `ORG-MIN-${fx.runId}`,
        name: 'Minimal Branch',
      });
      expect(res.status).toBe(201);

      const b = res.body.data;
      expect(b.isActive).toBe(true);
      // null, not a value: the branch inherits the company default until told
      // otherwise. A default written here would silently de-globalize config.
      expect(b.timezone).toBeNull();
      expect(b.officeStartTime).toBeNull();
      expect(b.officeEndTime).toBeNull();
      expect(b.weeklyOffDays).toBeNull();
    });

    it('BR-API-05 round-trips every field it was given', async () => {
      const payload = {
        code: `ORG-FULL-${fx.runId}`,
        name: 'Full Branch',
        description: 'Every field set',
        addressLine: '1 Test Road',
        city: 'Muscat',
        state: 'Muscat',
        country: 'OM',
        postalCode: '100',
        timezone: 'Asia/Muscat',
        officeStartTime: '08:00',
        officeEndTime: '16:30',
        weeklyOffDays: '5,6',
        geofencingEnabled: true,
        latitude: 23.588,
        longitude: 58.3829,
        geofenceRadiusM: 150,
        managerId: fx.seniorCandidateId,
      };
      const res = await create(fx.admin.token, payload);
      expect(res.status).toBe(201);

      const read = await ctx
        .http()
        .get(`/branches/${res.body.data.id}`)
        .set(bearer(fx.admin.token));
      const b = read.body.data;
      expect(b.city).toBe('Muscat');
      expect(b.country).toBe('OM');
      expect(b.timezone).toBe('Asia/Muscat');
      expect(b.officeStartTime).toBe('08:00');
      expect(b.officeEndTime).toBe('16:30');
      expect(b.weeklyOffDays).toBe('5,6');
      expect(b.geofencingEnabled).toBe(true);
      expect(Number(b.latitude)).toBeCloseTo(23.588, 3);
      expect(Number(b.longitude)).toBeCloseTo(58.3829, 3);
      expect(b.geofenceRadiusM).toBe(150);
      expect(b.managerId).toBe(fx.seniorCandidateId);
    });

    it('BR-API-06 refuses a duplicate code with 409 and names the reason', async () => {
      const res = await create(fx.admin.token, {
        code: fx.branchAcode,
        name: 'Duplicate',
      });
      expect(res.status).toBe(409);
      expect(body(res)).toContain('Branch code already exists');
    });

    it('BR-API-07 treats a differently-cased code as a different branch', async () => {
      // KNOWN BEHAVIOUR, worth pinning: the unique index is case-sensitive, so
      // "ho" and "HO" can coexist and a user reading the list sees what looks
      // like the same branch twice. Not a bug the tests should hide.
      const res = await create(fx.admin.token, {
        code: fx.branchAcode.toLowerCase(),
        name: 'Lowercased twin',
      });
      expect(res.status).toBe(201);
    });

    it('BR-API-08 refuses an unknown manager with 400', async () => {
      const res = await create(fx.admin.token, {
        code: `ORG-NOMGR-${fx.runId}`,
        name: 'No such manager',
        managerId: '00000000-0000-0000-0000-000000000000',
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Manager not found');
    });

    it.each([
      ['code longer than 50', { code: 'C'.repeat(51), name: 'x' }],
      ['name longer than 255', { code: 'ORG-V1', name: 'N'.repeat(256) }],
      ['country longer than 2', { code: 'ORG-V2', name: 'x', country: 'OMN' }],
      [
        'office start without a leading zero',
        { code: 'ORG-V3', name: 'x', officeStartTime: '9:00' },
      ],
      [
        'an impossible hour',
        { code: 'ORG-V4', name: 'x', officeStartTime: '25:00' },
      ],
      [
        'an impossible minute',
        { code: 'ORG-V5', name: 'x', officeEndTime: '18:60' },
      ],
      [
        'a weekly-off day out of range',
        { code: 'ORG-V6', name: 'x', weeklyOffDays: '7' },
      ],
      [
        'a non-numeric weekly-off day',
        { code: 'ORG-V7', name: 'x', weeklyOffDays: 'mon' },
      ],
      ['a latitude past the pole', { code: 'ORG-V8', name: 'x', latitude: 91 }],
      [
        'a latitude past the south pole',
        { code: 'ORG-V9', name: 'x', latitude: -91 },
      ],
      [
        'a longitude past the date line',
        { code: 'ORG-V10', name: 'x', longitude: 181 },
      ],
      ['a zero radius', { code: 'ORG-V11', name: 'x', geofenceRadiusM: 0 }],
      [
        'a negative radius',
        { code: 'ORG-V12', name: 'x', geofenceRadiusM: -5 },
      ],
      [
        'a fractional radius',
        { code: 'ORG-V13', name: 'x', geofenceRadiusM: 1.5 },
      ],
      [
        'a timezone longer than 100',
        { code: 'ORG-V14', name: 'x', timezone: 'Z'.repeat(101) },
      ],
      [
        'a postal code longer than 20',
        { code: 'ORG-V15', name: 'x', postalCode: '1'.repeat(21) },
      ],
      ['an unknown field', { code: 'ORG-V16', name: 'x', notAField: true }],
      ['no code at all', { name: 'x' }],
      ['no name at all', { code: 'ORG-V17' }],
    ])('BR-API-09 refuses %s', async (_label, payload) => {
      const res = await create(fx.admin.token, {
        ...(payload as Record<string, unknown>),
        code: (payload as any).code
          ? `${(payload as any).code}-${fx.runId}`
          : undefined,
      });
      expect(res.status).toBe(400);
    });

    it('BR-API-10 accepts the boundary values on every ranged field', async () => {
      const res = await create(fx.admin.token, {
        code: `ORG-EDGE-${fx.runId}`,
        name: 'Edges',
        officeStartTime: '00:00',
        officeEndTime: '23:59',
        weeklyOffDays: '0,1,2,3,4,5,6',
        latitude: -90,
        longitude: 180,
        geofenceRadiusM: 1,
        country: 'OM',
      });
      expect(res.status).toBe(201);
    });

    it('BR-API-11 refuses MANAGER and EMPLOYEE', async () => {
      const asManager = await create(fx.deptManager.token, {
        code: `ORG-MGR-${fx.runId}`,
        name: 'nope',
      });
      const asEmployee = await create(fx.employee.token, {
        code: `ORG-EMP-${fx.runId}`,
        name: 'nope',
      });
      expect(asManager.status).toBe(403);
      expect(asEmployee.status).toBe(403);
    });

    it('BR-API-25 lets exactly one of two simultaneous creates win the code', async () => {
      const code = `ORG-RACE-${fx.runId}`;
      const [a, b] = await Promise.all([
        ctx
          .http()
          .post('/branches')
          .set(bearer(fx.admin.token))
          .send({ code, name: 'race A' }),
        ctx
          .http()
          .post('/branches')
          .set(bearer(fx.admin.token))
          .send({ code, name: 'race B' }),
      ]);
      for (const r of [a, b]) {
        if (r.status === 201) created.push(r.body.data.id);
      }

      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      // The read-then-write in the service can let both through the check, but
      // the unique index still refuses the second write — so the second answer
      // is a refusal, whether the service (409) or Prisma (500 → 400) produced
      // it. What must never happen is two branches with the same code.
      expect(statuses[1]).not.toBe(201);

      const rows = await ctx.prisma.branch.findMany({ where: { code } });
      expect(rows).toHaveLength(1);
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────
  describe('updating a branch', () => {
    let target: string;

    beforeAll(async () => {
      const res = await create(fx.admin.token, {
        code: `ORG-UPD-${fx.runId}`,
        name: 'Update target',
      });
      target = res.body.data.id;
    });

    it('BR-API-12 changes fields, allows re-sending its own code, refuses a taken one', async () => {
      const renamed = await ctx
        .http()
        .patch(`/branches/${target}`)
        .set(bearer(fx.admin.token))
        .send({ name: 'Renamed', city: 'Bengaluru' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data.name).toBe('Renamed');
      expect(renamed.body.data.city).toBe('Bengaluru');

      const sameCode = await ctx
        .http()
        .patch(`/branches/${target}`)
        .set(bearer(fx.admin.token))
        .send({ code: `ORG-UPD-${fx.runId}`, name: 'Still fine' });
      expect(sameCode.status).toBe(200);

      const takenCode = await ctx
        .http()
        .patch(`/branches/${target}`)
        .set(bearer(fx.admin.token))
        .send({ code: fx.branchAcode });
      expect(takenCode.status).toBe(409);
      expect(body(takenCode)).toContain('Branch code already exists');
    });

    it('BR-API-13 refuses an unknown branch (404) and an unknown manager (400)', async () => {
      const unknownBranch = await ctx
        .http()
        .patch('/branches/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token))
        .send({ name: 'ghost' });
      expect(unknownBranch.status).toBe(404);

      const unknownManager = await ctx
        .http()
        .patch(`/branches/${target}`)
        .set(bearer(fx.admin.token))
        .send({ managerId: '00000000-0000-0000-0000-000000000000' });
      expect(unknownManager.status).toBe(400);
      expect(body(unknownManager)).toContain('Manager not found');
    });

    it('BR-API-18 hides a branch deactivated through PATCH, and brings it back', async () => {
      const off = await ctx
        .http()
        .patch(`/branches/${target}`)
        .set(bearer(fx.admin.token))
        .send({ isActive: false });
      expect(off.status).toBe(200);

      const hidden = await ctx
        .http()
        .get('/branches')
        .set(bearer(fx.admin.token));
      expect(codesOf(hidden)).not.toContain(`ORG-UPD-${fx.runId}`);

      const on = await ctx
        .http()
        .patch(`/branches/${target}`)
        .set(bearer(fx.admin.token))
        .send({ isActive: true });
      expect(on.status).toBe(200);

      const back = await ctx
        .http()
        .get('/branches')
        .set(bearer(fx.admin.token));
      expect(codesOf(back)).toContain(`ORG-UPD-${fx.runId}`);
    });

    it('BR-API-18b lists a retired branch only when includeInactive is asked for', async () => {
      // BR-API-18 proves PATCH can bring a branch back. It could not be REACHED
      // to do so: retired branches are filtered out of the list and `findOne`
      // 404s on them, so deactivation was a one-way door through the UI.
      const code = `ORG-RET-${fx.runId}`;
      const made = await create(fx.admin.token, { code, name: 'Retired site' });
      expect(made.status).toBe(201);
      const id = made.body.data.id;

      const off = await ctx
        .http()
        .patch(`/branches/${id}`)
        .set(bearer(fx.admin.token))
        .send({ isActive: false });
      expect(off.status).toBe(200);

      // The default list is what every branch picker reads — it must not change.
      const plain = await ctx.http().get('/branches').set(bearer(fx.admin.token));
      expect(codesOf(plain)).not.toContain(code);

      const withRetired = await ctx
        .http()
        .get('/branches?includeInactive=true')
        .set(bearer(fx.admin.token));
      expect(withRetired.status).toBe(200);
      expect(codesOf(withRetired)).toContain(code);
      expect(rowsOf(withRetired).find((b: any) => b.code === code)?.isActive).toBe(
        false,
      );
      // The active filter is DROPPED, not inverted — live branches stay listed.
      expect(codesOf(withRetired)).toContain(fx.branchAcode);
    });

    it('BR-API-18c ignores includeInactive for a MANAGER', async () => {
      // MANAGER may read the list (pickers need it) but may not reactivate, so
      // there is no reason to show them sites nobody can act on.
      const res = await ctx
        .http()
        .get('/branches?includeInactive=true')
        .set(bearer(fx.deptManager.token));
      expect(res.status).toBe(200);
      expect(rowsOf(res).every((b: any) => b.isActive)).toBe(true);
    });

    it('BR-API-17 refuses MANAGER and EMPLOYEE on update and delete', async () => {
      const upd = await ctx
        .http()
        .patch(`/branches/${target}`)
        .set(bearer(fx.deptManager.token))
        .send({ name: 'nope' });
      const del = await ctx
        .http()
        .delete(`/branches/${target}`)
        .set(bearer(fx.employee.token));
      expect(upd.status).toBe(403);
      expect(del.status).toBe(403);
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  describe('deleting a branch', () => {
    it('BR-API-15 refuses while employees are still assigned', async () => {
      const res = await ctx
        .http()
        .delete(`/branches/${fx.branchA}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Cannot delete branch with employees');
    });

    it('BR-API-14 soft-deletes an empty branch — gone from the list, still readable by id', async () => {
      const del = await ctx
        .http()
        .delete(`/branches/${fx.branchC}`)
        .set(bearer(fx.admin.token));
      expect(del.status).toBe(200);

      const row = await ctx.prisma.branch.findUnique({
        where: { id: fx.branchC },
      });
      expect(row?.isActive).toBe(false);

      const list = await ctx
        .http()
        .get('/branches')
        .set(bearer(fx.admin.token));
      expect(codesOf(list)).not.toContain(fx.branchCcode);

      // And gone by id too: a stale link must not keep working, and an edit
      // form must not keep saving into somewhere nobody can see.
      const byId = await ctx
        .http()
        .get(`/branches/${fx.branchC}`)
        .set(bearer(fx.admin.token));
      expect(byId.status).toBe(404);
    });

    it('BR-API-16 answers a repeated delete without failing, and 404s an unknown one', async () => {
      const again = await ctx
        .http()
        .delete(`/branches/${fx.branchC}`)
        .set(bearer(fx.admin.token));
      expect(again.status).toBe(200);

      const unknown = await ctx
        .http()
        .delete('/branches/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token));
      expect(unknown.status).toBe(404);
    });
  });

  // ── Scoping ───────────────────────────────────────────────────────────────
  describe('branch scoping of the branch record itself', () => {
    /** A branch that has been soft-deleted, created once and reused. */
    let dead: string | null = null;
    const deadBranchId = async (): Promise<string> => {
      if (dead) return dead;
      const res = await create(fx.admin.token, {
        code: `ORG-DEAD-${fx.runId}`,
        name: 'Closing branch',
      });
      dead = res.body.data.id;
      await ctx.http().delete(`/branches/${dead}`).set(bearer(fx.admin.token));
      return dead!;
    };

    let hireSeq = 0;
    const hireInto = (branchId: string) =>
      ctx
        .http()
        .post('/employees')
        .set(bearer(fx.admin.token))
        .send({
          fullName: `Ghost Hire ${fx.runId}`,
          email: `ghost${hireSeq++}-${fx.runId}@test.local`,
          departmentId: fx.topDeptId,
          branchId,
          position: 'Engineer',
          startDate: new Date().toISOString().slice(0, 10),
          dateOfBirth: '1995-01-01',
          baseSalary: 1000,
          status: 'ACTIVE',
          autoGenerateIdCard: true,
        });

    it('BR-API-20 a branch-scoped HR sees only the branches they were granted', async () => {
      // `Branch` cannot be covered by the branch-scope map — its identity IS the
      // branch, so there is no branchId column to filter on — and it was
      // therefore the one record the branch engine did not protect.
      const list = await ctx
        .http()
        .get('/branches')
        .set(bearer(fx.scopedHr.token));
      expect(list.status).toBe(200);
      expect(codesOf(list)).toContain(fx.branchAcode);
      expect(codesOf(list)).not.toContain(fx.branchBcode);
    });

    it('BR-API-20b a scoped HR cannot read, change or remove a branch outside its grant', async () => {
      const read = await ctx
        .http()
        .get(`/branches/${fx.branchB}`)
        .set(bearer(fx.scopedHr.token));
      // 404, not 403: the shape of the refusal must not reveal that the branch
      // exists — the same rule assertInBranch follows everywhere else.
      expect(read.status).toBe(404);

      const write = await ctx
        .http()
        .patch(`/branches/${fx.branchB}`)
        .set(bearer(fx.scopedHr.token))
        .send({ description: 'written from outside the grant' });
      expect(write.status).toBe(404);

      const remove = await ctx
        .http()
        .delete(`/branches/${fx.branchB}`)
        .set(bearer(fx.scopedHr.token));
      expect(remove.status).toBe(404);

      const branch = await ctx.prisma.branch.findUnique({
        where: { id: fx.branchB },
      });
      expect(branch?.isActive).toBe(true);
      expect(branch?.description).toBeNull();
    });

    it('BR-API-20c a scoped HR keeps the branch they opened themselves', async () => {
      // The other half of the rule above. Scoping the list to the envelope means
      // a scoped HR would otherwise create a branch and watch it disappear, so
      // the creator is granted access to what they just opened — a new, empty
      // branch, which widens their reach over nothing that already existed.
      const res = await ctx
        .http()
        .post('/branches')
        .set(bearer(fx.scopedHr.token))
        .send({ code: `ORG-HROWN-${fx.runId}`, name: 'Opened by scoped HR' });
      expect(res.status).toBe(201);
      created.push(res.body.data.id);

      const list = await ctx
        .http()
        .get('/branches')
        .set(bearer(fx.scopedHr.token));
      expect(codesOf(list)).toContain(`ORG-HROWN-${fx.runId}`);
      // And still not the one they were never granted.
      expect(codesOf(list)).not.toContain(fx.branchBcode);

      const edit = await ctx
        .http()
        .patch(`/branches/${res.body.data.id}`)
        .set(bearer(fx.scopedHr.token))
        .send({ city: 'Salalah' });
      expect(edit.status).toBe(200);
    });

    it('BR-API-21 X-Branch-Id does not narrow the branch list', async () => {
      const res = await ctx
        .http()
        .get('/branches')
        .set(bearer(fx.admin.token))
        .set('X-Branch-Id', fx.branchA);
      expect(res.status).toBe(200);
      // The header selects a working context for scoped models; the branch list
      // is the picker's own source and must keep showing everywhere the user
      // may switch to.
      expect(codesOf(res)).toEqual(
        expect.arrayContaining([fx.branchAcode, fx.branchBcode]),
      );
    });

    it('BR-API-22 refuses to hire into a soft-deleted branch', async () => {
      // The check used to be existence only, so a closed branch kept accepting
      // staff — who then held a branch that appears in no list and no picker,
      // and whose presence re-armed the delete guard on it.
      const res = await hireInto(await deadBranchId());
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Branch is not active');

      const hires = await ctx.prisma.employee.count({
        where: { branchId: await deadBranchId() },
      });
      expect(hires).toBe(0);
    });
  });

  // ── What a branch's configuration changes ─────────────────────────────────
  describe('per-branch configuration takes effect', () => {
    it('BR-API-23 office hours resolve from the branch, and fall back when cleared', async () => {
      const settings = ctx.app.get(SystemSettingsService);

      await ctx
        .http()
        .patch(`/branches/${fx.branchA}`)
        .set(bearer(fx.admin.token))
        .send({ officeStartTime: '07:15', officeEndTime: '15:45' });

      const overridden = await settings.getOfficeHours(fx.branchA);
      expect(overridden.start).toBe('07:15');
      expect(overridden.end).toBe('15:45');

      // Branch B never set hours, so it must answer with the company default —
      // proving the override is per branch and not a global write.
      const global = await settings.getOfficeHours(fx.branchB);
      expect(global.start).not.toBe('07:15');

      await ctx
        .http()
        .patch(`/branches/${fx.branchA}`)
        .set(bearer(fx.admin.token))
        .send({ officeStartTime: '09:00', officeEndTime: '18:00' });
    });

    it('BR-API-24 the weekly-off calendar follows the branch that owns it', async () => {
      const holidays = ctx.app.get(HolidaysService);

      // 2026-09-05 is a Saturday, 2026-09-06 a Sunday.
      const saturday = new Date('2026-09-05T00:00:00.000Z');

      await ctx
        .http()
        .patch(`/branches/${fx.branchA}`)
        .set(bearer(fx.admin.token))
        .send({ weeklyOffDays: '6' });

      const offForA = await holidays.isWeeklyOff(saturday, fx.branchA);
      expect(offForA).toBe(true);

      await ctx
        .http()
        .patch(`/branches/${fx.branchA}`)
        .set(bearer(fx.admin.token))
        .send({ weeklyOffDays: '0' });

      const nowWorking = await holidays.isWeeklyOff(saturday, fx.branchA);
      expect(nowWorking).toBe(false);

      await ctx
        .http()
        .patch(`/branches/${fx.branchA}`)
        .set(bearer(fx.admin.token))
        .send({ weeklyOffDays: null });
    });
  });

  // ── Audit ─────────────────────────────────────────────────────────────────
  describe('the audit trail', () => {
    it('BR-API-19 records who created, changed and removed a branch', async () => {
      const res = await create(fx.admin.token, {
        code: `ORG-AUD-${fx.runId}`,
        name: 'Audited',
      });
      const id = res.body.data.id;

      await ctx
        .http()
        .patch(`/branches/${id}`)
        .set(bearer(fx.admin.token))
        .send({ name: 'Audited (renamed)' });
      await ctx.http().delete(`/branches/${id}`).set(bearer(fx.admin.token));

      const rows = await ctx.prisma.auditLog.findMany({
        where: { resourceType: 'Branch', userId: fx.admin.userId },
        select: { action: true, resourceId: true },
      });
      const actions = rows
        .filter((r) => r.resourceId === id)
        .map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['UPDATE', 'DELETE']));
      expect(rows.some((r) => r.action === 'CREATE')).toBe(true);
    });
  });
});
