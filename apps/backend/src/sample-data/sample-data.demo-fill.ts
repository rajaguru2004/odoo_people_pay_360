import type { PrismaClient } from '@prisma/client';
import type { ExtrasContext } from './sample-data.extras';
import { NO_BRANCH_EMPLOYEE_INDEX } from './sample-data.constants';

/**
 * The gaps the core sample seed leaves on the module hubs.
 *
 * Everything here exists for one reason: after a full sample seed, several hub
 * cards still read zero, and a demo of a dashboard with nothing on it is a demo
 * of nothing. Each block below fills exactly one such hole, and only where the
 * missing rows could not fall out of the ordinary seed:
 *
 *  - Payroll wrote DRAFT runs only, and every payroll report reads LOCKED runs
 *    exclusively — so net pay, the variance waterfall and cost-by-department
 *    were all blank on a database with 54 payroll items in it.
 *  - Gratuity, settlements and WPS files were never seeded at all.
 *  - Loans existed with no amortisation schedule, so nothing was ever due or
 *    overdue.
 *  - Nobody joined this month and no contract expired inside 30 days, so the
 *    People hub's two lead cards were zero by construction.
 *  - No shift ever landed on a holiday or a weekly off, so the roster-conflict
 *    card had nothing to find.
 *
 * Written to be re-runnable: every row it creates is deleted by
 * `resetSampleChildren`, which runs at the top of the seed.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Identifies the audit rows this file owns, so a re-run can replace them. */
export const DEMO_AUDIT_MARKER = 'sample-demo-fill';

/**
 * Prefix on every change request and termination request this file writes.
 *
 * `resetSampleChildren` only runs at the top of the FULL sample seed. The
 * standalone `prisma:seed:demo-fill` runner tops up an existing database
 * without it, so anything this file creates has to be able to delete its own
 * previous copy — otherwise a second run doubles the queue and a third trebles
 * it, which is exactly what happened the first time this was run twice.
 */
export const DEMO_ROW_MARKER = 'Demo: ';
const dU = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

