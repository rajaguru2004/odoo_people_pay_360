import { AssetStatus } from '@prisma/client';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import { withSetting } from './utils/settings';
import {
  setupWorkplaceFixtures,
  WorkplaceFixtures,
} from './utils/workplace-fixtures';
import { RemindersService } from '../src/reminders/reminders.service';
import { AssetWarrantyReminderSource } from '../src/reminders/sources/asset-warranty-reminder.source';

/**
 * WP-2 — the offboarding clearance gate (`CLR-API-*`).
 *
 * `src/assets/clearance.service.ts` is the sharpest production consequence in
 * the Workplace module: it is the one piece of code that can REFUSE to end an
 * employment. `test/asset-clearance.e2e-spec.ts` proves the happy shape of that
 * — one asset, three paths, one override. This file proves the parts that
 * decide whether the control is real:
 *
 *   1. The gate matrix, twice over. All three offboarding paths refused while
 *      an assignment is open, then all three admitted once it is returned, with
 *      the RETURN as the only difference between the halves. A control that
 *      passes only the "blocked" half is indistinguishable from an endpoint
 *      that is broken for everyone.
 *   2. The kill switch, BOTH WAYS. `clearance_blocking_enabled` releases all
 *      three paths while the asset is still held, and the block is back the
 *      instant the switch is restored. A gate that can be switched off but not
 *      back on is not a control, and only the second half proves it is one.
 *   3. The override: BOTH a reason AND an OVERRIDE_ROLE, always audited.
 *   4. `getClearanceStatus` keyed on `returnedAt IS NULL` and never on
 *      `Employee.status` — asserted head-on with an INACTIVE employee who is
 *      still holding, because that is the rule most likely to be "simplified"
 *      into a status check by a later change.
 *   5. Who may ask, and what a stranger's id answers.
 *   6. XM-API-12, the warranty reminder source that keeps the register honest
 *      between offboardings.
 *   7. Branch scope on the read — the one that used to produce a FALSE
 *      CLEARANCE rather than a refusal, which is the failure mode nobody
 *      notices.
 *
 * FINDINGS. Three defects this file pinned are now FIXED, and each pin has been
 * collapsed with its `it.failing` twin into a single case asserting the correct
 * behaviour, keeping the finding's own id and a comment recording what the
 * defect was (docs/TESTING.md, "Recorded defects"):
 *
 *   R26  CLR-API-39  no branch check on the clearance read — a scoped HR was
 *                    told a foreign employee owed nothing. Now 404.
 *   R27  CLR-API-37  an unknown employeeId answered `cleared:true`. Now 404.
 *   R28  CLR-API-34  the MANAGER read was not department-scoped. Now 403.
 *
 * No `it.failing` remains in this file, which is the point of the convention:
 * a twin that would now pass is a pin that has to go.
 *
 * SETTINGS DISCIPLINE. `clearance_blocking_enabled` and
 * `reminder_days_asset_warranty` are GLOBAL rows shared with every other suite.
 * Every flip below is wrapped around ONE case (never a describe block) via
 * `withSetting`, which restores in a `finally`. A suite that leaves one flipped
 * fails a file that never touched it.
 */
