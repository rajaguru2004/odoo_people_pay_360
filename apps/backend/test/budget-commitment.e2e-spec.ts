import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import {
  readApprovalSwitch,
  restoreApprovalSwitch,
} from './utils/approval-switch';

/**
 * HR budgeting, end to end — and specifically the double-count guard.
 *
 * The assertion that matters: approve a trip (money becomes COMMITTED), then
 * lock the payroll that pays its per-diem (the same money becomes ACTUAL), and
 * Remaining must move exactly ONCE. If the commitment were merely left open,
 * 500 would be subtracted twice and every budget would look overspent.
 */
describe('HR budgeting & commitment ledger (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `bud${Date.now()}`;

  /**
   * Both suites drive travel through the LEGACY auto-approve path, which only
   * runs when no configured chain governs TRAVEL. An admin can turn chains on
   * from Settings, so pin the switch rather than inheriting the environment's.
   */
  let originalSwitch: string | null = null;

  const emails = {
    admin: `admin-${runId}@test.local`,
    traveller: `trav-${runId}@test.local`,
  };

  let branchId: string;
  let deptId: string;
  let adminToken: string;
  let travellerToken: string;
  let empId: string;
  let budgetId: string;

  const PLANNED_TRAVEL = 5000;
  const PER_DIEM_RATE = 100;
  const PER_DIEM_DAYS = 5; // 1–5 Sep inclusive
  const TRIP_ESTIMATE = 700;
  const DESTINATION = `Budget Dest ${runId}`;

  /** Convenience: the Travel row of the variance report. */
  async function travelRow() {
    const res = await ctx
      .http()
      .get(`/budgets/${budgetId}/variance`)
      .set(bearer(adminToken))
      .expect(200);
    return {
      row: res.body.data.rows.find((r: any) => r.category === 'Travel'),
      totals: res.body.data.totals,
      unbudgeted: res.body.data.unbudgeted,
    };
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
        data: { code: `BUD-BR-${runId}`, name: 'Budget E2E Branch', isActive: true },
      })
    ).id;
    deptId = (
      await prisma.department.create({
        data: { code: `BUD-DEP-${runId}`, name: `Budget Dept ${runId}`, isActive: true },
      })
    ).id;

    await prisma.user.create({
      data: {
        email: emails.admin,
        passwordHash: hash,
        role: 'ADMIN',
        isActive: true,
        isGlobalBranchAccess: true,
      },
    });

    const employee = await prisma.employee.create({
      data: {
        employeeCode: `BUD-A-${runId}`,
        fullName: `Budget Traveller ${runId}`,
        email: emails.traveller,
        idCard: `ID-BUD-${runId}`,
        dateOfBirth: new Date('1990-01-01'),
        startDate: new Date('2020-01-01'),
        departmentId: deptId,
        position: 'Engineer',
        branchId,
        baseSalary: 1000,
        status: 'ACTIVE',
      },
    });
    empId = employee.id;
    await prisma.user.create({
      data: {
        email: emails.traveller,
        passwordHash: hash,
        role: 'EMPLOYEE',
        employeeId: employee.id,
        isActive: true,
        branchAccess: { create: [{ branchId }] },
      },
    });

    await prisma.libraryItem.create({
      data: {
        libraryType: 'PER_DIEM_DESTINATION',
        label: DESTINATION,
        isActive: true,
        perDiemRate: PER_DIEM_RATE,
      },
    });

    // Attendance, or payroll refuses to run for the period.
    await prisma.attendance.createMany({
      data: Array.from({ length: 22 }, (_, i) => ({
        employeeId: empId,
        date: new Date(Date.UTC(2026, 8, i + 1)),
        checkIn: new Date(Date.UTC(2026, 8, i + 1, 9, 0)),
        checkOut: new Date(Date.UTC(2026, 8, i + 1, 18, 0)),
        workHours: 8,
        status: 'PRESENT',
        branchId,
      })),
      skipDuplicates: true,
    });

    adminToken = (
      await ctx.http().post('/auth/login').send({ email: emails.admin, password: PASSWORD })
    ).body.data.accessToken;
    travellerToken = (
      await ctx
        .http()
        .post('/auth/login')
        .send({ email: emails.traveller, password: PASSWORD })
    ).body.data.accessToken;
    expect(adminToken).toBeTruthy();
  });

  afterAll(async () => {
    const { prisma } = ctx;
    await prisma.budgetCommitment.deleteMany({
      where: { line: { budget: { branchId } } },
    });
    await prisma.budgetLine.deleteMany({ where: { budget: { branchId } } });
    await prisma.budget.deleteMany({ where: { branchId } });
    await prisma.reimbursement.deleteMany({ where: { employee: { branchId } } });
    await prisma.travelRequest.deleteMany({ where: { employee: { branchId } } });
    await prisma.attendance.deleteMany({ where: { branchId } });
    await prisma.payrollItem.deleteMany({ where: { employee: { branchId } } });
    await prisma.payroll.deleteMany({ where: { branchId } });
    await prisma.libraryItem.deleteMany({
      where: { libraryType: 'PER_DIEM_DESTINATION', label: DESTINATION },
    });
    await prisma.user.deleteMany({
      where: { email: { endsWith: `${runId}@test.local` } },
    });
    await prisma.employee.deleteMany({ where: { branchId } });
    await prisma.department.deleteMany({ where: { id: deptId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await restoreApprovalSwitch(prisma, originalSwitch);
    await ctx.app.close();
  });

  describe('setup', () => {
    it('creates a fiscal budget', async () => {
      const res = await ctx
        .http()
        .post('/budgets')
        .set(bearer(adminToken))
        .send({
          name: `FY2026 ${runId}`,
          fiscalYear: 2026,
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          branchId,
          currency: 'OMR',
        })
        .expect(201);
      budgetId = res.body.data.id;
      // DRAFT by default — only ACTIVE budgets attract commitments.
      expect(res.body.data.status).toBe('DRAFT');
    });

    it('rejects an end date before the start', async () => {
      await ctx
        .http()
        .post('/budgets')
        .set(bearer(adminToken))
        .send({
          name: `Bad ${runId}`,
          fiscalYear: 2026,
          startDate: '2026-12-31',
          endDate: '2026-01-01',
          branchId,
        })
        .expect(400);
    });

    it('adds a departmental travel line', async () => {
      await ctx
        .http()
        .post(`/budgets/${budgetId}/lines`)
        .set(bearer(adminToken))
        .send({ departmentId: deptId, category: 'Travel', plannedAmount: PLANNED_TRAVEL })
        .expect(201);

      const { row } = await travelRow();
      expect(row.planned).toBe(PLANNED_TRAVEL);
      expect(row.committed).toBe(0);
      expect(row.actual).toBe(0);
      expect(row.remaining).toBe(PLANNED_TRAVEL);
    });

    it('upserts rather than duplicating a line', async () => {
      await ctx
        .http()
        .post(`/budgets/${budgetId}/lines`)
        .set(bearer(adminToken))
        .send({ departmentId: deptId, category: 'Travel', plannedAmount: PLANNED_TRAVEL })
        .expect(201);

      const budget = await ctx.prisma.budget.findUnique({
        where: { id: budgetId },
        include: { lines: true },
      });
      expect(budget!.lines.filter((l) => l.category === 'Travel')).toHaveLength(1);
    });

    it('activates the budget', async () => {
      await ctx
        .http()
        .patch(`/budgets/${budgetId}/status`)
        .set(bearer(adminToken))
        .send({ status: 'ACTIVE' })
        .expect(200);
    });
  });


  /**
   * Approve a trip that has already been submitted.
   *
   * Travel stopped approving itself on submit: "no approval chain configured"
   * means no CHAIN, not "nobody decides". The budget commitment is a side effect
   * of APPROVAL, so a trip that is merely submitted commits nothing. See
   * docs/TEST-PLAN-FINANCE.md F9.
   */
  const approveTrip = (id: string) =>
    ctx
      .http()
      .post(`/travel-requests/${id}/approve`)
      .set(bearer(adminToken))
      .send({})
      .expect(201);

  describe('commitment', () => {
    let tripId: string;

    it('an approved trip commits money before it is spent', async () => {
      const res = await ctx
        .http()
        .post('/travel-requests')
        .set(bearer(travellerToken))
        .send({
          purpose: 'Budget e2e trip',
          travelType: 'DOMESTIC',
          destination: DESTINATION,
          departureDate: '2026-09-01',
          returnDate: '2026-09-05',
          estimatedCost: TRIP_ESTIMATE,
        })
        .expect(201);
      tripId = res.body.data.id;
      await approveTrip(tripId);

      const commitment = await ctx.prisma.budgetCommitment.findUnique({
        where: { sourceType_sourceId: { sourceType: 'TRAVEL', sourceId: tripId } },
      });
      expect(commitment?.status).toBe('OPEN');
      expect(Number(commitment?.amount)).toBe(TRIP_ESTIMATE);

      const { row } = await travelRow();
      expect(row.committed).toBe(TRIP_ESTIMATE);
      expect(row.actual).toBe(0);
      // Remaining reflects the approval immediately — not a payroll cycle later.
      expect(row.remaining).toBe(PLANNED_TRAVEL - TRIP_ESTIMATE);
    });

    it('THE DOUBLE-COUNT GUARD: paying the claim moves money once, not twice', async () => {
      const perDiem = PER_DIEM_RATE * PER_DIEM_DAYS;

      const run = await ctx
        .http()
        .post('/payrolls')
        .set(bearer(adminToken))
        .set('X-Branch-Id', branchId)
        .send({ month: 9, year: 2026, employeeIds: [empId] })
        .expect(201);
      const payrollId = run.body.data?.id ?? run.body.data?.payroll?.id;

      await ctx.prisma.payroll.update({
        where: { id: payrollId },
        data: { status: 'APPROVED' },
      });
      await ctx
        .http()
        .post(`/payrolls/${payrollId}/lock`)
        .set(bearer(adminToken))
        .set('X-Branch-Id', branchId)
        .expect(201);

      // The commitment is REALIZED, not released and not left open.
      const commitment = await ctx.prisma.budgetCommitment.findUnique({
        where: { sourceType_sourceId: { sourceType: 'TRAVEL', sourceId: tripId } },
      });
      expect(commitment?.status).toBe('REALIZED');
      expect(commitment?.resolvedAt).toBeTruthy();

      const { row } = await travelRow();
      // Committed drops to zero exactly as Actual picks the money up.
      expect(row.committed).toBe(0);
      expect(row.actual).toBe(perDiem);
      expect(row.remaining).toBe(PLANNED_TRAVEL - perDiem);

      // The whole point, stated directly: had the commitment stayed OPEN,
      // remaining would be PLANNED - TRIP_ESTIMATE - perDiem.
      expect(row.remaining).not.toBe(PLANNED_TRAVEL - TRIP_ESTIMATE - perDiem);
    });

    it('a cancelled trip releases its commitment', async () => {
      const res = await ctx
        .http()
        .post('/travel-requests')
        .set(bearer(travellerToken))
        .send({
          purpose: 'To be cancelled',
          travelType: 'DOMESTIC',
          destination: DESTINATION,
          departureDate: '2026-10-01',
          returnDate: '2026-10-02',
          estimatedCost: 400,
        })
        .expect(201);
      const cancelId = res.body.data.id;
      await approveTrip(cancelId);

      const before = (await travelRow()).row.committed;
      expect(before).toBe(400);

      await ctx
        .http()
        .delete(`/travel-requests/${cancelId}`)
        .set(bearer(travellerToken))
        .expect(200);

      const commitment = await ctx.prisma.budgetCommitment.findUnique({
        where: { sourceType_sourceId: { sourceType: 'TRAVEL', sourceId: cancelId } },
      });
      expect(commitment?.status).toBe('RELEASED');
      expect((await travelRow()).row.committed).toBe(0);
    });

    it('budgeting never blocks an approval when no line matches', async () => {
      // Nothing budgeted for Training in this fiscal year.
      const res = await ctx
        .http()
        .post('/travel-requests')
        .set(bearer(travellerToken))
        .send({
          purpose: 'Out of fiscal window',
          travelType: 'DOMESTIC',
          destination: DESTINATION,
          // 2028 falls outside the budget window entirely.
          departureDate: '2028-03-01',
          returnDate: '2028-03-02',
          estimatedCost: 250,
        })
        .expect(201);
      await approveTrip(res.body.data.id);

      const trip = await ctx.prisma.travelRequest.findUnique({
        where: { id: res.body.data.id },
      });
      // Approved regardless — an unconfigured budget must not stop the business.
      expect(trip?.status).toBe('APPROVED');
      const commitment = await ctx.prisma.budgetCommitment.findUnique({
        where: {
          sourceType_sourceId: { sourceType: 'TRAVEL', sourceId: res.body.data.id },
        },
      });
      expect(commitment).toBeNull();
    });
  });

  describe('variance report', () => {
    it('surfaces real spend that has no budget line', async () => {
      // Payroll for this branch was locked above, but nothing is budgeted for
      // the Payroll category — that overspend must be visible, not swallowed.
      const { unbudgeted } = await travelRow();
      const payroll = unbudgeted.find((u: any) => u.category === 'Payroll');
      expect(payroll).toBeTruthy();
      expect(payroll.actual).toBeGreaterThan(0);
    });

    it('refuses to delete a line with open commitments', async () => {
      const res = await ctx
        .http()
        .post('/travel-requests')
        .set(bearer(travellerToken))
        .send({
          purpose: 'Holds a commitment',
          travelType: 'DOMESTIC',
          destination: DESTINATION,
          departureDate: '2026-11-01',
          returnDate: '2026-11-02',
          estimatedCost: 100,
        })
        .expect(201);
      await approveTrip(res.body.data.id);

      const line = await ctx.prisma.budgetLine.findFirst({
        where: { budgetId, category: 'Travel' },
      });

      const del = await ctx
        .http()
        .delete(`/budgets/${budgetId}/lines/${line!.id}`)
        .set(bearer(adminToken))
        .expect(400);
      expect(del.body.message).toMatch(/open commitments/i);

      // Tidy up so the line is deletable again.
      await ctx
        .http()
        .delete(`/travel-requests/${res.body.data.id}`)
        .set(bearer(travellerToken))
        .expect(200);
    });

    it('totals across lines', async () => {
      const { totals } = await travelRow();
      expect(totals.planned).toBe(PLANNED_TRAVEL);
      expect(totals.remaining).toBe(totals.planned - totals.committed - totals.actual);
    });
  });
});
