import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import {
  readApprovalSwitch,
  restoreApprovalSwitch,
} from './utils/approval-switch';

/**
 * Training management + the appraisal-derived training-needs differentiator.
 *
 * What matters here:
 *   1. training is a reimbursement EXTENSION — with training_paid_by=EMPLOYEE a
 *      nomination spawns an ordinary `reimbursements` row tagged
 *      sourceType='TRAINING'; with COMPANY (the default) it spawns none, because
 *      there is nothing to reimburse;
 *   2. certificate expiry is DERIVED from the course validity window at
 *      attendance, which is what feeds the reminder engine;
 *   3. needs derived from an appraisal run read real improvement areas, keep the
 *      provenance, and never auto-nominate;
 *   4. seat caps and one-nomination-per-employee-per-session hold.
 */
describe('Training management (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `trn${Date.now()}`;

  /**
   * These specs assert the LEGACY auto-approve path (engaged=false). That path
   * is only taken when the master switch is off or no chain governs the type —
   * both of which an admin can change from Settings. Pin the switch for the
   * duration rather than inheriting whatever the environment happens to be
   * configured with, and put it back on teardown.
   */
  let originalSwitch: string | null = null;

  const emails = {
    admin: `admin-${runId}@test.local`,
    a: `traineea-${runId}@test.local`,
    b: `traineeb-${runId}@test.local`,
  };

  let branchId: string;
  let deptId: string;
  let adminToken: string;
  let adminUserId: string;
  let empA: string;
  let empB: string;
  let courseId: string;
  let sessionId: string;
  let appraisalRunId: string;
  let appraisalResultId: string;

  const COURSE_CODE = `SEC-${runId}`;
  const CERT_VALID_MONTHS = 12;
  const COST_PER_SEAT = 300;

  async function makeEmployee(email: string, code: string) {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const employee = await ctx.prisma.employee.create({
      data: {
        employeeCode: code,
        fullName: `Trainee ${code}`,
        email,
        idCard: `ID-${code}`,
        dateOfBirth: new Date('1990-01-01'),
        startDate: new Date('2020-01-01'),
        departmentId: deptId,
        position: 'Engineer',
        branchId,
        baseSalary: 1000,
        status: 'ACTIVE',
      },
    });
    await ctx.prisma.user.create({
      data: {
        email,
        passwordHash: hash,
        role: 'EMPLOYEE',
        employeeId: employee.id,
        isActive: true,
        branchAccess: { create: [{ branchId }] },
      },
    });
    return employee.id;
  }

  async function setPaidBy(value: 'COMPANY' | 'EMPLOYEE') {
    await ctx.prisma.systemSetting.upsert({
      where: { key: 'training_paid_by' },
      create: { key: 'training_paid_by', value },
      update: { value },
    });
  }

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const { prisma } = ctx;
    originalSwitch = await readApprovalSwitch(prisma);
    await prisma.systemSetting.upsert({
      where: { key: 'supervisor_approval_enabled' },
      update: { value: 'false' },
      create: { key: 'supervisor_approval_enabled', value: 'false' },
    });
    const hash = await bcrypt.hash(PASSWORD, 10);

    branchId = (
      await prisma.branch.create({
        data: { code: `TRN-BR-${runId}`, name: 'Training E2E Branch', isActive: true },
      })
    ).id;
    deptId = (
      await prisma.department.create({
        data: { code: `TRN-DEP-${runId}`, name: `Training Dept ${runId}`, isActive: true },
      })
    ).id;

    adminUserId = (
      await prisma.user.create({
        data: {
          email: emails.admin,
          passwordHash: hash,
          role: 'ADMIN',
          isActive: true,
          isGlobalBranchAccess: true,
        },
      })
    ).id;

    empA = await makeEmployee(emails.a, `TRN-A-${runId}`);
    empB = await makeEmployee(emails.b, `TRN-B-${runId}`);

    // A completed appraisal run with a COACH result carrying real improvement
    // areas — the evidence the needs feature derives from.
    const run = await prisma.appraisalRun.create({
      data: {
        status: 'COMPLETED',
        periodStart: new Date('2026-01-01'),
        periodEnd: new Date('2026-06-30'),
        periodLabel: `H1 ${runId}`,
        branchId,
        createdById: adminUserId,
      },
    });
    appraisalRunId = run.id;
    appraisalResultId = (
      await prisma.appraisalResult.create({
        data: {
          runId: run.id,
          employeeId: empA,
          employeeCode: `TRN-A-${runId}`,
          employeeName: `Trainee TRN-A-${runId}`,
          departmentName: `Training Dept ${runId}`,
          recommendation: 'COACH',
          improvementsJson: [
            'Needs to improve information security awareness and phishing recognition',
            'Should strengthen password hygiene practices',
          ],
          status: 'COMPLETED',
        },
      })
    ).id;

    // A second result that is NOT a development signal — must be excluded by default.
    await prisma.appraisalResult.create({
      data: {
        runId: run.id,
        employeeId: empB,
        employeeCode: `TRN-B-${runId}`,
        employeeName: `Trainee TRN-B-${runId}`,
        recommendation: 'PROMOTE',
        improvementsJson: ['Could delegate more'],
        status: 'COMPLETED',
      },
    });

    adminToken = (
      await ctx.http().post('/auth/login').send({ email: emails.admin, password: PASSWORD })
    ).body.data.accessToken;
    expect(adminToken).toBeTruthy();

    await setPaidBy('COMPANY');
  });

  afterAll(async () => {
    const { prisma } = ctx;
    await prisma.reimbursement.deleteMany({ where: { employee: { branchId } } });
    await prisma.trainingNomination.deleteMany({
      where: { employee: { branchId } },
    });
    await prisma.trainingSession.deleteMany({ where: { branchId } });
    await prisma.course.deleteMany({ where: { code: COURSE_CODE } });
    await prisma.appraisalResult.deleteMany({ where: { runId: appraisalRunId } });
    await prisma.appraisalRun.deleteMany({ where: { id: appraisalRunId } });
    await prisma.requestApproval.deleteMany({ where: { requestType: 'TRAINING' } });
    await prisma.user.deleteMany({
      where: { email: { endsWith: `${runId}@test.local` } },
    });
    await prisma.employee.deleteMany({ where: { branchId } });
    await prisma.department.deleteMany({ where: { id: deptId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await setPaidBy('COMPANY');
    await restoreApprovalSwitch(prisma, originalSwitch);
    await ctx.app.close();
  });

  describe('catalogue & sessions', () => {
    it('creates a course with a certificate validity window', async () => {
      const res = await ctx
        .http()
        .post('/training/courses')
        .set(bearer(adminToken))
        .send({
          code: COURSE_CODE,
          title: 'Information Security Awareness',
          category: 'Compliance',
          defaultCost: COST_PER_SEAT,
          certValidMonths: CERT_VALID_MONTHS,
          description: 'Phishing recognition, password hygiene and secure handling',
        })
        .expect(201);
      courseId = res.body.data.id;
      expect(res.body.data.certValidMonths).toBe(CERT_VALID_MONTHS);
    });

    it('rejects a duplicate course code', async () => {
      await ctx
        .http()
        .post('/training/courses')
        .set(bearer(adminToken))
        .send({ code: COURSE_CODE, title: 'Duplicate' })
        .expect(409);
    });

    it('schedules a session, inheriting the course default cost', async () => {
      const res = await ctx
        .http()
        .post('/training/sessions')
        .set(bearer(adminToken))
        .send({
          courseId,
          branchId,
          startDate: '2026-10-05',
          endDate: '2026-10-07',
          location: 'Muscat HQ',
          seats: 1, // deliberately one seat, to prove the cap
        })
        .expect(201);
      sessionId = res.body.data.id;
      expect(Number(res.body.data.costPerSeat)).toBe(COST_PER_SEAT);
    });

    it('rejects a session ending before it starts', async () => {
      await ctx
        .http()
        .post('/training/sessions')
        .set(bearer(adminToken))
        .send({ courseId, startDate: '2026-10-10', endDate: '2026-10-01' })
        .expect(400);
    });
  });

  describe('nomination', () => {
    let nominationId: string;

    it('nominates and auto-approves when no chain governs TRAINING', async () => {
      const res = await ctx
        .http()
        .post('/training/nominations')
        .set(bearer(adminToken))
        .send({ sessionId, employeeId: empA, justification: 'Compliance requirement' })
        .expect(201);

      nominationId = res.body.data.id;
      const row = await ctx.prisma.trainingNomination.findUnique({
        where: { id: nominationId },
      });
      expect(row?.status).toBe('APPROVED');
      // Cost snapshotted, for the same reason travel snapshots its per-diem.
      expect(Number(row?.cost)).toBe(COST_PER_SEAT);
    });

    it('spawns NO claim when the company pays the provider directly', async () => {
      const claims = await ctx.prisma.reimbursement.findMany({
        where: { sourceType: 'TRAINING', sourceId: nominationId },
      });
      expect(claims).toHaveLength(0);
    });

    it('refuses a second nomination for the same employee and session', async () => {
      await ctx
        .http()
        .post('/training/nominations')
        .set(bearer(adminToken))
        .send({ sessionId, employeeId: empA })
        .expect(409);
    });

    it('enforces the seat cap', async () => {
      const res = await ctx
        .http()
        .post('/training/nominations')
        .set(bearer(adminToken))
        .send({ sessionId, employeeId: empB })
        .expect(400);
      expect(res.body.message).toMatch(/full/i);
    });

    it('derives the certificate expiry from the course validity window', async () => {
      await ctx
        .http()
        .post(`/training/nominations/${nominationId}/attendance`)
        .set(bearer(adminToken))
        .send({ attended: true, score: 92, passed: true })
        .expect(201);

      const row = await ctx.prisma.trainingNomination.findUnique({
        where: { id: nominationId },
      });
      expect(row?.status).toBe('ATTENDED');
      expect(row?.certificateExpiry).toBeTruthy();

      // Session ends 7 Oct 2026 + 12 months.
      const expiry = new Date(row!.certificateExpiry!);
      expect(expiry.getUTCFullYear()).toBe(2027);
      expect(expiry.getUTCMonth()).toBe(9); // October
    });

    it('records a NO_SHOW without a certificate', async () => {
      const session2 = await ctx.prisma.trainingSession.create({
        data: { courseId, branchId, startDate: new Date('2026-11-02'), endDate: new Date('2026-11-03') },
      });
      const nom = await ctx
        .http()
        .post('/training/nominations')
        .set(bearer(adminToken))
        .send({ sessionId: session2.id, employeeId: empB })
        .expect(201);

      await ctx
        .http()
        .post(`/training/nominations/${nom.body.data.id}/attendance`)
        .set(bearer(adminToken))
        .send({ attended: false })
        .expect(201);

      const row = await ctx.prisma.trainingNomination.findUnique({
        where: { id: nom.body.data.id },
      });
      expect(row?.status).toBe('NO_SHOW');
      expect(row?.certificateExpiry).toBeNull();
      expect(row?.attendedAt).toBeNull();
    });
  });

  describe('employee-paid training spawns a reimbursement', () => {
    it('creates an ordinary claim tagged sourceType=TRAINING', async () => {
      await setPaidBy('EMPLOYEE');

      const session3 = await ctx.prisma.trainingSession.create({
        data: {
          courseId,
          branchId,
          startDate: new Date('2026-12-01'),
          endDate: new Date('2026-12-02'),
          costPerSeat: 150,
        },
      });

      const res = await ctx
        .http()
        .post('/training/nominations')
        .set(bearer(adminToken))
        .send({ sessionId: session3.id, employeeId: empA })
        .expect(201);

      const claims = await ctx.prisma.reimbursement.findMany({
        where: { sourceType: 'TRAINING', sourceId: res.body.data.id },
      });
      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe('APPROVED');
      expect(Number(claims[0].amount)).toBe(150);
      expect(claims[0].budgetCategory).toBe('Training');
      // Not linked to payroll yet — the normal run picks it up like any claim.
      expect(claims[0].payrollItemId).toBeNull();

      await setPaidBy('COMPANY');
    });
  });

  describe('appraisal-derived training needs', () => {
    it('derives needs from the appraisal run, keeping the evidence', async () => {
      const res = await ctx
        .http()
        .get(`/training/needs/from-run/${appraisalRunId}`)
        .set(bearer(adminToken))
        .expect(200);

      expect(res.body.data.length).toBe(1);
      const need = res.body.data[0];
      expect(need.appraisalResultId).toBe(appraisalResultId);
      expect(need.recommendation).toBe('COACH');
      // The improvement areas the appraisal actually recorded, not a paraphrase.
      expect(need.improvements).toHaveLength(2);
      expect(need.improvements[0]).toMatch(/information security/i);
      // 'llm' when a model is configured and answers, 'keyword' on the
      // deterministic fallback. Both are valid — the point is that the feature
      // produces a real suggestion either way, including offline.
      expect(['llm', 'keyword']).toContain(need.matchedBy);
      expect(need.suggestedCourses.length).toBeGreaterThan(0);

      // Whatever matched must be a course that ACTUALLY EXISTS — a hallucinated
      // code is dropped rather than surfaced. Asserted against the live
      // catalogue rather than against this suite's own course: other seeded
      // courses can legitimately rank higher, and pinning first place would
      // make the test fail on unrelated data.
      const catalogue = await ctx.prisma.course.findMany({ select: { code: true } });
      const known = new Set(catalogue.map((c) => c.code));
      for (const suggestion of need.suggestedCourses) {
        expect(known.has(suggestion.code)).toBe(true);
        expect(suggestion.reason.trim()).not.toBe('');
      }

      // And the match is topically right for the development area, without
      // pinning WHICH course wins: the catalogue can hold several equally valid
      // security courses (seed data does), and the model may reasonably return
      // only one. Asserting a specific winner makes this flaky by design.
      const titles = await ctx.prisma.course.findMany({
        where: { code: { in: need.suggestedCourses.map((c: any) => c.code) } },
        select: { title: true, category: true },
      });
      expect(
        titles.some((t) =>
          /security|phishing|password|compliance/i.test(
            `${t.title} ${t.category ?? ''}`,
          ),
        ),
      ).toBe(true);
    });

    it('narrows to COACH/PIP by default, and widens on request', async () => {
      const narrow = await ctx
        .http()
        .get(`/training/needs/from-run/${appraisalRunId}`)
        .set(bearer(adminToken))
        .expect(200);
      // The PROMOTE result is excluded.
      expect(narrow.body.data.map((n: any) => n.recommendation)).toEqual(['COACH']);

      const wide = await ctx
        .http()
        .get(`/training/needs/from-run/${appraisalRunId}?all=true`)
        .set(bearer(adminToken))
        .expect(200);
      expect(wide.body.data.length).toBe(2);
    });

    it('never auto-nominates', async () => {
      // Deriving needs is a read. Acting on them is a human decision.
      const fromAppraisal = await ctx.prisma.trainingNomination.count({
        where: { source: 'APPRAISAL' },
      });
      expect(fromAppraisal).toBe(0);
    });

    it('keeps provenance when a human acts on a suggestion', async () => {
      const session4 = await ctx.prisma.trainingSession.create({
        data: { courseId, branchId, startDate: new Date('2027-01-11'), endDate: new Date('2027-01-12') },
      });

      const res = await ctx
        .http()
        .post('/training/nominations')
        .set(bearer(adminToken))
        .send({
          sessionId: session4.id,
          employeeId: empA,
          source: 'APPRAISAL',
          appraisalResultId,
          justification: 'Derived from H1 appraisal: security awareness',
        })
        .expect(201);

      const row = await ctx.prisma.trainingNomination.findUnique({
        where: { id: res.body.data.id },
      });
      expect(row?.source).toBe('APPRAISAL');
      // The traceable link back to the evidence that produced the suggestion.
      expect(row?.appraisalResultId).toBe(appraisalResultId);
    });

    it('404s on an unknown appraisal run', async () => {
      await ctx
        .http()
        .get('/training/needs/from-run/00000000-0000-0000-0000-000000000000')
        .set(bearer(adminToken))
        .expect(404);
    });
  });
});
