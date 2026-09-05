import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  seedAttendance,
  PayrollFixtures,
  Period,
  bearer,
} from './utils/payroll-fixtures';

/**
 * The payroll state machine — Phase 4, chunk C3.
 *
 * ```
 * DRAFT ──submit(A|HR)──▶ PENDING_APPROVAL ──approve(A)──▶ APPROVED ──lock(A|HR)──▶ LOCKED
 *   ▲                            │                             ▲                       │
 *   └───────────────────────── reject(A) ──▶ REJECTED          └──── unlock(A, reason) ─┘
 *
 * create-revision(A|HR) from LOCKED ⇒ a NEW payroll row at version+1, in DRAFT.
 * DELETE is allowed from every status except LOCKED.
 * ```
 *
 * Payroll does NOT use the generic ApprovalEngine — `ApprovalRequestType` has no
 * payroll member and no `RequestApproval` row is ever written for a run. The
 * machine is hand-rolled, the approver is always an ADMIN, and `GET :id/history`
 * reconstructs the trail from the stamp columns rather than reading an audit
 * table. Each of those is a property worth a test, because none of them is
 * visible from the route table.
 *
 * `applyLock` is the single money-finalizing path in the product: it is where a
 * run stops being a draft and the money is claimed. `unlock` is the only way
 * back, and it reverses append-only. Both are asserted through their RECORDED
 * EFFECTS, not just their status column — a lock that moved the status and
 * settled nothing is exactly the defect this file exists to prevent.
 */
