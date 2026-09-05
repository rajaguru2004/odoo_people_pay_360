import { bootFaceE2EApp, FaceE2EContext } from './utils/face-e2e-app';
import {
  setupAttendanceFixtures,
  AttendanceFixtures,
  pinCompanyTzToMidMorning,
} from './utils/attendance-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * Biometric enrolment: descriptor CRUD, the per-employee cap, the RBAC on
 * registering for somebody else, and the capture endpoints.
 *
 * ── How this runs without TensorFlow ────────────────────────────────────────
 *
 * `FaceRecognitionModule` is deliberately absent from `TestAppModule` because
 * loading the face-api models costs every suite several seconds it does not
 * need. That exclusion is right, but it left the whole `/face-recognition/*`
 * surface answering 404 in e2e rather than failing honestly.
 *
 * `bootFaceE2EApp()` (test/utils/face-e2e-app.ts) writes
 * `face_recognition_enabled = 'false'` BEFORE `Test.compile()`, which makes
 * `onModuleInit` skip the model load while leaving controller, service and
 * database fully wired. Everything asserted below either returns before
 * `extractDescriptor` is ever called, or never touches the model at all:
 *
 *   - the cap 400            counted at L221-227, *before* extraction at L232
 *   - cross-employee 400     role check at L204-211, before everything
 *   - unknown-employee 404   L215-219
 *   - all descriptor reads and deletes — pure Prisma
 *   - the four `capture-*` endpoints — no matching whatsoever
 *   - every `@Roles` denial — RolesGuard runs before the handler body
 *
 * FACE MATCHING ACCURACY IS OUT OF SCOPE. No case here compares two faces or
 * reads a confidence score. The duplicate guard (euclidean < 0.3), the quality
 * floor and the 0.6 match threshold all run *after* extraction and belong in a
 * unit spec with `extractDescriptor` stubbed — they are named in
 * docs/TEST-PLAN-ATTENDANCE.md §9 as explicitly not covered here.
 *
 * This file owns "today" for `nullBranchStaff`.
 */