/** `n` whole months before the given period. */
function monthsBack(period: { year: number; month: number }, n: number) {
  const d = new Date(Date.UTC(period.year, period.month - 1 - n, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export async function seedDemoFill(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, branchIds, hrUserId, months, say, info } = ctx;
  if (!employees.length) return;

  const cur = months[months.length - 1];
  const prev = months.length > 1 ? months[0] : monthsBack(cur, 1);

  say('Filling the module dashboards (locked payroll, gratuity, WPS, loan schedules)…');

  await lockPayrolls(prisma, cur, prev, hrUserId, info);
  await seedOpenPayroll(prisma, ctx, cur, hrUserId, info);
  await seedGratuityAndSettlements(prisma, ctx, cur, info);
  // PREVIOUS month, not the current one. The row stands for a file already sent
  // to the bank, and a wage file on a run is exclusive — `generate` refuses with
  // "a wage file for this payroll already exists (version 1, SUBMITTED)". Filing
  // it against the current month would leave the demo unable to produce the one
  // thing the screen exists for.
  await seedWpsFile(prisma, ctx, prev, info);
  await seedLoanSchedules(prisma, ctx, cur, info);
  await seedPeopleLifecycle(prisma, ctx, info);
  await seedRosterConflicts(prisma, ctx, info);
  await seedTalentAndAudit(prisma, ctx, info);
  await seedWorkplaceFill(prisma, ctx, info);
  await seedOrgGovernance(prisma, ctx, info);
  await seedWorkforceHistory(prisma, ctx, info);
}

/* ── Organization hub ────────────────────────────────────────────────────── */

/**
 * The governance gaps the Organization hub exists to surface.
 *
 * The sample seed builds a tidy company: every department headed, every branch
 * managed, every employee placed, and a change-request queue that is either
 * empty or entirely PENDING. That is a demo of a dashboard with nothing on it.
 *
 * Each row below plants exactly one gap the hub is built to find, and nothing
 * else. They are deliberately small — one headless department, one unmanaged
 * branch — because the point is to prove the card fires, not to make the demo
 * company look broken.
 */
async function seedOrgGovernance(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  info: (m: string) => void,
): Promise<void> {
  const { employees, deptIds, branchIds, hrUserId } = ctx;

  // One department loses its head. Picked from the END of the list so the
  // primary demo departments keep theirs.
  const headlessDeptId = deptIds[deptIds.length - 1];
  if (headlessDeptId) {
    await prisma.department.update({
      where: { id: headlessDeptId },
      data: { managerId: null },
    });
  }

  // One branch loses its manager, and one employee loses their branch. Both are
  // states the schema allows and nothing else sweeps for.
  const unmanagedBranchId = branchIds[branchIds.length - 1];
  if (unmanagedBranchId) {
    await prisma.branch.update({
      where: { id: unmanagedBranchId },
      data: { managerId: null },
    });
  }
  // A NAMED index, not an offset from the end: the last few are leavers and
  // joiners (an INACTIVE employee is excluded from the no-branch count, so the
  // card this row exists to light up would read zero), and the tail of the
  // roster is Muscat — whose per-branch payroll would then carry someone with
  // no branch and refuse to produce a wage file. See NO_BRANCH_EMPLOYEE_INDEX.
  const stray = employees.find((e) => e.index === NO_BRANCH_EMPLOYEE_INDEX);
  if (stray) {
    await prisma.employee.update({ where: { id: stray.id }, data: { branchId: null } });
  }

  // One termination awaiting a decision. Nothing else seeds a TerminationRequest,
  // so the People hub's pending-actions card and its Notice slice both read zero
  // without this — and "Notice" is one of the four buckets the donut claims to
  // draw.
  await prisma.terminationRequest.deleteMany({
    where: { reason: { startsWith: DEMO_ROW_MARKER } },
  });
  const openTerminationTarget = await prisma.contract.findFirst({
    where: {
      status: 'ACTIVE',
      employee: { email: { endsWith: '@sample.hrms.local' }, status: 'ACTIVE' },
      terminationRequests: { none: {} },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (openTerminationTarget) {
    await prisma.terminationRequest.create({
      data: {
        contractId: openTerminationTarget.id,
        requestedBy: hrUserId,
        terminationCategory: 'RESIGNATION',
        noticeDate: new Date(),
        terminationDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        reason: 'Demo: resignation awaiting approval',
        status: 'PENDING_APPROVAL',
      },
    });
  }

  // A change-request queue with something in every bucket, so the donut is more
  // than one solid arc. Only PENDING exists after the ordinary seed.
  const targetDeptId = deptIds[0];
  const reviewer = hrUserId;
  // Clear this file's own previous rows first — see DEMO_ROW_MARKER.
  await prisma.departmentChangeRequest.deleteMany({
    where: { reason: { startsWith: DEMO_ROW_MARKER } },
  });
  if (targetDeptId && employees.length) {
    const effective = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const rows: Array<{ status: string; reason: string; reviewed: boolean }> = [
      { status: 'PENDING', reason: 'Demo: restructure awaiting review', reviewed: false },
      { status: 'PENDING', reason: 'Demo: second request awaiting review', reviewed: false },
      { status: 'APPROVED', reason: 'Demo: head change already approved', reviewed: true },
      { status: 'APPROVED', reason: 'Demo: parent change already approved', reviewed: true },
      { status: 'REJECTED', reason: 'Demo: request declined on review', reviewed: true },
      { status: 'CANCELLED', reason: 'Demo: request withdrawn by the raiser', reviewed: true },
    ];
    for (const r of rows) {
      await prisma.departmentChangeRequest.create({
        data: {
          departmentId: targetDeptId,
          requestType: 'CHANGE_MANAGER',
          requestedBy: reviewer,
          newManagerId: employees[0].id,
          reason: r.reason,
          status: r.status,
          effectiveDate: effective,
          ...(r.reviewed
            ? { reviewedBy: reviewer, reviewedAt: new Date(), reviewNote: 'Demo data' }
            : {}),
        },
      });
    }
  }

  info('Planted 1 headless department, 1 unmanaged branch, 1 employee with no branch and a 6-row change-request queue.');
}

/* ── Workforce history ───────────────────────────────────────────────────── */

/**
 * Joiners and leavers spread across the trailing year.
 *
 * `seedPeopleLifecycle` above puts two joiners in the CURRENT month, which is
 * what the lead cards need. Both hubs also draw a six- or twelve-month curve,
 * and a curve built from one month of data is a flat line with a single spike —
 * which demos as "the chart is broken" rather than "the business is steady".
 *
 * Leavers are written as `endDate` on an INACTIVE record, because that is what
 * the trend actually reads. Setting `status` without `endDate` would leave the
 * curve flat while the headcount card moved, and the two would disagree on
 * screen with no way to tell which was right.
 */
async function seedWorkforceHistory(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  info: (m: string) => void,
): Promise<void> {
  const { employees } = ctx;
  const now = new Date();

  /** First week of the month `n` months back, in UTC. */
  const monthAgo = (n: number, day = 6): Date =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day));

  // Backdate a handful of existing people so the joiners curve has a shape.
  // Months 2, 4, 5, 7 and 9 — uneven on purpose: an evenly-spaced curve looks
  // generated, and a demo that looks generated teaches nobody anything.
  const joinerPlan: Array<[number, number]> = [
    [2, 1], [4, 2], [5, 1], [7, 2], [9, 1],
  ];
  let cursor = 0;
  let backdated = 0;
  for (const [monthsBackCount, count] of joinerPlan) {
    for (let i = 0; i < count; i++) {
      const e = employees[cursor++];
      if (!e) break;
      await prisma.employee.update({
        where: { id: e.id },
        data: { startDate: monthAgo(monthsBackCount, 4 + i * 3) },
      });
      backdated++;
    }
  }

  // Two leavers, in different months, so the trend has a downward component and
  // the turnover rate has something to divide.
  const leavers = employees.slice(-2);
  const leaverMonths = [3, 6];
  let left = 0;
  for (let i = 0; i < leavers.length; i++) {
    const e = leavers[i];
    if (!e) continue;
    await prisma.employee.update({
      where: { id: e.id },
      data: { status: 'INACTIVE', endDate: monthAgo(leaverMonths[i] ?? 3, 20) },
    });
    left++;
  }

  info(`${backdated} joiners spread across the trailing year and ${left} leavers recorded.`);
}

/* ── Payroll ─────────────────────────────────────────────────────────────── */

/**
 * Every figure on the payroll hub comes from a report that filters
 * `status: 'LOCKED'` — a DRAFT run is money that has not moved, and the reports
 * are right to ignore it. The seed's runs are DRAFT, so both months are locked
 * here and the hub gets a register, a variance and a cost breakdown.
 */
async function lockPayrolls(
  prisma: PrismaClient,
  cur: { year: number; month: number },
  prev: { year: number; month: number },
  hrUserId: string,
  info: (m: string) => void,
): Promise<void> {
  const runs = await prisma.payroll.findMany({
    where: {
      batch: { name: { startsWith: 'SMP' } },
      OR: [
        { month: cur.month, year: cur.year },
        { month: prev.month, year: prev.year },
      ],
    },
    select: { id: true, month: true, year: true },
  });

  for (const run of runs) {
    const finalisedOn = dU(run.year, run.month, 28);
    await prisma.payroll.update({
      where: { id: run.id },
      data: {
        status: 'LOCKED',
        submittedAt: finalisedOn,
        submittedBy: hrUserId,
        approvedAt: finalisedOn,
        approvedBy: hrUserId,
        finalizedAt: finalisedOn,
        finalizedBy: hrUserId,
        lockedAt: finalisedOn,
        lockedBy: hrUserId,
      },
    });
  }

  // A month-on-month variance needs the two months to differ, and two runs
  // generated from the same salary table are identical to the rupee. Nudging
  // the previous month down gives the waterfall something real to decompose.
  const prevRun = runs.find((r) => r.month === prev.month && r.year === prev.year);
  if (prevRun) {
    const items = await prisma.payrollItem.findMany({
      where: { payrollId: prevRun.id },
      select: { id: true, baseSalary: true, netSalary: true },
      take: 6,
    });
    for (const item of items) {
      const shaved = round2(Number(item.netSalary) * 0.94);
      await prisma.payrollItem.update({
        where: { id: item.id },
        data: { netSalary: shaved, bonus: 0 },
      });
    }
  }

  info(`Locked ${runs.length} payroll run(s) so the reports have something to read.`);
}

/**
 * One older run left open on purpose.
 *
 * With both recent months locked, "open pay runs" reads zero and the card that
 * exists to catch money that has not moved has nothing to show. A forgotten
 * run two months back is both realistic and the exact state the card is for.
 */
async function seedOpenPayroll(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  cur: { year: number; month: number },
  hrUserId: string,
  info: (m: string) => void,
): Promise<void> {
  const { employees } = ctx;
  const period = monthsBack(cur, 2);
  const batch = await prisma.payrollBatch.findFirst({
    where: { name: { startsWith: 'SMP' } },
    select: { id: true },
  });
  if (!batch) return;

  const existing = await prisma.payroll.findFirst({
    where: { batchId: batch.id, month: period.month, year: period.year },
    select: { id: true },
  });
  if (existing) return;

  const sample = employees.slice(0, 8);
  const branchId = await branchOf(prisma, sample[0].id);

  const run = await prisma.payroll.create({
    data: {
      month: period.month,
      year: period.year,
      status: 'DRAFT',
      batchId: batch.id,
      branchId,
      notes: 'Left open from a prior cycle — never finalised.',
      totalAmount: 0,
    },
  });

  let total = 0;
  for (const e of sample) {
    const allowances = round2(e.baseSalary * 0.12);
    const deduction = round2(e.baseSalary * 0.08);
    const net = round2(e.baseSalary + allowances - deduction);
    total += net;
    await prisma.payrollItem.create({
      data: {
        payrollId: run.id,
        employeeId: e.id,
        baseSalary: e.baseSalary,
        workDays: 22,
        actualWorkDays: 22,
        allowances,
        deduction,
        insurance: round2(e.baseSalary * 0.03),
        tax: round2(e.baseSalary * 0.05),
        netSalary: net,
      },
    });
  }
  await prisma.payroll.update({ where: { id: run.id }, data: { totalAmount: round2(total) } });
  info(`Left ${period.month}/${period.year} open so the "money that has not moved" card fires.`);
}

async function branchOf(prisma: PrismaClient, employeeId: string): Promise<string | undefined> {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { branchId: true },
  });
  return emp?.branchId ?? undefined;
}

/* ── Gratuity, settlements, WPS ──────────────────────────────────────────── */

async function seedGratuityAndSettlements(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  cur: { year: number; month: number },
  info: (m: string) => void,
): Promise<void> {
  const { employees } = ctx;
  const locked = await prisma.payroll.findFirst({
    where: { batch: { name: { startsWith: 'SMP' } }, month: cur.month, year: cur.year },
    select: { id: true },
  });
  if (!locked) return;

  // Accrue for everyone with real service behind them — the liability figure is
  // "what we would owe if they all left today", so a thin sample understates it
  // in a way that makes the card look broken rather than empty.
  const accruing = employees.slice(0, Math.max(1, Math.floor(employees.length * 0.8)));
  for (const e of accruing) {
    const branchId = await branchOf(prisma, e.id);
    if (!branchId) continue;
    const serviceYears = Math.max(
      0.5,
      (Date.now() - e.startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
    );
    const daysAccrued = round2(Math.min(serviceYears, 5) * 15);
    const amount = round2((e.baseSalary / 30) * daysAccrued);
    await prisma.gratuityAccrual.create({
      data: {
        employeeId: e.id,
        branchId,
        payrollId: locked.id,
        month: cur.month,
        year: cur.year,
        basisAmount: e.baseSalary,
        serviceYears: round2(serviceYears),
        daysAccrued,
        amount,
        employerShare: 1,
        status: 'ACCRUED',
        // The working is how the figure was reached; the settlement screens
        // render it, so an empty object would show a blank breakdown.
        workingJson: {
          basis: 'BASIC',
          basisAmount: e.baseSalary,
          serviceYears: round2(serviceYears),
          daysPerYear: 15,
          daysAccrued,
          formula: '(basic / 30) * daysAccrued',
        },
      },
    });
  }

  // Two leavers mid-settlement: one still being computed, one signed off and
  // waiting to be paid. That pair is what makes the settlements card mean
  // something — a single status reads as a list, not a queue.
  // The last two, so this never collides with the accrual slice above however
  // many employees the sample happens to carry.
  const leavers = employees.slice(-2);
  const variants = ['RESIGNATION', 'END_OF_CONTRACT'];
  const statuses = ['DRAFT', 'APPROVED'];
  for (let i = 0; i < leavers.length; i++) {
    const e = leavers[i];
    const branchId = await branchOf(prisma, e.id);
    if (!branchId) continue;
    const variant = variants[i % variants.length];
    const deductions = round2(e.baseSalary * 0.3);
    // The same four heads the composer would produce, so the sample row is
    // shaped like a real one: positive amounts, the category carries the sign.
    const parts = [
      { category: 'EARNING', code: 'GRATUITY', label: 'End of service', amount: round2(e.baseSalary * 1.5) },
      { category: 'EARNING', code: 'LEAVE_ENCASH', label: 'Leave encashment', amount: round2(e.baseSalary * 0.6) },
      { category: 'EARNING', code: 'NOTICE', label: 'Notice pay', amount: round2(e.baseSalary * 0.3) },
      { category: 'DEDUCTION', code: 'LOAN', label: 'Outstanding loan', amount: deductions },
    ];
    const earnings = round2(
      parts.filter((p) => p.category === 'EARNING').reduce((sum, p) => sum + p.amount, 0),
    );
    const net = round2(earnings - deductions);
    await prisma.finalSettlement.create({
      data: {
        employeeId: e.id,
        branchId,
        variant,
        lastWorkingDate: new Date(Date.now() - (i + 3) * 24 * 60 * 60 * 1000),
        status: statuses[i % statuses.length],
        totalEarnings: earnings,
        totalDeductions: deductions,
        netPayable: net,
        // The working is a list of sentences, exactly as composeSettlement
        // writes it. Structured entries here crashed the detail screen, which
        // renders each element as text.
        workingJson: {
          lines: [
            `Settlement variant: ${variant}.`,
            ...parts.map(
              (p) => `${p.category === 'EARNING' ? '+' : '\u2212'} ${p.label}: ${p.amount}`,
            ),
            `Total earnings ${earnings}, total deductions ${deductions}, net ${net}.`,
          ],
        },
        // Without these the screen shows a net with no breakdown under it.
        lines: {
          create: parts.map((p, order) => ({
            category: p.category,
            code: p.code,
            label: p.label,
            computedAmount: p.amount,
            displayOrder: order,
          })),
        },
      },
    });
  }
  info(`Accrued gratuity for ${accruing.length} and opened ${leavers.length} settlements.`);
}

async function seedWpsFile(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  period: { year: number; month: number },
  info: (m: string) => void,
): Promise<void> {
  const cur = period;
  // Prefer the Oman run: the row carries OMR minor units and an Omani file
  // name, so hanging it off an Indian branch's payroll was a wage file that
  // could not have been produced by the branch it claimed.
  const where = { batch: { name: { startsWith: 'SMP' } }, month: cur.month, year: cur.year };
  const locked =
    (await prisma.payroll.findFirst({
      where: { ...where, branch: { country: 'OM' } },
      select: { id: true, branchId: true },
    })) ??
    (await prisma.payroll.findFirst({ where, select: { id: true, branchId: true } }));
  const branchId = locked?.branchId ?? ctx.branchIds[0];
  if (!locked || !branchId) return;

  const items = await prisma.payrollItem.aggregate({
    where: { payrollId: locked.id },
    _sum: { netSalary: true },
    _count: { _all: true },
  });

  await prisma.wpsFile.create({
    data: {
      branchId,
      payrollId: locked.id,
      // The registry key, not a made-up one: a file row whose format no adapter
      // answers to cannot be re-opened, re-generated or explained afterwards.
      format: 'om-cbo-v1',
      specVersion: 'OM-CBO-SIF/PROVISIONAL-2026-08',
      status: 'SUBMITTED',
      periodMonth: cur.month,
      periodYear: cur.year,
      generatedBy: ctx.hrUserId,
      fileName: `WPS_${cur.year}${String(cur.month).padStart(2, '0')}.sif`,
      employeeCount: items._count._all,
      // Minor units throughout WPS — the caller formats it, never the store.
      totalMinor: Math.round(Number(items._sum.netSalary ?? 0) * 1000),
      currency: 'OMR',
      currencyExponent: 3,
      paymentDate: dU(cur.year, cur.month, 28),
    },
  });
  info('Filed one wage file so the payroll hub can show when the bank last saw one.');
}

/* ── Loans ───────────────────────────────────────────────────────────────── */

/**
 * Amortisation rows for the loans the seed already approved.
 *
 * Without them nothing is ever due, so "overdue" and "due this cycle" are both
 * zero and the aging panel has no buckets. Two instalments are deliberately
 * left unpaid and backdated — one recently, one deep into the 61–90 bucket — so
 * the escalation the panel is built to show actually appears.
 */
async function seedLoanSchedules(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  cur: { year: number; month: number },
  info: (m: string) => void,
): Promise<void> {
  const loans = await prisma.advanceLoanRequest.findMany({
    where: { employee: { email: { endsWith: '@sample.hrms.local' } }, status: 'APPROVED' },
    select: { id: true, amount: true, createdAt: true },
    take: 6,
  });
  if (!loans.length) return;

  let overdue = 0;
  for (let li = 0; li < loans.length; li++) {
    const loan = loans[li];
    const principal = Number(loan.amount);
    const terms = 12;
    const emi = round2(principal / terms);
    let balance = principal;

    for (let n = 1; n <= terms; n++) {
      // Instalments run from five months before the current period, so the
      // early ones are in the past and the rest still ahead.
      const due = new Date(Date.UTC(cur.year, cur.month - 1 - 5 + n, 5));
      const opening = round2(balance);
      balance = round2(balance - emi);
      const isPast = due.getTime() < Date.now();

      // Loan 0 skips two past instalments; the oldest lands ~75 days back so
      // the aging panel gets a 61–90 bucket rather than one flat "overdue".
      const missed = li === 0 && (n === 1 || n === 4);
      const status = !isPast ? 'SCHEDULED' : missed ? 'SCHEDULED' : 'PAID';
      if (isPast && missed) overdue += 1;

      await prisma.loanSchedule.create({
        data: {
          requestId: loan.id,
          installmentNo: n,
          dueDate: due,
          dueCycleKey: due.getUTCFullYear() * 100 + (due.getUTCMonth() + 1),
          dueMonth: due.getUTCMonth() + 1,
          dueYear: due.getUTCFullYear(),
          openingBalance: opening,
          principalComponent: emi,
          emiAmount: emi,
          closingBalance: Math.max(0, round2(balance)),
          status: status as never,
          paidAmount: status === 'PAID' ? emi : 0,
          paidPrincipal: status === 'PAID' ? emi : 0,
          settledAt: status === 'PAID' ? due : null,
        },
      });
    }
  }
  info(`Amortised ${loans.length} loans, ${overdue} instalment(s) deliberately unpaid.`);
}

/* ── People lifecycle ────────────────────────────────────────────────────── */

/**
 * Joiners, a starter still to arrive, and contracts running out.
 *
 * All three of the People hub's lead cards are date-driven, and a seed whose
 * employees all started years ago leaves every one of them at zero.
 */
async function seedPeopleLifecycle(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  info: (m: string) => void,
): Promise<void> {
  const { employees } = ctx;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 3));

  // Two people who joined this month, and one who has been hired but has not
  // started — the onboarding queue exists before anybody appears in headcount.
  // Indices are relative to the roster size: the sample is 24 people today and
  // fixed offsets past that silently selected nobody.
  const joiners = employees.slice(-5, -3);
  for (const e of joiners) {
    await prisma.employee.update({ where: { id: e.id }, data: { startDate: monthStart } });
  }
  const future = employees[employees.length - 6];
  if (future) {
    await prisma.employee.update({
      where: { id: future.id },
      data: { startDate: new Date(Date.now() + 11 * 24 * 60 * 60 * 1000) },
    });
  }

  // Contracts inside the renewal window, and a probation ending soon enough
  // that somebody has to confirm or act before the date passes.
  const contracts = await prisma.contract.findMany({
    where: { employee: { email: { endsWith: '@sample.hrms.local' } }, status: 'ACTIVE' },
    select: { id: true, contractType: true },
    take: 40,
  });
  const fixed = contracts.filter((c) => c.contractType !== 'PROBATION').slice(0, 4);
  for (let i = 0; i < fixed.length; i++) {
    await prisma.contract.update({
      where: { id: fixed[i].id },
      data: { endDate: new Date(Date.now() + (8 + i * 6) * 24 * 60 * 60 * 1000) },
    });
  }
  const probations = contracts.filter((c) => c.contractType === 'PROBATION').slice(0, 3);
  for (let i = 0; i < probations.length; i++) {
    await prisma.contract.update({
      where: { id: probations[i].id },
      data: { endDate: new Date(Date.now() + (6 + i * 9) * 24 * 60 * 60 * 1000) },
    });
  }
  info(`${joiners.length} joiners, ${fixed.length} contracts and ${probations.length} probations now inside the window.`);
}

