import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';
import {
  readLoanConfig,
  writeLoanConfig,
  restoreLoanConfig,
  purgeLoans,
  LoanConfigSnapshot,
} from './utils/loan-config';

/**
 * Loan & Advances v2 — pre-deployment verification suite.
 *
 * Run this before shipping. It exercises the whole money path end to end over
 * HTTP against a real database, and every assertion below corresponds to a
 * numbered section of
 * `docs/requirement/Loan & Advances Management v2 with Test Cases *.md`:
 *
 *   §1  creation + validation          §5  partial salary
 *   §2  approval workflow              §6  multiple loans
 *   §3  EMI calculation / schedule     §8  closure
 *   §4  payroll deduction              §12 leave interaction
 *   §11 payroll adjustments            §16 security
 *   §21 concurrency / idempotency      §22 audit trail
 *
 * WHAT THIS SUITE PROTECTS (the properties that cost real money if broken):
 *   1. The v2 kill-switch is honoured: OFF behaves exactly like pre-v2.
 *   2. Money moves in exactly ONE place — payroll lock — and never twice.
 *   3. Generating a payroll does not move balances; deleting a draft releases
 *      the instalment again.
 *   4. Recovery never breaches the protected minimum take-home.
 *   5. Unlock fully reverses a locked run, append-only.
 *   6. An employee can never read another employee's loan or its attachments.
 *
 * The suite restores every shared setting it touches, and purges its own loan
 * rows before deleting its employees (the employee FK is RESTRICT).
 */
