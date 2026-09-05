/**
 * Everything else the Muscat demo needs so no screen opens empty.
 *
 * Sibling to `sample-data.muscat-payroll.ts`, which owns the wage-file story.
 * This one closes the gaps a screen-by-screen sweep of the branch turned up —
 * each entry below exists because an API call a real screen makes returned an
 * empty list for Muscat:
 *
 *   /payrolls (approvals tabs)      every run was LOCKED, so all three tabs read 0
 *   /overtime/pending               every Oman overtime row was already APPROVED
 *   /advance-loans/pending          same, for loans
 *   /advance-loans/reports/emi-due  no schedule row fell in the current cycle
 *   …/interest-earned               no loan carried interest
 *   /advance-loans/settlement/receivable   no loan had survived an exit
 *   /loan-policies (products)       no policy row at all
 *   /employees/without-active-contract     everyone had a contract
 *   /contracts/termination-requests/history  only a pending one existed
 *   /bank-change-requests/migration/candidates  nobody left to migrate
 *   /leave-encashment/carry-forward/runs   never run
 *   /legal-documents/expiring       nothing inside the alert window
 *   /assets/clearance/reports/outstanding  no asset left out by a leaver
 *   /accounting/{accounts,mappings,journal}  the ledger was never set up
 *
 * A DEMO CONSTRAINT runs through all of it: nothing seeded here may block the
 * wage file. Anyone added without bank details is a FUTURE joiner, so they are
 * on no payroll run; the extra payroll runs are older periods in states that are
 * not LOCKED, so the locked run the file comes from is untouched.
 *
 * Idempotent: every row is keyed and re-found, so a re-seed converges.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { companyTzCache } from '../common/timezone/timezone-cache';

export type PrismaLike = PrismaClient;

export interface MuscatCoverageOptions {
  branchCode?: string;
  /** The period the demo treats as "this month". */
  period?: { year: number; month: number };
  say?: (m: string) => void;
  info?: (m: string) => void;
}

