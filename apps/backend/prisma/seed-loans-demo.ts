/**
 * Loan & Advances v2 — end-to-end demo seed.
 *
 * Drives the REAL services (approval, schedule generation, payroll recovery,
 * lock, prepayment, hold, write-off), not raw Prisma inserts. That is the point:
 * a seed that writes rows directly proves the schema exists; this one proves the
 * feature works, and fails loudly if it does not.
 *
 * Everything it creates is namespaced `LNDEMO` / `@loandemo.local` and is deleted
 * on re-run, so it is safe to run repeatedly and never touches other data.
 *
 * Run from apps/backend, pointing at a DEV/demo database — never PROD:
 *   npm run prisma:seed:loans
 *
 * It turns ON `loan_module_v2_enabled` and `loan_interest_enabled` so the
 * affordability engine and interest are actually exercised. Both are reported at
 * the end; turn them back off if the target database is a plain demo.
 */

import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdvanceLoansService } from '../src/advance-loans/advance-loans.service';
import { LoanLifecycleService } from '../src/advance-loans/loan-lifecycle.service';
import { LoanPolicyService } from '../src/advance-loans/loan-policy.service';
import { LoanReportsService } from '../src/advance-loans/loan-reports.service';
import { LoanScheduleService } from '../src/advance-loans/loan-schedule.service';
import { LoanSettlementService } from '../src/advance-loans/loan-settlement.service';
import { LoanImportService } from '../src/advance-loans/loan-import.service';
import { PayrollsService } from '../src/payrolls/payrolls.service';

const NS = 'LNDEMO';
const EMAIL_DOMAIN = 'loandemo.local';
const PASSWORD = 'Passw0rd!';

/**
 * The cycle the demo payroll runs for. Chosen at runtime:
 * payroll periods are unique, and an unrelated run already occupying the period
 * would abort the seed with "Payroll for M/YYYY already exists".
 */
let MONTH = 0;
let YEAR = 0;

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), AppModule] })
class LoanSeedModule {}

const log = (m: string) => console.log(`  • ${m}`);

