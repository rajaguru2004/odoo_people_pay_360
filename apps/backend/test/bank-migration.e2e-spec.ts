import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  seedAttendance,
  PayrollFixtures,
  VALID_OM_IBAN,
  bearer,
} from './utils/payroll-fixtures';

/**
 * Bank migration — the free-text → Bank Master backfill. Phase 4, chunk C6.
 *
 * Employees onboarded before the Bank Master existed carry their bank as loose
 * text on `EmployeeProfile` (`bankName`, `bankBranch`, `bankAccountNumber`,
 * `bankAccountHolderName`). Nothing can be paid from that: WPS needs a `Bank`
 * row, a validated account and a country whose field schema it can check
 * against. `POST /bank-change-requests/migration` is how HR converts one.
 *
 * Two properties make it different from an ordinary bank change, and both are
 * deliberate:
 *
 *  1. **It bypasses the approval chain entirely.** HR is verifying a record that
 *     already exists rather than accepting a new instruction, so there is no one
 *     to approve it. `EmployeeBankDetail.source` is `MIGRATION`, not `APPROVAL`,
 *     and `sourceRequestId` is null.
 *  2. **`exemptFirstTime` lets it through an in-flight payroll.** The freeze
 *     exists to stop an account changing under a run; an employee who has NO
 *     active detail has nothing to change, and without the exemption one open
 *     company-wide run deadlocked onboarding for everybody.
 */