const TAG = 'MCT-DEMO';
const dU = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0));
const dec = (n: number) => new Prisma.Decimal(n.toFixed(2));
const n2 = (n: number) => Math.round(n * 100) / 100;
const shift = (p: { year: number; month: number }, by: number) => {
  const d = new Date(Date.UTC(p.year, p.month - 1 + by, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
};
/** The engine's cycle key: one indexed integer per (year, month). */
const cycleKey = (y: number, m: number) => y * 12 + m;

interface Emp {
  id: string;
  employeeCode: string;
  fullName: string;
  baseSalary: Prisma.Decimal | null;
  departmentId: string | null;
  status: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Payroll runs in every approval state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The approvals inbox reads `/payrolls` and splits it by status. Both seeded
 * Muscat runs are LOCKED — correct for the wage file, and empty for every tab
 * on the approvals screen.
 *
 * These are OLDER periods, never the locked one: a demo that finds a
 * PENDING_APPROVAL run for the same month the wage file comes from would be
 * showing two contradictory truths about one payroll.
 */
async function seedApprovalStates(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
  period: { year: number; month: number },
  hrUserId: string | null,
): Promise<number> {
  const batch = await prisma.payrollBatch.findFirst({
    where: { branchId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const payable = emps.filter((e) => e.status === 'ACTIVE' && Number(e.baseSalary ?? 0) > 0);
  if (!payable.length) return 0;

  const states = [
    { back: 2, status: 'PENDING_APPROVAL', factor: 0.98 },
    { back: 3, status: 'APPROVED', factor: 0.96 },
    { back: 4, status: 'REJECTED', factor: 0.94 },
  ];

  let created = 0;
  for (const s of states) {
    const p = shift(period, -s.back);
    const exists = await prisma.payroll.findFirst({
      where: { branchId, month: p.month, year: p.year },
      select: { id: true },
    });
    if (exists) continue;

    const decided = lastDay(p.year, p.month);
    const run = await prisma.payroll.create({
      data: {
        month: p.month,
        year: p.year,
        branchId,
        batchId: batch?.id ?? null,
        status: s.status as never,
        totalAmount: 0,
        submittedAt: decided,
        submittedBy: hrUserId,
        approvedAt: s.status === 'APPROVED' ? decided : null,
        approvedBy: s.status === 'APPROVED' ? hrUserId : null,
        rejectionReason:
          s.status === 'REJECTED'
            ? 'Overtime for the depot crew was claimed twice — rerun after the correction.'
            : null,
        notes: `${TAG} — demo run in ${s.status} state.`,
      },
    });

    let total = 0;
    for (const e of payable) {
      const gross = Number(e.baseSalary ?? 0) * s.factor;
      const base = n2(gross * 0.6);
      const allowances = n2(gross * 0.4);
      const insurance = n2(base * 0.07);
      const net = n2(base + allowances - insurance);
      total += net;
      await prisma.payrollItem.create({
        data: {
          payrollId: run.id,
          employeeId: e.id,
          baseSalary: dec(base),
          allowances: dec(allowances),
          insurance: dec(insurance),
          workDays: 22,
          actualWorkDays: new Prisma.Decimal(22),
          netSalary: dec(net),
          notes: `${TAG} demo payslip.`,
        },
      });
    }
    await prisma.payroll.update({ where: { id: run.id }, data: { totalAmount: dec(total) } });
    created += 1;
  }
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pending overtime
// ─────────────────────────────────────────────────────────────────────────────

async function seedPendingOvertime(
  prisma: PrismaLike,
  emps: Emp[],
  period: { year: number; month: number },
): Promise<number> {
  const targets = emps.filter((e) => e.status === 'ACTIVE').slice(0, 2);
  let created = 0;
  for (const [i, e] of targets.entries()) {
    // Oman rests Friday/Saturday; the 9th and 16th of a month are never both a
    // weekend, and an overtime row on a rest day reads as a different feature.
    const day = dU(period.year, period.month, 9 + i * 7);
    const exists = await prisma.overtimeRequest.findFirst({
      where: { employeeId: e.id, date: day, status: 'PENDING' },
    });
    if (exists) continue;
    await prisma.overtimeRequest.create({
      data: {
        employeeId: e.id,
        date: day,
        startTime: new Date(Date.UTC(period.year, period.month - 1, 9 + i * 7, 13, 0)),
        endTime: new Date(Date.UTC(period.year, period.month - 1, 9 + i * 7, 16, 0)),
        hours: new Prisma.Decimal(3),
        otType: i === 0 ? 'REGULAR' : 'LATE',
        reason: 'Month-end stock count at the Muscat depot.',
        status: 'PENDING',
      },
    });
    created += 1;
  }
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Loans: a policy, a pending request, an interest-bearing loan, a receivable
// ─────────────────────────────────────────────────────────────────────────────

async function seedLoans(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
  period: { year: number; month: number },
  actorId: string | null,
): Promise<{ policy: number; requests: number; schedules: number; transactions: number }> {
  const out = { policy: 0, requests: 0, schedules: 0, transactions: 0 };

  // The affordability rules the loan engine reads. Without a row the products
  // screen is blank and every check falls back to a global default.
  const existingPolicy = await prisma.loanPolicy.findFirst({ where: { branchId } });
  if (!existingPolicy) {
    await prisma.loanPolicy.create({
      data: {
        branchId,
        isActive: true,
        minNetPayAmount: dec(150),
        minNetPayPercent: dec(40),
        maxTotalDeductionPercentOfNet: dec(50),
        shortfallPolicy: 'PARTIAL',
        deferralMode: 'CARRY_FORWARD',
        unpaidLeavePolicy: 'PAUSE',
        gracePeriodCycles: 1,
        maxActivePerEmployee: 2,
        minServiceMonths: 6,
        maxAmountMultipleOfSalary: dec(6),
        interestDefaultMethod: 'REDUCING_BALANCE',
        roundingTolerance: dec(1),
      },
    });
    out.policy = 1;
  }

  const active = emps.filter((e) => e.status === 'ACTIVE');
  const leaver = emps.find((e) => e.status !== 'ACTIVE');
  const loanType = await prisma.loanType.findFirst({ where: { isActive: true } });

  // (a) One request waiting on a decision, so the approvals tab is not empty.
  const applicant = active[0];
  if (applicant) {
    const ref = `${TAG}-LN-PENDING`;
    const exists = await prisma.advanceLoanRequest.findFirst({ where: { referenceNo: ref } });
    if (!exists) {
      await prisma.advanceLoanRequest.create({
        data: {
          employeeId: applicant.id,
          type: 'LOAN',
          amount: dec(1200),
          reason: 'Home repair after the spring storms.',
          status: 'PENDING',
          installments: 12,
          installmentAmount: dec(100),
          referenceNo: ref,
          currency: 'OMR',
          employeeCodeSnapshot: applicant.employeeCode,
          employeeNameSnapshot: applicant.fullName,
          loanTypeId: loanType?.id ?? null,
          interestMethod: 'NONE',
          effectiveDate: dU(period.year, period.month, 1),
        },
      });
      out.requests += 1;
    }
  }

  // (b) A disbursed loan that CARRIES INTEREST, with part of its schedule already
  //     recovered. Three reports read this one loan: EMI due (the row falling in
  //     the current cycle), interest earned (the PAID deductions' interest
  //     component) and the employee statement (the transactions).
  const borrower = active[1] ?? active[0];
  if (borrower) {
    const ref = `${TAG}-LN-ACTIVE`;
    let loan = await prisma.advanceLoanRequest.findFirst({ where: { referenceNo: ref } });
    if (!loan) {
      const principal = 2400;
      const months = 12;
      const rate = 6; // % per annum, flat — the arithmetic below matches FLAT.
      const interestTotal = n2((principal * rate) / 100);
      const principalPart = n2(principal / months);
      const interestPart = n2(interestTotal / months);
      const emi = n2(principalPart + interestPart);
      const start = shift(period, -3);

      loan = await prisma.advanceLoanRequest.create({
        data: {
          employeeId: borrower.id,
          type: 'LOAN',
          amount: dec(principal),
          reason: 'Vehicle purchase.',
          status: 'ACTIVE',
          installments: months,
          installmentAmount: dec(emi),
          amountRepaid: dec(principalPart * 3),
          approverId: actorId,
          approvedAt: dU(start.year, start.month, 2),
          referenceNo: ref,
          currency: 'OMR',
          employeeCodeSnapshot: borrower.employeeCode,
          employeeNameSnapshot: borrower.fullName,
          loanTypeId: loanType?.id ?? null,
          interestMethod: 'FLAT',
          interestRate: new Prisma.Decimal(rate),
          effectiveDate: dU(start.year, start.month, 1),
          disbursementDate: dU(start.year, start.month, 2),
          disbursedAmount: dec(principal),
          firstDeductionDate: lastDay(start.year, start.month),
          priority: 100,
        },
      });
      out.requests += 1;

      let opening = principal;
      for (let i = 1; i <= months; i++) {
        const due = shift(start, i - 1);
        const closing = n2(Math.max(0, opening - principalPart));
        // Everything before this cycle is settled; the current cycle is what the
        // EMI-due report exists to list.
        const dueKey = cycleKey(due.year, due.month);
        const nowKey = cycleKey(period.year, period.month);
        const settled = dueKey < nowKey;
        // The MOST RECENT past instalment is left half-paid. Arrears is its own
        // screen, and a loan book where every past row settled in full ages
        // nothing into it.
        const arrears = dueKey === nowKey - 1;
        const schedule = await prisma.loanSchedule.create({
          data: {
            requestId: loan.id,
            version: 1,
            installmentNo: i,
            dueDate: lastDay(due.year, due.month),
            dueCycleKey: cycleKey(due.year, due.month),
            dueMonth: due.month,
            dueYear: due.year,
            openingBalance: dec(opening),
            principalComponent: dec(principalPart),
            interestComponent: dec(interestPart),
            feeComponent: dec(0),
            emiAmount: dec(emi),
            closingBalance: dec(closing),
            status: settled ? (arrears ? 'PARTIAL' : 'PAID') : 'SCHEDULED',
            paidAmount: settled ? dec(arrears ? n2(emi / 2) : emi) : dec(0),
            paidPrincipal: settled ? dec(arrears ? n2(principalPart / 2) : principalPart) : dec(0),
            paidInterest: settled ? dec(arrears ? n2(interestPart / 2) : interestPart) : dec(0),
            carryForwardAmount: settled && arrears ? dec(n2(emi / 2)) : dec(0),
            settledAt: settled && !arrears ? lastDay(due.year, due.month) : null,
          },
        });
        out.schedules += 1;

        if (settled) {
          // The repayment LEDGER row. `interest-earned` sums this, not the
          // schedule — a plan is not money that moved.
          // A DB CHECK asserts principal + interest + fee = amount, so a partial
          // recovery has to be split, not scaled after the fact.
          const paidPrincipal = arrears ? n2(principalPart / 2) : principalPart;
          const paidInterest = arrears ? n2(interestPart / 2) : interestPart;
          await prisma.advanceLoanDeduction.create({
            data: {
              requestId: loan.id,
              scheduleId: schedule.id,
              amount: dec(n2(paidPrincipal + paidInterest)),
              principalComponent: dec(paidPrincipal),
              interestComponent: dec(paidInterest),
              feeComponent: dec(0),
              plannedAmount: dec(emi),
              shortfallAmount: dec(arrears ? n2(emi - paidPrincipal - paidInterest) : 0),
              month: due.month,
              year: due.year,
              status: 'PAID',
            },
          });
          await prisma.loanTransaction.create({
            data: {
              requestId: loan.id,
              type: 'EMI_RECOVERY',
              status: 'POSTED',
              transactionDate: lastDay(due.year, due.month),
              amount: dec(n2(paidPrincipal + paidInterest)),
              principalComponent: dec(paidPrincipal),
              interestComponent: dec(paidInterest),
              balanceAfter: dec(arrears ? n2(closing + principalPart / 2) : closing),
              narration: `Installment ${i} of ${months} recovered through payroll.`,
              sourceType: 'PAYROLL',
            },
          });
          out.transactions += 1;
        }
        opening = closing;
      }

      await prisma.loanTransaction.create({
        data: {
          requestId: loan.id,
          type: 'DISBURSEMENT',
          status: 'POSTED',
          transactionDate: dU(start.year, start.month, 2),
          amount: dec(principal),
          principalComponent: dec(principal),
          balanceAfter: dec(principal),
          narration: 'Loan disbursed to the employee account.',
          sourceType: 'BANK',
        },
      });
      out.transactions += 1;
    }
  }

  // (c) A debt that outlived the employment. RECEIVABLE is a decision — the
  //     money is still owed and nobody wrote it off — and it is the only thing
  //     the exit-receivables screen lists.
  if (leaver) {
    const ref = `${TAG}-LN-RECEIVABLE`;
    const exists = await prisma.advanceLoanRequest.findFirst({ where: { referenceNo: ref } });
    if (!exists) {
      await prisma.advanceLoanRequest.create({
        data: {
          employeeId: leaver.id,
          type: 'ADVANCE',
          amount: dec(600),
          reason: 'Salary advance taken before the exit.',
          status: 'RECEIVABLE',
          installments: 6,
          installmentAmount: dec(100),
          amountRepaid: dec(200),
          referenceNo: ref,
          currency: 'OMR',
          employeeCodeSnapshot: leaver.employeeCode,
          employeeNameSnapshot: leaver.fullName,
          interestMethod: 'NONE',
          effectiveDate: shiftDate(period, -6),
        },
      });
      out.requests += 1;
    }
  }
  return out;
}

const shiftDate = (p: { year: number; month: number }, by: number) => {
  const s = shift(p, by);
  return dU(s.year, s.month, 1);
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. A future joiner: no contract yet, legacy bank data only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One person who has been hired but has not started.
 *
 * Deliberately covers TWO empty screens at once, and can only be the same
 * person: the Bank Master migration queue lists employees who still have
 * free-text bank details and no versioned record, and the onboarding list wants
 * someone without an active contract. Both states are BLOCKING wage-file
 * findings for anyone on a payroll run — so the person carrying them is a
 * future joiner, who is on none.
 */
async function seedFutureJoiner(
  prisma: PrismaLike,
  branchId: string,
  departmentId: string | null,
  period: { year: number; month: number },
): Promise<number> {
  const email = 'noor.al-lawati@sample.hrms.local';
  // `departmentId` is NOT NULL on Employee — nobody is hired into no department.
  if (!departmentId) return 0;

  const start = dU(period.year, period.month + 1, 5);
  // The employee survives a reset but their PROFILE does not — `resetSampleChildren`
  // clears profiles for every sample employee. The legacy bank fields live on the
  // profile, so re-creating the person alone would leave the migration queue
  // empty on every re-seed. Both halves are written every time.
  const existing = await prisma.employee.findUnique({ where: { email } });
  const employee = existing ?? (await prisma.employee.create({
    data: {
      employeeCode: 'SMP-EMP-025',
      fullName: 'Noor Al-Lawati',
      email,
      idCard: 'SMP-ID-025',
      dateOfBirth: dU(1996, 3, 18),
      gender: 'FEMALE',
      phone: '+968-9250-0000',
      position: 'Operations Associate',
      departmentId,
      branchId,
      startDate: start,
      baseSalary: dec(720),
      status: 'ACTIVE',
      hasCompleteProfile: false,
    },
  }));

  // Free-text bank data ONLY — no EmployeeBankDetail. That combination is
  // precisely what the migration screen looks for.
  const profile = {
    bankName: 'Bank Muscat',
    bankAccountNumber: '0180001234567',
    bankAccountHolderName: 'Noor Al-Lawati',
    bankBranch: 'Al Khuwair Branch',
    nationality: 'Omani',
    permanentAddress: 'Al Khuwair, Muscat, Sultanate of Oman',
    profileCompletionPercentage: 45,
  };
  await prisma.employeeProfile.upsert({
    where: { employeeId: employee.id },
    update: profile,
    create: { employeeId: employee.id, ...profile },
  });
  return existing ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. A decided termination, so the history tab is not empty
// ─────────────────────────────────────────────────────────────────────────────

async function seedTerminationHistory(
  prisma: PrismaLike,
  emps: Emp[],
  period: { year: number; month: number },
  actorId: string | null,
): Promise<number> {
  const leaver = emps.find((e) => e.status !== 'ACTIVE');
  // `requestedBy` is NOT NULL — a termination nobody raised is not a record.
  if (!leaver || !actorId) return 0;
  const contract = await prisma.contract.findFirst({
    where: { employeeId: leaver.id },
    orderBy: { startDate: 'desc' },
  });
  if (!contract) return 0;

  const exists = await prisma.terminationRequest.findFirst({
    where: { contractId: contract.id, status: { not: 'PENDING' } },
  });
  if (exists) return 0;

  const decidedOn = shiftDate(period, -1);
  await prisma.terminationRequest.create({
    data: {
      contractId: contract.id,
      reason: `${TAG} — resignation accepted; notice served in full.`,
      requestedBy: actorId,
      terminationCategory: 'RESIGNATION',
      noticeDate: shiftDate(period, -2),
      terminationDate: decidedOn,
      status: 'APPROVED',
      approverId: actorId,
      approvedAt: decidedOn,
      approverComments: 'Cleared by HR; final settlement raised.',
    },
  });
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. A completed leave carry-forward
// ─────────────────────────────────────────────────────────────────────────────

async function seedCarryForwardRun(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
  year: number,
  actorId: string | null,
): Promise<number> {
  const fromYear = year - 1;
  const exists = await prisma.leaveCarryForwardRun.findUnique({
    where: { branchId_fromYear_toYear: { branchId, fromYear, toYear: year } },
  });
  if (exists) return 0;

  const active = emps.filter((e) => e.status === 'ACTIVE');
  const daysCarried = active.length * 4;
  await prisma.leaveCarryForwardRun.create({
    data: {
      branchId,
      fromYear,
      toYear: year,
      leaveTypeKeys: ['Annual Leave'],
      employeeCount: active.length,
      daysCarried: new Prisma.Decimal(daysCarried),
      daysLapsed: new Prisma.Decimal(active.length * 2),
      status: 'APPLIED',
      // The working is the whole point of the record: a balance rewritten for
      // every employee has to be explainable a year later.
      workingJson: {
        policy: { leaveTypeKey: 'Annual Leave', maxDays: 10, expiryMonths: 6 },
        employees: active.map((e) => ({
          employeeCode: e.employeeCode,
          carried: 4,
          lapsed: 2,
        })),
      },
      executedBy: actorId ?? undefined,
      executedAt: dU(year, 1, 2),
    },
  });
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. A document inside the expiry alert window
// ─────────────────────────────────────────────────────────────────────────────

async function seedExpiringDocument(prisma: PrismaLike, emps: Emp[]): Promise<number> {
  const target = emps.find((e) => e.status === 'ACTIVE');
  if (!target) return 0;
  let created = 0;

  // The renewal queue reads VISA and only VISA (`getExpiring(days, 'VISA')`), so
  // a work permit inside the window does not reach it. One Muscat visa is pulled
  // into the alert window instead of a second record being invented — the
  // partial unique index allows exactly one current visa per employee.
  const soonMs = Date.now() + 18 * 24 * 60 * 60 * 1000;
  const visa = await prisma.employeeLegalDocument.findFirst({
    where: {
      employeeId: target.id,
      category: 'VISA',
      isCurrent: true,
      status: 'ACTIVE',
      expiryDate: { gt: new Date(soonMs) },
    },
  });
  if (visa) {
    await prisma.employeeLegalDocument.update({
      where: { id: visa.id },
      data: { expiryDate: new Date(soonMs) },
    });
    created += 1;
  }
  const number = `OMP${target.employeeCode.replace(/\D/g, '').slice(-3)}EXP`;
  const exists = await prisma.employeeLegalDocument.findFirst({
    where: { documentNumber: number },
  });
  if (exists) return created;

  const soon = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
  await prisma.employeeLegalDocument.create({
    data: {
      employeeId: target.id,
      category: 'WORK_PERMIT',
      documentNumber: number,
      documentType: 'Work Permit',
      country: 'Oman',
      nationality: 'OM',
      issueDate: dU(soon.getUTCFullYear() - 2, 1, 10),
      // Inside the alert window on purpose: the renewal queue is a screen, and
      // a queue with nothing in it teaches nobody how the renewal works.
      expiryDate: soon,
      issuingAuthority: 'Ministry of Labour',
      placeOfIssue: 'Muscat',
      status: 'ACTIVE',
      isCurrent: true,
      remarks: TAG,
    },
  });
  return created + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. An asset still out with someone who left
// ─────────────────────────────────────────────────────────────────────────────

async function seedOutstandingClearance(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
  period: { year: number; month: number },
  actorId: string | null,
): Promise<number> {
  const leaver = emps.find((e) => e.status !== 'ACTIVE');
  // `assignedById` is NOT NULL — custody always has a person who handed it over.
  if (!leaver || !actorId) return 0;

  const held = await prisma.assetAssignment.findFirst({
    where: { employeeId: leaver.id, returnedAt: null },
  });
  if (held) return 0;

  const asset = await prisma.assetItem.findFirst({
    where: { branchId, assignments: { none: { returnedAt: null } } },
  });
  if (!asset) return 0;

  await prisma.assetAssignment.create({
    data: {
      assetId: asset.id,
      employeeId: leaver.id,
      assignedAt: shiftDate(period, -8),
      assignedById: actorId,
      notes: `${TAG} — never returned at exit; blocks clearance.`,
    },
  });
  await prisma.assetItem.update({ where: { id: asset.id }, data: { status: 'ASSIGNED' } });
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. The ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A minimal but real chart of accounts, the loan-event mappings that use it, and
 * a posted entry per loan transaction.
 *
 * Accounts are company-wide (`branchId: null`) because a chart of accounts that
 * differs per branch is a different product decision; the mappings and entries
 * are branch-stamped so the Muscat view is not empty.
 */
async function seedLedger(
  prisma: PrismaLike,
  branchId: string,
  actorId: string | null,
): Promise<{ accounts: number; mappings: number; entries: number }> {
  const ACCOUNTS = [
    { code: '1010', name: 'Bank — current account', type: 'ASSET' },
    { code: '1310', name: 'Employee loans receivable', type: 'ASSET' },
    { code: '2100', name: 'Payroll payable', type: 'LIABILITY' },
    { code: '4100', name: 'Interest income — employee loans', type: 'INCOME' },
    { code: '5100', name: 'Salaries and wages', type: 'EXPENSE' },
  ];
  const byCode = new Map<string, string>();
  let accounts = 0;
  for (const a of ACCOUNTS) {
    const row = await prisma.ledgerAccount.upsert({
      where: { code: a.code },
      update: { name: a.name, type: a.type, isActive: true },
      create: { code: a.code, name: a.name, type: a.type, isActive: true },
    });
    byCode.set(a.code, row.id);
    accounts += 1;
  }

  // What each loan event posts to. An unmapped event is refused rather than
  // guessed, so the demo needs these before anything can post.
  const MAPPINGS = [
    { event: 'DISBURSEMENT', component: 'TOTAL', debit: '1310', credit: '1010' },
    { event: 'EMI_RECOVERY', component: 'PRINCIPAL', debit: '2100', credit: '1310' },
    { event: 'EMI_RECOVERY', component: 'INTEREST', debit: '2100', credit: '4100' },
    { event: 'WRITE_OFF', component: 'TOTAL', debit: '5100', credit: '1310' },
  ];
  let mappings = 0;
  for (const m of MAPPINGS) {
    const exists = await prisma.ledgerMapping.findFirst({
      where: { event: m.event, component: m.component, branchId },
    });
    if (exists) continue;
    await prisma.ledgerMapping.create({
      data: {
        event: m.event,
        component: m.component,
        branchId,
        debitAccountId: byCode.get(m.debit)!,
        creditAccountId: byCode.get(m.credit)!,
        isActive: true,
      },
    });
    mappings += 1;
  }

  // One entry per loan transaction that has not been posted yet. `journalRef` on
  // the transaction is what makes this replayable — a second run finds the ref
  // and skips.
  const txns = await prisma.loanTransaction.findMany({
    where: {
      journalRef: null,
      status: 'POSTED',
      request: { employee: { branchId } },
    },
    orderBy: { transactionDate: 'asc' },
    take: 40,
  });

  let entries = 0;
  for (const t of txns) {
    const mapEvent = t.type === 'DISBURSEMENT' ? 'DISBURSEMENT' : 'EMI_RECOVERY';
    const reference = `JE-${t.transactionDate.toISOString().slice(0, 10).replace(/-/g, '')}-${t.id.slice(0, 6)}`;
    const lines: Prisma.JournalLineCreateWithoutEntryInput[] = [];

    const push = (component: string, amount: number) => {
      if (amount <= 0) return;
      const m = MAPPINGS.find(
        (x) => x.event === mapEvent && x.component === (mapEvent === 'DISBURSEMENT' ? 'TOTAL' : component),
      );
      if (!m) return;
      lines.push({
        debitAccount: { connect: { id: byCode.get(m.debit)! } },
        creditAccount: { connect: { id: byCode.get(m.credit)! } },
        amount: dec(amount),
        component: mapEvent === 'DISBURSEMENT' ? 'TOTAL' : component,
        narration: t.narration,
      });
    };

    if (mapEvent === 'DISBURSEMENT') {
      push('TOTAL', Number(t.amount));
    } else {
      push('PRINCIPAL', Number(t.principalComponent));
      push('INTEREST', Number(t.interestComponent));
    }
    if (!lines.length) continue;

    const entry = await prisma.journalEntry.create({
      data: {
        reference,
        entryDate: t.transactionDate,
        narration: t.narration,
        sourceType: 'LOAN_TRANSACTION',
        sourceId: t.id,
        branchId,
        status: 'POSTED',
        postedById: actorId ?? undefined,
        lines: { create: lines },
      },
    });
    await prisma.loanTransaction.update({
      where: { id: t.id },
      data: { journalRef: entry.reference },
    });
    entries += 1;
  }
  return { accounts, mappings, entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. The payroll extension switches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every payroll extension defaults to OFF, and a screen behind an off switch
 * answers 404 — "Payroll reports are not enabled" — which reads as a broken
 * demo rather than a disabled feature. The demo dataset turns them on, since it
 * exists to show the whole product.
 */
const DEMO_FLAGS = [
  'payroll_item_lines_enabled',
  'payroll_eosb_enabled',
  'payroll_eosb_settlement_enabled',
  'payroll_eosb_accrual_enabled',
  'payroll_calendar_enabled',
  'payroll_preflight_enabled',
  'payroll_employee_recovery_enabled',
  'payroll_reports_enabled',
  'leave_encashment_enabled',
  'employee_transfer_enabled',
  'employee_grade_enabled',
];

/**
 * The demo is an Oman company, and every instant in the UI is rendered in
 * `system_timezone` — leaving it at the `Asia/Kolkata` default made the Muscat
 * branch's 08:00 check-ins read as 09:30 on the attendance list. Pinned here
 * rather than in the shared seed because this is the Oman-specific pass.
 *
 * `companyTzCache` holds the resolved zone for 60 s, so the running process is
 * told to re-read rather than serving the old zone until the TTL lapses.
 */
const DEMO_TIMEZONE = 'Asia/Muscat';

async function setDemoTimezone(prisma: PrismaLike): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: 'system_timezone' },
    update: { value: DEMO_TIMEZONE },
    create: { key: 'system_timezone', value: DEMO_TIMEZONE },
  });
  companyTzCache.invalidate();
}

async function enableDemoFeatures(prisma: PrismaLike): Promise<number> {
  let flipped = 0;
  for (const key of DEMO_FLAGS) {
    const existing = await prisma.systemSetting.findUnique({ where: { key } });
    if (existing?.value === 'true') continue;
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value: 'true' },
      create: { key, value: 'true' },
    });
    flipped += 1;
  }
  return flipped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function seedMuscatCoverage(
  prisma: PrismaLike,
  opts: MuscatCoverageOptions = {},
): Promise<Record<string, number>> {
  const branchCode = opts.branchCode ?? 'SMP-MCT';
  const now = new Date();
  const period = opts.period ?? { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const say = opts.say ?? (() => {});
  const info = opts.info ?? (() => {});

  const branch = await prisma.branch.findUnique({ where: { code: branchCode } });
  if (!branch) {
    info(`Muscat coverage skipped — branch ${branchCode} does not exist.`);
    return {};
  }

  say('Filling the remaining Muscat screens (approvals, loans, ledger, onboarding)…');

  const emps: Emp[] = await prisma.employee.findMany({
    where: { branchId: branch.id },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      baseSalary: true,
      departmentId: true,
      status: true,
    },
    orderBy: { employeeCode: 'asc' },
  });
  if (!emps.length) {
    info(`Muscat coverage skipped — no employees in ${branchCode}.`);
    return {};
  }

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' as never },
    select: { id: true },
  });
  const actorId = admin?.id ?? null;

  await setDemoTimezone(prisma);
  const flags = await enableDemoFeatures(prisma);
  const approvalRuns = await seedApprovalStates(prisma, branch.id, emps, period, actorId);
  const overtime = await seedPendingOvertime(prisma, emps, period);
  const loans = await seedLoans(prisma, branch.id, emps, period, actorId);
  const joiner = await seedFutureJoiner(
    prisma,
    branch.id,
    emps.find((e) => e.departmentId)?.departmentId ?? null,
    period,
  );
  const termination = await seedTerminationHistory(prisma, emps, period, actorId);
  const carryForward = await seedCarryForwardRun(prisma, branch.id, emps, period.year, actorId);
  const expiringDoc = await seedExpiringDocument(prisma, emps);
  const clearance = await seedOutstandingClearance(prisma, branch.id, emps, period, actorId);
  const ledger = await seedLedger(prisma, branch.id, actorId);

  info(
    `Muscat coverage: ${approvalRuns} approval-state run(s), ${overtime} pending overtime, ` +
      `${loans.requests} loan(s) with ${loans.schedules} schedule row(s), ${joiner} future joiner, ` +
      `${termination} decided termination, ${carryForward} carry-forward run, ${expiringDoc} expiring doc, ` +
      `${clearance} outstanding asset, ${ledger.entries} journal entrie(s), ${flags} feature switch(es) enabled.`,
  );

  return {
    muscatApprovalRuns: approvalRuns,
    muscatPendingOvertime: overtime,
    muscatLoanPolicies: loans.policy,
    muscatLoans: loans.requests,
    muscatLoanSchedules: loans.schedules,
    muscatLoanTransactions: loans.transactions,
    muscatFutureJoiner: joiner,
    muscatTerminationHistory: termination,
    muscatCarryForwardRuns: carryForward,
    muscatExpiringDocs: expiringDoc,
    muscatOutstandingAssets: clearance,
    muscatLedgerAccounts: ledger.accounts,
    muscatLedgerMappings: ledger.mappings,
    muscatJournalEntries: ledger.entries,
    muscatFeatureFlags: flags,
  };
}
