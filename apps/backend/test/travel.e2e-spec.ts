import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import {
  readApprovalSwitch,
  restoreApprovalSwitch,
} from './utils/approval-switch';

/**
 * Travel management, proved against the real DB.
 *
 * The design claim under test: a trip is a REQUEST, not a second attendance or
 * leave system. So the tests that matter are not "a trip row exists" — they are:
 *   1. the per-diem rate and day count are snapshotted at submit and a later
 *      rate edit cannot move an already-submitted trip;
 *   2. with no chain governing TRAVEL the request WAITS for a human rather than
 *      applying itself;
 *   3. an international trip with no covering visa alerts HR;
 *   4. a trip writes neither attendance nor leave.
 */
describe('Travel management (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `trv${Date.now()}`;

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
    traveller: `trav-${runId}@test.local`,
    intl: `intl-${runId}@test.local`,
  };

  let branchId: string;
  let deptId: string;
  let adminToken: string;
  let travellerToken: string;
  let adminUserId: string;
  let intlEmpId: string;

  const PER_DIEM_RATE = 50;
  const PER_DIEM_DAYS = 5; // 1–5 Sep inclusive
  const DESTINATION = `E2E Muscat ${runId}`;

  async function makeEmployee(email: string, code: string) {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const employee = await ctx.prisma.employee.create({
      data: {
        employeeCode: code,
        fullName: `Traveller ${code}`,
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

    const branch = await prisma.branch.create({
      data: { code: `TRV-BR-${runId}`, name: 'Travel E2E Branch', isActive: true },
    });
    branchId = branch.id;

    const dept = await prisma.department.create({
      data: { code: `TRV-DEP-${runId}`, name: `Travel Dept ${runId}`, isActive: true },
    });
    deptId = dept.id;

    const adminUser = await prisma.user.create({
      data: {
        email: emails.admin,
        passwordHash: hash,
        role: 'ADMIN',
        isActive: true,
        isGlobalBranchAccess: true,
      },
    });
    adminUserId = adminUser.id;

    await makeEmployee(emails.traveller, `TRV-A-${runId}`);
    intlEmpId = await makeEmployee(emails.intl, `TRV-B-${runId}`);

    // Per-diem destination with a rate; the trip snapshots it at submit.
    await prisma.libraryItem.create({
      data: {
        libraryType: 'PER_DIEM_DESTINATION',
        label: DESTINATION,
        isActive: true,
        perDiemRate: PER_DIEM_RATE,
      },
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
    await prisma.travelItinerary.deleteMany({
      where: { travel: { employee: { branchId } } },
    });
    await prisma.travelRequest.deleteMany({ where: { employee: { branchId } } });
    await prisma.requestApproval.deleteMany({ where: { requestType: 'TRAVEL' } });
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

  let tripId: string;

  /**
   * Submit a trip and settle it, which is now two steps rather than one: with
   * no chain configured the request WAITS for an approver instead of applying
   * itself (see the CHANGED note below and docs/TEST-PLAN-FINANCE.md F9).
   * Every case that asserts a side effect of approval goes through here.
   */
  const submitAndApprove = async (
    token: string,
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const res = await ctx
      .http()
      .post('/travel-requests')
      .set(bearer(token))
      .send(payload)
      .expect(201);
    const id = res.body.data.id;
    await ctx
      .http()
      .post(`/travel-requests/${id}/approve`)
      .set(bearer(adminToken))
      .send({})
      .expect(201);
    return id;
  };

  it('snapshots the per-diem rate at submit', async () => {
    const res = await ctx
      .http()
      .post('/travel-requests')
      .set(bearer(travellerToken))
      .send({
        purpose: 'Client workshop',
        travelType: 'DOMESTIC',
        destination: DESTINATION,
        departureDate: '2026-09-01',
        returnDate: '2026-09-05',
        estimatedCost: 400,
      })
      .expect(201);

    tripId = res.body.data.id;
    const trip = await ctx.prisma.travelRequest.findUnique({ where: { id: tripId } });
    expect(Number(trip?.perDiemRate)).toBe(PER_DIEM_RATE);
    // Inclusive day count — a 1–5 Sep trip is five per-diem days, not four.
    expect(trip?.perDiemDays).toBe(PER_DIEM_DAYS);
  });

  it('a later rate edit does not change the approved trip', async () => {
    await ctx.prisma.libraryItem.updateMany({
      where: { libraryType: 'PER_DIEM_DESTINATION', label: DESTINATION },
      data: { perDiemRate: 999 },
    });
    const trip = await ctx.prisma.travelRequest.findUnique({ where: { id: tripId } });
    expect(Number(trip?.perDiemRate)).toBe(PER_DIEM_RATE);
    // Restore for the remaining tests.
    await ctx.prisma.libraryItem.updateMany({
      where: { libraryType: 'PER_DIEM_DESTINATION', label: DESTINATION },
      data: { perDiemRate: PER_DIEM_RATE },
    });
  });

  it('waits for a human when no chain governs TRAVEL', async () => {
    // CHANGED: this used to assert that the request applied ITSELF on submit.
    // `initiate` still returns engaged:false with no ApprovalWorkflow and the
    // master switch off — but that answer means "no CHAIN governs this", not
    // "nobody needs to approve it". Approving a trip is what commits money
    // against a budget. Falling back to no approval at all was the defect. See
    // docs/TEST-PLAN-FINANCE.md F9.
    const pending = await ctx.prisma.travelRequest.findUnique({
      where: { id: tripId },
    });
    expect(pending?.status).toBe('PENDING');

    await ctx
      .http()
      .post(`/travel-requests/${tripId}/approve`)
      .set(bearer(adminToken))
      .send({})
      .expect(201);

    const trip = await ctx.prisma.travelRequest.findUnique({ where: { id: tripId } });
    expect(trip?.status).toBe('APPROVED');
  });

  it('alerts HR when an approved international trip has no covering visa', async () => {
    const before = await ctx.prisma.notification.count({
      where: { userId: adminUserId, title: 'Visa required for approved travel' },
    });

    const intlToken = (
      await ctx.http().post('/auth/login').send({ email: emails.intl, password: PASSWORD })
    ).body.data.accessToken;

    // The visa check runs on APPROVAL — the title says "approved travel".
    await submitAndApprove(intlToken, {
      purpose: 'Vendor visit',
      travelType: 'INTERNATIONAL',
      destination: DESTINATION,
      country: 'United Arab Emirates',
      departureDate: '2026-11-01',
      returnDate: '2026-11-04',
      estimatedCost: 900,
    });

    const after = await ctx.prisma.notification.count({
      where: { userId: adminUserId, title: 'Visa required for approved travel' },
    });
    expect(after).toBe(before + 1);

    // Notified, NOT auto-created: a visa record needs a document number and
    // issuing authority nobody has at trip-approval time.
    const visas = await ctx.prisma.employeeLegalDocument.count({
      where: { employeeId: intlEmpId },
    });
    expect(visas).toBe(0);
  });

  it('shows approved trips on the who-is-away view', async () => {
    const res = await ctx
      .http()
      .get('/travel-requests/on-trip?from=2026-09-01&to=2026-12-31')
      .set(bearer(adminToken))
      .expect(200);

    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('a trip never writes attendance or leave rows', async () => {
    // A trip is NOT leave. Writing either would move payroll day counts, which
    // is exactly why travel days are surfaced through a read-only calendar
    // query instead.
    //
    // Asserted against the international traveller: they took an approved trip
    // (1-4 Nov) and have no attendance seeded by this suite, so anything found
    // here would have been written by the travel flow itself.
    const leaves = await ctx.prisma.leaveRequest.count({
      where: { employeeId: intlEmpId },
    });
    const attendance = await ctx.prisma.attendance.count({
      where: { employeeId: intlEmpId },
    });
    expect(leaves).toBe(0);
    expect(attendance).toBe(0);
  });

  it('rejects a return date before departure', async () => {
    await ctx
      .http()
      .post('/travel-requests')
      .set(bearer(travellerToken))
      .send({
        purpose: 'Bad dates',
        travelType: 'DOMESTIC',
        destination: DESTINATION,
        departureDate: '2026-09-10',
        returnDate: '2026-09-01',
        estimatedCost: 100,
      })
      .expect(400);
  });
});
