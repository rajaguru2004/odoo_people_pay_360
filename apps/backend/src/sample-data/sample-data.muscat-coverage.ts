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
 * The demo is an Oman company, and every instant in the UI is rendered in
 * `system_timezone` — leaving it at the `Asia/Kolkata` default made the Muscat
 * branch's 08:00 check-ins read as 09:30 on the attendance list. Pinned here
 * rather than in the shared seed because this is the Oman-specific pass.
 *
 * `companyTzCache` holds the resolved zone for 60 s, so the running process is
 * told to re-read rather than serving the old zone until the TTL lapses.
 */
/** Feature switches the demo turns on so its screens are not empty. */
const DEMO_FLAGS = ['payroll_item_lines_enabled'];

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

  info(
    `Muscat coverage: ${approvalRuns} approval-state run(s), ${overtime} pending overtime, ` +
      `${joiner} future joiner, ${termination} decided termination, ` +
      `${carryForward} carry-forward run, ${expiringDoc} expiring doc, ` +
      `${clearance} outstanding asset, ${flags} feature switch(es) enabled.`,
  );

  return {
    muscatApprovalRuns: approvalRuns,
    muscatPendingOvertime: overtime,
    muscatFutureJoiner: joiner,
    muscatTerminationHistory: termination,
    muscatCarryForwardRuns: carryForward,
    muscatExpiringDocs: expiringDoc,
    muscatOutstandingAssets: clearance,
    muscatFeatureFlags: flags,
  };
}