describe('Bank migration — legacy free-text to Bank Master (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;
  let periodCursor = 120;

  const api = () => ctx.http();
  const as = (token: string, req: any, branchId: string | null = fx.branchA) => {
    req.set(bearer(token));
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };
  const asHr = (req: any, branchId: string | null = fx.branchA) =>
    as(fx.hr.token, req, branchId);
  const asAdmin = (req: any, branchId: string | null = fx.branchA) =>
    as(fx.admin.token, req, branchId);

  const candidates = (token = fx.hr.token, branchId: string | null = fx.branchA) =>
    as(token, api().get('/bank-change-requests/migration/candidates'), branchId);

  const migrate = (
    body: Record<string, any>,
    token = fx.hr.token,
    branchId: string | null = fx.branchA,
  ) => as(token, api().post('/bank-change-requests/migration'), branchId).send(body);

  const INDIAN_DETAILS = {
    accountHolderName: 'Payroll MIGRATE',
    accountNumber: '000111222333',
    ifsc: 'HDFC0001234',
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── BMIG-API-01..08  The candidate list ──────────────────────────────────
  describe('BMIG-API-01..08 — candidates', () => {
    it('BMIG-API-01: lists an ACTIVE employee with legacy text and no active detail', async () => {
      const res = await candidates();
      expect(res.status).toBe(200);
      const row = res.body.data.find(
        (c: any) => c.id === fx.migrationCandidateId,
      );
      expect(row).toBeTruthy();
      expect(row.profile.bankName).toBe('Legacy State Bank');
      expect(row.profile.bankAccountNumber).toBe('000111222333');
      expect(row.countries).toContain('IN');
    });

    it('BMIG-API-02: an employee with no legacy record is not a candidate', async () => {
      const res = await candidates();
      const ids = res.body.data.map((c: any) => c.id);
      expect(ids).not.toContain(fx.monthlyEmpId);
    });

    it('BMIG-API-03: an employee who already has an active detail is not a candidate', async () => {
      const res = await candidates(fx.admin.token, fx.branchOm);
      const ids = res.body.data.map((c: any) => c.id);
      expect(ids).not.toContain(fx.omEmpId);
    });

    it('BMIG-API-04: an INACTIVE employee is not a candidate', async () => {
      await ctx.prisma.employeeProfile.create({
        data: {
          employeeId: fx.terminatedEmpId,
          bankName: 'Legacy Leaver Bank',
          bankAccountNumber: '999888777',
        },
      });
      const res = await candidates();
      expect(res.body.data.map((c: any) => c.id)).not.toContain(
        fx.terminatedEmpId,
      );
    });

    it('BMIG-API-05: the list is branch-scoped', async () => {
      await ctx.prisma.employeeProfile.create({
        data: {
          employeeId: fx.branchBEmpId,
          bankName: 'Other Branch Bank',
          bankAccountNumber: '111000111',
        },
      });

      const scoped = await candidates(fx.scopedHr.token, null);
      expect(scoped.status).toBe(200);
      expect(scoped.body.data.map((c: any) => c.id)).not.toContain(
        fx.branchBEmpId,
      );

      const inBranchB = await candidates(fx.admin.token, fx.branchB);
      expect(inBranchB.body.data.map((c: any) => c.id)).toContain(
        fx.branchBEmpId,
      );
    });

    it('BMIG-API-06: MANAGER and EMPLOYEE are refused the list', async () => {
      for (const token of [fx.deptManager.token, fx.employee.token]) {
        expect((await candidates(token)).status).toBe(403);
      }
    });

    it('BMIG-API-07: an anonymous caller is 401', async () => {
      expect(
        (await api().get('/bank-change-requests/migration/candidates')).status,
      ).toBe(401);
    });
  });

  // ── BMIG-API-09..18  Migrating ───────────────────────────────────────────
  describe('BMIG-API-09..18 — migrating one employee', () => {
    it('BMIG-API-09: refuses a bank whose country the branch does not allow', async () => {
      // Branch A banks in IN only; the OM bank is real and active, and still
      // wrong for this employee.
      const res = await migrate({
        employeeId: fx.migrationCandidateId,
        bankId: fx.bankOmId,
        data: { accountHolderName: 'Payroll MIGRATE', iban: VALID_OM_IBAN },
      });
      expect(res.status).toBe(400);
    });

    it('BMIG-API-10: refuses an INACTIVE bank', async () => {
      const res = await migrate({
        employeeId: fx.migrationCandidateId,
        bankId: fx.bankInactiveId,
        data: INDIAN_DETAILS,
      });
      expect(res.status).toBe(400);
    });

    it('BMIG-API-11: refuses details that fail the country field schema', async () => {
      const res = await migrate({
        employeeId: fx.migrationCandidateId,
        bankId: fx.bankInId,
        data: { accountHolderName: 'Payroll MIGRATE', accountNumber: '123' },
      });
      expect(res.status).toBe(400);
      // The per-field reasons are what the screen needs in order to point at the
      // input that is wrong.
      expect(JSON.stringify(res.body)).toMatch(/ifsc|required|errors/i);
    });

    it('BMIG-API-12: writes ONE active detail, sourced MIGRATION, with no request behind it', async () => {
      const res = await migrate({
        employeeId: fx.migrationCandidateId,
        bankId: fx.bankInId,
        data: INDIAN_DETAILS,
      });
      expect(res.status).toBe(201);

      const details = await ctx.prisma.employeeBankDetail.findMany({
        where: { employeeId: fx.migrationCandidateId },
      });
      expect(details).toHaveLength(1);
      expect(details[0].isActive).toBe(true);
      expect(details[0].source).toBe('MIGRATION');
      expect(details[0].sourceRequestId).toBeNull();
      expect(details[0].branchId).toBe(fx.branchA);

      // No approval chain ran: HR verified an existing record.
      const requests = await ctx.prisma.bankChangeRequest.count({
        where: { employeeId: fx.migrationCandidateId },
      });
      expect(requests).toBe(0);
    });

    it('BMIG-API-13: the migrated employee leaves the candidate list', async () => {
      const res = await candidates();
      expect(res.body.data.map((c: any) => c.id)).not.toContain(
        fx.migrationCandidateId,
      );
    });

    it('BMIG-API-14: writes an audit row naming the migration', async () => {
      const audits = await ctx.prisma.auditLog.count({
        where: { action: 'BANK_DETAIL_MIGRATED' },
      });
      expect(audits).toBeGreaterThan(0);
    });

    it('BMIG-API-15: migrating again REPLACES rather than duplicating', async () => {
      // Idempotency in the sense that matters: a second pass over an already
      // migrated employee must not leave two active details, which the partial
      // unique index would refuse anyway.
      const res = await migrate({
        employeeId: fx.migrationCandidateId,
        bankId: fx.bankInId,
        data: { ...INDIAN_DETAILS, accountNumber: '000111222444' },
      });
      expect(res.status).toBe(201);

      const active = await ctx.prisma.employeeBankDetail.findMany({
        where: { employeeId: fx.migrationCandidateId, isActive: true },
      });
      expect(active).toHaveLength(1);
      expect(active[0].accountNumber).toContain('444');

      const all = await ctx.prisma.employeeBankDetail.count({
        where: { employeeId: fx.migrationCandidateId },
      });
      expect(all).toBe(2);
    });

    it('BMIG-API-16: an unknown employee is 404 and a foreign one is refused', async () => {
      const ghost = await migrate({
        employeeId: '00000000-0000-0000-0000-000000000000',
        bankId: fx.bankInId,
        data: INDIAN_DETAILS,
      });
      expect(ghost.status).toBe(404);

      const foreign = await as(
        fx.scopedHr.token,
        api().post('/bank-change-requests/migration'),
        fx.branchA,
      ).send({
        employeeId: fx.branchBEmpId,
        bankId: fx.bankInId,
        data: INDIAN_DETAILS,
      });
      expect(foreign.status).toBeGreaterThanOrEqual(400);
      expect(foreign.status).toBeLessThan(500);
    });

    it.each([
      ['a malformed employeeId', { employeeId: 'nope' }],
      ['a malformed bankId', { bankId: 'nope' }],
      ['a missing data object', { data: undefined }],
      ['a non-object data', { data: 'iban=x' }],
      ['an unknown key', { note: 'why' }],
    ])('BMIG-API-17: refuses %s', async (_l, over) => {
      const body: Record<string, any> = {
        employeeId: fx.noBankEmpId,
        bankId: fx.bankInId,
        data: INDIAN_DETAILS,
        ...over,
      };
      if ('data' in over && over.data === undefined) delete body.data;
      const res = await migrate(body);
      expect(res.status).toBe(400);
    });

    it('BMIG-API-18: MANAGER and EMPLOYEE cannot migrate', async () => {
      for (const token of [fx.deptManager.token, fx.employee.token]) {
        const res = await migrate(
          {
            employeeId: fx.noBankEmpId,
            bankId: fx.bankInId,
            data: INDIAN_DETAILS,
          },
          token,
        );
        expect(res.status).toBe(403);
      }
    });
  });

  // ── BMIG-API-19..22  The payroll freeze, and what comes after ────────────
  describe('BMIG-API-19..22 — migration versus the payroll freeze', () => {
    it('BMIG-API-19: a FIRST-TIME migration is allowed during an in-flight run', async () => {
      // `exemptFirstTime`. Bank details are frozen while a run is in progress so
      // an account cannot move under it — but an employee with no active detail
      // has nothing to move, and refusing them would mean one open company-wide
      // run blocks onboarding for everyone.
      const period = fx.periodAt(periodCursor++);
      await seedAttendance(ctx.prisma, [fx.noBankEmpId], fx.branchA, period);
      const run = await asAdmin(api().post('/payrolls')).send({
        month: period.month,
        year: period.year,
      });
      expect(run.status).toBe(201);

      const res = await migrate({
        employeeId: fx.noBankEmpId,
        bankId: fx.bankInId,
        data: { ...INDIAN_DETAILS, accountHolderName: 'Payroll NOBANK' },
      });
      expect(res.status).toBe(201);
    });

    it('BMIG-API-20: an OVERWRITE during the same in-flight run is refused', async () => {
      // The employee now HAS an active detail, so the exemption no longer
      // applies and the freeze bites — this is the line between "let them start"
      // and "let them change the account this run is about to pay".
      const res = await migrate({
        employeeId: fx.noBankEmpId,
        bankId: fx.bankInId,
        data: { ...INDIAN_DETAILS, accountNumber: '000111222555' },
      });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/payroll run is in progress/i);

      const active = await ctx.prisma.employeeBankDetail.findFirst({
        where: { employeeId: fx.noBankEmpId, isActive: true },
      });
      expect(active!.accountNumber).not.toContain('555');
    });

    it('BMIG-API-21: once the run is LOCKED the overwrite goes through', async () => {
      const run = await ctx.prisma.payroll.findFirst({
        where: { branchId: fx.branchA, status: 'DRAFT' },
        orderBy: { createdAt: 'desc' },
      });
      await asAdmin(api().post(`/payrolls/${run!.id}/submit`));
      await asAdmin(api().post(`/payrolls/${run!.id}/approve`)).send({});
      expect(
        (await asAdmin(api().post(`/payrolls/${run!.id}/lock`))).status,
      ).toBe(201);

      const res = await migrate({
        employeeId: fx.noBankEmpId,
        bankId: fx.bankInId,
        data: { ...INDIAN_DETAILS, accountNumber: '000111222555' },
      });
      expect(res.status).toBe(201);
      const active = await ctx.prisma.employeeBankDetail.findFirst({
        where: { employeeId: fx.noBankEmpId, isActive: true },
      });
      expect(active!.accountNumber).toContain('555');
    });

    it('BMIG-API-22: a migrated employee is payable — the detail is what WPS reads', async () => {
      const active = await ctx.prisma.employeeBankDetail.findFirst({
        where: { employeeId: fx.migrationCandidateId, isActive: true },
        include: { bank: true },
      });
      expect(active).toBeTruthy();
      expect(active!.bank.isActive).toBe(true);
      expect(active!.accountHolderName).toBeTruthy();
      // Masked on the way out, whole in the row.
      const masked = await asHr(
        api().get(
          `/bank-change-requests/employee/${fx.migrationCandidateId}/current`,
        ),
      );
      expect(masked.status).toBe(200);
      expect(JSON.stringify(masked.body)).not.toContain('000111222444');
    });
  });
});