describe('Workplace — asset clearance gate (e2e)', () => {
  let ctx: E2EContext;
  let fx: WorkplaceFixtures;

  /** Termination requests hold `requestedBy` RESTRICT on User; cleared by hand. */
  const terminationRequestIds: string[] = [];
  /** Reminder dispatch rows that existed before this file ran. */
  let dispatchSnapshot: string[] = [];

  let seq = 0;
  const tag = (label: string) => `${label}${++seq}`;

  const daysFromNow = (n: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d;
  };

  interface Leaver {
    employeeId: string;
    employeeCode: string;
    contractId?: string;
    assetId?: string;
    assetTag?: string;
    assignmentId?: string;
  }

  /**
   * One self-contained offboarding subject.
   *
   * Every case that completes an exit CONSUMES its employee (all three paths
   * write INACTIVE — R72, fixed; they used to disagree, the soft delete writing
   * TERMINATED), so a shared leaver would make case order load-bearing. Each
   * case builds its own.
   */
  async function makeLeaver(
    label: string,
    opts: {
      withAsset?: boolean;
      withContract?: boolean;
      branchId?: string;
      employeeStatus?: string;
      warrantyExpiry?: Date;
    } = {},
  ): Promise<Leaver> {
    const { prisma } = ctx;
    const suffix = tag(label);
    const branchId = opts.branchId ?? fx.branchA;

    const employee = await prisma.employee.create({
      data: {
        employeeCode: `CLR-${fx.runId}-${suffix}`,
        fullName: `CLR ${suffix}`,
        email: `clr-${suffix.toLowerCase()}-${fx.runId}@test.local`,
        idCard: `IDC-${fx.runId}-${suffix}`,
        dateOfBirth: new Date('1991-04-04'),
        startDate: new Date('2022-01-01'),
        departmentId: fx.managedDeptId,
        position: 'Engineer',
        branchId,
        baseSalary: 40000,
        status: opts.employeeStatus ?? 'ACTIVE',
      },
    });

    const out: Leaver = {
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
    };

    if (opts.withContract) {
      const contract = await prisma.contract.create({
        data: {
          employeeId: employee.id,
          contractType: 'INDEFINITE',
          contractNumber: `CLR-CT-${fx.runId}-${suffix}`,
          startDate: new Date('2022-01-01'),
          salary: 40000,
          workType: 'FULL_TIME',
          workHoursPerWeek: 40,
          status: 'ACTIVE',
        },
      });
      out.contractId = contract.id;
    }

    if (opts.withAsset) {
      const asset = await prisma.assetItem.create({
        data: {
          assetTag: `CLR-${fx.runId}-${suffix}`,
          category: 'Laptop',
          name: `CLR Asset ${suffix}`,
          serialNumber: `CLRSN-${fx.runId}-${suffix}`,
          branchId,
          status: 'ASSIGNED',
          purchaseDate: new Date('2025-02-01'),
          purchaseCost: 900,
          warrantyExpiry: opts.warrantyExpiry ?? new Date('2029-02-01'),
        },
      });
      const assignment = await prisma.assetAssignment.create({
        data: {
          assetId: asset.id,
          employeeId: employee.id,
          assignedAt: new Date('2025-03-01'),
          assignedById: fx.admin.userId,
          conditionOut: 'GOOD',
        },
      });
      out.assetId = asset.id;
      out.assetTag = asset.assetTag;
      out.assignmentId = assignment.id;
    }

    return out;
  }

  /** Raise a PENDING_APPROVAL termination request against a contract. */
  async function makeTerminationRequest(contractId: string): Promise<string> {
    const row = await ctx.prisma.terminationRequest.create({
      data: {
        contractId,
        requestedBy: fx.admin.userId,
        terminationCategory: 'RESIGNATION',
        noticeDate: new Date(),
        terminationDate: new Date(),
        reason: 'Resigned',
        status: 'PENDING_APPROVAL',
      },
    });
    terminationRequestIds.push(row.id);
    return row.id;
  }

  /** Return an open assignment through the real endpoint, not a raw update. */
  const returnAsset = (assignmentId: string) =>
    ctx
      .http()
      .post(`/assets/assignments/${assignmentId}/return`)
      .set(bearer(fx.admin.token))
      .send({ conditionIn: 'GOOD' });

  // The three doors, expressed identically so a case can drive any of them.
  const approveTermination = (requestId: string, token: string, body: any = {}) =>
    ctx
      .http()
      .post(`/contracts/termination-requests/${requestId}/approve`)
      .set(bearer(token))
      .send({ approverId: fx.admin.userId, comments: 'ok', ...body });

  const terminateContract = (contractId: string, token: string, body: any = {}) =>
    ctx
      .http()
      .post(`/contracts/${contractId}/terminate`)
      .set(bearer(token))
      .send({ reason: 'Offboarding', ...body });

  const deleteEmployee = (employeeId: string, token: string, reason?: string) =>
    ctx
      .http()
      .delete(
        `/employees/${employeeId}` +
          (reason === undefined
            ? ''
            : `?clearanceOverrideReason=${encodeURIComponent(reason)}`),
      )
      .set(bearer(token));

  const clearanceOf = (employeeId: string, token?: string) => {
    const req = ctx.http().get(`/assets/clearance/${employeeId}`);
    return token ? req.set(bearer(token)) : req;
  };

  const statusOf = (employeeId: string) =>
    ctx.prisma.employee
      .findUnique({ where: { id: employeeId }, select: { status: true } })
      .then((e) => e?.status);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupWorkplaceFixtures(ctx);
    dispatchSnapshot = (
      await ctx.prisma.reminderDispatch.findMany({ select: { id: true } })
    ).map((r) => r.id);
  }, 180000);

  afterAll(async () => {
    const { prisma } = ctx;
    // Anything this file added to the shared dispatch table, removed — so a
    // burned tier here cannot silence a neighbour's reminder case.
    await prisma.reminderDispatch.deleteMany({
      where: { id: { notIn: dispatchSnapshot } },
    });
    // requestedBy is RESTRICT on User; these must go before the base fixture
    // deletes its users.
    await prisma.terminationRequest.deleteMany({
      where: { id: { in: terminationRequestIds } },
    });
    await prisma.terminationRequest.deleteMany({
      where: { contract: { contractNumber: { contains: fx.runId } } },
    });
    await prisma.contract.deleteMany({
      where: { contractNumber: { contains: fx.runId } },
    });
    await prisma.auditLog.deleteMany({
      where: {
        action: 'CLEARANCE_OVERRIDDEN',
        user: { email: { contains: fx.runId } },
      },
    });
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ══ 1. The gate matrix — three paths, blocked, then the same three admitted ══
  //
  // Six cases in two halves. Each path gets its OWN leaver because each path
  // consumes one, but within a path the blocked case and the admitted case are
  // the same employee, the same contract and the same asset: the only thing
  // that changes between them is the return. That is what makes the second half
  // evidence about the gate rather than evidence about the endpoint.

  describe('CLR-API-01..06 the gate on all three offboarding paths', () => {
    let path1: Leaver;
    let path2: Leaver;
    let path3: Leaver;
    let request1: string;

    beforeAll(async () => {
      path1 = await makeLeaver('P1', { withAsset: true, withContract: true });
      path2 = await makeLeaver('P2', { withAsset: true, withContract: true });
      path3 = await makeLeaver('P3', { withAsset: true });
      request1 = await makeTerminationRequest(path1.contractId!);
    });

    it('CLR-API-01 PATH 1 (approve termination request) is refused, naming the asset', async () => {
      const res = await approveTermination(request1, fx.admin.token).expect(400);

      expect(res.body.message).toMatch(/Cannot complete offboarding/i);
      expect(res.body.message).toMatch(/1 company asset\(s\)/);
      expect(res.body.message).toContain(path1.assetTag!);
      // The refusal has to tell the reader the way out, or HR raises a ticket.
      expect(res.body.message).toMatch(/override reason \(ADMIN\/HR_MANAGER only\)/i);

      // The gate runs BEFORE the transaction: nothing moved.
      expect(await statusOf(path1.employeeId)).toBe('ACTIVE');
      const req = await ctx.prisma.terminationRequest.findUnique({
        where: { id: request1 },
      });
      expect(req?.status).toBe('PENDING_APPROVAL');
      const contract = await ctx.prisma.contract.findUnique({
        where: { id: path1.contractId! },
      });
      expect(contract?.status).toBe('ACTIVE');
    });

    it('CLR-API-02 PATH 2 (direct contract terminate) is refused, naming the asset', async () => {
      const res = await terminateContract(
        path2.contractId!,
        fx.admin.token,
      ).expect(400);

      expect(res.body.message).toMatch(/Cannot complete offboarding/i);
      expect(res.body.message).toContain(path2.assetTag!);
      expect(await statusOf(path2.employeeId)).toBe('ACTIVE');
      const contract = await ctx.prisma.contract.findUnique({
        where: { id: path2.contractId! },
      });
      expect(contract?.status).toBe('ACTIVE');
    });

    it('CLR-API-03 PATH 3 (employee soft delete) is refused, naming the asset', async () => {
      const res = await deleteEmployee(path3.employeeId, fx.admin.token).expect(
        400,
      );

      expect(res.body.message).toMatch(/Cannot complete offboarding/i);
      expect(res.body.message).toContain(path3.assetTag!);
      expect(await statusOf(path3.employeeId)).toBe('ACTIVE');
    });

    it('CLR-API-04 PATH 1 succeeds once the asset is returned', async () => {
      await returnAsset(path1.assignmentId!).expect(201);

      await approveTermination(request1, fx.admin.token).expect(201);

      expect(await statusOf(path1.employeeId)).toBe('INACTIVE');
      const req = await ctx.prisma.terminationRequest.findUnique({
        where: { id: request1 },
      });
      expect(req?.status).toBe('APPROVED');
    });

    it('CLR-API-05 PATH 2 succeeds once the asset is returned', async () => {
      await returnAsset(path2.assignmentId!).expect(201);

      await terminateContract(path2.contractId!, fx.admin.token).expect(201);

      expect(await statusOf(path2.employeeId)).toBe('INACTIVE');
      const contract = await ctx.prisma.contract.findUnique({
        where: { id: path2.contractId! },
      });
      expect(contract?.status).toBe('TERMINATED');
    });

    it('CLR-API-06 PATH 3 succeeds once the asset is returned', async () => {
      await returnAsset(path3.assignmentId!).expect(201);

      await deleteEmployee(path3.employeeId, fx.admin.token).expect(200);

      // R72 (fixed): the soft-delete path records the same exit status as the
      // two contract-side paths above. It used to write TERMINATED.
      expect(await statusOf(path3.employeeId)).toBe('INACTIVE');
    });

    it('CLR-API-06b the returned assignment is closed, not deleted — the custody evidence survives', async () => {
      const row = await ctx.prisma.assetAssignment.findUnique({
        where: { id: path3.assignmentId! },
      });
      expect(row).toBeTruthy();
      expect(row?.returnedAt).toBeTruthy();
      // And the asset is back in stock, which is what makes it re-assignable.
      const asset = await ctx.prisma.assetItem.findUnique({
        where: { id: path3.assetId! },
      });
      expect(asset?.status).toBe('AVAILABLE');
    });
  });

  // ══ 2. The kill switch ═════════════════════════════════════════════════════

  describe('CLR-API-07..08 the clearance kill switch', () => {
    it('CLR-API-07 clearance_blocking_enabled=false admits all three paths while the asset is STILL held', async () => {
      const a = await makeLeaver('KS1', { withAsset: true, withContract: true });
      const b = await makeLeaver('KS2', { withAsset: true, withContract: true });
      const c = await makeLeaver('KS3', { withAsset: true });
      const requestId = await makeTerminationRequest(a.contractId!);

      await withSetting(ctx, 'clearance_blocking_enabled', 'false', async () => {
        await approveTermination(requestId, fx.admin.token).expect(201);
        await terminateContract(b.contractId!, fx.admin.token).expect(201);
        await deleteEmployee(c.employeeId, fx.admin.token).expect(200);
      });

      // All three left while holding. That is the point of the switch, and also
      // exactly what `clearance/reports/outstanding` exists to surface.
      for (const l of [a, b, c]) {
        const held = await ctx.prisma.assetAssignment.findFirst({
          where: { employeeId: l.employeeId, returnedAt: null },
        });
        expect(held).toBeTruthy();
      }
      // All three exits, one status (R72, fixed).
      expect(await statusOf(a.employeeId)).toBe('INACTIVE');
      expect(await statusOf(b.employeeId)).toBe('INACTIVE');
      expect(await statusOf(c.employeeId)).toBe('INACTIVE');
    });

    it('CLR-API-08 restoring clearance_blocking_enabled brings the block straight back', async () => {
      const l = await makeLeaver('KS4', { withAsset: true });

      // The switch is back to its stored value the moment CLR-API-07's
      // `withSetting` unwound; this proves it rather than assuming it.
      const row = await ctx.prisma.systemSetting.findUnique({
        where: { key: 'clearance_blocking_enabled' },
      });
      expect(row?.value ?? 'true').not.toBe('false');

      const res = await deleteEmployee(l.employeeId, fx.admin.token).expect(400);
      expect(res.body.message).toContain(l.assetTag!);
      expect(await statusOf(l.employeeId)).toBe('ACTIVE');
    });
  });

  // ══ 3. Override ════════════════════════════════════════════════════════════

  describe('CLR-API-20..26 the override', () => {
    it('CLR-API-20 ADMIN overrides with a reason, and the exit completes while the asset is still held', async () => {
      const l = await makeLeaver('OV1', { withAsset: true });

      await deleteEmployee(
        l.employeeId,
        fx.admin.token,
        'Laptop written off — stolen in transit',
      ).expect(200);

      expect(await statusOf(l.employeeId)).toBe('INACTIVE');
      const held = await ctx.prisma.assetAssignment.findFirst({
        where: { employeeId: l.employeeId, returnedAt: null },
      });
      expect(held).toBeTruthy(); // the obligation SURVIVES the override
    });

    it('CLR-API-21 HR_MANAGER overrides too — OVERRIDE_ROLES is ADMIN and HR_MANAGER', async () => {
      const l = await makeLeaver('OV2', { withAsset: true, withContract: true });

      await terminateContract(l.contractId!, fx.scopedHr.token, {
        clearanceOverrideReason: 'Urgent exit, recovery in progress',
      }).expect(201);

      expect(await statusOf(l.employeeId)).toBe('INACTIVE');
      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'CLEARANCE_OVERRIDDEN', resourceId: l.employeeId },
      });
      expect(audit?.userId).toBe(fx.scopedHr.userId);
    });

    it('CLR-API-22 a MANAGER cannot override, because a MANAGER cannot reach any of the three doors at all', async () => {
      const l = await makeLeaver('OV3', { withAsset: true, withContract: true });
      const requestId = await makeTerminationRequest(l.contractId!);

      // NOTE ON MECHANISM. `OVERRIDE_ROLES` inside `assertCleared` is defence in
      // depth, not the enforcement point: all three offboarding endpoints carry
      // `@Roles('ADMIN','HR_MANAGER')`, so a MANAGER is refused by the guard
      // before the clearance service is ever constructed a role to check. The
      // outcome the requirement asks for (a MANAGER may not override) holds; the
      // 403 rather than the service's own 400 is what proves WHERE.
      await approveTermination(requestId, fx.manager.token, {
        clearanceOverrideReason: 'let me through',
      }).expect(403);
      await terminateContract(l.contractId!, fx.manager.token, {
        clearanceOverrideReason: 'let me through',
      }).expect(403);
      await deleteEmployee(l.employeeId, fx.manager.token, 'let me through').expect(
        403,
      );

      expect(await statusOf(l.employeeId)).toBe('ACTIVE');
      const audit = await ctx.prisma.auditLog.count({
        where: { action: 'CLEARANCE_OVERRIDDEN', resourceId: l.employeeId },
      });
      expect(audit).toBe(0);
    });

    it('CLR-API-23 an EMPLOYEE cannot override either', async () => {
      const l = await makeLeaver('OV4', { withAsset: true, withContract: true });

      await terminateContract(l.contractId!, fx.employee.token, {
        clearanceOverrideReason: 'please',
      }).expect(403);
      await deleteEmployee(l.employeeId, fx.employee.token, 'please').expect(403);

      expect(await statusOf(l.employeeId)).toBe('ACTIVE');
    });

    it('CLR-API-24 a MISSING reason is refused, and so is an empty one', async () => {
      const missing = await makeLeaver('OV5', { withAsset: true });
      const empty = await makeLeaver('OV6', { withAsset: true });

      const noReason = await deleteEmployee(
        missing.employeeId,
        fx.admin.token,
      ).expect(400);
      expect(noReason.body.message).toMatch(/Cannot complete offboarding/i);

      const emptyReason = await deleteEmployee(
        empty.employeeId,
        fx.admin.token,
        '',
      ).expect(400);
      expect(emptyReason.body.message).toMatch(/Cannot complete offboarding/i);

      expect(await statusOf(missing.employeeId)).toBe('ACTIVE');
      expect(await statusOf(empty.employeeId)).toBe('ACTIVE');
    });

    it('CLR-API-25 a whitespace-only reason is refused — `reason.trim()`, not `reason`', async () => {
      const l = await makeLeaver('OV7', { withAsset: true, withContract: true });

      const res = await terminateContract(l.contractId!, fx.admin.token, {
        clearanceOverrideReason: '   \t  ',
      }).expect(400);
      expect(res.body.message).toMatch(/Cannot complete offboarding/i);
      expect(await statusOf(l.employeeId)).toBe('ACTIVE');

      const audit = await ctx.prisma.auditLog.count({
        where: { action: 'CLEARANCE_OVERRIDDEN', resourceId: l.employeeId },
      });
      expect(audit).toBe(0);
    });

    it('CLR-API-26 the CLEARANCE_OVERRIDDEN audit row carries the actor, the reason and the obligations outstanding at the time', async () => {
      // The override row is the ONLY record that the obligation was waived
      // rather than met: once the employee is INACTIVE and the assignment stops
      // appearing in anybody's working queue, nothing else in the system
      // reconstructs what was still held at the moment somebody decided to let
      // the exit through. So the row has to name the actor, the reason and the
      // assets themselves — an audit row that says only "overridden" answers
      // none of the questions an auditor actually arrives with.
      const l = await makeLeaver('OV8', { withAsset: true });
      const reason = `Written off under case ${fx.runId}`;

      await deleteEmployee(l.employeeId, fx.admin.token, reason).expect(200);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'CLEARANCE_OVERRIDDEN', resourceId: l.employeeId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeTruthy();
      expect(audit!.userId).toBe(fx.admin.userId);
      expect(audit!.resourceType).toBe('Employee');

      const newData = audit!.newData as any;
      expect(newData.reason).toBe(reason);
      // The tag AND the name, because a tag alone is unreadable to whoever
      // reviews the trail months later without the register in front of them.
      expect(newData.openAssets).toEqual([
        { assetTag: l.assetTag, name: expect.any(String) },
      ]);
    });
  });

  // ══ 4. `getClearanceStatus` shape, and the returnedAt rule ═════════════════

  describe('CLR-API-27..31 the status projection', () => {
    it('CLR-API-27 a holder gets the full three-field shape with the assignment detail', async () => {
      const res = await clearanceOf(fx.holderId, fx.admin.token).expect(200);
      const data = res.body.data;

      expect(Object.keys(data).sort()).toEqual(
        ['assetCleared', 'cleared', 'openAssets'].sort(),
      );
      expect(data.cleared).toBe(false);
      expect(data.assetCleared).toBe(false);
      expect(data.openAssets).toHaveLength(1);
      expect(data.openAssets[0]).toMatchObject({
        assignmentId: fx.openAssignmentHolderId,
        assetId: fx.assetHeldAId,
        assetTag: fx.assetHeldATag,
        category: 'Laptop',
      });
      expect(data.openAssets[0].assignedAt).toBeTruthy();
    });

    it('CLR-API-28 an employee with nothing outstanding is cleared with an EMPTY array, not a crash', async () => {
      const l = await makeLeaver('SH1');

      const res = await clearanceOf(l.employeeId, fx.admin.token).expect(200);
      expect(res.body.data).toEqual({
        cleared: true,
        assetCleared: true,
        openAssets: [],
      });
    });

    it('CLR-API-29 an INACTIVE employee who is still holding is NOT auto-cleared — the rule is returnedAt, never Employee.status', async () => {
      // THE SUBTLE ONE. `Employee.status` is a free-text VarChar written as
      // INACTIVE by every offboarding path (R72 fixed the soft delete, which
      // used to write TERMINATED). Keying clearance on it would mean the moment
      // someone is marked a leaver they are considered clear — the exact
      // inversion of the rule. Clearance keys on `returnedAt` instead, so it
      // never depended on which word the exit wrote.
      const inactive = await ctx.prisma.employee.findUnique({
        where: { id: fx.leaverId },
        select: { status: true },
      });
      expect(inactive?.status).toBe('INACTIVE');

      const res = await clearanceOf(fx.leaverId, fx.admin.token).expect(200);
      expect(res.body.data.cleared).toBe(false);
      expect(res.body.data.assetCleared).toBe(false);
      expect(res.body.data.openAssets).toHaveLength(1);
      expect(res.body.data.openAssets[0].assetTag).toBe(fx.assetLeaverHeldTag);
    });

    it('CLR-API-29b an employee offboarded through the SOFT DELETE path is not cleared either', async () => {
      // The other offboarding route into the same state. Since R72 it records
      // the same status as the two above; the point of the case is that the
      // route it came through makes no difference to the clearance answer.
      const l = await makeLeaver('SH2', { withAsset: true });
      await deleteEmployee(l.employeeId, fx.admin.token, 'urgent exit').expect(
        200,
      );
      expect(await statusOf(l.employeeId)).toBe('INACTIVE');

      const res = await clearanceOf(l.employeeId, fx.admin.token).expect(200);
      expect(res.body.data.cleared).toBe(false);
      expect(res.body.data.openAssets[0].assetTag).toBe(l.assetTag);
    });

    it('CLR-API-30 a CLOSED assignment does not count — a returned asset is not held', async () => {
      // The fixture holder owns one open assignment AND one closed one. If the
      // query keyed on the assignment rather than `returnedAt IS NULL`, this
      // would report two.
      const closed = await ctx.prisma.assetAssignment.findUnique({
        where: { id: fx.closedAssignmentId },
      });
      expect(closed?.employeeId).toBe(fx.holderId);
      expect(closed?.returnedAt).toBeTruthy();

      const res = await clearanceOf(fx.holderId, fx.admin.token).expect(200);
      expect(res.body.data.openAssets).toHaveLength(1);
      expect(
        res.body.data.openAssets.map((a: any) => a.assignmentId),
      ).not.toContain(fx.closedAssignmentId);
    });

    it('CLR-API-31 openAssets are ordered oldest-first, so the longest-held item reads first', async () => {
      const l = await makeLeaver('SH3');
      const { prisma } = ctx;
      const mk = async (label: string, assignedAt: Date) => {
        const asset = await prisma.assetItem.create({
          data: {
            assetTag: `CLR-${fx.runId}-${tag(label)}`,
            category: 'Phone',
            name: `CLR ${label}`,
            branchId: fx.branchA,
            status: 'ASSIGNED',
          },
        });
        await prisma.assetAssignment.create({
          data: {
            assetId: asset.id,
            employeeId: l.employeeId,
            assignedAt,
            assignedById: fx.admin.userId,
          },
        });
        return asset.assetTag;
      };
      const newer = await mk('ORD-NEW', new Date('2025-06-01'));
      const older = await mk('ORD-OLD', new Date('2024-06-01'));

      const res = await clearanceOf(l.employeeId, fx.admin.token).expect(200);
      expect(res.body.data.openAssets.map((a: any) => a.assetTag)).toEqual([
        older,
        newer,
      ]);
      expect(res.body.data.cleared).toBe(false);
    });
  });

  // ══ 5. Who may ask ═════════════════════════════════════════════════════════

  describe('CLR-API-32..38 roles on the clearance endpoints', () => {
    it('CLR-API-32 ADMIN and HR_MANAGER may read a clearance', async () => {
      await clearanceOf(fx.holderId, fx.admin.token).expect(200);
      await clearanceOf(fx.holderId, fx.scopedHr.token).expect(200);
    });

    it('CLR-API-33 a MANAGER may read a clearance for an employee in the department they head', async () => {
      const res = await clearanceOf(
        fx.managedEmployeeId,
        fx.manager.token,
      ).expect(200);
      expect(res.body.data.cleared).toBe(true);
    });

    it('CLR-API-34 a MANAGER is refused a clearance outside the departments they head', async () => {
      // REGRESSION LOCK (R28 — fixed). `GET /assets/clearance/:employeeId`
      // carried `@Roles('ADMIN','HR_MANAGER','MANAGER')` and nothing else, while
      // its sibling `/assets/assignments/open` narrowed a MANAGER to
      // `managedDepartmentIds` — so any manager could read what any employee in
      // the company was holding, in any department. The clearance read names an
      // employee by id and enumerates their custody, which is exactly the
      // surface the department narrowing exists to keep closed.
      //
      // The read path now runs `assertCanAccessEmployeeRecord`
      // (`common/services/record-access.util.ts`), which applies the same
      // department narrowing: 403 outside the scope, after the branch check.
      const res = await clearanceOf(
        fx.unmanagedEmployeeId,
        fx.manager.token,
      ).expect(403);
      expect(String(res.body.message)).toMatch(/department/i);
    });

    it('CLR-API-35 an EMPLOYEE is refused, even for their own record', async () => {
      await clearanceOf(fx.holderId, fx.employee.token).expect(403);
      await clearanceOf(fx.employee.employeeId!, fx.employee.token).expect(403);
    });

    it('CLR-API-36 anonymous is 401, and a malformed id is 400 before anything is read', async () => {
      await clearanceOf(fx.holderId).expect(401);
      await ctx
        .http()
        .get('/assets/clearance/not-a-uuid')
        .set(bearer(fx.admin.token))
        .expect(400);
    });

    it('CLR-API-37 an UNKNOWN employeeId answers 404, not a clearance', async () => {
      // REGRESSION LOCK (R27 — fixed). `getClearanceStatus` never loaded the
      // Employee: a uuid belonging to nobody matched no open assignment, so the
      // endpoint answered a confident `cleared: true` and `assertCleared`
      // would have waved the same id straight through. An operator who pasted a
      // wrong id was told the wrong person was clear. The service now resolves
      // the subject first and 404s an id that belongs to nobody.
      const res = await clearanceOf(
        '00000000-0000-0000-0000-000000000001',
        fx.admin.token,
      ).expect(404);
      expect(String(res.body.message)).toMatch(/employee not found/i);
    });

    it('CLR-API-38 the outstanding report is ADMIN/HR only, and lists the inactive leaver who is still holding', async () => {
      const res = await ctx
        .http()
        .get('/assets/clearance/reports/outstanding')
        .set(bearer(fx.admin.token))
        .expect(200);

      const rows = res.body.data.filter(
        (r: any) => r.employee.id === fx.leaverId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].asset.assetTag).toBe(fx.assetLeaverHeldTag);
      expect(rows[0].employee.status).not.toBe('ACTIVE');

      await ctx
        .http()
        .get('/assets/clearance/reports/outstanding')
        .set(bearer(fx.scopedHr.token))
        .expect(200);
      await ctx
        .http()
        .get('/assets/clearance/reports/outstanding')
        .set(bearer(fx.manager.token))
        .expect(403);
      await ctx
        .http()
        .get('/assets/clearance/reports/outstanding')
        .set(bearer(fx.employee.token))
        .expect(403);
      await ctx.http().get('/assets/clearance/reports/outstanding').expect(401);
    });
  });

  // ══ 6. XM-API-12 — the warranty reminder source ════════════════════════════
  //
  // Driven through `RemindersService.runSource` with the asset source only,
  // rather than `runAll()`: this file has no business dispatching contract,
  // visa or training reminders for rows it did not create, and every dispatch
  // row it does write is removed in `afterAll`.

  describe('XM-API-12 asset warranty reminders', () => {
    let reminders: RemindersService;
    let source: AssetWarrantyReminderSource;

    const dispatchesFor = (entityId: string) =>
      ctx.prisma.reminderDispatch.findMany({
        where: { sourceKey: 'asset_warranty', entityId },
        orderBy: { threshold: 'desc' },
      });

    const mkWarrantyAsset = async (
      label: string,
      daysOut: number,
      status: AssetStatus = 'AVAILABLE',
    ) => {
      const asset = await ctx.prisma.assetItem.create({
        data: {
          assetTag: `CLR-${fx.runId}-${tag(label)}`,
          category: 'Laptop',
          name: `CLR Warranty ${label}`,
          branchId: fx.branchA,
          status,
          warrantyExpiry: daysFromNow(daysOut),
        },
      });
      return asset.id;
    };

    beforeAll(() => {
      reminders = ctx.app.get(RemindersService);
      source = ctx.app.get(AssetWarrantyReminderSource);
    });

    it('XM-API-12a the source declares tiers 60/30/7 against reminder_days_asset_warranty', () => {
      expect(source.key).toBe('asset_warranty');
      expect(source.thresholdSettingKey).toBe('reminder_days_asset_warranty');
      expect(source.defaultThresholds).toEqual([60, 30, 7]);
      expect(
        reminders.listSources().map((s) => s.key),
      ).toContain('asset_warranty');
    });

    it('XM-API-12b each of the three tiers fires as the expiry closes in, tighter tiers burning the wider ones', async () => {
      const wide = await mkWarrantyAsset('W60', 50); // crosses 60 only
      const mid = await mkWarrantyAsset('W30', 20); // crosses 60 and 30
      const tight = await mkWarrantyAsset('W07', 3); // crosses all three

      await reminders.runSource(source);

      expect((await dispatchesFor(wide)).map((d) => d.threshold)).toEqual([60]);
      // The tightest CROSSED tier is the one that sends; the wider ones are
      // burned so a late-entered record cannot emit three reminders in a row.
      expect((await dispatchesFor(mid)).map((d) => d.threshold)).toEqual([
        60, 30,
      ]);
      expect((await dispatchesFor(tight)).map((d) => d.threshold)).toEqual([
        60, 30, 7,
      ]);
    });

    it('XM-API-12c RETIRED and LOST assets are skipped — nobody owns their warranty', async () => {
      const retired = await mkWarrantyAsset('WRET', 10, 'RETIRED');
      const lost = await mkWarrantyAsset('WLOST', 10, 'LOST');
      const control = await mkWarrantyAsset('WCTRL', 10, 'ASSIGNED');

      await reminders.runSource(source);

      expect(await dispatchesFor(retired)).toHaveLength(0);
      expect(await dispatchesFor(lost)).toHaveLength(0);
      // The control proves the run reached the window at all, so the two
      // empties above are a filter and not a no-op.
      expect((await dispatchesFor(control)).length).toBeGreaterThan(0);
    });

    it('XM-API-12d every active ADMIN and HR_MANAGER is notified, and nobody else', async () => {
      const assetId = await mkWarrantyAsset('WREC', 4);
      await reminders.runSource(source);

      const notified = await ctx.prisma.notification.findMany({
        where: {
          userId: {
            in: [
              fx.admin.userId,
              fx.scopedHr.userId,
              fx.manager.userId,
              fx.employee.userId,
            ],
          },
          title: { contains: 'Asset warranty' },
          link: { contains: assetId },
        },
        select: { userId: true },
      });
      const ids = new Set(notified.map((n) => n.userId));
      expect(ids.has(fx.admin.userId)).toBe(true);
      expect(ids.has(fx.scopedHr.userId)).toBe(true);
      // An asset is company property; a MANAGER or an EMPLOYEE has no standing.
      expect(ids.has(fx.manager.userId)).toBe(false);
      expect(ids.has(fx.employee.userId)).toBe(false);
    });

    it('XM-API-12e reminder_days_asset_warranty overrides the tiers', async () => {
      const assetId = await mkWarrantyAsset('WSET', 40);

      await withSetting(
        ctx,
        'reminder_days_asset_warranty',
        '45,15',
        async () => {
          await reminders.runSource(source);
        },
      );

      // 45 is the only crossed tier at 40 days out; the default 60 never
      // existed for this run, and 15 is not crossed yet.
      expect((await dispatchesFor(assetId)).map((d) => d.threshold)).toEqual([
        45,
      ]);
    });

    it('XM-API-12f the reminder_dispatches unique key stops a second dispatch for the same tier', async () => {
      const assetId = await mkWarrantyAsset('WDUP', 5);
      await reminders.runSource(source);

      const first = await dispatchesFor(assetId);
      expect(first.map((d) => d.threshold)).toEqual([60, 30, 7]);
      const before = await ctx.prisma.notification.count({
        where: { userId: fx.admin.userId, link: { contains: assetId } },
      });

      // A second run is silent — the dedupe rows are the whole point.
      await reminders.runSource(source);
      expect(await dispatchesFor(assetId)).toHaveLength(3);
      const after = await ctx.prisma.notification.count({
        where: { userId: fx.admin.userId, link: { contains: assetId } },
      });
      expect(after).toBe(before);

      // And the guarantee is in the DATABASE, not only in the service: the
      // @@unique([sourceKey, entityId, threshold, expiryDate]) refuses the
      // duplicate outright, which is what makes two overlapping cron runs safe.
      await expect(
        ctx.prisma.reminderDispatch.create({
          data: {
            sourceKey: 'asset_warranty',
            entityId: assetId,
            threshold: first[0].threshold,
            expiryDate: first[0].expiryDate,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('XM-API-12g a warranty that has already lapsed is never chased', async () => {
      const assetId = await mkWarrantyAsset('WOLD', -3);
      await reminders.runSource(source);
      expect(await dispatchesFor(assetId)).toHaveLength(0);
    });
  });

  // ══ 7. Branch scope on the clearance read ══════════════════════════════════

  describe('CLR-API-39..40 branch scope', () => {
    let foreign: Leaver;

    beforeAll(async () => {
      foreign = await makeLeaver('BR1', {
        withAsset: true,
        branchId: fx.branchB,
      });
    });

    it('CLR-API-39 a branch-scoped HR gets 404 for an employee outside their branch, never a clearance', async () => {
      // REGRESSION LOCK (R26 — fixed, and the severe one). The controller handed
      // the raw id to `getClearanceStatus` with no `assertInBranch`.
      // `AssetAssignment` is `'relation'`-scoped by the holder, so for a
      // branch-A HR the branch middleware FILTERED the branch-B holdings out
      // and the projection reported zero obligations. The answer was not "you
      // may not see this employee" — it was "this employee owes nothing" about
      // someone provably holding a laptop. It failed toward "clear to go".
      //
      // The read now resolves the Employee and runs the same `assertInBranch`
      // the three offboarding doors already use. Per the house convention
      // (`branch-scope.util.ts`), that throws NotFound rather than Forbidden, so
      // a scoped caller cannot use the door as an existence oracle: 404, not
      // 403, matching the neighbouring modules.
      const truth = await clearanceOf(foreign.employeeId, fx.admin.token).expect(
        200,
      );
      expect(truth.body.data.cleared).toBe(false);
      expect(truth.body.data.openAssets[0].assetTag).toBe(foreign.assetTag);

      // The scoped HR is refused rather than misinformed.
      await clearanceOf(foreign.employeeId, fx.scopedHr.token).expect(404);

      // And the refusal is indistinguishable from a genuinely unknown id — no
      // existence leak.
      await clearanceOf(
        '00000000-0000-0000-0000-000000000002',
        fx.scopedHr.token,
      ).expect(404);
    });

    it('CLR-API-40 the offboarding DOORS are branch-guarded even though the read is not', async () => {
      // This is why the gap above is a reporting hole rather than an escape
      // hatch: `EmployeesService.delete` and `ContractsService.terminate` both
      // call `assertInBranch` on the employee before the clearance check, so a
      // scoped HR cannot act on a foreign leaver at all.
      await deleteEmployee(foreign.employeeId, fx.scopedHr.token).expect(404);
      expect(await statusOf(foreign.employeeId)).toBe('ACTIVE');

      // And the global ADMIN, who CAN act, is still refused by the gate.
      const res = await deleteEmployee(
        foreign.employeeId,
        fx.admin.token,
      ).expect(400);
      expect(res.body.message).toContain(foreign.assetTag!);
    });
  });
});
