import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupLeaveOvertimeFixtures,
  LeaveOtFixtures,
  freeWindow,
  attachmentFile,
} from './utils/leave-overtime-fixtures';
import { bearer } from './utils/settings';

/**
 * Leave attachments, end to end.
 *
 * ── Why this file could not exist before WP-0 ───────────────────────────────
 *
 * `LeaveAttachmentsModule` was imported by `src/app.module.ts` and by nothing
 * else — it was absent from `test/utils/test-app.module.ts`. Every request to
 * `/leave-requests/:id/attachments` therefore answered **404 rather than
 * failing honestly**, exactly the class of lie Phase 3 found with
 * `AttendanceCorrectionsModule`. A suite written against that would have
 * "passed" by asserting nothing at all.
 *
 * ── The shape of what it finds ──────────────────────────────────────────────
 *
 * `remove()` always authorised properly: owner, ADMIN, HR, or the department
 * manager. `uploadAndCreate()` and `findByLeaveRequest()` authorised **not at
 * all** — no ownership check, no department check, no branch check — and
 * `LeaveAttachment` was missing from `BRANCH_SCOPE` while its sibling
 * `LeaveApproval` was present. That contrast (LAT-API-11) is what made the gap
 * an omission rather than a design: the same file already knew how.
 *
 * These are medical certificates. Both doors now run the shared
 * `assertCanAccessEmployeeRecord`, and `LeaveAttachment` is in the scope map.
 *
 * ── A real filesystem is involved ───────────────────────────────────────────
 *
 * `StorageService` falls back to LOCAL DISK when MinIO is unconfigured, and
 * falls back again when a configured MinIO fails — so an e2e upload really
 * writes a file under `uploads/leave-attachments/`. The fixture's `cleanup()`
 * unlinks them.
 *
 * ── Actors this file OWNS for writes ────────────────────────────────────────
 *
 *   attachStaff · applicant (the peer-access arm) · foreignStaff (branch arm)
 */
