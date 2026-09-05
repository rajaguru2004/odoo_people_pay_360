import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { readApprovalSwitch, restoreApprovalSwitch } from './utils/approval-switch';
import { bearer } from './utils/fixtures';

/**
 * End-to-end coverage for Enterprise Bank Master + Bank Change Requests. Proves,
 * against the real DB:
 *   1. Bank Master CRUD (admin) + employee can list active banks.
 *   2. A BANK_CHANGE chain SUPERVISOR->HR_MANAGER: request never mutates the
 *      employee record until final approval, then writes ONE active
 *      EmployeeBankDetail. Reject writes nothing.
 *   3. Guards: invalid IBAN -> 400; one pending per employee -> 409;
 *      self/outsider cannot approve -> 403; payroll-in-progress -> 409.
 *   4. Kill-switch off => request auto-applies (legacy fallback).
 *
 * A supervisor here is a role=EMPLOYEE user — approval authority is a data-driven
 * assignment, not an RBAC grant.
 */
describe('Bank Master & Bank Change Requests (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `bank${Date.now()}`;
  let originalSwitchValue: string | null = null;

  // A genuinely valid Oman IBAN (23 chars, bank code "018").
  const VALID_OM_IBAN = 'OM810180000001299123456';
  const BAD_IBAN = 'OM8101800000012991234'; // wrong length (21, OM needs 23)

  const emails = {
    admin: `admin-${runId}@test.local`,
    hr: `hr-${runId}@test.local`,
    supervisor: `sup-${runId}@test.local`,
    requester: `req-${runId}@test.local`,
    outsider: `out-${runId}@test.local`,
  };

  let branchId: string;
  let supervisorEmpId: string;
  let requesterEmpId: string;
  let outsiderEmpId: string;
  let bankId: string;

  let adminToken: string;
  let hrToken: string;
  let supervisorToken: string;
  let requesterToken: string;
  let outsiderToken: string;

  const createdWorkflowIds: string[] = [];

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const { prisma } = ctx;
    const hash = await bcrypt.hash(PASSWORD, 10);
    originalSwitchValue = await readApprovalSwitch(prisma);

    const branch = await prisma.branch.create({
      data: {
        code: `BNK-BR-${runId}`,
        name: 'Bank Branch',
        country: 'OM',
        isActive: true,
        timezone: 'Asia/Muscat',
        officeStartTime: '09:00',
        officeEndTime: '18:00',
      },
    });
    branchId = branch.id;

    const dept = await prisma.department.create({
      data: { code: `BNK-D-${runId}`, name: `Bank Dept ${runId}`, isActive: true },
    });

    const mkEmp = (suffix: string) =>
      prisma.employee.create({
        data: {
          employeeCode: `BNK-${runId}-${suffix}`,
          fullName: `Bank ${suffix}`,
          dateOfBirth: new Date('1990-01-01'),
          idCard: `BNK-ID-${runId}-${suffix}`,
          email: `emp-${suffix}-${runId}@test.local`,
          departmentId: dept.id,
          branchId: branch.id,
          position: 'Engineer',
          startDate: new Date('2015-01-01'),
          baseSalary: 50000,
          status: 'ACTIVE',
        },
      });
    const [supEmp, reqEmp, outEmp] = await Promise.all([
      mkEmp('SUP'),
      mkEmp('REQ'),
      mkEmp('OUT'),
    ]);
    supervisorEmpId = supEmp.id;
    requesterEmpId = reqEmp.id;
    outsiderEmpId = outEmp.id;

    const mkUser = (email: string, role: string, employeeId?: string) =>
      prisma.user.create({
        data: {
          email,
          passwordHash: hash,
          role,
          isActive: true,
          isGlobalBranchAccess: true,
          employeeId,
        },
      });
    await Promise.all([
      mkUser(emails.admin, 'ADMIN'),
      mkUser(emails.hr, 'HR_MANAGER'),
      mkUser(emails.supervisor, 'EMPLOYEE', supervisorEmpId),
      mkUser(emails.requester, 'EMPLOYEE', requesterEmpId),
      mkUser(emails.outsider, 'EMPLOYEE', outsiderEmpId),
    ]);

    // Requester reports to supervisor so the SUPERVISOR step resolves.
    await prisma.employee.update({
      where: { id: requesterEmpId },
      data: { supervisorId: supervisorEmpId },
    });

    // Ensure the OM banking field schema exists (accountHolderName + iban).
    await prisma.countryBankingField.upsert({
      where: { country_fieldKey: { country: 'OM', fieldKey: 'accountHolderName' } },
      update: {},
      create: { country: 'OM', fieldKey: 'accountHolderName', label: 'Account Holder Name', validationType: 'NONE', required: true, displayOrder: 1, isSensitive: false },
    });
    await prisma.countryBankingField.upsert({
      where: { country_fieldKey: { country: 'OM', fieldKey: 'iban' } },
      update: {},
      create: { country: 'OM', fieldKey: 'iban', label: 'IBAN', validationType: 'IBAN', required: true, displayOrder: 2, isSensitive: true },
    });

    const login = async (email: string) =>
      (await ctx.http().post('/auth/login').send({ email, password: PASSWORD }))
        .body?.data?.accessToken as string;
    [adminToken, hrToken, supervisorToken, requesterToken, outsiderToken] =
      await Promise.all([
        login(emails.admin),
        login(emails.hr),
        login(emails.supervisor),
        login(emails.requester),
        login(emails.outsider),
      ]);
  });

  afterAll(async () => {
    const { prisma } = ctx;
    const empWhere = { employee: { employeeCode: { contains: runId } } };
    const bankReqIds = (
      await prisma.bankChangeRequest.findMany({
        where: empWhere,
        select: { id: true },
      })
    ).map((r) => r.id);
    await prisma.requestApproval.deleteMany({
      where: { requestType: 'BANK_CHANGE', requestId: { in: bankReqIds } },
    });
    await prisma.payrollItem.deleteMany({ where: empWhere });
    await prisma.payroll.deleteMany({
      where: { month: 3, year: 2099, branchId },
    });
    await prisma.employeeBankDetail.deleteMany({ where: empWhere });
    await prisma.bankChangeRequest.deleteMany({ where: empWhere });
    await prisma.bank.deleteMany({ where: { name: { contains: runId } } });
    if (createdWorkflowIds.length) {
      await prisma.approvalStep.deleteMany({
        where: { workflowId: { in: createdWorkflowIds } },
      });
      await prisma.approvalWorkflow.deleteMany({
        where: { id: { in: createdWorkflowIds } },
      });
    }
    await prisma.approvalWorkflow.deleteMany({
      where: { name: { contains: runId } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: runId } } });
    await prisma.employee.deleteMany({
      where: { employeeCode: { contains: runId } },
    });
    await prisma.department.deleteMany({ where: { code: { contains: runId } } });
    await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
    await restoreApprovalSwitch(prisma, originalSwitchValue);
    await ctx.app.close();
  });

  // ── 1. Bank Master ────────────────────────────────────────────────────
  it('ADMIN creates a bank; employees can list active banks', async () => {
    const create = await ctx
      .http()
      .post('/banks')
      .set(bearer(adminToken))
      .send({ country: 'OM', name: `Bank Muscat ${runId}`, swift: 'BMUSOMRX' });
    expect(create.status).toBe(201);
    bankId = create.body?.data?.id;
    expect(bankId).toBeDefined();

    // Non-admin cannot create.
    const forbidden = await ctx
      .http()
      .post('/banks')
      .set(bearer(requesterToken))
      .send({ country: 'OM', name: `Nope ${runId}` });
    expect(forbidden.status).toBe(403);

    const list = await ctx
      .http()
      .get('/banks?country=OM&activeOnly=true')
      .set(bearer(requesterToken));
    expect(list.body?.success).toBe(true);
    expect(JSON.stringify(list.body.data)).toContain(bankId);
  });

  // ── 2. Configure the BANK_CHANGE chain + enable the switch ────────────
  it('ADMIN configures a BANK_CHANGE chain SUPERVISOR->HR_MANAGER', async () => {
    const wf = await ctx
      .http()
      .put('/approval-workflows')
      .set(bearer(adminToken))
      .send({
        requestType: 'BANK_CHANGE',
        name: `wf-bank-${runId}`,
        steps: [{ approverType: 'SUPERVISOR' }, { approverType: 'HR_MANAGER' }],
      });
    expect(wf.status).toBe(200);
    createdWorkflowIds.push(wf.body.data.id);

    await ctx
      .http()
      .post('/system-settings')
      .set(bearer(adminToken))
      .send({ settings: { supervisor_approval_enabled: 'true' } });
  });

  // ── 3. Submit + guards ────────────────────────────────────────────────
  it('rejects an invalid IBAN with 400', async () => {
    const res = await ctx
      .http()
      .post('/bank-change-requests')
      .set(bearer(requesterToken))
      .send({
        bankId,
        data: { accountHolderName: 'Bank REQ', iban: BAD_IBAN },
      });
    expect(res.status).toBe(400);
  });

  let requestId: string;
  it('requester submits a valid request -> PENDING, trail materialized, no detail yet', async () => {
    const res = await ctx
      .http()
      .post('/bank-change-requests')
      .set(bearer(requesterToken))
      .send({
        bankId,
        data: { accountHolderName: 'Bank REQ', iban: VALID_OM_IBAN },
      });
    expect(res.status).toBe(201);
    expect(res.body?.data?.status).toBe('PENDING');
    requestId = res.body.data.id;

    const trail = await ctx
      .http()
      .get(`/approval-workflows/trail/BANK_CHANGE/${requestId}`)
      .set(bearer(adminToken));
    // Trail responses carry { engaged, steps, activeStep, canAct }.
    expect(trail.body.data.engaged).toBe(true);
    const step1 = trail.body.data.steps.find((t: any) => t.stepOrder === 1);
    expect(step1.status).toBe('ACTIVE');
    expect(step1.approverType).toBe('SUPERVISOR');

    // Employee record untouched: no active bank detail.
    const detail = await ctx.prisma.employeeBankDetail.findFirst({
      where: { employeeId: requesterEmpId, isActive: true },
    });
    expect(detail).toBeNull();
  });

  it('a second pending request is rejected with 409', async () => {
    const res = await ctx
      .http()
      .post('/bank-change-requests')
      .set(bearer(requesterToken))
      .send({ bankId, data: { accountHolderName: 'Bank REQ', iban: VALID_OM_IBAN } });
    expect(res.status).toBe(409);
  });

  it('an outsider cannot approve the request (403)', async () => {
    const res = await ctx
      .http()
      .post(`/bank-change-requests/${requestId}/approve`)
      .set(bearer(outsiderToken))
      .send({});
    expect(res.status).toBe(403);
  });

  it('supervisor then HR approve -> APPROVED writes one active EmployeeBankDetail', async () => {
    const s = await ctx
      .http()
      .post(`/bank-change-requests/${requestId}/approve`)
      .set(bearer(supervisorToken))
      .send({});
    expect(s.status).toBe(201);
    let req = await ctx.prisma.bankChangeRequest.findUnique({
      where: { id: requestId },
      select: { status: true },
    });
    expect(req?.status).toBe('PENDING');

    const h = await ctx
      .http()
      .post(`/bank-change-requests/${requestId}/approve`)
      .set(bearer(hrToken))
      .send({});
    expect(h.status).toBe(201);
    req = await ctx.prisma.bankChangeRequest.findUnique({
      where: { id: requestId },
      select: { status: true },
    });
    expect(req?.status).toBe('APPROVED');

    const details = await ctx.prisma.employeeBankDetail.findMany({
      where: { employeeId: requesterEmpId, isActive: true },
    });
    expect(details.length).toBe(1);
    expect(details[0].iban).toBe(VALID_OM_IBAN);
  });

  it('reject path writes no new detail', async () => {
    const create = await ctx
      .http()
      .post('/bank-change-requests')
      .set(bearer(requesterToken))
      .send({ bankId, data: { accountHolderName: 'Bank REQ v2', iban: VALID_OM_IBAN } });
    expect(create.status).toBe(201);
    const rejId = create.body.data.id;

    const rej = await ctx
      .http()
      .post(`/bank-change-requests/${rejId}/reject`)
      .set(bearer(supervisorToken))
      .send({ comment: 'wrong iban' });
    expect(rej.status).toBe(201);

    const req = await ctx.prisma.bankChangeRequest.findUnique({
      where: { id: rejId },
      select: { status: true },
    });
    expect(req?.status).toBe('REJECTED');
    // Still exactly one active detail (the earlier approved one).
    const active = await ctx.prisma.employeeBankDetail.count({
      where: { employeeId: requesterEmpId, isActive: true },
    });
    expect(active).toBe(1);
  });

  it('rejects a bank whose country differs from the employee branch (400)', async () => {
    const ae = await ctx
      .http()
      .post('/banks')
      .set(bearer(adminToken))
      .send({ country: 'AE', name: `AE Bank ${runId}` });
    expect(ae.status).toBe(201);
    const res = await ctx
      .http()
      .post('/bank-change-requests')
      .set(bearer(requesterToken))
      .send({
        bankId: ae.body.data.id,
        data: { accountHolderName: 'Bank REQ', iban: 'AE070331234567890123456' },
      });
    expect(res.status).toBe(400);
  });

  it('branch banking countries drive the allowed set (multi-country)', async () => {
    const set = await ctx
      .http()
      .put(`/banks/branch-countries/${branchId}`)
      .set(bearer(adminToken))
      .send({ countries: ['OM', 'AE'] });
    expect(set.status).toBe(200);

    const cur = await ctx
      .http()
      .get('/bank-change-requests/me/current')
      .set(bearer(requesterToken));
    expect(cur.body?.data?.countries).toEqual(expect.arrayContaining(['OM', 'AE']));
  });

  // ── 4. Payroll lock ───────────────────────────────────────────────────
  it('blocks a submission while a payroll run is in progress (409)', async () => {
    const payroll = await ctx.prisma.payroll.create({
      data: { month: 3, year: 2099, status: 'DRAFT', branchId },
    });
    await ctx.prisma.payrollItem.create({
      data: {
        payrollId: payroll.id,
        employeeId: outsiderEmpId,
        baseSalary: 50000,
        workDays: 22,
        actualWorkDays: 22,
        netSalary: 50000,
      },
    });

    const res = await ctx
      .http()
      .post('/bank-change-requests')
      .set(bearer(outsiderToken))
      .send({ bankId, data: { accountHolderName: 'Bank OUT', iban: VALID_OM_IBAN } });
    expect(res.status).toBe(409);

    // Cleanup so it doesn't leak into later tests.
    await ctx.prisma.payrollItem.deleteMany({ where: { payrollId: payroll.id } });
    await ctx.prisma.payroll.delete({ where: { id: payroll.id } });
  });

  // ── 4b. Migration is exempt from the payroll lock for FIRST-TIME details ──
  //
  // The payroll-in-progress lock stops a destination being CHANGED mid-run. Every
  // employee the Bank Migration screen lists has no active detail at all, so
  // enforcing it there protected nothing and deadlocked onboarding: a single open
  // company-wide payroll blocked the whole company. These two cases pin the
  // carve-out to exactly first-time population.
  describe('migration vs the payroll lock', () => {
    let lockPayrollId: string;
    let freshEmpId: string;

    beforeAll(async () => {
      const dept = await ctx.prisma.department.findFirst({
        where: { code: { startsWith: 'BNK-D-' } },
      });
      const fresh = await ctx.prisma.employee.create({
        data: {
          employeeCode: `BNK-${runId}-MIG`,
          fullName: 'Bank MIG',
          dateOfBirth: new Date('1990-01-01'),
          idCard: `BNK-ID-${runId}-MIG`,
          email: `emp-mig-${runId}@test.local`,
          departmentId: dept!.id,
          branchId,
          position: 'Engineer',
          startDate: new Date('2015-01-01'),
          baseSalary: 50000,
          status: 'ACTIVE',
        },
      });
      freshEmpId = fresh.id;

      // One in-flight run covering BOTH the fresh employee (no detail) and the
      // requester (who already has an active detail from the approval test).
      const payroll = await ctx.prisma.payroll.create({
        data: { month: 4, year: 2099, status: 'DRAFT', branchId },
      });
      lockPayrollId = payroll.id;
      for (const employeeId of [freshEmpId, requesterEmpId]) {
        await ctx.prisma.payrollItem.create({
          data: {
            payrollId: payroll.id,
            employeeId,
            baseSalary: 50000,
            workDays: 22,
            actualWorkDays: 22,
            netSalary: 50000,
          },
        });
      }
    });

    afterAll(async () => {
      await ctx.prisma.payrollItem.deleteMany({ where: { payrollId: lockPayrollId } });
      await ctx.prisma.payroll.delete({ where: { id: lockPayrollId } });
    });

    it('allows first-time migration during an in-flight payroll', async () => {
      const res = await ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(adminToken))
        .send({
          employeeId: freshEmpId,
          bankId,
          data: { accountHolderName: 'Bank MIG', iban: VALID_OM_IBAN },
        });
      expect(res.status).toBe(201);

      const detail = await ctx.prisma.employeeBankDetail.findFirst({
        where: { employeeId: freshEmpId, isActive: true },
      });
      expect(detail?.source).toBe('MIGRATION');
    });

    it('still blocks migration that would OVERWRITE an existing detail (409)', async () => {
      // The requester already has an active detail, so this is a real change of
      // destination mid-run — exactly what the lock is for.
      const res = await ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(adminToken))
        .send({
          employeeId: requesterEmpId,
          bankId,
          data: { accountHolderName: 'Bank REQ', iban: VALID_OM_IBAN },
        });
      expect(res.status).toBe(409);
      expect(res.body?.message).toMatch(/payroll run is in progress/i);
    });
  });

  // ── 5. Kill-switch off => auto-apply ──────────────────────────────────
  it('with the master switch off, a request auto-applies (legacy fallback)', async () => {
    await ctx
      .http()
      .post('/system-settings')
      .set(bearer(adminToken))
      .send({ settings: { supervisor_approval_enabled: 'false' } });

    const res = await ctx
      .http()
      .post('/bank-change-requests')
      .set(bearer(outsiderToken))
      .send({ bankId, data: { accountHolderName: 'Bank OUT', iban: VALID_OM_IBAN } });
    expect(res.status).toBe(201);
    expect(res.body?.data?.status).toBe('APPROVED');

    const detail = await ctx.prisma.employeeBankDetail.findFirst({
      where: { employeeId: outsiderEmpId, isActive: true },
    });
    expect(detail?.iban).toBe(VALID_OM_IBAN);
  });
});