/* ── Roster conflicts ────────────────────────────────────────────────────── */

/**
 * A shift on a public holiday and a shift on the branch's weekly off.
 *
 * Both are states the roster is perfectly happy to contain and nothing sweeps
 * for, which is exactly why the hub card exists — and why it needs planted
 * examples to demo against.
 */
async function seedRosterConflicts(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  info: (m: string) => void,
): Promise<void> {
  const { employees, branchIds } = ctx;
  const branchId = branchIds[0];
  if (!branchId) return;

  // Sunday off, so a Sunday shift is a conflict the panel can find. getDay() is
  // Sunday-first, matching how the resolver reads this CSV.
  await prisma.branch.update({ where: { id: branchId }, data: { weeklyOffDays: '0' } });

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const wednesday = new Date(monday);
  wednesday.setUTCDate(monday.getUTCDate() + 2);

  const onSite = employees.filter((e) => e.branchIndex === 0).slice(0, 3);
  if (!onSite.length) return;

  // A holiday mid-week that somebody is nonetheless rostered for.
  await prisma.holiday.upsert({
    where: { id: (await prisma.holiday.findFirst({ where: { date: wednesday, branchId }, select: { id: true } }))?.id ?? '00000000-0000-0000-0000-000000000000' },
    update: {},
    create: {
      name: 'Founders Day',
      date: wednesday,
      year: wednesday.getUTCFullYear(),
      branchId,
      isRecurring: false,
    },
  }).catch(() => undefined);

  for (const [i, e] of onSite.entries()) {
    const date = i === 0 ? wednesday : sunday;
    const existing = await prisma.workSchedule.findFirst({
      where: { employeeId: e.id, date },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.workSchedule.create({
      data: {
        employeeId: e.id,
        date,
        shiftType: 'FULL_DAY',
        // Timestamps, not clock strings — the column is a Timestamp(6).
        startTime: new Date(date.getTime() + 9 * 60 * 60 * 1000),
        endTime: new Date(date.getTime() + 18 * 60 * 60 * 1000),
        isWorkDay: true,
        requiredHours: 8,
      },
    });
  }
  info('Planted one holiday shift and weekly-off shifts for the conflict card.');
}

/* ── Workplace hub ───────────────────────────────────────────────────────── */

/**
 * The workplace top-up that never existed.
 *
 * Every other module hub had one of these; Workplace had none, and it showed.
 * The sample seed builds an asset register where nothing is lost, a letter desk
 * with a handful of rows in the current month only, and projects with no end
 * dates — so three of the hub's five cards were structurally incapable of
 * moving off zero.
 *
 * The base seed now handles the asset side (one LOST item, unsigned handovers)
 * and the project side (real end dates). What is left, and what this does, is
 * the letter desk: the hub's HEADLINE chart is twelve months of letter volume,
 * and the sample seed writes only the current month.
 */
async function seedWorkplaceFill(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  info: (m: string) => void,
): Promise<void> {
  const { employees, hrUserId, rng } = ctx;
  if (!employees.length) return;

  const templates = ['SALARY_CERTIFICATE', 'NOC', 'EXPERIENCE', 'EMBASSY'];

  // Marked so a re-run replaces its own rows rather than stacking another year
  // on top. `purpose` is the only free-text column on the model.
  await prisma.letterRequest.deleteMany({
    where: { purpose: { startsWith: DEMO_ROW_MARKER } },
  });

  let issuedCount = 0;
  const rows: any[] = [];
  // Month 0 is the current, partial month — deliberately left thinner, and its
  // requests deliberately left mostly PENDING, because that is what a live desk
  // looks like on any given day.
  for (let monthsAgo = 11; monthsAgo >= 0; monthsAgo--) {
    const base = new Date();
    const cap = monthsAgo === 0 ? base.getUTCDate() : 28;
    const perMonth = monthsAgo === 0 ? 2 : 2 + Math.floor(rng() * 4);

    for (let i = 0; i < perMonth; i++) {
      const employee = employees[Math.floor(rng() * employees.length)];
      const requestedOn = new Date(
        Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - monthsAgo, Math.max(1, Math.min(cap, 2 + i * 6))),
      );
      // An older request has had time to be dealt with; this month's mostly has
      // not. Turnaround is 1–5 days, which is what the panel averages.
      const settled = monthsAgo > 0 ? rng() < 0.85 : rng() < 0.25;
      const rejected = settled && rng() < 0.12;
      const issuedAt = settled && !rejected
        ? new Date(requestedOn.getTime() + (1 + Math.floor(rng() * 5)) * 86400000)
        : null;
      if (issuedAt) issuedCount += 1;

      rows.push({
        employeeId: employee.id,
        templateKey: templates[Math.floor(rng() * templates.length)],
        locale: 'en',
        purpose: `${DEMO_ROW_MARKER}Requested for personal records.`,
        status: rejected ? 'REJECTED' : issuedAt ? 'ISSUED' : 'PENDING',
        // A unique serial is only issued with the letter itself.
        serialNumber: issuedAt
          ? `DEMO-${requestedOn.getUTCFullYear()}${String(requestedOn.getUTCMonth() + 1).padStart(2, '0')}-${rows.length + 1}`
          : null,
        issuedById: issuedAt ? hrUserId : null,
        issuedAt,
        rejectedReason: rejected ? 'Superseded by a later request.' : null,
        createdAt: requestedOn,
      });
    }
  }

  await prisma.letterRequest.createMany({ data: rows as never });
  info(`Wrote ${rows.length} letter requests across the year (${issuedCount} issued).`);
}

/* ── Talent + system activity ────────────────────────────────────────────── */

async function seedTalentAndAudit(
  prisma: PrismaClient,
  ctx: ExtrasContext,
  info: (m: string) => void,
): Promise<void> {
  const { prisma: _p, employees, branchIds, hrUserId, rng } = ctx;
  void _p;

  // A grievance that has been open long enough to be a problem in itself. The
  // hub scores this queue by age, and everything the seed writes is fresh.
  const stale = await prisma.grievance.findFirst({
    where: { employee: { email: { endsWith: '@sample.hrms.local' } } },
    select: { id: true },
  });
  if (stale) {
    await prisma.grievance.update({
      where: { id: stale.id },
      data: { status: 'OPEN', createdAt: new Date(Date.now() - 41 * 24 * 60 * 60 * 1000) },
    });
  }

  // An appraisal cycle actually running — "runs completed" says nothing about
  // whether this quarter has started.
  if (branchIds[0]) {
    // Seeded as RUNNING so the Talent hub can show a cycle in flight. Note that
    // a backend running against this database will pick the run up and drive it
    // to COMPLETED or FAILED within seconds — the row is correct on insert, and
    // the orchestrator claiming it afterwards is the system working as intended.
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getFullYear(), periodEnd.getMonth() - 3, 1);
    const inScope = Math.min(employees.length, 24);
    const done = Math.floor(inScope / 3);
    const run = await prisma.appraisalRun.create({
      data: {
        branchId: branchIds[0],
        status: 'RUNNING',
        periodStart,
        periodEnd,
        periodLabel: `Q${Math.floor(periodStart.getMonth() / 3) + 1} ${periodStart.getFullYear()}`,
        totalEmployees: inScope,
        completedEmployees: done,
        createdById: hrUserId,
      },
    });

    // Per-employee results, so the hub's performance panel has a distribution
    // to draw rather than a completion percentage with nothing behind it. The
    // run row alone gave a ratio and an empty donut.
    //
    // One DEGRADED and one FAILED on purpose: those two are what the attention
    // strip watches for, and a run where everything succeeds proves nothing
    // about whether the card fires.
    const recommendations = ['PROMOTE', 'REWARD', 'MAINTAIN', 'COACH', 'PIP'];
    await prisma.appraisalResult.createMany({
      data: employees.slice(0, inScope).map((e, i) => ({
        runId: run.id,
        employeeId: e.id,
        employeeCode: `${DEMO_ROW_MARKER}${i + 1}`,
        employeeName: e.fullName,
        status:
          i < done ? 'COMPLETED' : i === done ? 'DEGRADED' : i === done + 1 ? 'FAILED' : 'PENDING',
        recommendation: recommendations[i % recommendations.length],
        rankOverall: i + 1,
      })) as never,
    });
    info(`Wrote ${inScope} appraisal results for the run in flight.`);
  }

  // A year of recognition and correction.
  //
  // The Talent hub's headline chart is rewards against disciplinary actions by
  // month, and the sample seed writes neither — so the chart was twelve empty
  // bars on every demo. Rewards outnumber actions roughly 3:1, which is what a
  // functioning company looks like and what makes a bad month visible.
  const conductEmployees = employees.slice(0, Math.min(employees.length, 12));
  if (conductEmployees.length) {
    await prisma.reward.deleteMany({ where: { reason: { startsWith: DEMO_ROW_MARKER } } });
    await prisma.discipline.deleteMany({ where: { reason: { startsWith: DEMO_ROW_MARKER } } });

    const rewards: any[] = [];
    const disciplines: any[] = [];
    for (let monthsAgo = 11; monthsAgo >= 0; monthsAgo--) {
      const base = new Date();
      const inMonth = (dayOfMonth: number) =>
        new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - monthsAgo, dayOfMonth));
      // Never date a row into the future: the current month is partial, and a
      // reward dated the 28th on the 3rd would inflate the newest bar.
      const cap = monthsAgo === 0 ? base.getUTCDate() : 28;

      const rewardCount = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < rewardCount; i++) {
        const e = conductEmployees[Math.floor(rng() * conductEmployees.length)];
        rewards.push({
          employeeId: e.id,
          reason: `${DEMO_ROW_MARKER}Recognised for consistent delivery.`,
          amount: 100 + Math.floor(rng() * 8) * 50,
          rewardDate: inMonth(Math.max(1, Math.min(cap, 3 + i * 9))),
          rewardType: ['BONUS', 'CERTIFICATE', 'PROMOTION'][Math.floor(rng() * 3)],
          createdBy: hrUserId,
        });
      }

      if (rng() < 0.55) {
        const e = conductEmployees[Math.floor(rng() * conductEmployees.length)];
        disciplines.push({
          employeeId: e.id,
          reason: `${DEMO_ROW_MARKER}Repeated late arrival after a written warning.`,
          disciplineType: ['WARNING', 'FINE'][Math.floor(rng() * 2)],
          amount: rng() < 0.5 ? 0 : 50,
          disciplineDate: inMonth(Math.max(1, Math.min(cap, 17))),
          createdBy: hrUserId,
        });
      }
    }
    await prisma.reward.createMany({ data: rewards as never });
    await prisma.discipline.createMany({ data: disciplines as never });
    info(`Wrote ${rewards.length} rewards and ${disciplines.length} disciplinary actions across the year.`);
  }

  // System activity. The audit log is written by real requests, so a freshly
  // seeded database has almost none and the hub reads near-zero for a company
  // of fifty people.
  const actions = ['CREATE', 'UPDATE', 'UPDATE', 'UPDATE', 'DELETE', 'APPROVE'];
  const resources = ['Employee', 'Payroll', 'LeaveRequest', 'Attendance', 'Contract', 'Asset'];
  // Marked so a re-run replaces its own rows instead of stacking another 60 on
  // top; there is no other column here to identify seeded events by.
  await prisma.auditLog.deleteMany({ where: { userAgent: DEMO_AUDIT_MARKER } });
  const rows = Array.from({ length: 60 }, (_, i) => ({
    userId: hrUserId,
    userAgent: DEMO_AUDIT_MARKER,
    action: actions[Math.floor(rng() * actions.length)],
    resourceType: resources[Math.floor(rng() * resources.length)],
    // Spread across the last 23 hours so the 24-hour window catches all of it.
    createdAt: new Date(Date.now() - Math.floor(rng() * 23 * 60 * 60 * 1000)),
    branchId: branchIds[0] ?? null,
  }));
  await prisma.auditLog.createMany({ data: rows as never });
  info(`Wrote ${rows.length} audit events across the last day.`);
}