describe('Attendance — biometric enrolment (e2e)', () => {
  let ctx: FaceE2EContext;
  let fx: AttendanceFixtures;
  let restoreTz: () => Promise<void>;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any) => res.body?.data ?? res.body;
  const rowsOf = (res: any): any[] => {
    if (Array.isArray(res.body)) return res.body;
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  /** A 1x1 transparent PNG. Never decoded — every case stops before extraction. */
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  beforeAll(async () => {
    ctx = await bootFaceE2EApp();
    fx = await setupAttendanceFixtures(ctx);
    restoreTz = await pinCompanyTzToMidMorning(ctx);
  }, 180000);

  afterEach(async () => {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 2);
    from.setUTCHours(0, 0, 0, 0);
    await ctx.prisma.attendance.deleteMany({
      where: { employeeId: fx.nullBranchStaffId, date: { gte: from } },
    });
  });

  afterAll(async () => {
    if (restoreTz) await restoreTz();
    if (fx) await fx.cleanup();
    if (ctx) {
      await ctx.restoreFlag();
      await ctx.app.close();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('enrolment status and descriptor reads', () => {
    it('AFR-API-01 status distinguishes an enrolled employee from an unenrolled one', async () => {
      const enrolled = await ctx
        .http()
        .get('/face-recognition/status')
        .set(bearer(fx.employee.token));
      expect(enrolled.status).toBe(200);
      // The fixture gives `puncher` two descriptors, written straight through
      // Prisma — `descriptor` is a plain Float[], so no model is involved.
      expect(body(enrolled)).toContain('2');

      const unenrolled = await ctx
        .http()
        .get('/face-recognition/status')
        .set(bearer(fx.otherEmployee.token));
      expect(unenrolled.status).toBe(200);
    });

    it('AFR-API-02 descriptors/me returns only the caller’s own', async () => {
      const res = await ctx
        .http()
        .get('/face-recognition/descriptors/me')
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);
      const rows = rowsOf(res);
      expect(rows).toHaveLength(2);

      // The payload deliberately does NOT echo `employeeId` — it is a
      // self-scoped endpoint, so the owner is implied by the caller. Ownership
      // is therefore verified against the rows themselves rather than against a
      // field the response was never going to carry.
      const ids = rows.map((r) => r.id);
      const owners = await ctx.prisma.faceDescriptor.findMany({
        where: { id: { in: ids } },
        select: { employeeId: true },
      });
      expect(owners).toHaveLength(2);
      expect(owners.every((o) => o.employeeId === fx.puncherId)).toBe(true);
    });

    it('AFR-API-03 descriptors/me for an unenrolled employee is empty, not a 404', async () => {
      const res = await ctx
        .http()
        .get('/face-recognition/descriptors/me')
        .set(bearer(fx.otherEmployee.token));
      expect(res.status).toBe(200);
      expect(rowsOf(res)).toEqual([]);
    });

    it('AFR-API-04 reading another employee’s descriptors is ADMIN/HR only', async () => {
      const path = `/face-recognition/descriptors/${fx.puncherId}`;
      expect(
        (await ctx.http().get(path).set(bearer(fx.admin.token))).status,
      ).toBe(200);
      expect((await ctx.http().get(path).set(bearer(fx.hr.token))).status).toBe(
        200,
      );
      expect((await ctx.http().get(path).set(bearer(fx.mgr.token))).status).toBe(
        403,
      );
      expect(
        (await ctx.http().get(path).set(bearer(fx.employee.token))).status,
      ).toBe(403);
      expect((await ctx.http().get(path)).status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('registering, up to the point where a model would be needed', () => {
    /**
     * The cap check sits at L221-227, BEFORE `extractDescriptor` at L232 —
     * which is the whole reason this arm is reachable with a one-pixel payload
     * and no models loaded. `finStaff` carries exactly
     * FACE_RECOGNITION_MAX_DESCRIPTORS (5) from the fixture.
     */
    it('AFR-API-05 the five-descriptor cap is refused before any image is decoded', async () => {
      const res = await ctx
        .http()
        .post('/face-recognition/register')
        .set(bearer(fx.hr.token))
        .send({ image: TINY_PNG, employeeId: fx.finStaffId });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Maximum limit of 5 images reached');
    });

    it('AFR-API-06 an employee cannot enrol a face for somebody else', async () => {
      const res = await ctx
        .http()
        .post('/face-recognition/register')
        .set(bearer(fx.employee.token))
        .send({ image: TINY_PNG, employeeId: fx.puncher2Id });
      expect(res.status).toBe(400);
      expect(body(res)).toContain(
        'You do not have permission to register a face for another employee.',
      );
    });

    it('AFR-API-07 a MANAGER cannot enrol a face for somebody else either', async () => {
      const res = await ctx
        .http()
        .post('/face-recognition/register')
        .set(bearer(fx.mgr.token))
        .send({ image: TINY_PNG, employeeId: fx.puncherId });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('do not have permission');
    });

    it('AFR-API-08 an unknown employee is a 404, ahead of the cap and the model', async () => {
      const res = await ctx
        .http()
        .post('/face-recognition/register')
        .set(bearer(fx.hr.token))
        .send({
          image: TINY_PNG,
          employeeId: '00000000-0000-0000-0000-000000000000',
        });
      expect(res.status).toBe(404);
      expect(body(res)).toContain('Employee not found');
    });

    it('AFR-API-09 registration requires authentication', async () => {
      const res = await ctx
        .http()
        .post('/face-recognition/register')
        .send({ image: TINY_PNG });
      expect(res.status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('deleting a descriptor', () => {
    it('AFR-API-10 an employee deletes their own descriptor', async () => {
      const own = await ctx.prisma.faceDescriptor.create({
        data: {
          employeeId: fx.puncherId,
          descriptor: Array.from({ length: 128 }, (_, i) => i * 0.5),
          quality: 0.9,
        },
      });
      const res = await ctx
        .http()
        .delete(`/face-recognition/descriptors/${own.id}`)
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);

      const gone = await ctx.prisma.faceDescriptor.findUnique({
        where: { id: own.id },
      });
      expect(gone).toBeNull();
    });

    /**
     * The controller picks between `deleteDescriptor(id, employeeId)` and
     * `deleteDescriptorAdmin(id)` on ROLE (L191-194), so the two branches are
     * asserted separately — a single case could pass on either one.
     */
    it('AFR-API-11 an employee cannot delete a colleague’s descriptor', async () => {
      const theirs = await ctx.prisma.faceDescriptor.create({
        data: {
          employeeId: fx.puncher2Id,
          descriptor: Array.from({ length: 128 }, (_, i) => i * 0.25),
          quality: 0.9,
        },
      });
      const res = await ctx
        .http()
        .delete(`/face-recognition/descriptors/${theirs.id}`)
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(404);

      const still = await ctx.prisma.faceDescriptor.findUnique({
        where: { id: theirs.id },
      });
      expect(still).toBeTruthy();
      await ctx.prisma.faceDescriptor.delete({ where: { id: theirs.id } });
    });

    it('AFR-API-12 an ADMIN deletes anybody’s descriptor', async () => {
      const theirs = await ctx.prisma.faceDescriptor.create({
        data: {
          employeeId: fx.puncher2Id,
          descriptor: Array.from({ length: 128 }, (_, i) => i * 0.125),
          quality: 0.9,
        },
      });
      const res = await ctx
        .http()
        .delete(`/face-recognition/descriptors/${theirs.id}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
    });

    it('AFR-API-13 a malformed descriptor id is a 400, not a 500', async () => {
      const res = await ctx
        .http()
        .delete('/face-recognition/descriptors/not-a-uuid')
        .set(bearer(fx.admin.token));
      // This controller carries ParseUUIDPipe, which the employees controller
      // lacked until People's P27 — so the repo path never leaks from here.
      expect(res.status).toBe(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the capture endpoints', () => {
    /**
     * A7 — the highest-severity finding of the phase.
     *
     * `attendance_face_only = true` is the switch a site turns on when it wants
     * attendance to be provable: no face, no punch. `POST /attendances/check-in`
     * honours it and refuses.
     *
     * `POST /face-recognition/capture-check-in` does not. It calls
     * `attendancesService.checkIn(id, byFace = true)` after
     * `uploadAttendanceImage`, which **swallows every error** — so the payload
     * need not be an image, nothing is matched against anything, and no
     * `face_recognition_enabled` check happens either. Any authenticated
     * employee posts an arbitrary string and is punched in, with the row marked
     * as face-verified.
     *
     * `verifyEmployeeFace` in the same file documents exactly why this is
     * dangerous ("catastrophic from a chat where anyone can send any photo") and
     * then leaves these four HTTP doors as they are.
     */
    it('AFR-API-14 KNOWN GAP: capture-check-in bypasses the face-only switch with junk input', async () => {
      await withSetting(ctx, 'attendance_face_only', 'true', async () => {
        // The guarded door refuses, which is the control.
        const guarded = await ctx
          .http()
          .post('/attendances/check-in')
          .set(bearer(fx.employee.token))
          .send({});
        expect(guarded.status).toBe(400);
        expect(body(guarded)).toContain('face verification');

        // The unguarded one accepts a string that is not an image at all.
        const captured = await ctx
          .http()
          .post('/face-recognition/capture-check-in')
          .set(bearer(fx.employee.token))
          .send({ image: 'not-an-image-at-all' });
        expect(captured.status).toBe(201);

        const row = await ctx.prisma.attendance.findFirst({
          where: { employeeId: fx.puncherId },
          orderBy: { createdAt: 'desc' },
        });
        expect(row).toBeTruthy();
        expect(row!.status).toBe('PRESENT');

        await ctx.prisma.attendance.deleteMany({
          where: { employeeId: fx.puncherId, id: row!.id },
        });
      });
    });

    it.failing(
      'AFR-API-14b capture-check-in should honour the face-only switch',
      async () => {
        await withSetting(ctx, 'attendance_face_only', 'true', async () => {
          const res = await ctx
            .http()
            .post('/face-recognition/capture-check-in')
            .set(bearer(fx.employee.token))
            .send({ image: 'not-an-image-at-all' });
          expect(res.status).toBe(400);
        });
      },
    );

    it('AFR-API-15 the capture endpoints require authentication', async () => {
      for (const path of [
        '/face-recognition/capture-check-in',
        '/face-recognition/capture-check-out',
        '/face-recognition/capture-lunch-check-in',
        '/face-recognition/capture-lunch-check-out',
      ]) {
        const res = await ctx.http().post(path).send({ image: TINY_PNG });
        expect(res.status).toBe(401);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the recognition endpoints, guard behaviour only', () => {
    /**
     * `RolesGuard` runs before the handler body, so these denials are provable
     * with no model loaded. The 2xx paths extract a descriptor first and are
     * out of scope — see the file header.
     */
    it('AFR-API-16 the self-test endpoint is ADMIN/HR only', async () => {
      expect(
        (
          await ctx
            .http()
            .post('/face-recognition/test')
            .set(bearer(fx.mgr.token))
            .send({ image: TINY_PNG })
        ).status,
      ).toBe(403);
      expect(
        (
          await ctx
            .http()
            .post('/face-recognition/test')
            .set(bearer(fx.employee.token))
            .send({ image: TINY_PNG })
        ).status,
      ).toBe(403);
      expect(
        (await ctx.http().post('/face-recognition/test').send({})).status,
      ).toBe(401);
    });

    it('AFR-API-17 the matching endpoints refuse an anonymous caller', async () => {
      for (const path of [
        '/face-recognition/check-in',
        '/face-recognition/check-out',
        '/face-recognition/lunch-check-in',
        '/face-recognition/lunch-check-out',
      ]) {
        expect((await ctx.http().post(path).send({ image: TINY_PNG })).status).toBe(
          401,
        );
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('branch scoping of descriptors', () => {
    /**
     * `FaceDescriptor` is a `relation`-rule model scoped through
     * `employee.branchId`, and `findMany` IS intercepted by the middleware — so
     * a scoped HR reading a foreign employee's descriptors gets an EMPTY LIST
     * rather than the 404 `assertInBranch` would produce. Worth asserting as the
     * behaviour it is: the two mechanisms disagree about how to say no, and a
     * reader who expects 404 everywhere would call this a bug.
     */
    it('AFR-API-18 a scoped HR sees no descriptors for a foreign employee, rather than a 404', async () => {
      await ctx.prisma.faceDescriptor.create({
        data: {
          employeeId: fx.foreignStaffId,
          descriptor: Array.from({ length: 128 }, (_, i) => i * 0.75),
          quality: 0.9,
        },
      });

      const res = await ctx
        .http()
        .get(`/face-recognition/descriptors/${fx.foreignStaffId}`)
        .set(bearer(fx.scopedHr.token))
        .set('X-Branch-Id', fx.branchHome);
      expect(res.status).toBe(200);
      expect(rowsOf(res)).toEqual([]);

      const asGlobal = await ctx
        .http()
        .get(`/face-recognition/descriptors/${fx.foreignStaffId}`)
        .set(bearer(fx.admin.token));
      expect(rowsOf(asGlobal)).toHaveLength(1);
    });
  });
});