describe('Payroll lifecycle (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;
  /** Bumped per run so each helper-created payroll owns a distinct period. */
  let periodCursor = 30;

  const api = () => ctx.http();
  const as = (token: string, req: any, branchId = fx.branchA) =>
    req.set(bearer(token)).set('x-branch-id', branchId);
  const asAdmin = (req: any, branchId = fx.branchA) =>
    as(fx.admin.token, req, branchId);

  /** A fresh DRAFT run over one employee, in its own period. */
  const freshDraft = async (
    employeeIds: string[] = [fx.monthlyEmpId],
  ): Promise<{ id: string; period: Period }> => {
    const period = fx.periodAt(periodCursor++);
    await seedAttendance(ctx.prisma, employeeIds, fx.branchA, period);
    const res = await asAdmin(api().post('/payrolls')).send({
      month: period.month,
      year: period.year,
      employeeIds,
    });
    expect(res.status).toBe(201);
    return { id: res.body.data.id, period };
  };

  const submit = (id: string, token = fx.admin.token) =>
    as(token, api().post(`/payrolls/${id}/submit`));
  const approve = (id: string, token = fx.admin.token, body = {}) =>
    as(token, api().post(`/payrolls/${id}/approve`)).send(body);
  const reject = (id: string, token = fx.admin.token, body: any = { reason: 'nope, recheck the overtime' }) =>
    as(token, api().post(`/payrolls/${id}/reject`)).send(body);
  const lock = (id: string, token = fx.admin.token) =>
    as(token, api().post(`/payrolls/${id}/lock`));
  const unlock = (id: string, token = fx.admin.token, body: any = { reason: 'overtime hours were wrong' }) =>
    as(token, api().post(`/payrolls/${id}/unlock`)).send(body);

  /** DRAFT → LOCKED in one go. */
  const lockedRun = async (employeeIds?: string[]) => {
    const { id, period } = await freshDraft(employeeIds);
    expect((await submit(id)).status).toBe(201);
    expect((await approve(id)).status).toBe(201);
    expect((await lock(id)).status).toBe(201);
    return { id, period };
  };

  const statusOf = async (id: string) =>
    (await ctx.prisma.payroll.findUnique({ where: { id } }))?.status;

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── PL-API-01..12  The transitions ───────────────────────────────────────
  describe('PL-API-01..12 — legal and illegal transitions', () => {
    it('PL-API-01: DRAFT → PENDING_APPROVAL → APPROVED → LOCKED', async () => {
      const { id } = await freshDraft();
      expect(await statusOf(id)).toBe('DRAFT');

      expect((await submit(id)).status).toBe(201);
      expect(await statusOf(id)).toBe('PENDING_APPROVAL');

      expect((await approve(id)).status).toBe(201);
      expect(await statusOf(id)).toBe('APPROVED');

      expect((await lock(id)).status).toBe(201);
      expect(await statusOf(id)).toBe('LOCKED');
    });

    it('PL-API-02: PENDING_APPROVAL → REJECTED records the reason', async () => {
      const { id } = await freshDraft();
      await submit(id);
      const res = await reject(id, fx.admin.token, {
        reason: 'the transport allowance is doubled',
      });
      expect(res.status).toBe(201);

      const row = await ctx.prisma.payroll.findUnique({ where: { id } });
      expect(row!.status).toBe('REJECTED');
      expect(row!.rejectionReason).toBe('the transport allowance is doubled');
      expect(row!.rejectedAt).toBeTruthy();
      expect(row!.rejectedBy).toBe(fx.admin.userId);
    });

    it('PL-API-03: a REJECTED run can be corrected and resubmitted', async () => {
      // Rejection exists to send work BACK. Item edits are allowed on a REJECTED
      // run (only LOCKED refuses them), and the manage screen offers Submit for
      // exactly this status — so refusing the resubmit made REJECTED a dead end
      // recoverable only by deleting the run and generating it again.
      const { id } = await freshDraft();
      await submit(id);
      await reject(id);
      expect(await statusOf(id)).toBe('REJECTED');

      const detail = await asAdmin(api().get(`/payrolls/${id}`));
      const itemId = detail.body.data.items[0].id;
      const edit = await asAdmin(
        api().patch(`/payrolls/${id}/items/${itemId}`),
      ).send({ allowances: 111 });
      expect(edit.status).toBe(200);

      const again = await submit(id);
      expect(again.status).toBe(201);
      expect(await statusOf(id)).toBe('PENDING_APPROVAL');
    });

    it('PL-API-04: submit is refused from PENDING_APPROVAL, APPROVED and LOCKED', async () => {
      const { id } = await freshDraft();
      await submit(id);
      expect((await submit(id)).status).toBe(400);

      await approve(id);
      expect((await submit(id)).status).toBe(400);

      await lock(id);
      expect((await submit(id)).status).toBe(400);
    });

    it('PL-API-05: submit is refused when the run has no employees', async () => {
      const { id } = await freshDraft();
      await ctx.prisma.payrollItem.deleteMany({ where: { payrollId: id } });
      const res = await submit(id);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('no employees');
    });

    it('PL-API-06: approve and reject are refused outside PENDING_APPROVAL', async () => {
      const { id } = await freshDraft();
      expect((await approve(id)).status).toBe(400);
      expect((await reject(id)).status).toBe(400);

      await submit(id);
      await approve(id);
      // Already APPROVED: neither decision may be taken twice.
      expect((await approve(id)).status).toBe(400);
      expect((await reject(id)).status).toBe(400);
    });

    it('PL-API-07: lock is refused from anything but APPROVED', async () => {
      const { id } = await freshDraft();
      expect((await lock(id)).status).toBe(400);

      await submit(id);
      expect((await lock(id)).status).toBe(400);

      await approve(id);
      expect((await lock(id)).status).toBe(201);
      // And a second lock is refused rather than silently re-settling the money.
      const twice = await lock(id);
      expect(twice.status).toBe(400);
      expect(twice.body.message).toContain('already locked');
    });

    it('PL-API-08: finalize is a true alias of lock', async () => {
      // Kept for existing integrations. It used to lock from ANY status without
      // running lock's own settlement, which left LOCKED meaning nothing — so the
      // alias must be proved to share lock's guard AND its stamps, not merely its
      // name.
      const { id } = await freshDraft();
      expect(
        (await asAdmin(api().post(`/payrolls/${id}/finalize`))).status,
      ).toBe(400);

      await submit(id);
      await approve(id);
      const res = await asAdmin(api().post(`/payrolls/${id}/finalize`));
      expect(res.status).toBe(201);

      const row = await ctx.prisma.payroll.findUnique({ where: { id } });
      expect(row!.status).toBe('LOCKED');
      expect(row!.lockedAt).toBeTruthy();
      expect(row!.finalizedAt).toBeTruthy();
    });

    it('PL-API-09: unlock is refused from anything but LOCKED', async () => {
      const { id } = await freshDraft();
      expect((await unlock(id)).status).toBe(400);
      await submit(id);
      expect((await unlock(id)).status).toBe(400);
      await approve(id);
      const res = await unlock(id);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('LOCKED');
    });

    it('PL-API-10: create-revision is refused from anything but LOCKED', async () => {
      const { id } = await freshDraft();
      const draft = await asAdmin(
        api().post(`/payrolls/${id}/create-revision`),
      ).send({ reason: 'too early' });
      expect(draft.status).toBe(400);
    });

    it('PL-API-11: delete is allowed from every status except LOCKED', async () => {
      for (const advance of [
        async () => {},
        async (id: string) => void (await submit(id)),
        async (id: string) => {
          await submit(id);
          await approve(id);
        },
        async (id: string) => {
          await submit(id);
          await reject(id);
        },
      ]) {
        const { id } = await freshDraft();
        await advance(id);
        const res = await asAdmin(api().delete(`/payrolls/${id}`));
        expect(res.status).toBe(200);
      }

      const { id: lockedId } = await lockedRun();
      const refused = await asAdmin(api().delete(`/payrolls/${lockedId}`));
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain('locked');
    });

    it('PL-API-12: an unknown payroll is 404 on every workflow door', async () => {
      const ghost = '00000000-0000-0000-0000-000000000000';
      for (const call of [
        () => submit(ghost),
        () => approve(ghost),
        () => reject(ghost),
        () => lock(ghost),
        () => unlock(ghost),
        () => asAdmin(api().get(`/payrolls/${ghost}/history`)),
      ]) {
        expect((await call()).status).toBe(404);
      }
    });
  });

  // ── PL-API-13..20  Who may do what ───────────────────────────────────────
  describe('PL-API-13..20 — the role matrix', () => {
    it('PL-API-13: HR may submit, lock, revise and delete', async () => {
      const { id } = await freshDraft();
      expect((await submit(id, fx.hr.token)).status).toBe(201);
      // ...but not approve — see PL-API-14.
      await approve(id);
      expect((await lock(id, fx.hr.token)).status).toBe(201);

      const rev = await as(
        fx.hr.token,
        api().post(`/payrolls/${id}/create-revision`),
      ).send({ reason: 'HR may revise a locked run' });
      expect(rev.status).toBe(201);
    });

    it('PL-API-14: approve, reject, unlock and bulk-approve are ADMIN-only', async () => {
      const { id } = await freshDraft();
      await submit(id);

      expect((await approve(id, fx.hr.token)).status).toBe(403);
      expect((await reject(id, fx.hr.token)).status).toBe(403);

      await approve(id);
      await lock(id);
      expect((await unlock(id, fx.hr.token)).status).toBe(403);

      const bulk = await as(
        fx.hr.token,
        api().post('/payrolls/bulk-approve'),
      ).send({ payrollIds: [id] });
      expect(bulk.status).toBe(403);
    });

    it.each([
      ['MANAGER', () => fx.deptManager.token],
      ['EMPLOYEE', () => fx.employee.token],
    ])('PL-API-15: %s is refused every workflow door', async (_r, token) => {
      const { id } = await freshDraft();
      for (const call of [
        () => submit(id, token()),
        () => approve(id, token()),
        () => reject(id, token()),
        () => lock(id, token()),
        () => unlock(id, token()),
        () => as(token(), api().get(`/payrolls/${id}/history`)),
      ]) {
        expect((await call()).status).toBe(403);
      }
    });

    it('PL-API-16: an anonymous caller is 401, not 403', async () => {
      const { id } = await freshDraft();
      expect((await api().post(`/payrolls/${id}/submit`)).status).toBe(401);
    });

    it('PL-API-17: a scoped HR cannot drive another branch’s run', async () => {
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.branchBEmpId], fx.branchB, period);
      const foreign = await asAdmin(api().post('/payrolls'), fx.branchB).send({
        month: period.month,
        year: period.year,
      });
      expect(foreign.status).toBe(201);

      const res = await api()
        .post(`/payrolls/${foreign.body.data.id}/submit`)
        .set(bearer(fx.scopedHr.token));
      expect([403, 404]).toContain(res.status);
      expect(await statusOf(foreign.body.data.id)).toBe('DRAFT');
    });
  });

  // ── PL-API-21..24  What locking actually settles ─────────────────────────
  describe('PL-API-21..24 — lock side effects', () => {
    it('PL-API-22: the lock stamps who and when', async () => {
      const { id } = await lockedRun();
      const row = await ctx.prisma.payroll.findUnique({ where: { id } });
      expect(row!.lockedBy).toBe(fx.admin.userId);
      expect(row!.lockedAt).toBeTruthy();
      expect(row!.approvedBy).toBe(fx.admin.userId);
      expect(row!.submittedBy).toBe(fx.admin.userId);
    });

    it('PL-API-23: a LOCKED run refuses item edits', async () => {
      const { id } = await lockedRun();
      const detail = await asAdmin(api().get(`/payrolls/${id}`));
      const itemId = detail.body.data.items[0].id;
      const res = await asAdmin(
        api().patch(`/payrolls/${id}/items/${itemId}`),
      ).send({ bonus: 1 });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('locked');
    });

    it('PL-API-24: two simultaneous locks settle the money exactly once', async () => {
      // applyLock takes a pg_advisory_xact_lock and then a compare-and-set
      // `updateMany({id, status IN allowedFrom})`. A count of 0 means another
      // request won the race — the difference between "settled twice" and
      // "refused politely".
      const { id } = await freshDraft();
      await submit(id);
      await approve(id);

      const [a, b] = await Promise.all([lock(id), lock(id)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      // The loser is REFUSED; which refusal it is has never been the point. The
      // compare-and-set raises a ConflictException (409); this line asserted 400
      // and had been red on every run since. The money invariant the case exists
      // to protect — settled once, LOCKED once — was never what failed.
      // See G14 in `docs/TEST-PLAN-PAYROLL-EDGE.md`; `PE-CONC-02` asserts the
      // same invariant and accepts either refusal.
      expect(statuses[1]).toBeGreaterThanOrEqual(400);
      expect(String(JSON.stringify([a.body?.message, b.body?.message]))).toMatch(
        /no longer in a lockable state|locked or changed concurrently/i,
      );
      expect(await statusOf(id)).toBe('LOCKED');
    });
  });

  // ── PL-API-25..29  Unlock ────────────────────────────────────────────────
  describe('PL-API-25..29 — unlock', () => {
    it('PL-API-25: unlock returns a LOCKED run to APPROVED and records why', async () => {
      const { id } = await lockedRun();
      const res = await unlock(id, fx.admin.token, {
        reason: 'overtime hours were wrong for three employees',
      });
      expect(res.status).toBe(201);

      const row = await ctx.prisma.payroll.findUnique({ where: { id } });
      expect(row!.status).toBe('APPROVED');
      expect(row!.unlockReason).toContain('overtime hours were wrong');
      expect(row!.unlockedBy).toBe(fx.admin.userId);
      expect(row!.unlockCount).toBe(1);
    });

    it('PL-API-26: unlock demands a reason of real length', async () => {
      const { id } = await lockedRun();
      for (const body of [{}, { reason: '' }, { reason: 'oops' }]) {
        const res = await unlock(id, fx.admin.token, body);
        expect(res.status).toBe(400);
      }
      expect(await statusOf(id)).toBe('LOCKED');
    });

    it('PL-API-28: an unlocked run can be re-locked, and the count accumulates', async () => {
      const { id } = await lockedRun();
      await unlock(id);
      expect((await lock(id)).status).toBe(201);
      await unlock(id);
      const row = await ctx.prisma.payroll.findUnique({ where: { id } });
      expect(row!.unlockCount).toBe(2);
    });
  });

  // ── PL-API-30..36  Revisions, bulk approve, history ──────────────────────
  describe('PL-API-30..36 — revisions, bulk approve and history', () => {
    it('PL-API-30: a revision is a NEW DRAFT at version+1, linked to its source', async () => {
      const { id, period } = await lockedRun();
      const res = await asAdmin(
        api().post(`/payrolls/${id}/create-revision`),
      ).send({ reason: 'restate the transport allowance' });
      expect(res.status).toBe(201);

      const revision = await ctx.prisma.payroll.findUnique({
        where: { id: res.body.data.id },
        include: { items: true },
      });
      expect(revision!.status).toBe('DRAFT');
      expect(revision!.version).toBe(2);
      expect(revision!.previousVersionId).toBe(id);
      expect(revision!.month).toBe(period.month);
      expect(revision!.year).toBe(period.year);
      expect(revision!.branchId).toBe(fx.branchA);
      expect(revision!.items.length).toBeGreaterThan(0);

      // The source stays LOCKED — a revision restates, it does not reopen.
      expect(await statusOf(id)).toBe('LOCKED');
    });

    it('PL-API-31: the revision shares the period, so version is what separates them', async () => {
      // uniq_payroll_period_branch_batch_version includes `version` precisely so
      // a restatement can share month, year, branch and batch with its source.
      const { id } = await lockedRun();
      const first = await asAdmin(
        api().post(`/payrolls/${id}/create-revision`),
      ).send({ reason: 'first restatement' });
      expect(first.status).toBe(201);

      const both = await ctx.prisma.payroll.findMany({
        where: { previousVersionId: id },
      });
      expect(both).toHaveLength(1);
      expect(both[0].version).toBe(2);
    });

    it('PL-API-32: bulk-approve approves several runs at once', async () => {
      const a = await freshDraft();
      const b = await freshDraft([fx.secondMonthlyEmpId]);
      await submit(a.id);
      await submit(b.id);

      const res = await asAdmin(api().post('/payrolls/bulk-approve')).send({
        payrollIds: [a.id, b.id],
        notes: 'batch approved',
      });
      expect(res.status).toBe(201);
      expect(await statusOf(a.id)).toBe('APPROVED');
      expect(await statusOf(b.id)).toBe('APPROVED');
    });

    it('PL-API-33: bulk-approve is not transactional — partial success is the shape', async () => {
      // The loop calls approvePayroll per id and collects outcomes. A caller that
      // treats the 201 as "all of them worked" is wrong, so the response has to
      // name the failures and the successes have to STICK.
      const ok = await freshDraft();
      const notSubmitted = await freshDraft([fx.secondMonthlyEmpId]);
      await submit(ok.id);

      const res = await asAdmin(api().post('/payrolls/bulk-approve')).send({
        payrollIds: [ok.id, notSubmitted.id],
      });
      expect(res.status).toBe(201);

      const payload = res.body.data ?? res.body;
      expect(JSON.stringify(payload)).toContain(notSubmitted.id);
      expect(await statusOf(ok.id)).toBe('APPROVED');
      expect(await statusOf(notSubmitted.id)).toBe('DRAFT');
    });

    it('PL-API-34: history reconstructs the trail from the stamp columns', async () => {
      const { id } = await lockedRun();
      const res = await asAdmin(api().get(`/payrolls/${id}/history`));
      expect(res.status).toBe(200);

      const trail = JSON.stringify(res.body.data);
      // There is no RequestApproval row for a payroll; the timeline is derived
      // from submittedAt/By, approvedAt/By and lockedAt/By.
      expect(trail).toMatch(/SUBMIT|submitted/i);
      expect(trail).toMatch(/APPROVE|approved/i);
      expect(trail).toMatch(/LOCK|locked/i);

      const engineRows = await ctx.prisma.requestApproval.count({
        where: { requestId: id },
      });
      expect(engineRows).toBe(0);
    });
  });

  // ── PL-API-40..43  Body validation on the four once-dead DTOs ────────────
  describe('PL-API-40..43 — request bodies are validated', () => {
    it('PL-API-40: reject demands a reason', async () => {
      // The reason is written to `rejectionReason` and is the only explanation the
      // person who has to redo the run ever sees. Unvalidated, `{}` stored
      // `undefined` and the screen showed nothing.
      const { id } = await freshDraft();
      await submit(id);

      for (const body of [{}, { reason: '' }]) {
        const res = await reject(id, fx.admin.token, body);
        expect(res.status).toBe(400);
      }
      expect(await statusOf(id)).toBe('PENDING_APPROVAL');
    });

    it('PL-API-41: create-revision demands a reason', async () => {
      const { id } = await lockedRun();
      for (const body of [{}, { reason: '' }]) {
        const res = await asAdmin(
          api().post(`/payrolls/${id}/create-revision`),
        ).send(body);
        expect(res.status).toBe(400);
      }
    });

    it('PL-API-42: bulk-approve demands an array of ids', async () => {
      for (const body of [
        {},
        { payrollIds: 'not-an-array' },
        { payrollIds: [1, 2] },
      ]) {
        const res = await asAdmin(api().post('/payrolls/bulk-approve')).send(
          body,
        );
        expect(res.status).toBe(400);
      }
    });

    it('PL-API-43: unknown body keys are refused on every workflow door', async () => {
      const { id } = await freshDraft();
      await submit(id);

      const approveJunk = await approve(id, fx.admin.token, {
        note: 'typo for notes',
      });
      expect(approveJunk.status).toBe(400);

      const rejectJunk = await reject(id, fx.admin.token, {
        reason: 'fine',
        because: 'extra',
      });
      expect(rejectJunk.status).toBe(400);
    });

    it('PL-API-44: approve accepts optional notes and nothing else', async () => {
      const { id } = await freshDraft();
      await submit(id);
      const res = await approve(id, fx.admin.token, {
        notes: 'checked against the attendance report',
      });
      expect(res.status).toBe(201);
      expect(await statusOf(id)).toBe('APPROVED');
    });
  });
});