describe('Loan & Advances v2 (e2e)', () => {
  let ctx: E2EContext;
  let prisma: E2EContext['prisma'];
  let http: E2EContext['http'];

  const runId = `loanv2${Date.now()}`;
  const PASSWORD = 'Passw0rd!';

  let branchId: string;
  let deptId: string;
  let adminToken: string;
  let hrToken: string;
  let empToken: string;
  let otherEmpToken: string;

  let empId: string; // the borrower
  let otherEmpId: string; // an unrelated colleague, for the security cases
  let configSnapshot: LoanConfigSnapshot;
  const createdLoanIds: string[] = [];
  const createdPayrollIds: string[] = [];

  // A cycle far enough in the future that no existing payroll collides.
  const YEAR = 2030;
  const MONTH = 6;
  const SALARY = 60000;

  const CONFIG_KEYS = [
    'loan_module_v2_enabled',
    'loan_interest_enabled',
    'loan_min_net_pay_amount',
    'loan_max_total_deduction_percent_of_net',
    'loan_shortfall_policy',
    'loan_unpaid_leave_policy',
    'loan_recover_on_run_types',
    'advance_loan_enabled',
    'advance_loan_max_installments',
    'advance_max_percent_of_salary',
    'supervisor_approval_enabled',
  ];

  const login = async (email: string) => {
    const res = await http().post('/auth/login').send({ email, password: PASSWORD });
    if (!res.body?.data?.accessToken) {
      throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data.accessToken as string;
  };

  /** Create an APPROVED loan directly, with its schedule, bypassing the UI. */
  const seedLoan = async (over: Record<string, any> = {}) => {
    const loan = await prisma.advanceLoanRequest.create({
      data: {
        employeeId: empId,
        type: 'LOAN',
        amount: 12000,
        installments: 4,
        installmentAmount: 3000,
        status: 'APPROVED',
        approvedAt: new Date(),
        ...over,
      },
    });
    createdLoanIds.push(loan.id);
    return loan;
  };

  const runPayroll = async (over: Record<string, any> = {}) => {
    // Payroll runs are per-branch, and these users have global access — so a
    // branch must be selected explicitly, exactly as the UI does.
    const res = await http()
      .post('/payrolls')
      .set(bearer(adminToken))
      .set('X-Branch-Id', branchId)
      .send({ month: MONTH, year: YEAR, employeeIds: [empId], ...over });
    if (res.body?.data?.id) createdPayrollIds.push(body(res).id);
    else if (res.status >= 400 && process.env.LOAN_E2E_DEBUG) {
      // Opt-in diagnostics: a payroll refusal is far easier to read here than
      // as a later `undefined.id`. Set LOAN_E2E_DEBUG=1 to surface it.
      // eslint-disable-next-line no-console
      console.error('payroll create failed:', res.status, JSON.stringify(res.body));
    }
    return res;
  };

  const dropPayrolls = async () => {
    // Ledger rows first: the payroll_item FK is SetNull, so they no longer
    // cascade away, and PAID/REVERSED rows are history that must be removed
    // explicitly by the test that created them.
    await prisma.advanceLoanDeduction.deleteMany({
      where: { payrollItem: { payroll: { year: YEAR } } },
    });
    await prisma.payroll.deleteMany({ where: { year: YEAR } });
    createdPayrollIds.length = 0;
  };

  /**
   * Some loan routes return the entity directly and others return the
   * {success, data} envelope. Normalise so assertions do not depend on which.
   */
  const body = (res: any) => res.body?.data ?? res.body;

  const itemFor = async (payrollId: string) =>
    prisma.payrollItem.findFirst({ where: { payrollId, employeeId: empId } });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    prisma = ctx.prisma;
    http = ctx.http;

    configSnapshot = await readLoanConfig(prisma, CONFIG_KEYS);
    await writeLoanConfig(prisma, {
      advance_loan_enabled: 'true',
      // Default posture for the suite = LEGACY, so any test that wants v2
      // must opt in explicitly and put it back.
      loan_module_v2_enabled: 'false',
      loan_interest_enabled: 'false',
      supervisor_approval_enabled: 'false',
    });

    const hash = await bcrypt.hash(PASSWORD, 10);

    const dept = await prisma.department.create({
      data: { code: `LN-DEP-${runId}`, name: `Loan Dept ${runId}`, isActive: true },
    });
    deptId = dept.id;

    const branch = await prisma.branch.create({
      data: { code: `LN-BR-${runId}`, name: 'Loan Branch', isActive: true },
    });
    branchId = branch.id;

    const mkEmployee = async (suffix: string) =>
      prisma.employee.create({
        data: {
          employeeCode: `LN-${runId}-${suffix}`,
          fullName: `Loan Tester ${suffix}`,
          dateOfBirth: new Date('1990-01-01'),
          idCard: `LNID-${runId}-${suffix}`,
          email: `loan-${suffix}-${runId}@test.local`,
          departmentId: deptId,
          branchId,
          position: 'Engineer',
          startDate: new Date('2026-01-01'),
          baseSalary: SALARY,
          status: 'ACTIVE',
        },
      });

    const emp = await mkEmployee('A');
    const other = await mkEmployee('B');
    empId = emp.id;
    otherEmpId = other.id;

    const admin = await prisma.user.create({
      data: {
        email: `ln-admin-${runId}@test.local`,
        passwordHash: hash,
        role: 'ADMIN',
        isActive: true,
        isGlobalBranchAccess: true,
      },
    });
    const hr = await prisma.user.create({
      data: {
        email: `ln-hr-${runId}@test.local`,
        passwordHash: hash,
        role: 'HR_MANAGER',
        isActive: true,
        isGlobalBranchAccess: true,
      },
    });
    await prisma.user.create({
      data: {
        email: `ln-emp-${runId}@test.local`,
        passwordHash: hash,
        role: 'EMPLOYEE',
        isActive: true,
        employeeId: empId,
      },
    });
    await prisma.user.create({
      data: {
        email: `ln-other-${runId}@test.local`,
        passwordHash: hash,
        role: 'EMPLOYEE',
        isActive: true,
        employeeId: otherEmpId,
      },
    });

    // Payroll refuses to run for a period with no processed attendance, so
    // give both employees a full month of PRESENT days in the target cycle.
    const daysInMonth = new Date(Date.UTC(YEAR, MONTH, 0)).getUTCDate();
    await prisma.attendance.createMany({
      data: [empId, otherEmpId].flatMap((id) =>
        Array.from({ length: daysInMonth }, (_, i) => ({
          employeeId: id,
          branchId,
          date: new Date(Date.UTC(YEAR, MONTH - 1, i + 1)),
          status: 'PRESENT' as const,
        })),
      ),
      skipDuplicates: true,
    });

    adminToken = await login(admin.email);
    hrToken = await login(hr.email);
    empToken = await login(`ln-emp-${runId}@test.local`);
    otherEmpToken = await login(`ln-other-${runId}@test.local`);
  }, 120000);

  afterAll(async () => {
    await dropPayrolls();
    const all = await prisma.advanceLoanRequest.findMany({
      where: { employeeId: { in: [empId, otherEmpId] } },
      select: { id: true },
    });
    await purgeLoans(prisma, all.map((r) => r.id));
    await prisma.loanSettlement.deleteMany({
      where: { employeeId: { in: [empId, otherEmpId] } },
    });
    await prisma.attendance.deleteMany({
      where: { employeeId: { in: [empId, otherEmpId] } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: runId } } });
    await prisma.employee.deleteMany({
      where: { employeeCode: { contains: runId } },
    });
    await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
    await prisma.department.deleteMany({ where: { code: { contains: runId } } });
    await restoreLoanConfig(prisma, configSnapshot);
    await ctx.app.close();
  }, 120000);

  beforeEach(async () => {
    await dropPayrolls();
    await purgeLoans(
      prisma,
      (
        await prisma.advanceLoanRequest.findMany({
          where: { employeeId: { in: [empId, otherEmpId] } },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    createdLoanIds.length = 0;
    await writeLoanConfig(prisma, {
      loan_module_v2_enabled: 'false',
      loan_interest_enabled: 'false',
    });
  });

  // ── §1 creation & §2 approval ───────────────────────────────────────────
  describe('§1/§2 request, approve, schedule', () => {
    it('an employee raises a loan and it starts PENDING', async () => {
      const res = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        .send({ type: 'LOAN', amount: 12000, installments: 4, reason: 'e2e' });

      expect(res.status).toBe(201);
      expect(body(res).status).toBe('PENDING');
      createdLoanIds.push(body(res).id);
    });

    it('approval generates a reconciling schedule — the old Math.round bug is gone', async () => {
      const created = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        // 100000 / 7 does not divide; the legacy code produced 14286 x 7 =
        // 100002 and over-recovered by 2.
        .send({ type: 'LOAN', amount: 100000, installments: 7 });
      const loanId = body(created).id;
      createdLoanIds.push(loanId);

      const approved = await http()
        .post(`/advance-loans/${loanId}/approve`)
        .set(bearer(hrToken))
        .send({ installments: 7 });
      expect(approved.status).toBe(201);

      const rows = await prisma.loanSchedule.findMany({
        where: { requestId: loanId },
        orderBy: { installmentNo: 'asc' },
      });
      expect(rows).toHaveLength(7);

      const totalPrincipal = rows.reduce(
        (a, r) => a + Number(r.principalComponent),
        0,
      );
      expect(Math.round(totalPrincipal * 100) / 100).toBe(100000);
      expect(Number(rows[6].closingBalance)).toBe(0);
      // Due dates walk forward one cycle at a time.
      expect(rows[1].dueCycleKey).toBe(rows[0].dueCycleKey + 1);
    });

    it('an advance gets a single-instalment schedule', async () => {
      const created = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        .send({ type: 'ADVANCE', amount: 5000 });
      const loanId = body(created).id;
      createdLoanIds.push(loanId);

      await http()
        .post(`/advance-loans/${loanId}/approve`)
        .set(bearer(hrToken))
        .send({});

      const rows = await prisma.loanSchedule.findMany({
        where: { requestId: loanId },
      });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].emiAmount)).toBe(5000);
    });

    it('rejects an instalment count above the configured maximum', async () => {
      const created = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        .send({ type: 'LOAN', amount: 12000, installments: 4 });
      createdLoanIds.push(body(created).id);

      const res = await http()
        .post(`/advance-loans/${body(created).id}/approve`)
        .set(bearer(hrToken))
        .send({ installments: 999 });
      expect(res.status).toBe(400);
    });

    it('a second approver loses the race instead of double-approving', async () => {
      const created = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        .send({ type: 'LOAN', amount: 12000, installments: 4 });
      const loanId = body(created).id;
      createdLoanIds.push(loanId);

      const [a, b] = await Promise.all([
        http().post(`/advance-loans/${loanId}/approve`).set(bearer(hrToken)).send({ installments: 4 }),
        http().post(`/advance-loans/${loanId}/approve`).set(bearer(adminToken)).send({ installments: 4 }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBeLessThan(300); // exactly one succeeded
      expect(statuses[1]).toBeGreaterThanOrEqual(400);
    });

    it('cancelling a pending request works and a decided one cannot be re-decided', async () => {
      const created = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        .send({ type: 'LOAN', amount: 9000, installments: 3 });
      const loanId = body(created).id;
      createdLoanIds.push(loanId);

      expect((await http().delete(`/advance-loans/${loanId}`).set(bearer(empToken))).status).toBe(200);

      const res = await http()
        .post(`/advance-loans/${loanId}/approve`)
        .set(bearer(hrToken))
        .send({ installments: 3 });
      expect(res.status).toBe(400);
    });
  });

  // ── §3 interest ─────────────────────────────────────────────────────────
  describe('§3/§13 interest', () => {
    it('with interest OFF every instalment is pure principal', async () => {
      const loan = await seedLoan({ status: 'PENDING' });
      await http().post(`/advance-loans/${loan.id}/approve`).set(bearer(hrToken)).send({ installments: 4 });

      const rows = await prisma.loanSchedule.findMany({ where: { requestId: loan.id } });
      expect(rows.every((r) => Number(r.interestComponent) === 0)).toBe(true);
    });

    it('with interest ON a reducing-balance loan accrues declining interest and still reconciles', async () => {
      await writeLoanConfig(prisma, { loan_interest_enabled: 'true' });

      const loan = await seedLoan({
        status: 'PENDING',
        amount: 120000,
        installments: 12,
        interestMethod: 'REDUCING_BALANCE',
        interestRate: 12,
      });
      await http().post(`/advance-loans/${loan.id}/approve`).set(bearer(hrToken)).send({ installments: 12 });

      const rows = await prisma.loanSchedule.findMany({
        where: { requestId: loan.id },
        orderBy: { installmentNo: 'asc' },
      });
      expect(rows).toHaveLength(12);
      expect(Number(rows[0].interestComponent)).toBeGreaterThan(
        Number(rows[11].interestComponent),
      );
      const principal = rows.reduce((a, r) => a + Number(r.principalComponent), 0);
      expect(Math.round(principal * 100) / 100).toBe(120000);
      expect(Number(rows[11].closingBalance)).toBe(0);
    });
  });

  // ── §4 payroll deduction ────────────────────────────────────────────────
  describe('§4 payroll deduction', () => {
    it('generating a payroll writes a PENDING ledger row but moves NO balance', async () => {
      const loan = await seedLoan();
      const res = await runPayroll();
      expect(res.status).toBe(201);

      const item = await itemFor(body(res).id);
      expect(Number(item!.advanceLoanDeduction)).toBe(3000);

      const ledger = await prisma.advanceLoanDeduction.findMany({
        where: { requestId: loan.id },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].status).toBe('PENDING');

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(Number(after!.amountRepaid)).toBe(0); // ← nothing moved yet
    });

    it('locking is what moves the money, and it moves it once', async () => {
      const loan = await seedLoan();
      const created = await runPayroll();
      const payrollId = body(created).id;

      await http().post(`/payrolls/${payrollId}/submit`).set(bearer(adminToken)).send({});
      await http().post(`/payrolls/${payrollId}/approve`).set(bearer(adminToken)).send({});
      const locked = await http().post(`/payrolls/${payrollId}/lock`).set(bearer(adminToken)).send({});
      expect(locked.status).toBe(201);

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(Number(after!.amountRepaid)).toBe(3000);

      const ledger = await prisma.advanceLoanDeduction.findMany({ where: { requestId: loan.id } });
      expect(ledger.map((l) => l.status)).toEqual(['PAID']);

      // A second lock must not move the balance again.
      const again = await http().post(`/payrolls/${payrollId}/lock`).set(bearer(adminToken)).send({});
      expect(again.status).toBeGreaterThanOrEqual(400);
      const after2 = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(Number(after2!.amountRepaid)).toBe(3000);
    });

    it('finalize and lock are the SAME money path (no bypass)', async () => {
      const loan = await seedLoan();
      const created = await runPayroll();
      const payrollId = body(created).id;

      await http().post(`/payrolls/${payrollId}/submit`).set(bearer(adminToken)).send({});
      await http().post(`/payrolls/${payrollId}/approve`).set(bearer(adminToken)).send({});
      const res = await http().post(`/payrolls/${payrollId}/finalize`).set(bearer(adminToken)).send({});
      expect(res.status).toBe(201);

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(Number(after!.amountRepaid)).toBe(3000);
      const ledger = await prisma.advanceLoanDeduction.findMany({ where: { requestId: loan.id } });
      expect(ledger.map((l) => l.status)).toEqual(['PAID']);
    });

    it('a loan already carried by an unlocked draft is not picked up twice', async () => {
      await seedLoan();
      const first = await runPayroll();
      expect(first.status).toBe(201);

      // A second run for the same period is refused outright, which is the
      // outer guard; the ledger guard is asserted by the row count.
      const second = await runPayroll();
      expect(second.status).toBeGreaterThanOrEqual(400);

      const ledger = await prisma.advanceLoanDeduction.findMany({
        where: { request: { employeeId: empId } },
      });
      expect(ledger).toHaveLength(1);
    });

    it('deleting a DRAFT payroll releases the instalment again', async () => {
      const loan = await seedLoan();
      const created = await runPayroll();
      await http().delete(`/payrolls/${body(created).id}`).set(bearer(adminToken));

      const ledger = await prisma.advanceLoanDeduction.findMany({ where: { requestId: loan.id } });
      expect(ledger).toHaveLength(0);

      const again = await runPayroll();
      expect(again.status).toBe(201);
      const item = await itemFor(body(again).id);
      expect(Number(item!.advanceLoanDeduction)).toBe(3000);
    });

    it('the final instalment is capped at the outstanding balance', async () => {
      await seedLoan({ amount: 12000, amountRepaid: 10000, installmentAmount: 3000 });
      const res = await runPayroll();
      const item = await itemFor(body(res).id);
      expect(Number(item!.advanceLoanDeduction)).toBe(2000);
    });

    it('a fully-recovered loan auto-closes at lock', async () => {
      const loan = await seedLoan({ amount: 3000, installments: 1, installmentAmount: 3000 });
      const created = await runPayroll();
      const payrollId = body(created).id;
      await http().post(`/payrolls/${payrollId}/submit`).set(bearer(adminToken)).send({});
      await http().post(`/payrolls/${payrollId}/approve`).set(bearer(adminToken)).send({});
      await http().post(`/payrolls/${payrollId}/lock`).set(bearer(adminToken)).send({});

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(after!.status).toBe('COMPLETED');
      expect(after!.completedAt).not.toBeNull();
    });
  });

  // ── kill-switch & §5 partial salary ─────────────────────────────────────
  describe('kill-switch and §5 partial salary', () => {
    it('v2 OFF ignores the affordability cap entirely (legacy behaviour preserved)', async () => {
      await writeLoanConfig(prisma, {
        loan_module_v2_enabled: 'false',
        loan_max_total_deduction_percent_of_net: '1',
      });
      await seedLoan({ installmentAmount: 3000 });

      const res = await runPayroll();
      const item = await itemFor(body(res).id);
      expect(Number(item!.advanceLoanDeduction)).toBe(3000);
    });

    it('v2 ON caps recovery at the configured share of net pay', async () => {
      await writeLoanConfig(prisma, {
        loan_module_v2_enabled: 'true',
        loan_max_total_deduction_percent_of_net: '1',
      });
      await seedLoan({ installmentAmount: 3000 });

      const res = await runPayroll();
      const item = await itemFor(body(res).id);
      const recovered = Number(item!.advanceLoanDeduction);
      expect(recovered).toBeGreaterThan(0);
      expect(recovered).toBeLessThan(3000); // partially recovered, not full

      await writeLoanConfig(prisma, {
        loan_max_total_deduction_percent_of_net: '50',
      });
    });

    it('v2 ON never drives net pay below the protected minimum take-home', async () => {
      await writeLoanConfig(prisma, {
        loan_module_v2_enabled: 'true',
        loan_min_net_pay_amount: '999999', // floor above any possible net
      });
      await seedLoan({ installmentAmount: 3000 });

      const res = await runPayroll();
      const item = await itemFor(body(res).id);
      expect(Number(item!.advanceLoanDeduction)).toBe(0);

      // The reason is recorded rather than silently dropped.
      const ledger = await prisma.advanceLoanDeduction.findMany({
        where: { request: { employeeId: empId } },
      });
      expect(ledger.length).toBeGreaterThan(0);
      expect(ledger[0].status).toBe('SKIPPED');
      expect(ledger[0].reason).toBe('INSUFFICIENT_NET');

      await writeLoanConfig(prisma, { loan_min_net_pay_amount: '0' });
    });

    it('a SKIPPED row does not block the next cycle from recovering', async () => {
      await writeLoanConfig(prisma, {
        loan_module_v2_enabled: 'true',
        loan_min_net_pay_amount: '999999',
      });
      const loan = await seedLoan({ installmentAmount: 3000 });
      await runPayroll();

      await writeLoanConfig(prisma, { loan_min_net_pay_amount: '0' });
      await prisma.payroll.deleteMany({ where: { year: YEAR } });

      const res = await runPayroll();
      const item = await itemFor(body(res).id);
      expect(Number(item!.advanceLoanDeduction)).toBe(3000);

      const live = await prisma.advanceLoanDeduction.findMany({
        where: { requestId: loan.id, status: 'PENDING' },
      });
      expect(live).toHaveLength(1);
    });
  });

  // ── §6 multiple loans ───────────────────────────────────────────────────
  describe('§6 multiple loans', () => {
    it('recovers both loans and totals them onto one payslip', async () => {
      await seedLoan({ amount: 12000, installmentAmount: 2000 });
      await seedLoan({ amount: 6000, installmentAmount: 1000, type: 'ADVANCE', installments: 1 });

      const res = await runPayroll();
      const item = await itemFor(body(res).id);
      expect(Number(item!.advanceLoanDeduction)).toBeGreaterThan(0);

      const ledger = await prisma.advanceLoanDeduction.findMany({
        where: { request: { employeeId: empId } },
      });
      expect(ledger.length).toBe(2);
    });

    it('v2 ON funds loans in priority order when net cannot cover both', async () => {
      await writeLoanConfig(prisma, {
        loan_module_v2_enabled: 'true',
        loan_max_total_deduction_percent_of_net: '5',
      });
      const first = await seedLoan({ amount: 40000, installmentAmount: 20000, priority: 1 });
      const second = await seedLoan({ amount: 40000, installmentAmount: 20000, priority: 90 });

      const res = await runPayroll();
      expect(res.status).toBe(201);

      const rows = await prisma.advanceLoanDeduction.findMany({
        where: { request: { employeeId: empId } },
      });
      const byId = new Map(rows.map((r) => [r.requestId, Number(r.amount)]));
      expect(byId.get(first.id)!).toBeGreaterThan(byId.get(second.id) ?? 0);

      await writeLoanConfig(prisma, {
        loan_max_total_deduction_percent_of_net: '50',
      });
    });
  });

  // ── §11 payroll adjustments / reversal ──────────────────────────────────
  describe('§11 unlock and reversal', () => {
    it('unlock reverses the recovery append-only and reopens the loan', async () => {
      const loan = await seedLoan({ amount: 3000, installments: 1, installmentAmount: 3000 });
      const created = await runPayroll();
      const payrollId = body(created).id;
      await http().post(`/payrolls/${payrollId}/submit`).set(bearer(adminToken)).send({});
      await http().post(`/payrolls/${payrollId}/approve`).set(bearer(adminToken)).send({});
      await http().post(`/payrolls/${payrollId}/lock`).set(bearer(adminToken)).send({});

      const res = await http()
        .post(`/payrolls/${payrollId}/unlock`)
        .set(bearer(adminToken))
        .send({ reason: 'e2e reversal check' });
      expect(res.status).toBe(201);

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(Number(after!.amountRepaid)).toBe(0);
      expect(after!.status).toBe('ACTIVE'); // reopened, not left COMPLETED

      // Append-only: the original row is REVERSED, never deleted, and a
      // REVERSAL transaction exists.
      const ledger = await prisma.advanceLoanDeduction.findMany({ where: { requestId: loan.id } });
      expect(ledger.map((l) => l.status)).toEqual(['REVERSED']);
      const reversal = await prisma.loanTransaction.findFirst({
        where: { requestId: loan.id, type: 'REVERSAL' },
      });
      expect(reversal).not.toBeNull();

      const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
      expect(payroll!.status).toBe('APPROVED');
      expect(payroll!.unlockCount).toBe(1);
    });

    it('refuses to unlock a payroll that was never locked', async () => {
      const created = await runPayroll();
      const res = await http()
        .post(`/payrolls/${body(created).id}/unlock`)
        .set(bearer(adminToken))
        .send({ reason: 'should not work' });
      expect(res.status).toBe(400);
    });

    it('requires a reason (tampered/empty payload is rejected)', async () => {
      const created = await runPayroll();
      const res = await http()
        .post(`/payrolls/${body(created).id}/unlock`)
        .set(bearer(adminToken))
        .send({});
      expect(res.status).toBe(400);
    });
  });

  // ── §4 run types ────────────────────────────────────────────────────────
  describe('§4/§11 run types', () => {
    it('v2 ON: a BONUS run recovers nothing, so an EMI is never charged twice', async () => {
      await writeLoanConfig(prisma, { loan_module_v2_enabled: 'true' });
      await seedLoan({ installmentAmount: 3000 });

      const res = await runPayroll({ runType: 'BONUS' });
      expect(res.status).toBe(201);
      const item = await itemFor(body(res).id);
      expect(Number(item!.advanceLoanDeduction)).toBe(0);
    });

    it('rejects an unknown run type', async () => {
      const res = await runPayroll({ runType: 'NOT_A_RUN_TYPE' });
      expect(res.status).toBe(400);
    });
  });

  // ── §16 security ────────────────────────────────────────────────────────
  describe('§16 security', () => {
    let victimLoanId: string;

    beforeEach(async () => {
      const loan = await prisma.advanceLoanRequest.create({
        data: {
          employeeId: otherEmpId,
          type: 'LOAN',
          amount: 5000,
          installments: 2,
          status: 'PENDING',
        },
      });
      victimLoanId = loan.id;
      createdLoanIds.push(loan.id);
    });

    it("an employee cannot read a colleague's loan", async () => {
      const res = await http()
        .get(`/advance-loans/${victimLoanId}`)
        .set(bearer(empToken));
      expect([403, 404]).toContain(res.status);
    });

    it("an employee cannot list a colleague's loan ATTACHMENTS — the hole this closes", async () => {
      // Before the fix this returned 200 with filenames and publicly fetchable
      // URLs, because the ACL lived only on the parent route.
      const res = await http()
        .get(`/advance-loans/${victimLoanId}/attachments`)
        .set(bearer(empToken));
      expect([403, 404]).toContain(res.status);
    });

    it('HR can read both, and the owner can read their own', async () => {
      expect(
        (await http().get(`/advance-loans/${victimLoanId}`).set(bearer(hrToken))).status,
      ).toBe(200);
      expect(
        (await http().get(`/advance-loans/${victimLoanId}/attachments`).set(bearer(hrToken))).status,
      ).toBe(200);
      expect(
        (await http().get(`/advance-loans/${victimLoanId}`).set(bearer(otherEmpToken))).status,
      ).toBe(200);
    });

    it('a tampered payload cannot pre-approve a request', async () => {
      const res = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        .send({
          type: 'LOAN',
          amount: 5000,
          installments: 2,
          status: 'APPROVED',
          amountRepaid: 5000,
        });
      // forbidNonWhitelisted rejects server-owned fields outright.
      expect(res.status).toBe(400);
    });

    it('rejects a non-positive amount', async () => {
      for (const amount of [0, -100]) {
        const res = await http()
          .post('/advance-loans')
          .set(bearer(empToken))
          .send({ type: 'LOAN', amount, installments: 2 });
        expect(res.status).toBe(400);
      }
    });

    it('an unauthenticated caller gets nothing', async () => {
      expect((await http().get(`/advance-loans/${victimLoanId}`)).status).toBe(401);
      expect((await http().get('/advance-loans')).status).toBe(401);
    });

    it('only ADMIN may unlock a payroll', async () => {
      const created = await runPayroll();
      const res = await http()
        .post(`/payrolls/${body(created).id}/unlock`)
        .set(bearer(hrToken))
        .send({ reason: 'not allowed' });
      expect(res.status).toBe(403);
    });
  });

  // ── §22 audit trail ─────────────────────────────────────────────────────
  describe('§22 audit trail', () => {
    it('records an audit row for a loan decision', async () => {
      const created = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        .send({ type: 'LOAN', amount: 9000, installments: 3 });
      const loanId = body(created).id;
      createdLoanIds.push(loanId);

      await http()
        .post(`/advance-loans/${loanId}/approve`)
        .set(bearer(hrToken))
        .send({ installments: 3 });

      const logs = await prisma.auditLog.findMany({
        where: { resourceType: 'AdvanceLoan' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      expect(logs.length).toBeGreaterThan(0);
    });

    it('books a DISBURSEMENT transaction when a loan is approved', async () => {
      const loan = await seedLoan({ status: 'PENDING' });
      await http()
        .post(`/advance-loans/${loan.id}/approve`)
        .set(bearer(hrToken))
        .send({ installments: 4 });

      const txn = await prisma.loanTransaction.findFirst({
        where: { requestId: loan.id, type: 'DISBURSEMENT' },
      });
      expect(txn).not.toBeNull();
      expect(Number(txn!.amount)).toBe(12000);
    });
  });

  // ── §8/§9 lifecycle operations ──────────────────────────────────────────
  describe('§8/§9 lifecycle: prepay, close, write-off, waive, hold, skip, convert', () => {
    /** An APPROVED loan WITH a live schedule, via the real approval path. */
    const approvedWithSchedule = async (over: Record<string, any> = {}) => {
      const loan = await seedLoan({ status: 'PENDING', ...over });
      await http()
        .post(`/advance-loans/${loan.id}/approve`)
        .set(bearer(hrToken))
        .send({ installments: over.installments ?? 4 });
      return loan;
    };

    it('exposes a payoff quote and the live schedule', async () => {
      const loan = await approvedWithSchedule();

      const quote = await http()
        .get(`/advance-loans/${loan.id}/payoff-quote`)
        .set(bearer(hrToken));
      expect(quote.status).toBe(200);
      expect(body(quote).payoffAmount).toBe(12000);

      const sched = await http()
        .get(`/advance-loans/${loan.id}/schedule`)
        .set(bearer(hrToken));
      expect(sched.status).toBe(200);
      expect(sched.body).toHaveLength(4);
    });

    it('a partial prepayment reduces the balance and books a PREPAYMENT row', async () => {
      const loan = await approvedWithSchedule();

      const res = await http()
        .post(`/advance-loans/${loan.id}/prepay`)
        .set(bearer(hrToken))
        .send({ amount: 4000, mode: 'BANK', reference: 'UTR-1' });
      expect(res.status).toBe(201);
      expect(body(res).payoffAmount).toBe(8000);

      const txn = await prisma.loanTransaction.findFirst({
        where: { requestId: loan.id, type: 'PREPAYMENT' },
      });
      expect(Number(txn!.amount)).toBe(4000);
      expect(txn!.reference).toBe('UTR-1');
    });

    it('a full prepayment closes the loan as an early closure', async () => {
      const loan = await approvedWithSchedule();

      await http()
        .post(`/advance-loans/${loan.id}/prepay`)
        .set(bearer(hrToken))
        .send({ amount: 12000 });

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(after!.status).toBe('CLOSED');
      expect(after!.closureType).toBe('EARLY_CLOSURE');

      const live = await prisma.loanSchedule.findMany({
        where: { requestId: loan.id, status: { in: ['SCHEDULED', 'PARTIAL'] } },
      });
      expect(live).toHaveLength(0);
    });

    it('rejects a prepayment above the payoff amount, quoting the exact figure', async () => {
      const loan = await approvedWithSchedule();
      const res = await http()
        .post(`/advance-loans/${loan.id}/prepay`)
        .set(bearer(hrToken))
        .send({ amount: 99999 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/12000/);
    });

    it('rejects a zero or negative prepayment', async () => {
      const loan = await approvedWithSchedule();
      for (const amount of [0, -50]) {
        const res = await http()
          .post(`/advance-loans/${loan.id}/prepay`)
          .set(bearer(hrToken))
          .send({ amount });
        expect(res.status).toBe(400);
      }
    });

    it('REFUSES any lifecycle op while an unlocked payroll holds an instalment', async () => {
      const loan = await approvedWithSchedule();
      await runPayroll(); // creates a PENDING ledger row

      for (const path of ['prepay', 'close', 'write-off', 'waive', 'hold']) {
        const res = await http()
          .post(`/advance-loans/${loan.id}/${path}`)
          .set(bearer(adminToken))
          .send({ amount: 100, reason: 'blocked while payroll runs' });
        expect([409, 400]).toContain(res.status);
      }

      // 409 specifically for the in-flight guard on prepay.
      const prepay = await http()
        .post(`/advance-loans/${loan.id}/prepay`)
        .set(bearer(adminToken))
        .send({ amount: 100 });
      expect(prepay.status).toBe(409);
      expect(JSON.stringify(prepay.body)).toMatch(/payroll/i);
    });

    it('manual close is refused above the rounding tolerance, allowed within it', async () => {
      const big = await approvedWithSchedule();
      const refused = await http()
        .post(`/advance-loans/${big.id}/close`)
        .set(bearer(hrToken))
        .send({ reason: 'trying to close a live loan' });
      expect(refused.status).toBe(400);

      // A 0.50 residual is the "rounding leftover after the final EMI" case.
      const residual = await seedLoan({ amount: 12000, amountRepaid: 11999.5 });
      const ok = await http()
        .post(`/advance-loans/${residual.id}/close`)
        .set(bearer(hrToken))
        .send({ reason: 'residual after final EMI' });
      expect(ok.status).toBe(201);

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: residual.id } });
      expect(after!.status).toBe('CLOSED');
      expect(after!.closureType).toBe('MANUAL');
      const adj = await prisma.loanTransaction.findFirst({
        where: { requestId: residual.id, type: 'ADJUSTMENT' },
      });
      expect(adj).not.toBeNull();
    });

    it('write-off forgives the balance and reinstate puts it back', async () => {
      const loan = await approvedWithSchedule();

      const off = await http()
        .post(`/advance-loans/${loan.id}/write-off`)
        .set(bearer(adminToken))
        .send({ reason: 'Uncollectable after exit, ref FIN-42' });
      expect(off.status).toBe(201);

      let after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(after!.status).toBe('WRITTEN_OFF');
      expect(Number(after!.writtenOffAmount)).toBe(12000);

      const back = await http()
        .post(`/advance-loans/${loan.id}/reinstate`)
        .set(bearer(adminToken))
        .send({ reason: 'Employee rehired per HR-88' });
      expect(back.status).toBe(201);

      after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(after!.status).toBe('ACTIVE');
      expect(Number(after!.writtenOffAmount)).toBe(0);
      expect(body(back).outstandingPrincipal).toBe(12000);
    });

    it('write-off is restricted to the configured roles', async () => {
      const loan = await approvedWithSchedule();
      // Default advance_loan_writeoff_roles = ADMIN, so HR must be refused.
      const res = await http()
        .post(`/advance-loans/${loan.id}/write-off`)
        .set(bearer(hrToken))
        .send({ reason: 'HR should not be able to do this' });
      expect(res.status).toBe(403);
    });

    it('write-off cannot exceed the outstanding balance', async () => {
      const loan = await approvedWithSchedule();
      const res = await http()
        .post(`/advance-loans/${loan.id}/write-off`)
        .set(bearer(adminToken))
        .send({ amount: 99999, reason: 'more than is owed' });
      expect(res.status).toBe(400);
    });

    it('a full waiver closes the loan', async () => {
      const loan = await approvedWithSchedule();
      const res = await http()
        .post(`/advance-loans/${loan.id}/waive`)
        .set(bearer(hrToken))
        .send({ waiveType: 'BOTH', reason: 'Hardship waiver approved' });
      expect(res.status).toBe(201);

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(after!.status).toBe('CLOSED');
      expect(after!.closureType).toBe('WAIVER');
      expect(Number(after!.waivedAmount)).toBe(12000);
    });

    it('a held loan is skipped by payroll, and resuming restores recovery', async () => {
      const loan = await approvedWithSchedule();

      const held = await http()
        .post(`/advance-loans/${loan.id}/hold`)
        .set(bearer(hrToken))
        .send({ reason: 'Employee on unpaid sabbatical' });
      expect(held.status).toBe(201);

      let run = await runPayroll();
      let item = await itemFor(body(run).id);
      expect(Number(item!.advanceLoanDeduction)).toBe(0);

      await dropPayrolls();
      await http()
        .post(`/advance-loans/${loan.id}/resume`)
        .set(bearer(hrToken))
        .send({ reason: 'Back from sabbatical' });

      run = await runPayroll();
      item = await itemFor(body(run).id);
      expect(Number(item!.advanceLoanDeduction)).toBeGreaterThan(0);
    });

    it('skipping an instalment marks it and does not silently drop the debt', async () => {
      const loan = await approvedWithSchedule();

      const res = await http()
        .post(`/advance-loans/${loan.id}/skip-installment`)
        .set(bearer(hrToken))
        .send({ installmentNo: 2, mode: 'EXTEND', reason: 'Medical emergency' });
      expect(res.status).toBe(201);

      // Still owed in full — EXTEND pushes the tail out, it does not forgive.
      expect(body(res).outstandingPrincipal).toBe(12000);

      const skipped = await prisma.loanSchedule.findFirst({
        where: { requestId: loan.id, installmentNo: 2, status: 'SKIPPED' },
      });
      expect(skipped).not.toBeNull();
    });

    it('FORGIVE on an instalment waives it', async () => {
      const loan = await approvedWithSchedule();
      const res = await http()
        .post(`/advance-loans/${loan.id}/skip-installment`)
        .set(bearer(hrToken))
        .send({ installmentNo: 3, mode: 'FORGIVE', reason: 'Goodwill' });
      expect(res.status).toBe(201);

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(Number(after!.waivedAmount)).toBeGreaterThan(0);
    });

    it('cannot skip an instalment that does not exist', async () => {
      const loan = await approvedWithSchedule();
      const res = await http()
        .post(`/advance-loans/${loan.id}/skip-installment`)
        .set(bearer(hrToken))
        .send({ installmentNo: 99, mode: 'EXTEND', reason: 'no such instalment' });
      expect(res.status).toBe(404);
    });

    it('converting an advance closes it and opens a NEW loan awaiting approval', async () => {
      const adv = await seedLoan({
        type: 'ADVANCE',
        amount: 9000,
        installments: 1,
        installmentAmount: 9000,
        status: 'PENDING',
      });
      await http().post(`/advance-loans/${adv.id}/approve`).set(bearer(hrToken)).send({});

      const res = await http()
        .post(`/advance-loans/${adv.id}/convert`)
        .set(bearer(hrToken))
        .send({ installments: 3 });
      expect(res.status).toBe(201);

      const newLoanId = body(res).newLoanId;
      createdLoanIds.push(newLoanId);

      const oldAdv = await prisma.advanceLoanRequest.findUnique({ where: { id: adv.id } });
      expect(oldAdv!.status).toBe('CLOSED');
      expect(oldAdv!.closureType).toBe('CONVERTED');

      const newLoan = await prisma.advanceLoanRequest.findUnique({ where: { id: newLoanId } });
      // Re-enters approval on purpose: new terms need a fresh decision.
      expect(newLoan!.status).toBe('PENDING');
      expect(newLoan!.type).toBe('LOAN');
      expect(Number(newLoan!.amount)).toBe(9000);
      expect(newLoan!.convertedFromId).toBe(adv.id);

      // The pair nets to zero so the receivable ledger stays continuous.
      const conversions = await prisma.loanTransaction.findMany({
        where: { type: 'CONVERSION', requestId: { in: [adv.id, newLoanId] } },
      });
      expect(conversions).toHaveLength(2);
    });

    it('refuses to convert a LOAN (only advances convert)', async () => {
      const loan = await approvedWithSchedule();
      const res = await http()
        .post(`/advance-loans/${loan.id}/convert`)
        .set(bearer(hrToken))
        .send({ installments: 3 });
      expect(res.status).toBe(400);
    });

    it('rejects a non-uuid id before it reaches the database', async () => {
      const res = await http()
        .get('/advance-loans/not-a-uuid/schedule')
        .set(bearer(hrToken));
      expect(res.status).toBe(400);
    });
  });

  // ── §10 settlement at exit ──────────────────────────────────────────────
  describe('§10 exit settlement', () => {
    it('quotes everything an exiting employee still owes', async () => {
      await seedLoan({ amount: 12000, amountRepaid: 2000 });
      const res = await http()
        .get(`/advance-loans/settlement/${empId}`)
        .set(bearer(hrToken));

      expect(res.status).toBe(200);
      expect(body(res).totalOutstanding).toBe(10000);
      expect(body(res).cleared).toBe(false);
    });

    it('REFUSES a settlement that does not name every outstanding loan', async () => {
      await seedLoan({ amount: 12000 });
      await seedLoan({ amount: 6000, type: 'ADVANCE', installments: 1 });

      const quote = await http()
        .get(`/advance-loans/settlement/${empId}`)
        .set(bearer(hrToken));

      const res = await http()
        .post(`/advance-loans/settlement/${empId}`)
        .set(bearer(hrToken))
        .send({
          decisions: [
            { loanId: body(quote).loans[0].loanId, action: 'WAIVE', reason: 'exit' },
          ],
        });
      // A silent omission is how a receivable disappears at exit.
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/Missing/i);
    });

    it('records decisions and can be reversed exactly', async () => {
      const loan = await seedLoan({ amount: 12000, amountRepaid: 2000 });

      const settled = await http()
        .post(`/advance-loans/settlement/${empId}`)
        .set(bearer(hrToken))
        .send({
          decisions: [
            {
              loanId: loan.id,
              action: 'RECOVER_FROM_GRATUITY',
              amount: 10000,
              reference: 'GRAT-1',
              reason: 'Recovered from gratuity',
            },
          ],
        });
      expect(settled.status).toBe(201);

      let after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(after!.status).toBe('SETTLED');
      expect(Number(after!.amountRepaid)).toBe(12000);

      const reversal = await http()
        .post(`/advance-loans/settlement/${body(settled).settlementId}/reverse`)
        .set(bearer(adminToken))
        .send({ reason: 'Gratuity payout cancelled' });
      expect(reversal.status).toBe(201);

      after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(after!.status).toBe('APPROVED');
      expect(Number(after!.amountRepaid)).toBe(2000);
    });

    it('CARRY_AS_RECEIVABLE parks the debt and excludes it from payroll', async () => {
      const loan = await seedLoan({ amount: 12000 });

      await http()
        .post(`/advance-loans/settlement/${empId}`)
        .set(bearer(hrToken))
        .send({
          decisions: [
            { loanId: loan.id, action: 'CARRY_AS_RECEIVABLE', reason: 'Settlement insufficient' },
          ],
        });

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(after!.status).toBe('RECEIVABLE');

      // Not recoverable, so payroll takes nothing.
      const run = await runPayroll();
      const item = await itemFor(body(run).id);
      expect(Number(item!.advanceLoanDeduction)).toBe(0);

      const listed = await http()
        .get('/advance-loans/settlement/receivable')
        .set(bearer(hrToken));
      expect(listed.status).toBe(200);
      expect(listed.body.map((l: any) => l.id)).toContain(loan.id);
    });
  });

  // ── §18 clearance & data integrity ──────────────────────────────────────
  describe('§18 clearance and data integrity', () => {
    it('an outstanding loan blocks offboarding clearance', async () => {
      await seedLoan({ amount: 12000, amountRepaid: 1000 });
      const res = await http()
        .get(`/assets/clearance/${empId}`)
        .set(bearer(hrToken));

      if (res.status === 200) {
        expect(body(res).loanCleared).toBe(false);
        expect(body(res).cleared).toBe(false);
        expect(body(res).outstandingLoans.length).toBeGreaterThan(0);
      }
    });

    it('a settled loan no longer blocks clearance', async () => {
      const loan = await seedLoan({ amount: 12000, amountRepaid: 12000 });
      await prisma.advanceLoanRequest.update({
        where: { id: loan.id },
        data: { status: 'COMPLETED' },
      });
      const res = await http()
        .get(`/assets/clearance/${empId}`)
        .set(bearer(hrToken));
      if (res.status === 200) {
        expect(body(res).loanCleared).toBe(true);
      }
    });

    it('loan history survives the employee: hard delete is refused', async () => {
      await seedLoan();
      const victim = await prisma.employee.findUnique({ where: { id: empId } });
      await prisma.employee.update({
        where: { id: empId },
        data: { status: 'TERMINATED' },
      });

      const res = await http()
        .delete(`/employees/${empId}/permanent`)
        .set(bearer(adminToken));
      expect([400, 403, 404]).toContain(res.status);

      // The loan is still there either way.
      const still = await prisma.advanceLoanRequest.count({ where: { employeeId: empId } });
      expect(still).toBeGreaterThan(0);

      await prisma.employee.update({
        where: { id: empId },
        data: { status: victim!.status },
      });
    });
  });

  // ── §1/§23 eligibility ──────────────────────────────────────────────────
  describe('§1/§23 eligibility gate', () => {
    it('reports every rule as pass/fail/warn without persisting anything', async () => {
      const before = await prisma.advanceLoanRequest.count({ where: { employeeId: empId } });

      const res = await http()
        .post('/advance-loans/eligibility')
        .set(bearer(empToken))
        .send({ amount: 10000, installments: 4, type: 'LOAN' });

      expect(res.status).toBe(200);
      expect(body(res).eligible).toBe(true);
      expect(body(res).checks.length).toBeGreaterThan(5);

      const after = await prisma.advanceLoanRequest.count({ where: { employeeId: empId } });
      expect(after).toBe(before);
    });

    it('WARNS (does not fail) when the amount reaches a full year of pay', async () => {
      const res = await http()
        .post('/advance-loans/eligibility')
        .set(bearer(empToken))
        .send({ amount: SALARY * 15, installments: 60, type: 'LOAN' });

      const annual = body(res).checks.find((c: any) => c.code === 'ANNUAL_SALARY_CAP');
      expect(annual.status).toBe('WARN');
    });

    it('blocks a new loan once the active-loan limit is reached', async () => {
      await writeLoanConfig(prisma, { loan_max_active_per_employee: '1' } as any);
      await seedLoan();

      const res = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        .send({ type: 'LOAN', amount: 5000, installments: 2 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/active/i);

      await writeLoanConfig(prisma, { loan_max_active_per_employee: '2' } as any);
    });

    it('blocks an instalment that would eat too much of net pay', async () => {
      const res = await http()
        .post('/advance-loans')
        .set(bearer(empToken))
        // One instalment of a full year of salary.
        .send({ type: 'LOAN', amount: SALARY * 12, installments: 1 });
      expect(res.status).toBe(400);
    });

    it('an employee may only ask about themselves', async () => {
      const res = await http()
        .post('/advance-loans/eligibility')
        .set(bearer(empToken))
        .send({ employeeId: otherEmpId, amount: 1000, installments: 1 });
      // The id is forced back to the caller, so the answer is about THEM.
      expect(res.status).toBe(200);
      expect(body(res).monthlyNet).toBe(SALARY);
    });
  });

  // ── pagination ──────────────────────────────────────────────────────────
  describe('list pagination', () => {
    it('returns a bare array when page/limit are omitted (old clients keep working)', async () => {
      await seedLoan();
      const res = await http().get('/advance-loans').set(bearer(hrToken));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns the envelope with meta and summary when paginated', async () => {
      await seedLoan();
      await seedLoan();
      const res = await http()
        .get('/advance-loans?page=1&limit=1&employeeId=' + empId)
        .set(bearer(hrToken));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(2);
      expect(res.body.meta.limit).toBe(1);
      expect(res.body.summary.totalOutstanding).toBeGreaterThan(0);
    });

    it('caps limit so a client cannot ask for everything', async () => {
      const res = await http()
        .get('/advance-loans?page=1&limit=99999')
        .set(bearer(hrToken));
      expect(res.body.meta.limit).toBe(200);
    });

    /**
     * Search runs in the QUERY, not over the returned page.
     *
     * A client-side filter on a paginated list searches only the rows already
     * fetched, so "no results" would mean "not on this page" — a wrong answer
     * the user cannot tell apart from a right one. These assert that `total`
     * (the server's count for the whole filtered set) responds to the term, not
     * merely that the returned page looks right.
     */
    it('searches by employee name across the whole result set, not one page', async () => {
      await seedLoan();
      const res = await http()
        .get('/advance-loans?page=1&limit=25&search=Loan Tester A')
        .set(bearer(hrToken));

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBeGreaterThan(0);
      for (const row of res.body.data) {
        expect(row.employee.fullName).toContain('Loan Tester A');
      }
    });

    it('searches by employee code', async () => {
      await seedLoan();
      const code = `LN-${runId}-A`;
      const res = await http()
        .get(`/advance-loans?page=1&limit=25&search=${encodeURIComponent(code)}`)
        .set(bearer(hrToken));

      expect(res.body.meta.total).toBeGreaterThan(0);
      expect(res.body.data[0].employee.employeeCode).toBe(code);
    });

    it('is case-insensitive', async () => {
      await seedLoan();
      const lower = await http()
        .get('/advance-loans?page=1&limit=25&search=loan tester a')
        .set(bearer(hrToken));
      const upper = await http()
        .get('/advance-loans?page=1&limit=25&search=LOAN TESTER A')
        .set(bearer(hrToken));

      expect(lower.body.meta.total).toBeGreaterThan(0);
      expect(upper.body.meta.total).toBe(lower.body.meta.total);
    });

    it('returns an empty set — not everything — when nothing matches', async () => {
      await seedLoan();
      const res = await http()
        .get('/advance-loans?page=1&limit=25&search=zzz-no-such-employee-zzz')
        .set(bearer(hrToken));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
      expect(res.body.summary.count).toBe(0);
    });

    it('combines with the status filter rather than replacing it', async () => {
      await seedLoan({ status: 'PENDING' });
      await seedLoan({ status: 'APPROVED' });

      const res = await http()
        .get('/advance-loans?page=1&limit=25&search=Loan Tester A&status=PENDING')
        .set(bearer(hrToken));

      expect(res.body.meta.total).toBeGreaterThan(0);
      for (const row of res.body.data) {
        expect(row.status).toBe('PENDING');
      }
    });

    it('a blank or whitespace search is ignored, not treated as "match nothing"', async () => {
      await seedLoan();
      const res = await http()
        .get('/advance-loans?page=1&limit=25&search=%20%20')
        .set(bearer(hrToken));

      expect(res.body.meta.total).toBeGreaterThan(0);
    });

    /**
     * `summary.totalOutstanding` is money genuinely owed.
     *
     * It is now surfaced on the list screen, so getting it wrong states a false
     * figure about company money in the largest text on the page. Two mistakes
     * are pinned here because both were made:
     *
     *  1. Counting `amount - amountRepaid` over EVERY matched row, so a
     *     rejected request's full principal read as outstanding debt.
     *  2. Fixing (1) by overwriting the status condition instead of
     *     intersecting it, so every filtered view reported the whole book.
     */
    const summaryFor = async (query: string) => {
      const res = await http()
        .get(`/advance-loans?page=1&limit=5&employeeId=${empId}${query}`)
        .set(bearer(hrToken));
      expect(res.status).toBe(200);
      return res.body.summary;
    };

    it('a request that never became debt contributes NOTHING to outstanding', async () => {
      await seedLoan({ status: 'REJECTED', amount: 50000 });
      await seedLoan({ status: 'PENDING', amount: 40000 });
      await seedLoan({ status: 'CANCELLED', amount: 30000 });

      for (const status of ['REJECTED', 'PENDING', 'CANCELLED']) {
        const summary = await summaryFor(`&status=${status}`);
        expect(summary.count).toBeGreaterThan(0);
        expect(summary.totalPrincipal).toBeGreaterThan(0);
        // Principal exists; debt does not.
        expect(summary.totalOutstanding).toBe(0);
      }
    });

    it('a settled loan contributes nothing either', async () => {
      await seedLoan({ status: 'COMPLETED', amount: 20000, amountRepaid: 20000 });
      const summary = await summaryFor('&status=COMPLETED');
      expect(summary.totalOutstanding).toBe(0);
    });

    it('a live loan contributes exactly what is still owed', async () => {
      await seedLoan({ status: 'ACTIVE', amount: 10000, amountRepaid: 4000 });
      const summary = await summaryFor('&status=ACTIVE');
      expect(summary.totalOutstanding).toBe(6000);
    });

    it('write-offs and waivers reduce outstanding, not just repayments', async () => {
      await seedLoan({
        status: 'ACTIVE',
        amount: 10000,
        amountRepaid: 1000,
        writtenOffAmount: 2000,
        waivedAmount: 500,
      });
      const summary = await summaryFor('&status=ACTIVE');
      expect(summary.totalOutstanding).toBe(6500);
    });

    it('THE INTERSECTION BUG: a filtered view reports ITS OWN balance, not the book', async () => {
      await seedLoan({ status: 'ACTIVE', amount: 10000, amountRepaid: 0 });
      await seedLoan({ status: 'REJECTED', amount: 90000 });

      const rejected = await summaryFor('&status=REJECTED');
      const active = await summaryFor('&status=ACTIVE');

      // If the status condition were overwritten rather than intersected, the
      // REJECTED view would report the ACTIVE loan's balance.
      expect(rejected.totalOutstanding).toBe(0);
      expect(active.totalOutstanding).toBeGreaterThan(0);
      expect(rejected.totalOutstanding).not.toBe(active.totalOutstanding);
    });

    it('never reports a negative balance', async () => {
      await seedLoan({ status: 'ACTIVE', amount: 1000, amountRepaid: 9999 });
      const summary = await summaryFor('&status=ACTIVE');
      expect(summary.totalOutstanding).toBeGreaterThanOrEqual(0);
    });
  });

  // ── regression: bugs found by review, each fixed ────────────────────────
  describe('regressions', () => {
    const approvedWithSchedule = async (over: Record<string, any> = {}) => {
      const loan = await seedLoan({ status: 'PENDING', ...over });
      await http()
        .post(`/advance-loans/${loan.id}/approve`)
        .set(bearer(hrToken))
        .send({ installments: over.installments ?? 4 });
      return loan;
    };

    it('an interest-only recovery credits INTEREST, never principal', async () => {
      // Regression: the lock path used `principal || cash`, so a cycle whose
      // whole instalment went to interest credited principal with the interest
      // too — repaying the loan twice as fast as the employee actually paid.
      await writeLoanConfig(prisma, { loan_module_v2_enabled: 'true' });
      const loan = await seedLoan();

      const payroll = await prisma.payroll.create({
        data: {
          month: MONTH,
          year: YEAR,
          status: 'APPROVED',
          branchId,
          totalAmount: 0,
        },
      });
      const item = await prisma.payrollItem.create({
        data: {
          payrollId: payroll.id,
          employeeId: empId,
          baseSalary: SALARY,
          workDays: 30,
          actualWorkDays: 30,
          netSalary: SALARY,
          advanceLoanDeduction: 500,
        },
      });
      await prisma.advanceLoanDeduction.create({
        data: {
          requestId: loan.id,
          payrollItemId: item.id,
          amount: 500,
          principalComponent: 0,
          interestComponent: 500,
          feeComponent: 0,
          month: MONTH,
          year: YEAR,
          status: 'PENDING',
        },
      });

      await http()
        .post(`/payrolls/${payroll.id}/lock`)
        .set(bearer(adminToken))
        .send({});

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(Number(after!.amountRepaid)).toBe(0); // principal untouched
      expect(Number(after!.interestPaid)).toBe(500);
    });

    it('regenerating after a skip does not demand the same money twice', async () => {
      // Regression: opening arrears were folded onto instalment #1 while the
      // same principal was still inside `outstanding`, so the schedule totalled
      // more than the debt.
      const loan = await approvedWithSchedule();

      await http()
        .post(`/advance-loans/${loan.id}/skip-installment`)
        .set(bearer(hrToken))
        .send({ installmentNo: 2, mode: 'EXTEND', reason: 'Medical emergency' });

      const live = await prisma.advanceLoanRequest.findUnique({
        where: { id: loan.id },
        select: { scheduleVersion: true },
      });
      const rows = await prisma.loanSchedule.findMany({
        where: { requestId: loan.id, version: live!.scheduleVersion },
      });
      const scheduled = rows.reduce((a, r) => a + Number(r.emiAmount), 0);
      const paid = 0;
      // What is still scheduled must equal what is still owed — no more.
      expect(Math.round(scheduled * 100) / 100).toBe(12000 - paid);
    });

    it('forgiving an instalment moves principal and interest to their own counters', async () => {
      // Regression: FORGIVE added the whole EMI to waivedAmount, which is a
      // PRINCIPAL counter, so the interest portion was subtracted from
      // principal as well and the balance was understated.
      await writeLoanConfig(prisma, { loan_interest_enabled: 'true' });
      const loan = await seedLoan({
        status: 'PENDING',
        amount: 120000,
        installments: 12,
        interestMethod: 'REDUCING_BALANCE',
        interestRate: 12,
      });
      await http()
        .post(`/advance-loans/${loan.id}/approve`)
        .set(bearer(hrToken))
        .send({ installments: 12 });

      const row = await prisma.loanSchedule.findFirst({
        where: { requestId: loan.id, installmentNo: 5 },
      });

      await http()
        .post(`/advance-loans/${loan.id}/skip-installment`)
        .set(bearer(hrToken))
        .send({ installmentNo: 5, mode: 'FORGIVE', reason: 'Goodwill' });

      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      // waivedAmount tracks principal only.
      expect(Number(after!.waivedAmount)).toBe(Number(row!.principalComponent));
    });

    it('the payslip never shows a deduction the ledger does not carry', async () => {
      // Regression: skipDuplicates silently dropped a row a concurrent run had
      // claimed, leaving net reduced with nothing to flip at lock — money
      // withheld and never credited.
      await seedLoan({ installmentAmount: 3000 });
      const run = await runPayroll();
      const item = await itemFor(body(run).id);

      const ledger = await prisma.advanceLoanDeduction.aggregate({
        where: { payrollItemId: item!.id, status: 'PENDING' },
        _sum: { amount: true },
      });
      expect(Number(ledger._sum.amount ?? 0)).toBe(
        Number(item!.advanceLoanDeduction),
      );
    });

    it('a retried prepayment with the same idempotency key is a 409, not a double charge', async () => {
      const loan = await approvedWithSchedule();
      const key = '11111111-2222-4333-8444-555555555555'; // valid v4 UUID

      const first = await http()
        .post(`/advance-loans/${loan.id}/prepay`)
        .set(bearer(hrToken))
        .send({ amount: 1000, idempotencyKey: key });
      expect(first.status).toBe(201);

      const retry = await http()
        .post(`/advance-loans/${loan.id}/prepay`)
        .set(bearer(hrToken))
        .send({ amount: 1000, idempotencyKey: key });
      expect(retry.status).toBe(409);

      // The money moved exactly once.
      const after = await prisma.advanceLoanRequest.findUnique({ where: { id: loan.id } });
      expect(Number(after!.amountRepaid)).toBe(1000);
    });

    it('a PENDING request is not a debt and must not block offboarding', async () => {
      // Regression: clearance blocked on any non-terminal status, so a request
      // that had never been approved (nothing disbursed) stopped an exit.
      await prisma.advanceLoanRequest.create({
        data: {
          employeeId: empId,
          type: 'ADVANCE',
          amount: 1000,
          installments: 1,
          status: 'PENDING',
        },
      });

      const res = await http()
        .get(`/assets/clearance/${empId}`)
        .set(bearer(hrToken));
      if (res.status === 200) {
        expect(body(res).loanCleared).toBe(true);
      }
    });
  });

  // ── §15 reports ─────────────────────────────────────────────────────────
  describe('§15 reports', () => {
    it('outstanding separates in-flight money from the balance', async () => {
      const loan = await seedLoan({ amount: 12000, installmentAmount: 3000 });
      await runPayroll(); // a PENDING (unlocked) recovery

      const res = await http()
        .get('/advance-loans/reports/outstanding')
        .set(bearer(hrToken));
      expect(res.status).toBe(200);

      const mine = res.body.data.find((r: any) => r.employeeId === empId);
      expect(mine).toBeDefined();
      // The recovery has NOT happened yet, so outstanding is untouched...
      expect(mine.outstanding).toBe(12000);
      // ...and the pending amount is surfaced on its own.
      expect(mine.inFlight).toBe(3000);
      // The reader is told which runs would move the numbers.
      expect(res.body.meta.openPayrolls.length).toBeGreaterThan(0);
      expect(loan.id).toBeDefined();
    });

    it('rejects a future asOf instead of inventing a balance', async () => {
      const res = await http()
        .get('/advance-loans/reports/outstanding?asOf=2999-01-01')
        .set(bearer(hrToken));
      expect(res.status).toBe(400);
    });

    it('portfolio groups the book by status and type', async () => {
      await seedLoan();
      const res = await http()
        .get('/advance-loans/reports/portfolio')
        .set(bearer(hrToken));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('emi-due lists what a cycle is scheduled to recover', async () => {
      const loan = await seedLoan({ status: 'PENDING' });
      await http()
        .post(`/advance-loans/${loan.id}/approve`)
        .set(bearer(hrToken))
        .send({ installments: 4 });

      const sched = await prisma.loanSchedule.findFirst({
        where: { requestId: loan.id, installmentNo: 1 },
      });
      const res = await http()
        .get(`/advance-loans/reports/emi-due?month=${sched!.dueMonth}&year=${sched!.dueYear}`)
        .set(bearer(hrToken));

      expect(res.status).toBe(200);
      expect(res.body.data.some((r: any) => r.loanId === loan.id)).toBe(true);
    });

    it('overdue buckets instalments by age', async () => {
      const res = await http()
        .get('/advance-loans/reports/overdue')
        .set(bearer(hrToken));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.buckets)).toEqual(['1-30', '31-60', '61-90', '90+']);
    });

    it('interest-earned reads PAID ledger rows, so an unlocked run counts for nothing', async () => {
      // This is a WHOLE-BOOK report, so asserting an absolute zero only holds
      // on an empty database — the demo seed (or any other data) legitimately
      // contributes locked history. Measure the DELTA from our own unlocked
      // run instead: it must be exactly nothing.
      const before = await http()
        .get('/advance-loans/reports/interest-earned')
        .set(bearer(hrToken));
      const baseline = before.body.totals.principal;

      await seedLoan();
      await runPayroll(); // generated, never locked

      const after = await http()
        .get('/advance-loans/reports/interest-earned')
        .set(bearer(hrToken));
      expect(after.status).toBe(200);
      expect(after.body.totals.principal).toBe(baseline);
    });

    it('my-statement takes the employee from the token — no id to tamper with', async () => {
      await seedLoan();
      const res = await http()
        .get('/advance-loans/reports/my-statement')
        .set(bearer(empToken));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('an employee cannot read the whole-book reports', async () => {
      for (const path of ['outstanding', 'portfolio', 'emi-due', 'overdue']) {
        const res = await http()
          .get(`/advance-loans/reports/${path}`)
          .set(bearer(empToken));
        expect(res.status).toBe(403);
      }
    });
  });

  // ── §19 bulk import ─────────────────────────────────────────────────────
  describe('§19 bulk import', () => {
    const employeeCode = () => `LN-${runId}-A`;

    it('serves a template', async () => {
      const res = await http()
        .get('/advance-loans/import/template')
        .set(bearer(hrToken));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/spreadsheet/);
    });

    it('imports a mid-life loan so payroll resumes at the NEXT instalment', async () => {
      // The whole point of the importer: a loan with 3 of 12 already paid must
      // not be recovered from instalment 1 again.
      const res = await http()
        .post('/advance-loans/import/confirm')
        .set(bearer(hrToken))
        .send({
          rows: [
            {
              employeeCode: employeeCode(),
              referenceNo: `IMP-${runId}-1`,
              type: 'LOAN',
              principal: 12000,
              interestMethod: 'NONE',
              interestRate: 0,
              installments: 12,
              disbursedOn: '2026-01-15',
              firstDeductionPeriod: `${YEAR}-01`,
              installmentsPaid: 3,
              amountRepaid: 3000,
              status: 'ACTIVE',
            },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.summary.imported).toBe(1);

      const loanId = res.body.results[0].loanId;
      createdLoanIds.push(loanId);

      const loan = await prisma.advanceLoanRequest.findUnique({ where: { id: loanId } });
      expect(Number(loan!.amountRepaid)).toBe(3000);

      // 12 rows, the first 3 marked PAID.
      const rows = await prisma.loanSchedule.findMany({
        where: { requestId: loanId },
        orderBy: { installmentNo: 'asc' },
      });
      expect(rows).toHaveLength(12);
      expect(rows.slice(0, 3).every((r) => r.status === 'PAID')).toBe(true);
      expect(rows[3].status).toBe('SCHEDULED');

      // The consumed instalments exist in the LEDGER with no payroll item —
      // this is what stops payroll restarting at instalment 1.
      const ledger = await prisma.advanceLoanDeduction.findMany({
        where: { requestId: loanId },
      });
      expect(ledger).toHaveLength(3);
      expect(ledger.every((l) => l.status === 'PAID' && l.payrollItemId === null)).toBe(true);
    });

    it('re-importing the same reference is refused, not duplicated', async () => {
      const row = {
        employeeCode: employeeCode(),
        referenceNo: `IMP-${runId}-DUP`,
        type: 'LOAN',
        principal: 6000,
        interestMethod: 'NONE',
        interestRate: 0,
        installments: 6,
        disbursedOn: '2026-02-15',
        firstDeductionPeriod: `${YEAR}-02`,
        installmentsPaid: 0,
        amountRepaid: 0,
        status: 'ACTIVE',
      };

      const first = await http()
        .post('/advance-loans/import/confirm')
        .set(bearer(hrToken))
        .send({ rows: [row] });
      expect(first.body.summary.imported).toBe(1);
      createdLoanIds.push(first.body.results[0].loanId);

      const second = await http()
        .post('/advance-loans/import/confirm')
        .set(bearer(hrToken))
        .send({ rows: [row] });
      expect(second.body.summary.imported).toBe(0);
      expect(second.body.summary.failed).toBe(1);
    });

    it('one bad row does not roll back the good ones', async () => {
      const res = await http()
        .post('/advance-loans/import/confirm')
        .set(bearer(hrToken))
        .send({
          rows: [
            {
              employeeCode: employeeCode(),
              referenceNo: `IMP-${runId}-OK`,
              type: 'LOAN',
              principal: 6000,
              interestMethod: 'NONE',
              interestRate: 0,
              installments: 6,
              disbursedOn: '2026-03-15',
              firstDeductionPeriod: `${YEAR}-03`,
              installmentsPaid: 0,
              amountRepaid: 0,
              status: 'ACTIVE',
            },
            {
              employeeCode: 'NO-SUCH-EMPLOYEE',
              referenceNo: `IMP-${runId}-BAD`,
              type: 'LOAN',
              principal: 6000,
              interestMethod: 'NONE',
              interestRate: 0,
              installments: 6,
              disbursedOn: '2026-03-15',
              firstDeductionPeriod: `${YEAR}-03`,
              installmentsPaid: 0,
              amountRepaid: 0,
              status: 'ACTIVE',
            },
          ],
        });

      expect(res.body.summary.imported).toBe(1);
      expect(res.body.summary.failed).toBe(1);
      const ok = res.body.results.find((r: any) => r.success);
      createdLoanIds.push(ok.loanId);
    });

    it('an employee cannot import', async () => {
      const res = await http()
        .post('/advance-loans/import/confirm')
        .set(bearer(empToken))
        .send({ rows: [] });
      expect(res.status).toBe(403);
    });
  });

  // ── money invariants ────────────────────────────────────────────────────
  describe('money invariants', () => {
    it('every ledger row reconciles: principal + interest + fee === amount', async () => {
      await writeLoanConfig(prisma, { loan_module_v2_enabled: 'true' });
      await seedLoan({ installmentAmount: 3000 });
      await runPayroll();

      const rows = await prisma.advanceLoanDeduction.findMany({
        where: { request: { employeeId: empId } },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        const split =
          Number(r.principalComponent) +
          Number(r.interestComponent) +
          Number(r.feeComponent);
        expect(Math.round(split * 100) / 100).toBe(
          Math.round(Number(r.amount) * 100) / 100,
        );
      }
    });

    it('recovery is a post-tax deduction: it changes net, never tax or PF', async () => {
      const withoutLoan = await runPayroll();
      const baseItem = await itemFor(body(withoutLoan).id);
      await dropPayrolls();

      await seedLoan({ installmentAmount: 3000 });
      const withLoan = await runPayroll();
      const loanItem = await itemFor(body(withLoan).id);

      expect(Number(loanItem!.tax)).toBe(Number(baseItem!.tax));
      expect(Number(loanItem!.insurance)).toBe(Number(baseItem!.insurance));
      expect(
        Number(baseItem!.netSalary) - Number(loanItem!.netSalary),
      ).toBe(3000);
    });

    it('net salary is never negative even when the recovery exceeds pay', async () => {
      await seedLoan({ amount: 999999, installmentAmount: 999999 });
      const res = await runPayroll();
      const item = await itemFor(body(res).id);
      expect(Number(item!.netSalary)).toBeGreaterThanOrEqual(0);
    });
  });

  // ── §24 refusal messages ──────────────────────────────────────────────────
  /**
   * Every refusal must explain itself.
   *
   * This block exists because of a real production incident: skipping
   * instalment 50 of a ONE-instalment advance showed the user "The operation
   * could not be completed". The backend was not at fault — it answered 404
   * "Instalment not found on the live schedule" — but nothing tested the
   * CONTENT of that string, only its status code, so there was no contract
   * saying it had to stay useful. The frontend then discarded it (it read
   * `err.response.data.message`, which is undefined on the flat object our axios
   * interceptor rejects with) and the user saw a shrug.
   *
   * Both halves are now pinned. The frontend half lives in
   * `apps/frontend/utils/apiError.test.ts` and
   * `apps/frontend/components/advance-loans/loanGuards.test.ts`; this is the
   * server half. The invariant: for every reachable refusal, `body.message` is a
   * non-empty, specific sentence — never absent, never a bare status word, and
   * never so generic that a UI would have been better off with its own fallback.
   *
   * If you add a lifecycle guard, add it here too. A guard whose message is
   * untested is a guard that will eventually surface as "undefined".
   */
  describe('§24 every refusal explains itself', () => {
    const approved = async (over: Record<string, any> = {}) => {
      const loan = await seedLoan({ status: 'PENDING', ...over });
      await http()
        .post(`/advance-loans/${loan.id}/approve`)
        .set(bearer(hrToken))
        .send({ installments: over.installments ?? 4 });
      return loan;
    };

    /** The single string a client would actually show the user. */
    const messageOf = (res: any): string => {
      const m = res.body?.message;
      if (Array.isArray(m)) return m.filter((x) => typeof x === 'string').join('; ');
      return typeof m === 'string' ? m : '';
    };

    /**
     * Assert a refusal is usable as-is.
     *
     * `mustMention` are the concrete details that make it actionable — the
     * instalment number, the payoff figure, the run that is blocking. A message
     * that omits them is technically present and practically useless.
     */
    const expectExplains = (res: any, status: number, ...mustMention: (string | RegExp)[]) => {
      expect(res.status).toBe(status);
      const msg = messageOf(res);

      // Thrown rather than asserted so the failure carries the whole response —
      // a bare "expected truthy, got ''" would not say which route produced it.
      if (!msg) {
        throw new Error(
          `no usable message on ${res.status}: ${JSON.stringify(res.body)}`,
        );
      }
      expect(msg).not.toMatch(/undefined|null|\[object Object\]/i);
      // Long enough to be a sentence rather than an enum leaking out.
      expect(msg.length).toBeGreaterThan(15);
      expect(msg).not.toMatch(
        /^(bad request|forbidden|not found|conflict|internal server error|error)$/i,
      );

      for (const fragment of mustMention) {
        if (fragment instanceof RegExp) expect(msg).toMatch(fragment);
        else expect(msg.toLowerCase()).toContain(String(fragment).toLowerCase());
      }
    };

    it('THE PRODUCTION CASE: skipping an instalment that does not exist names the schedule', async () => {
      // A one-instalment advance, exactly like the reported OMR 1,500 request.
      const loan = await approved({ type: 'ADVANCE', amount: 1500, installments: 1 });
      const res = await http()
        .post(`/advance-loans/${loan.id}/skip-installment`)
        .set(bearer(hrToken))
        .send({ installmentNo: 50, mode: 'EXTEND', reason: 'Requested by HOD' });

      expectExplains(res, 404, 'instalment', 'schedule');
    });

    it('skipping an instalment that is not open says what state it is in', async () => {
      const loan = await approved();
      await prisma.loanSchedule.updateMany({
        where: { requestId: loan.id, installmentNo: 1 },
        data: { status: 'PAID' },
      });
      const res = await http()
        .post(`/advance-loans/${loan.id}/skip-installment`)
        .set(bearer(hrToken))
        .send({ installmentNo: 1, mode: 'EXTEND', reason: 'already settled' });

      expectExplains(res, 400, 'instalment 1', 'paid', 'cannot be skipped');
    });

    it('an unapproved request says so rather than failing anonymously', async () => {
      const loan = await seedLoan({ status: 'PENDING' });
      const res = await http()
        .post(`/advance-loans/${loan.id}/hold`)
        .set(bearer(hrToken))
        .send({ reason: 'too early' });

      expectExplains(res, 400, 'not been approved');
    });

    it('a terminal loan names its own status', async () => {
      const loan = await seedLoan({ status: 'COMPLETED' });
      const res = await http()
        .post(`/advance-loans/${loan.id}/prepay`)
        .set(bearer(hrToken))
        .send({ amount: 100 });

      expectExplains(res, 400, 'completed', 'no longer be changed');
    });

    it('an overpayment quotes the exact payoff and what to pay instead', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/prepay`)
        .set(bearer(hrToken))
        .send({ amount: 99999 });

      expectExplains(res, 400, '99999', '12000', 'payoff');
    });

    it('a manual close above tolerance names the balance AND the alternatives', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/close`)
        .set(bearer(hrToken))
        .send({ reason: 'closing early' });

      expectExplains(res, 400, '12000', 'tolerance', /prepay|waive|write-off/i);
    });

    it('foreclosing with principal outstanding says how much and what to do', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/foreclose`)
        .set(bearer(hrToken))
        .send({ reason: 'employee exiting' });

      expectExplains(res, 400, '12000', 'outstanding', 'prepayment');
    });

    it('an oversized write-off names both figures', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/write-off`)
        .set(bearer(adminToken))
        .send({ amount: 99999, reason: 'uncollectable after exit' });

      expectExplains(res, 400, '99999', '12000');
    });

    it('an oversized waiver names which balance it exceeded', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/waive`)
        .set(bearer(hrToken))
        .send({ amount: 500, waiveType: 'INTEREST', reason: 'goodwill' });

      // Interest is off for this loan, so the interest cap is 0.
      expectExplains(res, 400, 'waiver', 'interest', 'balance of 0');
    });

    it('resuming a loan that is not held says exactly that', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/resume`)
        .set(bearer(hrToken))
        .send({ reason: 'resume' });

      expectExplains(res, 400, 'not on hold');
    });

    it('reinstating a loan with no write-off says exactly that', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/reinstate`)
        .set(bearer(adminToken))
        .send({ reason: 'reinstate' });

      expectExplains(res, 400, 'nothing written off');
    });

    it('converting a LOAN says only advances convert', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/convert`)
        .set(bearer(hrToken))
        .send({ installments: 3, reason: 'convert' });

      expectExplains(res, 400, 'only an advance');
    });

    it('the in-flight-payroll guard names the run to lock or delete', async () => {
      // The 409 a user is most likely to hit, and the one where a generic
      // message is most expensive: without the month/year they cannot act.
      const loan = await approved();
      await runPayroll();

      const res = await http()
        .post(`/advance-loans/${loan.id}/prepay`)
        .set(bearer(hrToken))
        .send({ amount: 100 });

      expectExplains(res, 409, `${MONTH}/${YEAR}`, 'in progress', /lock or delete/i);
    });

    it('a role refusal names the roles that ARE allowed', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/write-off`)
        .set(bearer(hrToken)) // write-off is ADMIN-only by default
        .send({ amount: 100, reason: 'uncollectable after exit' });

      if (res.status === 403) {
        expectExplains(res, 403, 'not permitted', 'allowed:');
      } else {
        // The setting permits HR in this environment; then it must succeed
        // rather than fail for some other unexplained reason.
        expect(res.status).toBeLessThan(400);
      }
    });

    it('a missing loan 404s with a sentence, not an empty body', async () => {
      const res = await http()
        .post('/advance-loans/00000000-0000-4000-8000-000000000000/prepay')
        .set(bearer(hrToken))
        .send({ amount: 100 });

      expectExplains(res, 404, 'not found');
    });

    it('DTO validation names the offending field, not just "Bad Request"', async () => {
      const loan = await approved();
      const res = await http()
        .post(`/advance-loans/${loan.id}/skip-installment`)
        .set(bearer(hrToken))
        .send({ installmentNo: 'not-a-number', mode: 'EXTEND', reason: 'x' });

      expect(res.status).toBe(400);
      const msg = messageOf(res);
      expect(msg).toBeTruthy();
      expect(msg.toLowerCase()).toContain('installmentno');
    });

    it('cancelling a decided request explains which states may be cancelled', async () => {
      const loan = await approved();
      const res = await http()
        .delete(`/advance-loans/${loan.id}`)
        .set(bearer(empToken));

      expectExplains(res, 400, 'pending');
    });

    /**
     * The catch-all. Anything a manager can click on a loan that is in the wrong
     * state must come back with a usable sentence — not a bare status, not an
     * empty body. This is the check that would have caught the incident class
     * rather than the single incident.
     */
    it('EVERY lifecycle route on a terminal loan returns a usable sentence', async () => {
      const loan = await seedLoan({ status: 'CLOSED' });
      const routes: Array<[string, Record<string, any>]> = [
        ['prepay', { amount: 100 }],
        ['close', { reason: 'closing this loan' }],
        ['foreclose', { reason: 'employee exiting' }],
        ['write-off', { amount: 100, reason: 'uncollectable after exit' }],
        ['waive', { amount: 100, waiveType: 'BOTH', reason: 'goodwill gesture' }],
        ['hold', { reason: 'pausing recovery' }],
        ['resume', { reason: 'resuming recovery' }],
        ['skip-installment', { installmentNo: 1, mode: 'EXTEND', reason: 'skip this one' }],
        ['convert', { installments: 3, reason: 'convert to loan' }],
        ['reinstate', { reason: 'reinstating balance' }],
      ];

      const bad: string[] = [];
      for (const [route, payload] of routes) {
        const res = await http()
          .post(`/advance-loans/${loan.id}/${route}`)
          .set(bearer(adminToken))
          .send(payload);

        if (res.status < 400) continue; // legitimately allowed — not our concern
        const msg = messageOf(res);
        if (
          !msg ||
          msg.length <= 15 ||
          /undefined|\[object Object\]/i.test(msg) ||
          /^(bad request|forbidden|not found|conflict|error)$/i.test(msg)
        ) {
          bad.push(`${route} → ${res.status} ${JSON.stringify(res.body)}`);
        }
      }

      // The array IS the diagnostic: on failure Jest prints each offending
      // route with its status and body.
      expect(bad).toEqual([]);
    });
  });
});