describe('Leave attachments — upload, read and delete (e2e)', () => {
  let ctx: E2EContext;
  let fx: LeaveOtFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any) => res.body?.data ?? res.body;

  const listOf = (token: string, leaveId: string) =>
    ctx
      .http()
      .get(`/leave-requests/${leaveId}/attachments`)
      .set(bearer(token));
  const upload = (
    token: string,
    leaveId: string,
    buffer: Buffer,
    filename: string,
    contentType: string,
  ) =>
    ctx
      .http()
      .post(`/leave-requests/${leaveId}/attachments`)
      .set(bearer(token))
      .attach('file', buffer, { filename, contentType });
  const remove = (token: string, leaveId: string, attachmentId: string) =>
    ctx
      .http()
      .delete(`/leave-requests/${leaveId}/attachments/${attachmentId}`)
      .set(bearer(token));

  /** A small, valid PDF payload. */
  const pdf = () => attachmentFile(2048, 0x25);

  let owned: string[] = [];
  let leaveId = '';
  let peerLeaveId = '';
  let foreignLeaveId = '';

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupLeaveOvertimeFixtures(ctx);
    owned = [fx.attachStaffId, fx.applicantId, fx.foreignStaffId];
  }, 120000);

  beforeEach(async () => {
    // A fresh parent per case: the attachment list is per leave request, so
    // reusing one would make "the list contains exactly what this case
    // uploaded" false for reasons that have nothing to do with the rule.
    const a = freeWindow(300, 3);
    const b = freeWindow(310, 3);
    const c = freeWindow(320, 3);
    leaveId = await fx.seedLeave({
      employeeId: fx.attachStaffId,
      start: a.start,
      end: a.end,
    });
    peerLeaveId = await fx.seedLeave({
      employeeId: fx.applicantId,
      start: b.start,
      end: b.end,
    });
    foreignLeaveId = await fx.seedLeave({
      employeeId: fx.foreignStaffId,
      start: c.start,
      end: c.end,
    });
  });

  afterEach(async () => {
    const leaveIds = (
      await ctx.prisma.leaveRequest.findMany({
        where: { employeeId: { in: owned } },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (leaveIds.length) {
      await ctx.prisma.leaveAttachment.deleteMany({
        where: { leaveRequestId: { in: leaveIds } },
      });
      await ctx.prisma.requestApproval.deleteMany({
        where: { requestId: { in: leaveIds } },
      });
    }
    await ctx.prisma.leaveRequest.deleteMany({
      where: { employeeId: { in: owned } },
    });
    await ctx.prisma.attendance.deleteMany({
      where: { employeeId: { in: owned } },
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the routes exist at all', () => {
    it('LAT-API-01 all three doors are mounted — the WP-0 assertion', async () => {
      // Before `LeaveAttachmentsModule` was added to the e2e app module, every
      // one of these answered 404 for every id. A 404 that means "no route" and
      // a 404 that means "no such request" are indistinguishable from outside,
      // which is why this case asserts the two SEPARABLE outcomes below.
      const listed = await listOf(fx.hr.token, leaveId);
      expect(listed.status).toBe(200);

      const anonymous = await ctx
        .http()
        .get(`/leave-requests/${leaveId}/attachments`);
      expect(anonymous.status).toBe(401); // the guard ran, so the route is real

      const unknownParent = await listOf(
        fx.hr.token,
        '11111111-1111-4111-8111-111111111111',
      );
      // Reads of a nonexistent parent answer an empty list, not a 404 — the
      // list door never loads the parent at all.
      expect(unknownParent.status).toBe(200);
      expect(dataOf(unknownParent)).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('uploading', () => {
    it('LAT-API-02 the owner uploads a PDF and fileSize comes back as a Number, not a BigInt', async () => {
      const res = await upload(
        fx.hr.token,
        leaveId,
        pdf(),
        'certificate.pdf',
        'application/pdf',
      );
      expect(res.status).toBe(201);
      expect(body(res)).toContain('Attachment uploaded successfully');
      const data = dataOf(res);
      expect(typeof data.fileSize).toBe('number');
      expect(data.fileSize).toBe(2048);
      expect(data.uploadedBy).toBe(fx.hr.userId);
      expect(data.fileName).toBe('certificate.pdf');
    });

    it('LAT-API-03 the attachment is readable back through the parent leave request', async () => {
      const uploaded = await upload(
        fx.hr.token,
        leaveId,
        pdf(),
        'note.pdf',
        'application/pdf',
      );
      const detail = await ctx
        .http()
        .get(`/leave-requests/${leaveId}`)
        .set(bearer(fx.hr.token));
      expect(detail.status).toBe(200);
      const ids = dataOf(detail).attachments.map((a: any) => a.id);
      expect(ids).toContain(dataOf(uploaded).id);
      // Serialised through the leave payload too — the BigInt coercion lives in
      // two places and both are load-bearing.
      expect(typeof dataOf(detail).attachments[0].fileSize).toBe('number');
    });

    it('LAT-API-04 JPEG and PNG are accepted and anything else is refused by name', async () => {
      for (const [name, mime] of [
        ['scan.jpg', 'image/jpeg'],
        ['scan.png', 'image/png'],
      ] as const) {
        const res = await upload(fx.hr.token, leaveId, pdf(), name, mime);
        expect(res.status).toBe(201);
      }
      const denied = await upload(
        fx.hr.token,
        leaveId,
        Buffer.from('hello'),
        'notes.txt',
        'text/plain',
      );
      expect(denied.status).toBe(400);
      expect(body(denied)).toContain(
        'Invalid file type. Only PDF and JPG/PNG images are allowed',
      );
    });

    it('LAT-API-05 exactly ten megabytes is accepted and one byte more is not (±1 byte)', async () => {
      const TEN_MB = 10 * 1024 * 1024;
      const exact = await upload(
        fx.hr.token,
        leaveId,
        attachmentFile(TEN_MB),
        'exact.pdf',
        'application/pdf',
      );
      expect(exact.status).toBe(201);

      const over = await upload(
        fx.hr.token,
        leaveId,
        attachmentFile(TEN_MB + 1),
        'over.pdf',
        'application/pdf',
      );
      expect(over.status).toBe(400);
      expect(body(over)).toContain('File size exceeds the 10 MB limit');
    });

    it('LAT-API-06 a request with no file part is refused by name', async () => {
      // `file.size` was read off `undefined` before anything validated it.
      const res = await ctx
        .http()
        .post(`/leave-requests/${leaveId}/attachments`)
        .set(bearer(fx.hr.token))
        .field('note', 'no file here');
      expect(res.status).toBe(400);
      expect(body(res)).toContain('A file is required');
      expect(body(res)).not.toContain('prisma');
    });

    it('LAT-API-07 uploading to a leave request that does not exist is a 404', async () => {
      const res = await upload(
        fx.hr.token,
        '11111111-1111-4111-8111-111111111111',
        pdf(),
        'orphan.pdf',
        'application/pdf',
      );
      expect(res.status).toBe(404);
      expect(body(res)).toContain('Leave request not found');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('who can reach someone else’s medical certificate', () => {
    /**
     * L7, FIXED. `uploadAndCreate` used to load the leave request only to prove
     * it existed — never checking that the caller owned it, managed the
     * employee's department, or shared their branch.
     */
    it('LAT-API-08 an unrelated EMPLOYEE cannot attach a file to a colleague’s leave request', async () => {
      const res = await upload(
        fx.otherEmployee.token, // applicant2 — no relationship to attachStaff
        leaveId,
        pdf(),
        'planted.pdf',
        'application/pdf',
      );
      expect(res.status).toBe(403);
      expect(
        await ctx.prisma.leaveAttachment.count({
          where: { leaveRequestId: leaveId },
        }),
      ).toBe(0);

      // Their OWN request still accepts one, so the door narrowed rather than
      // closed.
      const own = await upload(
        fx.otherEmployee.token,
        peerLeaveId,
        pdf(),
        'mine.pdf',
        'application/pdf',
      );
      expect(own.status).toBe(403); // peerLeaveId belongs to `applicant`
      const reallyOwn = await fx.seedLeave({
        employeeId: fx.applicant2Id,
        start: freeWindow(330, 3).start,
        end: freeWindow(330, 3).end,
      });
      expect(
        (
          await upload(
            fx.otherEmployee.token,
            reallyOwn,
            pdf(),
            'mine.pdf',
            'application/pdf',
          )
        ).status,
      ).toBe(201);
      await ctx.prisma.leaveAttachment.deleteMany({
        where: { leaveRequestId: reallyOwn },
      });
      await ctx.prisma.leaveRequest.delete({ where: { id: reallyOwn } });
    });

    /** L7, the read half. `findByLeaveRequest` was a bare `findMany`. */
    it('LAT-API-09 an unrelated EMPLOYEE cannot list a colleague’s attachments', async () => {
      await upload(
        fx.hr.token,
        leaveId,
        pdf(),
        'medical-certificate.pdf',
        'application/pdf',
      );
      const res = await listOf(fx.otherEmployee.token, leaveId);
      expect(res.status).toBe(403);

      // HR still reads it.
      const hr = await listOf(fx.hr.token, leaveId);
      expect(hr.status).toBe(200);
      expect(dataOf(hr)).toHaveLength(1);
    });

    /**
     * L8, FIXED. `LeaveAttachment` is now in `BRANCH_SCOPE` with the same path
     * as its sibling `LeaveApproval`, and both doors run the shared guard — so
     * the attachments are refused exactly where their parent is.
     */
    it('LAT-API-10 a branch-scoped HR is refused wherever their parent request is refused', async () => {
      const parent = await ctx
        .http()
        .get(`/leave-requests/${foreignLeaveId}`)
        .set(bearer(fx.scopedHr.token));
      expect(parent.status).toBe(404);

      const uploaded = await upload(
        fx.scopedHr.token,
        foreignLeaveId,
        pdf(),
        'cross-branch.pdf',
        'application/pdf',
      );
      expect(uploaded.status).toBe(404);

      const listed = await listOf(fx.scopedHr.token, foreignLeaveId);
      expect(listed.status).toBe(404);

      expect(
        await ctx.prisma.leaveAttachment.count({
          where: { leaveRequestId: foreignLeaveId },
        }),
      ).toBe(0);
    });

    /**
     * The contrast that made 08–10 findings rather than a design decision:
     * DELETE on the very same resource always authorised correctly, in the same
     * service, a few lines below. All three doors now agree.
     */
    it('LAT-API-11 DELETE refuses an unrelated colleague by name, as it always did', async () => {
      const uploaded = await upload(
        fx.hr.token,
        leaveId,
        pdf(),
        'protected.pdf',
        'application/pdf',
      );
      const res = await remove(
        fx.otherEmployee.token,
        leaveId,
        dataOf(uploaded).id,
      );
      expect(res.status).toBe(403);
      expect(body(res)).toContain(
        'You do not have permission to delete this attachment',
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('deleting', () => {
    /**
     * `attachStaff` has no user account of its own, so every upload here is by
     * somebody authorised to act for them: HR, or the head of their department.
     * (Before the L7 fix any account at all could upload, which is exactly what
     * LAT-API-08 now refuses.)
     */
    const uploadAs = async (token: string) => {
      const res = await upload(
        token,
        leaveId,
        pdf(),
        'doc.pdf',
        'application/pdf',
      );
      expect(res.status).toBe(201);
      return dataOf(res).id as string;
    };

    it('LAT-API-12 the uploader deletes their own', async () => {
      const id = await uploadAs(fx.mgr.token);
      const res = await remove(fx.mgr.token, leaveId, id);
      expect(res.status).toBe(200);
      expect(body(res)).toContain('Attachment deleted successfully');
    });

    it('LAT-API-13 ADMIN and HR delete anyone’s', async () => {
      for (const actor of [fx.admin, fx.hr]) {
        const id = await uploadAs(fx.hr.token);
        expect((await remove(actor.token, leaveId, id)).status).toBe(200);
      }
    });

    it('LAT-API-14 the department manager deletes one in scope, and a manager outside it cannot', async () => {
      // attachStaff sits in deptOps, which `mgr` heads.
      const id = await uploadAs(fx.hr.token);
      expect((await remove(fx.mgr.token, leaveId, id)).status).toBe(200);

      const other = await uploadAs(fx.hr.token);
      const denied = await remove(fx.foreignMgr.token, leaveId, other);
      expect(denied.status).toBe(403);
    });

    it('LAT-API-15 delete is SOFT: the row survives, and disappears from both read surfaces', async () => {
      const id = await uploadAs(fx.hr.token);
      await remove(fx.hr.token, leaveId, id);

      const row = await ctx.prisma.leaveAttachment.findUniqueOrThrow({
        where: { id },
      });
      expect(row.deletedAt).not.toBeNull();

      expect(dataOf(await listOf(fx.hr.token, leaveId))).toEqual([]);
      const detail = await ctx
        .http()
        .get(`/leave-requests/${leaveId}`)
        .set(bearer(fx.hr.token));
      expect(dataOf(detail).attachments).toEqual([]);
    });

    it('LAT-API-16 deleting twice is a 404 the second time', async () => {
      const id = await uploadAs(fx.hr.token);
      expect((await remove(fx.hr.token, leaveId, id)).status).toBe(200);
      const again = await remove(fx.hr.token, leaveId, id);
      expect(again.status).toBe(404);
      expect(body(again)).toContain('Attachment not found');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the list, and the parent’s lifecycle', () => {
    it('LAT-API-17 the list is newest-first and excludes soft-deleted rows', async () => {
      const first = await upload(
        fx.hr.token,
        leaveId,
        pdf(),
        'first.pdf',
        'application/pdf',
      );
      const second = await upload(
        fx.hr.token,
        leaveId,
        pdf(),
        'second.pdf',
        'application/pdf',
      );
      const third = await upload(
        fx.hr.token,
        leaveId,
        pdf(),
        'third.pdf',
        'application/pdf',
      );
      await remove(fx.hr.token, leaveId, dataOf(second).id);

      const listed = dataOf(await listOf(fx.hr.token, leaveId));
      const ids = listed.map((a: any) => a.id);
      expect(ids).not.toContain(dataOf(second).id);
      expect(ids).toEqual([dataOf(third).id, dataOf(first).id]);
    });

    it('LAT-API-18 a leave request with no attachments answers an empty envelope', async () => {
      const res = await listOf(fx.hr.token, peerLeaveId);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(dataOf(res)).toEqual([]);
    });

    it('LAT-API-19 attachments survive approval and rejection of the parent request', async () => {
      await fx.setBalance(fx.attachStaffId, 'Annual Leave', 20);
      const uploaded = await upload(
        fx.hr.token,
        leaveId,
        pdf(),
        'evidence.pdf',
        'application/pdf',
      );
      await ctx
        .http()
        .post(`/leave-requests/${leaveId}/approve`)
        .set(bearer(fx.hr.token))
        .send({});
      expect(dataOf(await listOf(fx.hr.token, leaveId))).toHaveLength(1);

      const rejectedUpload = await upload(
        fx.hr.token,
        peerLeaveId,
        pdf(),
        'evidence2.pdf',
        'application/pdf',
      );
      await ctx
        .http()
        .post(`/leave-requests/${peerLeaveId}/reject`)
        .set(bearer(fx.hr.token))
        .send({ rejectedReason: 'no' });
      expect(dataOf(await listOf(fx.hr.token, peerLeaveId))).toHaveLength(1);

      void uploaded;
      void rejectedUpload;
    });

    it('LAT-API-20 deleting the parent leave request cascades the attachments away', async () => {
      const uploaded = await upload(
        fx.hr.token,
        leaveId,
        pdf(),
        'doomed.pdf',
        'application/pdf',
      );
      await ctx.prisma.leaveRequest.delete({ where: { id: leaveId } });
      const row = await ctx.prisma.leaveAttachment.findUnique({
        where: { id: dataOf(uploaded).id },
      });
      expect(row).toBeNull();
    });
  });
});