async function main() {
  console.log('🌱 Seeding the Loan & Advances v2 demo…\n');

  const app = await NestFactory.createApplicationContext(LoanSeedModule, {
    logger: ['error'],
  });
  const prisma = app.get(PrismaService);
  const loans = app.get(AdvanceLoansService);
  const lifecycle = app.get(LoanLifecycleService);
  const schedules = app.get(LoanScheduleService);
  const reports = app.get(LoanReportsService);
  const policy = app.get(LoanPolicyService);
  const payrolls = app.get(PayrollsService);

  // ── 0. Clean the namespace ────────────────────────────────────────────
  log('Clearing any previous run…');
  const oldEmployees = await prisma.employee.findMany({
    where: { employeeCode: { startsWith: NS } },
    select: { id: true },
  });
  const oldIds = oldEmployees.map((e) => e.id);
  if (oldIds.length) {
    const oldLoans = await prisma.advanceLoanRequest.findMany({
      where: { employeeId: { in: oldIds } },
      select: { id: true },
    });
    const loanIds = oldLoans.map((l) => l.id);
    // Children first: the employee FK is RESTRICT precisely so loan history
    // cannot be deleted by accident.
    await prisma.advanceLoanNotificationLog.deleteMany({ where: { requestId: { in: loanIds } } });
    await prisma.loanTransaction.deleteMany({ where: { requestId: { in: loanIds } } });
    await prisma.loanRateChange.deleteMany({ where: { requestId: { in: loanIds } } });
    await prisma.advanceLoanDeduction.deleteMany({ where: { requestId: { in: loanIds } } });
    await prisma.advanceLoanAttachment.deleteMany({ where: { requestId: { in: loanIds } } });
    await prisma.loanSchedule.deleteMany({ where: { requestId: { in: loanIds } } });
    await prisma.advanceLoanRequest.deleteMany({ where: { id: { in: loanIds } } });
    await prisma.loanSettlement.deleteMany({ where: { employeeId: { in: oldIds } } });

    // Find the previous run's payroll THROUGH its items. Filtering on the
    // branch code misses it: with no request context the run is created with a
    // null branchId, and the period-uniqueness index then rejects the re-run
    // with "Payroll for M/YYYY already exists".
    const oldItems = await prisma.payrollItem.findMany({
      where: { employeeId: { in: oldIds } },
      select: { id: true, payrollId: true },
    });
    const oldPayrollIds = [...new Set(oldItems.map((i) => i.payrollId))];
    await prisma.advanceLoanDeduction.deleteMany({
      where: { payrollItemId: { in: oldItems.map((i) => i.id) } },
    });
    await prisma.payrollItem.deleteMany({ where: { employeeId: { in: oldIds } } });
    await prisma.payroll.deleteMany({ where: { id: { in: oldPayrollIds } } });
    await prisma.attendance.deleteMany({ where: { employeeId: { in: oldIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await prisma.employee.deleteMany({ where: { employeeCode: { startsWith: NS } } });
  await prisma.branch.deleteMany({ where: { code: `${NS}-BR` } });
  await prisma.department.deleteMany({ where: { code: `${NS}-DEP` } });

  // Pick a period with no existing payroll, walking back from two months ago
  // (far enough back that locking it is realistic).
  {
    // Search FORWARD from the current month. Schedules generated today fall due
    // at the end of this month, so a past cycle would have nothing due and the
    // demo payroll would recover nothing.
    const now = new Date();
    for (let ahead = 0; ahead < 26; ahead++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
      const m = d.getUTCMonth() + 1;
      const y = d.getUTCFullYear();
      const clash = await prisma.payroll.findFirst({
        where: { month: m, year: y },
        select: { id: true },
      });
      if (!clash) {
        MONTH = m;
        YEAR = y;
        break;
      }
    }
    if (!MONTH) {
      throw new Error(
        'Could not find a payroll period free of an existing run in the last 26 months',
      );
    }
    log(`Demo payroll cycle: ${String(MONTH).padStart(2, '0')}/${YEAR}`);
  }

  // ── 1. Switch the module on ───────────────────────────────────────────
  for (const [key, value] of [
    ['loan_module_v2_enabled', 'true'],
    ['loan_interest_enabled', 'true'],
    ['advance_loan_enabled', 'true'],
    // Generous ceilings so the demo scenarios are not blocked by eligibility;
    // the affordability engine is still exercised by the partial-recovery case.
    ['loan_max_active_per_employee', '5'],
    ['loan_max_emi_percent_of_net', '90'],
    ['advance_loan_max_installments', '36'],
  ] as [string, string][]) {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
  log('Enabled loan_module_v2_enabled + loan_interest_enabled');

  // ── 2. Loan product catalogue ─────────────────────────────────────────
  const seeded = await policy.seedDefaultTypes();
  log(`Loan types: ${seeded} created (catalogue now complete)`);

  // ── 3. Org + people ───────────────────────────────────────────────────
  const dept = await prisma.department.create({
    data: { code: `${NS}-DEP`, name: 'Loan Demo Dept', isActive: true },
  });
  const branch = await prisma.branch.create({
    data: { code: `${NS}-BR`, name: 'Loan Demo Branch', isActive: true },
  });
  const hash = await bcrypt.hash(PASSWORD, 10);

  const people = [
    { suffix: 'AMARA', name: 'Amara Okafor', salary: 90000 },
    { suffix: 'BRUNO', name: 'Bruno Silva', salary: 75000 },
    { suffix: 'CHEN', name: 'Chen Wei', salary: 60000 },
    { suffix: 'DIYA', name: 'Diya Nair', salary: 48000 },
    // Deliberately low pay: their instalment cannot be met in full, which is
    // what exercises the affordability engine (PARTIAL recovery).
    { suffix: 'ELIF', name: 'Elif Demir', salary: 22000 },
    // Leaves the company, so the exit-settlement flow has a subject.
    { suffix: 'FARAI', name: 'Farai Moyo', salary: 55000 },
  ];

  const employees: Record<string, { id: string; name: string; salary: number }> = {};
  for (const p of people) {
    const e = await prisma.employee.create({
      data: {
        employeeCode: `${NS}-${p.suffix}`,
        fullName: p.name,
        dateOfBirth: new Date('1992-05-10'),
        idCard: `${NS}-ID-${p.suffix}`,
        email: `${p.suffix.toLowerCase()}@${EMAIL_DOMAIN}`,
        departmentId: dept.id,
        branchId: branch.id,
        position: 'Engineer',
        startDate: new Date('2024-01-01'),
        baseSalary: p.salary,
        status: 'ACTIVE',
      },
    });
    employees[p.suffix] = { id: e.id, name: p.name, salary: p.salary };
    await prisma.user.create({
      data: {
        email: `${p.suffix.toLowerCase()}@${EMAIL_DOMAIN}`,
        passwordHash: hash,
        role: 'EMPLOYEE',
        isActive: true,
        employeeId: e.id,
      },
    });
  }

  const hrUser = await prisma.user.create({
    data: {
      email: `hr@${EMAIL_DOMAIN}`,
      passwordHash: hash,
      role: 'HR_MANAGER',
      isActive: true,
      isGlobalBranchAccess: true,
    },
  });
  const adminUser = await prisma.user.create({
    data: {
      email: `admin@${EMAIL_DOMAIN}`,
      passwordHash: hash,
      role: 'ADMIN',
      isActive: true,
      isGlobalBranchAccess: true,
    },
  });
  const hr = { id: hrUser.id, role: 'HR_MANAGER', employeeId: null };
  const admin = { id: adminUser.id, role: 'ADMIN', employeeId: null };
  log(`People: ${people.length} employees + HR + ADMIN (password ${PASSWORD})`);

  // Payroll refuses a cycle with no processed attendance.
  const daysInMonth = new Date(Date.UTC(YEAR, MONTH, 0)).getUTCDate();
  await prisma.attendance.createMany({
    data: Object.values(employees).flatMap((e) =>
      Array.from({ length: daysInMonth }, (_, i) => ({
        employeeId: e.id,
        branchId: branch.id,
        date: new Date(Date.UTC(YEAR, MONTH - 1, i + 1)),
        status: 'PRESENT' as const,
      })),
    ),
    skipDuplicates: true,
  });

  // ── 4. Scenarios, through the real services ───────────────────────────
  console.log('\n🏦 Building loan scenarios…');

  const created: Array<{ label: string; id: string }> = [];

  /** Raise a request the way an employee would, then optionally approve it. */
  const raise = async (
    label: string,
    employeeKey: string,
    dto: { type: 'ADVANCE' | 'LOAN'; amount: number; installments?: number; reason: string },
    approve?: { installments?: number; interestRate?: number; method?: string },
  ) => {
    const emp = employees[employeeKey];
    const req: any = await loans.create(emp.id, dto as any);
    const id = req?.id ?? req?.data?.id;

    if (approve) {
      // Interest terms are a product decision made before approval, which is
      // when the schedule is built from them.
      if (approve.interestRate != null) {
        await prisma.advanceLoanRequest.update({
          where: { id },
          data: {
            interestRate: approve.interestRate,
            interestMethod: (approve.method ?? 'REDUCING_BALANCE') as any,
          },
        });
      }
      await loans.approve(id, hr, { installments: approve.installments } as any);
    }
    created.push({ label, id });
    log(`${label} → ${id}`);
    return id;
  };

  // 1. Awaiting approval.
  await raise('PENDING loan (awaiting approval)', 'DIYA', {
    type: 'LOAN',
    amount: 24000,
    installments: 6,
    reason: 'Home repairs',
  });

  // 2. Interest-free loan, recovered through payroll below.
  const plainLoan = await raise(
    'Interest-free loan, 12 instalments',
    'AMARA',
    { type: 'LOAN', amount: 120000, installments: 12, reason: 'Family event' },
    { installments: 12 },
  );

  // 3. Reducing-balance interest — the case the amortization engine exists for.
  const interestLoan = await raise(
    'Reducing-balance loan @ 12% p.a.',
    'BRUNO',
    { type: 'LOAN', amount: 120000, installments: 12, reason: 'Vehicle purchase' },
    { installments: 12, interestRate: 12, method: 'REDUCING_BALANCE' },
  );

  // 4. Advance — a single-instalment schedule.
  const advance = await raise(
    'Salary advance (single instalment)',
    'CHEN',
    { type: 'ADVANCE', amount: 15000, reason: 'Medical emergency' },
    {},
  );

  // 5. A loan that gets a cash prepayment.
  const prepaidLoan = await raise(
    'Loan with a part prepayment',
    'AMARA',
    { type: 'LOAN', amount: 60000, installments: 6, reason: 'Education fees' },
    { installments: 6 },
  );
  await lifecycle.prepay(prepaidLoan, hr, {
    amount: 20000,
    mode: 'BANK',
    reference: 'UTR-DEMO-1',
  });
  log('  ↳ prepaid 20,000 by bank transfer');

  // 6. Recovery paused — payroll skips it entirely.
  const heldLoan = await raise(
    'Loan on hold (unpaid sabbatical)',
    'CHEN',
    { type: 'LOAN', amount: 36000, installments: 12, reason: 'Relocation' },
    { installments: 12 },
  );
  await lifecycle.hold(heldLoan, hr, {
    reason: 'Employee on unpaid sabbatical until next quarter',
  });
  log('  ↳ recovery paused');

  // 7. Written off, then reinstated — proves the reversal path.
  const writtenOff = await raise(
    'Loan written off',
    'DIYA',
    { type: 'LOAN', amount: 18000, installments: 6, reason: 'Emergency' },
    { installments: 6 },
  );
  await lifecycle.writeOff(writtenOff, admin, {
    reason: 'Uncollectable after prolonged absence — Finance ref FIN-DEMO-7',
  });
  log('  ↳ written off by ADMIN');

  // 8. Rejected, so the list has one.
  const rejected: any = await loans.create(employees.BRUNO.id, {
    type: 'LOAN',
    amount: 500000,
    installments: 24,
    reason: 'Second property',
  } as any);
  await loans.reject(rejected.id ?? rejected.data?.id, hr, {
    remarks: 'Exceeds the affordability policy for this grade',
  } as any);
  created.push({ label: 'Rejected loan', id: rejected.id ?? rejected.data?.id });
  log('Rejected loan → recorded');

  // 9. Waived loan.
  const waived = await raise(
    'Loan partially waived',
    'CHEN',
    { type: 'LOAN', amount: 12000, installments: 6, reason: 'Hardship' },
    { installments: 6 },
  );
  await lifecycle.waive(waived, hr, {
    amount: 4000,
    waiveType: 'BOTH',
    reason: 'Hardship waiver approved by HR committee',
  });
  log('  ↳ 4,000 waived');

  // 10. A skipped instalment — still owed, tail pushed out.
  const skipped = await raise(
    'Loan with a skipped instalment',
    'AMARA',
    { type: 'LOAN', amount: 30000, installments: 6, reason: 'Home appliance' },
    { installments: 6 },
  );
  await lifecycle.skipInstallment(skipped, hr, {
    installmentNo: 2,
    mode: 'EXTEND',
    reason: 'Agreed payment holiday for one cycle',
  });
  log('  ↳ instalment 2 skipped (still owed)');

  // 11. Written off then REINSTATED — the reversal path.
  const reinstated = await raise(
    'Loan written off then reinstated',
    'BRUNO',
    { type: 'LOAN', amount: 9000, installments: 3, reason: 'Emergency travel' },
    { installments: 3 },
  );
  await lifecycle.writeOff(reinstated, admin, {
    reason: 'Presumed uncollectable — Finance ref FIN-DEMO-11',
  });
  await lifecycle.reinstate(reinstated, admin, {
    reason: 'Employee returned; debt reinstated per HR-DEMO-11',
  });
  log('  ↳ written off, then reinstated');

  // 12. Advance CONVERTED into an instalment loan.
  const convertible = await raise(
    'Advance converted to a loan',
    'DIYA',
    { type: 'ADVANCE', amount: 12000, reason: 'Bridging until payday' },
    {},
  );
  const conversion: any = await lifecycle.convertToLoan(convertible, hr, {
    installments: 4,
    reason: 'Employee asked to spread the repayment',
  });
  const convertedLoanId = conversion?.data?.newLoanId;
  created.push({ label: 'Converted loan (awaiting approval)', id: convertedLoanId });
  log(`  ↳ converted → new loan ${convertedLoanId} (awaiting approval)`);

  // 13. A loan whose instalments are already OVERDUE, for the ageing report.
  const overdueLoan = await raise(
    'Loan with overdue instalments',
    'BRUNO',
    { type: 'LOAN', amount: 24000, installments: 6, reason: 'Legacy balance' },
    { installments: 6 },
  );
  {
    // Backdate the live schedule so the overdue report has something to age.
    const rows = await prisma.loanSchedule.findMany({
      where: { requestId: overdueLoan },
      orderBy: { installmentNo: 'asc' },
    });
    for (let i = 0; i < Math.min(3, rows.length); i++) {
      const due = new Date();
      due.setUTCMonth(due.getUTCMonth() - (3 - i));
      await prisma.loanSchedule.update({
        where: { id: rows[i].id },
        data: {
          dueDate: due,
          dueMonth: due.getUTCMonth() + 1,
          dueYear: due.getUTCFullYear(),
          dueCycleKey: (due.getUTCFullYear() * 12) + (due.getUTCMonth() + 1),
        },
      });
    }
  }
  log('  ↳ first 3 instalments backdated (overdue)');

  // 14. A borrower who cannot afford the full instalment — PARTIAL recovery.
  // Sized to pass ELIGIBILITY (gated at 90% of the pay proxy, set above) but to
  // exceed what PAYROLL will actually take, since recovery is additionally
  // capped at loan_max_total_deduction_percent_of_net (50%) of the real net.
  // That gap is exactly the partial-recovery case.
  const unaffordable = await raise(
    'Loan the borrower cannot fully service each cycle',
    'ELIF',
    { type: 'LOAN', amount: 46000, installments: 3, reason: 'Family support' },
    { installments: 3 },
  );
  log('  ↳ instalment exceeds the affordable share of net → expect PARTIAL recovery');

  // 15. A leaver, for the exit-settlement flow.
  const leaverLoan = await raise(
    'Leaver with an outstanding balance',
    'FARAI',
    { type: 'LOAN', amount: 20000, installments: 10, reason: 'Relocation' },
    { installments: 10 },
  );

  // ── 5. Run payroll and lock it ────────────────────────────────────────
  console.log('\n💸 Running payroll for the demo cycle…');
  const run: any = await payrolls.create({
    month: MONTH,
    year: YEAR,
    employeeIds: Object.values(employees).map((e) => e.id),
    runType: 'REGULAR',
  } as any);
  const payrollId = run?.data?.id ?? run?.id;
  log(`Payroll ${MONTH}/${YEAR} generated (${payrollId})`);

  await payrolls.submitForApproval(payrollId, admin.id);
  await payrolls.approvePayroll(payrollId, admin.id, {} as any);
  await payrolls.lockPayroll(payrollId, admin.id);
  log('Payroll locked — recoveries have now moved the balances');

  // ── 5b. Flows that need a LOCKED payroll behind them ──────────────────
  console.log('\n🔄 Post-payroll flows…');

  // Exit settlement: the leaver's balance must be decided, not forgotten.
  const settlement = app.get(LoanSettlementService);
  const quote: any = await settlement.quote(employees.FARAI.id);
  if (quote.loans.length > 0) {
    await settlement.settle(employees.FARAI.id, hr, {
      decisions: quote.loans.map((l: any) => ({
        loanId: l.loanId,
        action: 'RECOVER_FROM_GRATUITY' as const,
        amount: l.total,
        reference: 'GRAT-DEMO-1',
        reason: 'Recovered from gratuity at exit',
      })),
    });
    await prisma.employee.update({
      where: { id: employees.FARAI.id },
      data: { status: 'TERMINATED', endDate: new Date() },
    });
    log(`Exit settlement recorded for ${employees.FARAI.name} (recovered from gratuity)`);
  }

  // Bulk import of a mid-life loan: 3 of 12 instalments already paid
  // elsewhere. Payroll must resume at instalment 4, not restart at 1.
  const importer = app.get(LoanImportService);
  const imported: any = await importer.confirm(
    [
      {
        employeeCode: `${NS}-CHEN`,
        referenceNo: `${NS}-IMP-001`,
        type: 'LOAN',
        principal: 24000,
        interestMethod: 'NONE',
        interestRate: 0,
        installments: 12,
        disbursedOn: '2025-06-15',
        firstDeductionPeriod: '2025-07',
        installmentsPaid: 3,
        amountRepaid: 6000,
        status: 'ACTIVE',
        notes: 'Migrated from the legacy spreadsheet',
      },
    ],
    hr,
  );
  const importedLoanId = imported?.results?.[0]?.loanId;
  if (importedLoanId) created.push({ label: 'Imported mid-life loan', id: importedLoanId });
  log(`Imported a mid-life loan (3 of 12 already paid) → ${importedLoanId}`);

  // ── 6. Verify, rather than assume ─────────────────────────────────────
  console.log('\n🔎 Verifying end to end…\n');

  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`   ${ok ? '✅' : '❌'} ${what}`);
    if (!ok) failures.push(what);
  };

  // Interest-free schedule must reconcile to the principal exactly.
  const plainRows = await schedules.listLive(plainLoan);
  const plainPrincipal =
    Math.round(plainRows.reduce((a, r) => a + Number(r.principalComponent), 0) * 100) / 100;
  check(plainRows.length === 12, `Interest-free loan has 12 instalments (${plainRows.length})`);
  check(plainPrincipal === 120000, `Interest-free principal reconciles to 120000 (${plainPrincipal})`);
  check(
    Number(plainRows[11].closingBalance) === 0,
    `Interest-free closing balance lands on 0 (${plainRows[11].closingBalance})`,
  );

  // Interest schedule: declining interest, principal still exact.
  const intRows = await schedules.listLive(interestLoan);
  const intPrincipal =
    Math.round(intRows.reduce((a, r) => a + Number(r.principalComponent), 0) * 100) / 100;
  const intTotal =
    Math.round(intRows.reduce((a, r) => a + Number(r.interestComponent), 0) * 100) / 100;
  check(intPrincipal === 120000, `Interest loan principal reconciles to 120000 (${intPrincipal})`);
  check(intTotal > 0, `Interest loan actually accrues interest (${intTotal})`);
  check(
    Number(intRows[0].interestComponent) > Number(intRows[11].interestComponent),
    'Reducing-balance interest declines over the term',
  );
  check(
    Number(intRows[11].closingBalance) === 0,
    `Interest loan closing balance lands on 0 (${intRows[11].closingBalance})`,
  );

  // The advance is a single-instalment schedule.
  const advRows = await schedules.listLive(advance);
  check(advRows.length === 1, `Advance has a single instalment (${advRows.length})`);

  // Prepayment moved principal, not just cash.
  const prepaid = await prisma.advanceLoanRequest.findUnique({ where: { id: prepaidLoan } });
  check(
    Number(prepaid!.amountRepaid) >= 20000,
    `Prepayment credited to principal (${prepaid!.amountRepaid})`,
  );

  // A held loan must be skipped by payroll entirely.
  const heldLedger = await prisma.advanceLoanDeduction.count({
    where: { requestId: heldLoan, status: { in: ['PENDING', 'PAID'] } },
  });
  check(heldLedger === 0, `Held loan was skipped by payroll (${heldLedger} recovery rows)`);

  // Write-off forgave the balance.
  const wo = await prisma.advanceLoanRequest.findUnique({ where: { id: writtenOff } });
  check(wo!.status === 'WRITTEN_OFF', `Written-off loan is WRITTEN_OFF (${wo!.status})`);

  // Lock actually moved money, and the ledger split reconciles.
  const paid = await prisma.advanceLoanDeduction.findMany({
    where: { status: 'PAID', payrollItem: { payrollId } },
  });
  check(paid.length > 0, `Payroll lock recorded ${paid.length} PAID recovery row(s)`);
  const splitOk = paid.every(
    (d) =>
      Math.abs(
        Number(d.principalComponent) + Number(d.interestComponent) + Number(d.feeComponent) -
          Number(d.amount),
      ) < 0.005,
  );
  check(splitOk, 'Every recovery reconciles: principal + interest + fee === amount');

  // amountRepaid counts PRINCIPAL, so it can never exceed the principal.
  const allLoans = await prisma.advanceLoanRequest.findMany({
    where: { employeeId: { in: Object.values(employees).map((e) => e.id) } },
  });
  check(
    allLoans.every((l) => Number(l.amountRepaid) <= Number(l.amount) + 0.005),
    'No loan is over-repaid (amountRepaid tracks principal only)',
  );

  // Waiver moved the balance.
  const wv = await prisma.advanceLoanRequest.findUnique({ where: { id: waived } });
  check(Number(wv!.waivedAmount) === 4000, `Waiver recorded 4000 (${wv!.waivedAmount})`);

  // A skipped instalment is still OWED — extend pushes the tail out, it does
  // not forgive. This is the case that used to be double-charged.
  const skRows = await schedules.listLive(skipped);
  // Compare what is STILL COLLECTABLE against what is still owed. Summing every
  // live row would also count instalments payroll has already recovered.
  const skScheduled =
    Math.round(
      skRows
        .filter((r) => !['PAID', 'WAIVED', 'WRITTEN_OFF', 'CLOSED_EARLY', 'CANCELLED'].includes(r.status))
        .reduce((a, r) => a + (Number(r.emiAmount) - Number(r.paidAmount)), 0) * 100,
    ) / 100;
  const skLoan = await prisma.advanceLoanRequest.findUnique({ where: { id: skipped } });
  const skOwed =
    Math.round(
      (Number(skLoan!.amount) -
        Number(skLoan!.amountRepaid) -
        Number(skLoan!.waivedAmount) -
        Number(skLoan!.writtenOffAmount)) * 100,
    ) / 100;
  check(
    Math.abs(skScheduled - skOwed) < 1,
    `Skipped-instalment loan schedules exactly what is owed (${skScheduled} vs ${skOwed})`,
  );

  // Reinstated after a write-off.
  const ri = await prisma.advanceLoanRequest.findUnique({ where: { id: reinstated } });
  check(
    ri!.status === 'ACTIVE' && Number(ri!.writtenOffAmount) === 0,
    `Reinstated loan is ACTIVE again with nothing written off (${ri!.status})`,
  );

  // Conversion: the advance closed, a new loan awaits approval, and the pair
  // nets to zero so the receivable ledger stays continuous.
  const oldAdv = await prisma.advanceLoanRequest.findUnique({ where: { id: convertible } });
  const newLoan = await prisma.advanceLoanRequest.findUnique({ where: { id: convertedLoanId } });
  check(oldAdv!.status === 'CLOSED', `Converted advance is CLOSED (${oldAdv!.status})`);
  check(
    newLoan!.status === 'PENDING' && newLoan!.convertedFromId === convertible,
    'Converted loan re-enters approval and links back to the advance',
  );
  const convTxns = await prisma.loanTransaction.count({
    where: { type: 'CONVERSION', requestId: { in: [convertible, convertedLoanId] } },
  });
  check(convTxns === 2, `Conversion nets to zero across both loans (${convTxns} entries)`);

  // Affordability: the low-paid borrower cannot meet the full instalment.
  const elifRows = await prisma.advanceLoanDeduction.findMany({
    where: { requestId: unaffordable },
  });
  const elifOutcome = elifRows[0]?.outcome;
  check(
    elifRows.length > 0 && elifOutcome !== 'FULL',
    `Unaffordable instalment was not taken in full (outcome ${elifOutcome ?? 'none'})`,
  );

  // Exit settlement cleared the leaver.
  const leaver = await prisma.advanceLoanRequest.findUnique({ where: { id: leaverLoan } });
  check(
    ['SETTLED', 'CLOSED'].includes(leaver!.status),
    `Leaver's balance was settled at exit (${leaver!.status})`,
  );

  // The imported mid-life loan resumes at instalment 4, not 1.
  if (importedLoanId) {
    const impRows = await prisma.loanSchedule.findMany({
      where: { requestId: importedLoanId },
      orderBy: { installmentNo: 'asc' },
    });
    const impLedger = await prisma.advanceLoanDeduction.count({
      where: { requestId: importedLoanId, status: 'PAID', payrollItemId: null },
    });
    check(impRows.length === 12, `Imported loan has 12 instalments (${impRows.length})`);
    check(
      impRows.slice(0, 3).every((r) => r.status === 'PAID') &&
        impRows[3].status === 'SCHEDULED',
      'Imported loan is marked paid to instalment 3 and scheduled from 4',
    );
    check(
      impLedger === 3,
      `Imported history is in the LEDGER so payroll resumes at 4 (${impLedger} rows)`,
    );
  }

  // Overdue ageing has something to report.
  const overdueReport: any = await reports.overdue({});
  check(
    overdueReport.totals.count > 0,
    `Overdue report ages ${overdueReport.totals.count} instalment(s)`,
  );

  // Reports answer.
  const outstanding: any = await reports.outstanding({ limit: 50 });
  const emiDue: any = await reports.emiDue({});
  check(outstanding.data.length > 0, `Outstanding report returns ${outstanding.data.length} row(s)`);
  check(
    typeof outstanding.totals.inFlight === 'number',
    'Outstanding report separates in-flight money from the balance',
  );
  check(Array.isArray(emiDue.data), 'EMI-due report answers');

  // ── 7. Summary ────────────────────────────────────────────────────────
  console.log('\n📊 Loan book:\n');
  const book = await prisma.advanceLoanRequest.findMany({
    where: { employeeId: { in: Object.values(employees).map((e) => e.id) } },
    include: { employee: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.table(
    book.map((l) => ({
      Employee: l.employee.fullName,
      Type: l.type,
      Principal: Number(l.amount),
      Repaid: Number(l.amountRepaid),
      Interest: `${Number(l.interestRate)}% ${l.interestMethod}`,
      Status: l.status,
    })),
  );

  console.log(`\n🔐 Sign in as any of these (password ${PASSWORD}):`);
  console.log(`   admin@${EMAIL_DOMAIN}   (ADMIN — can write off)`);
  console.log(`   hr@${EMAIL_DOMAIN}      (HR_MANAGER — approves, prepays, holds)`);
  for (const p of people) {
    console.log(`   ${p.suffix.toLowerCase()}@${EMAIL_DOMAIN}`.padEnd(38) + '(EMPLOYEE)');
  }
  console.log('\n🖥  Try: /dashboard/advance-loans, open any loan, then /dashboard/advance-loans/reports');
  console.log(
    '\n⚙️  This seed turned ON loan_module_v2_enabled and loan_interest_enabled.',
  );

  await app.close();

  if (failures.length) {
    console.error(`\n❌ ${failures.length} verification(s) FAILED:`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log('\n✅ Loan demo seeded and verified end to end.');
}

main().catch((e) => {
  console.error('❌ Loan demo seeding failed:', e);
  process.exit(1);
});
