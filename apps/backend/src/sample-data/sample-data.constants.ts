/**
 * Shared constants + helpers for the comprehensive SAMPLE dataset.
 *
 * Single source of truth for how sample data is namespaced and torn down.
 * Imported by the runtime SampleDataService (UI-triggered seeding) and by the
 * CLI wrapper (prisma/seed-sample.ts). Every sample row carries a recognizable
 * key so it can always be found and removed without touching base data.
 */

import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Namespace — the stable markers that make sample data identifiable
// ---------------------------------------------------------------------------

/** Email domain shared by every sample Employee AND its linked User login. */
export const SAMPLE_EMAIL_DOMAIN = 'sample.hrms.local';
/** Prefix for every other unique key (codes, contract numbers, project/task codes). */
export const SMP = 'SMP-';
/** SystemSetting row written last; presence == "sample data is currently seeded". */
export const SAMPLE_MARKER_KEY = 'sample_data_seeded';
/** The PayrollBatch name that scopes the sample DRAFT payroll runs. */
export const SAMPLE_BATCH_NAME = 'SMP Sample Payroll';

/** Previous month relative to the project "today" (2026-07-08). */
export const SAMPLE_PAYROLL_MONTH = 6; // June
export const SAMPLE_PAYROLL_YEAR = 2026;

export const sampleEmail = (localPart: string): string =>
  `${localPart}@${SAMPLE_EMAIL_DOMAIN}`;

/** Prisma where-filters that match ONLY sample data. Reused by seed + flush. */
export const sampleFilters = {
  employeeByEmail: { email: { endsWith: `@${SAMPLE_EMAIL_DOMAIN}` } },
  userByEmail: { email: { endsWith: `@${SAMPLE_EMAIL_DOMAIN}` } },
  byCodePrefix: { code: { startsWith: SMP } },
  projectByCodePrefix: { projectCode: { startsWith: SMP } },
  taskByCodePrefix: { taskCode: { startsWith: SMP } },
  /** relation filter: "belongs to a sample employee" */
  ofSampleEmployee: { employee: { email: { endsWith: `@${SAMPLE_EMAIL_DOMAIN}` } } },
} as const;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — so re-runs produce identical data
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rng() * arr.length)];

export const randInt = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

export const pad3 = (n: number): string => String(n).padStart(3, '0');

// ---------------------------------------------------------------------------
// Fixture data (hand-rolled — @faker-js/faker is not a dependency)
// ---------------------------------------------------------------------------

export const FIRST_NAMES = [
  'Aarav', 'Diya', 'Vihaan', 'Ananya', 'Kabir', 'Isha',
  'Rohan', 'Meera', 'Arjun', 'Sara', 'Aditya', 'Nisha',
  'Karan', 'Priya', 'Vikram', 'Tara', 'Dev', 'Riya',
  // Oman branch (indices 18–23) — Omani given names (M/F alternating)
  'Ahmed', 'Fatima', 'Said', 'Aisha', 'Khalid', 'Mariam',
] as const;

export const LAST_NAMES = [
  'Sharma', 'Reddy', 'Iyer', 'Nair', 'Gupta', 'Menon',
  'Rao', 'Kapoor', 'Bose', 'Verma', 'Pillai', 'Shah',
  'Chopra', 'Das', 'Malhotra', 'Joshi', 'Kulkarni', 'Sethi',
  // Oman branch (indices 18–23) — Omani family names
  'Al-Habsi', 'Al-Balushi', 'Al-Raisi', 'Al-Zadjali', 'Al-Harthy', 'Al-Maskari',
] as const;

/** 6 departments (code, name). Index 4 = HR (holds the HR approver user). */
export const DEPARTMENTS = [
  { code: `${SMP}ENG`, name: 'Engineering', description: 'Software engineering & platform' },
  { code: `${SMP}SAL`, name: 'Sales', description: 'Revenue & account management' },
  { code: `${SMP}MKT`, name: 'Marketing', description: 'Brand, growth & demand gen' },
  { code: `${SMP}FIN`, name: 'Finance', description: 'Accounting, payroll & controls' },
  { code: `${SMP}HR`, name: 'People & Culture', description: 'HR, hiring & operations' },
  { code: `${SMP}OPS`, name: 'Operations', description: 'Delivery & support operations' },
] as const;

/** One representative position title per department (parallel to DEPARTMENTS). */
export const POSITIONS_BY_DEPT = [
  'Software Engineer',
  'Account Executive',
  'Marketing Specialist',
  'Financial Analyst',
  'HR Business Partner',
  'Operations Associate',
] as const;

/**
 * 4 branches, each with its own timezone / office window / geofence.
 * `weeklyOffDays` is a CSV of weekday numbers (0=Sun … 6=Sat); null => inherit
 * the global `calendar_weekly_holidays` setting. The Oman (Muscat) branch runs a
 * Sun–Thu working week (Fri+Sat off) per Omani norms, exercising the per-branch
 * work-week engine end-to-end.
 */
export const BRANCHES = [
  {
    code: `${SMP}BLR`, name: 'Bengaluru Hub', city: 'Bengaluru', state: 'Karnataka',
    country: 'IN', timezone: 'Asia/Kolkata', officeStartTime: '09:00', officeEndTime: '18:00',
    latitude: 12.9716, longitude: 77.5946, weeklyOffDays: null as string | null,
  },
  {
    code: `${SMP}MAA`, name: 'Chennai Office', city: 'Chennai', state: 'Tamil Nadu',
    country: 'IN', timezone: 'Asia/Kolkata', officeStartTime: '09:30', officeEndTime: '18:30',
    latitude: 13.0827, longitude: 80.2707, weeklyOffDays: null as string | null,
  },
  {
    code: `${SMP}NYC`, name: 'New York Desk', city: 'New York', state: 'NY',
    country: 'US', timezone: 'America/New_York', officeStartTime: '09:00', officeEndTime: '17:00',
    latitude: 40.7128, longitude: -74.006, weeklyOffDays: null as string | null,
  },
  {
    code: `${SMP}MCT`, name: 'Muscat Branch', city: 'Muscat', state: 'Muscat',
    country: 'OM', timezone: 'Asia/Muscat', officeStartTime: '08:00', officeEndTime: '17:00',
    latitude: 23.588, longitude: 58.3829, weeklyOffDays: '5,6' as string | null,
  },
] as const;

export const LEAVE_TYPES = ['ANNUAL', 'SICK', 'UNPAID', 'MATERNITY', 'PATERNITY', 'BEREAVEMENT', 'OTHER'] as const;
export const REIMBURSEMENT_TYPES = ['Travel', 'Medical', 'Food', 'Office Supplies', 'Other'] as const;
export const OT_TYPES = ['REGULAR', 'LATE', 'DOUBLE', 'DOUBLE_LATE'] as const;
export const SHIFT_TYPES = ['FULL_DAY', 'MORNING', 'AFTERNOON', 'FLEXIBLE'] as const;

export const EMPLOYEE_COUNT = 24;

/**
 * The one employee deliberately left with no branch, so the data-quality card
 * that counts them has something to count.
 *
 * Named here rather than picked by offset inside the demo-fill seed because two
 * other places have to agree with the choice: the payroll seeder skips this
 * person (an employee with no branch on a per-branch run is a BLOCKING
 * `NOT_IN_BRANCH` finding that stops the branch's wage file), and it must not
 * collide with the leavers or joiners taken from the end of the roster. Index 5
 * is in the FIRST branch — never Muscat, which is the branch the wage-file flow
 * is demonstrated on.
 */
export const NO_BRANCH_EMPLOYEE_INDEX = 5;
export const PER_BRANCH = 6;

// ---------------------------------------------------------------------------
// Working-day calendar — mirrors HolidaysService.getWorkDaysInMonth EXACTLY
// so the seeded attendance count lines up with the payroll engine's workDays.
// ---------------------------------------------------------------------------

const parseWeeklyOff = (csv: string): number[] =>
  csv
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

export async function getSampleWorkingDays(
  prisma: PrismaClient,
  month: number,
  year: number,
  opts: { branchId?: string; weeklyOffDays?: string | null } = {},
): Promise<Date[]> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));

  // Holidays visible to this branch: company-wide (branchId null) + the branch's
  // own rows — mirrors HolidaysService.branchHolidayFilter so a branch-scoped
  // holiday (e.g. Oman's Renaissance Day) only removes days for that branch.
  const holidays = await prisma.holiday.findMany({
    where: {
      date: { gte: start, lte: end },
      ...(opts.branchId
        ? { OR: [{ branchId: null }, { branchId: opts.branchId }] }
        : { branchId: null }),
    },
    select: { date: true },
  });
  const holidaySet = new Set(holidays.map((h) => h.date.toISOString().split('T')[0]));

  // Weekly-off precedence: branch override → global calendar_weekly_holidays → [0].
  let weeklyHolidays: number[];
  if (opts.weeklyOffDays != null) {
    weeklyHolidays = parseWeeklyOff(opts.weeklyOffDays);
  } else {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'calendar_weekly_holidays' },
    });
    const parsed = setting?.value ? parseWeeklyOff(setting.value) : [];
    weeklyHolidays = parsed.length ? parsed : [0];
  }

  const days: Date[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getUTCDay();
    const ds = cur.toISOString().split('T')[0];
    if (!weeklyHolidays.includes(dow) && !holidaySet.has(ds)) {
      days.push(new Date(cur));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Delete the transactional/child sample rows (everything except the upserted
 * parents: departments, branches, employees, users). Run at the top of every
 * seed so a re-run is deterministic and never hits a duplicate key on the many
 * child tables that have no natural unique constraint.
 */
export async function resetSampleChildren(prisma: PrismaClient): Promise<void> {
  const ofEmp = sampleFilters.ofSampleEmployee;
  const sampleEmployees = await prisma.employee.findMany({
    where: sampleFilters.employeeByEmail,
    select: { id: true },
  });
  const empIds = sampleEmployees.map((e) => e.id);
  const sampleBranches = await prisma.branch.findMany({
    where: sampleFilters.byCodePrefix,
    select: { id: true },
  });
  const branchIds = sampleBranches.map((b) => b.id);
  const sampleUsers = await prisma.user.findMany({
    where: sampleFilters.userByEmail,
    select: { id: true },
  });
  const userIds = sampleUsers.map((u) => u.id);

  // 0. The approval engine's runtime trail has no FK to the requests it tracks,
  //    so it must be cleared by id BEFORE those requests disappear.
  if (empIds.length) {
    const [leaves, overtimes, travels, trainings, bankChanges] = await Promise.all([
      prisma.leaveRequest.findMany({ where: { employeeId: { in: empIds } }, select: { id: true } }),
      prisma.overtimeRequest.findMany({ where: { employeeId: { in: empIds } }, select: { id: true } }),
      prisma.travelRequest.findMany({ where: { employeeId: { in: empIds } }, select: { id: true } }),
      prisma.trainingNomination.findMany({ where: { employeeId: { in: empIds } }, select: { id: true } }),
      prisma.bankChangeRequest.findMany({ where: { employeeId: { in: empIds } }, select: { id: true } }),
    ]);
    const requestIds = [...leaves, ...overtimes, ...travels, ...trainings, ...bankChanges].map((r) => r.id);
    if (requestIds.length) {
      await prisma.requestApproval.deleteMany({ where: { requestId: { in: requestIds } } });
    }
  }

  // 1. Sample payroll first (cascades payroll_items -> advance_loan_deductions;
  //    nulls reimbursement.payroll_item_id). Then the batch (cascades members).
  //
  //    WPS files hold `payroll_id` with onDelete: Restrict, so a wage file left
  //    over from a previous seed makes the payroll delete below FAIL outright —
  //    they have to go first. Gratuity accruals and settlements cascade from
  //    Employee, and employees survive a reset, so they need clearing by hand
  //    too or a second run doubles every figure on the payroll hub.
  await prisma.wpsFile.deleteMany({
    where: { payroll: { batch: { name: { startsWith: 'SMP' } } } },
  });
  await prisma.payroll.deleteMany({ where: { batch: { name: { startsWith: 'SMP' } } } });
  await prisma.payrollBatch.deleteMany({ where: { name: { startsWith: 'SMP' } } });
  await prisma.gratuityAccrual.deleteMany({ where: ofEmp });
  await prisma.finalSettlement.deleteMany({ where: ofEmp });

  // 2. Tasks before projects (tasks.project_id is SetNull, not Cascade).
  //    Timesheets/work logs hang off tasks, so they go first.
  await prisma.timesheet.deleteMany({ where: ofEmp });
  await prisma.workLog.deleteMany({ where: ofEmp });
  await prisma.task.deleteMany({ where: sampleFilters.taskByCodePrefix });
  await prisma.project.deleteMany({ where: sampleFilters.projectByCodePrefix });

  // 3. Budgets: commitments -> lines -> budget (all keyed on the SMP budget name).
  await prisma.budgetCommitment.deleteMany({
    where: { line: { budget: { name: { startsWith: SMP } } } },
  });
  await prisma.budgetLine.deleteMany({ where: { budget: { name: { startsWith: SMP } } } });
  await prisma.budget.deleteMany({ where: { name: { startsWith: SMP } } });

  // 4. Training: nominations before sessions before courses. Nominations also
  //    reference appraisal results, so they must precede the appraisal runs.
  await prisma.trainingNomination.deleteMany({ where: ofEmp });
  await prisma.trainingSession.deleteMany({ where: { course: { code: { startsWith: SMP } } } });
  await prisma.course.deleteMany({ where: { code: { startsWith: SMP } } });

  // 5. Appraisal runs scoped to a sample branch (cascades results + events).
  if (branchIds.length) {
    await prisma.appraisalRun.deleteMany({ where: { branchId: { in: branchIds } } });
  }

  // 6. Assets: custody rows before the items themselves.
  await prisma.assetAssignment.deleteMany({ where: { asset: { assetTag: { startsWith: SMP } } } });
  await prisma.assetAssignment.deleteMany({ where: ofEmp });
  await prisma.assetItem.deleteMany({ where: { assetTag: { startsWith: SMP } } });

  // 7. Contract lifecycle (contracts themselves are upserted, never deleted).
  await prisma.terminationRequest.deleteMany({ where: { contract: { employee: sampleFilters.employeeByEmail } } });
  await prisma.contractAppendix.deleteMany({ where: { contract: { employee: sampleFilters.employeeByEmail } } });

  // 8. Department governance.
  await prisma.managerTransition.deleteMany({ where: { department: sampleFilters.byCodePrefix } });
  await prisma.departmentChangeRequest.deleteMany({ where: { department: sampleFilters.byCodePrefix } });
  await prisma.departmentHistory.deleteMany({ where: { department: sampleFilters.byCodePrefix } });

  // 9. Per-employee transactional children.
  await prisma.attendanceCorrection.deleteMany({ where: ofEmp });
  await prisma.attendance.deleteMany({ where: ofEmp });
  await prisma.workSchedule.deleteMany({ where: ofEmp });
  await prisma.leaveRequest.deleteMany({ where: ofEmp }); // -> approvals, attachments
  await prisma.overtimeRequest.deleteMany({ where: ofEmp });
  await prisma.travelRequest.deleteMany({ where: ofEmp }); // -> itineraries
  await prisma.reimbursement.deleteMany({ where: ofEmp }); // -> attachments
  await prisma.advanceLoanRequest.deleteMany({ where: ofEmp }); // -> deductions, attachments
  await prisma.salaryComponent.deleteMany({ where: ofEmp });
  await prisma.leaveTypeBalance.deleteMany({ where: ofEmp });
  await prisma.leaveAccrualHistory.deleteMany({ where: ofEmp });
  await prisma.leaveBalance.deleteMany({ where: ofEmp });
  await prisma.grievance.deleteMany({ where: ofEmp }); // -> events
  await prisma.grievance.deleteMany({ where: { againstEmployee: sampleFilters.employeeByEmail } });
  await prisma.letterRequest.deleteMany({ where: ofEmp });
  await prisma.employeeDocument.deleteMany({ where: ofEmp });
  await prisma.employeeLegalDocument.deleteMany({ where: ofEmp }); // -> attachments
  await prisma.reward.deleteMany({ where: ofEmp });
  await prisma.discipline.deleteMany({ where: ofEmp });
  await prisma.employeeActivity.deleteMany({ where: ofEmp });
  await prisma.employeeHistory.deleteMany({ where: ofEmp });
  await prisma.faceDescriptor.deleteMany({ where: ofEmp });
  await prisma.chatHistory.deleteMany({ where: ofEmp });
  await prisma.employeeProfile.deleteMany({ where: ofEmp });
  await prisma.bankChangeRequest.deleteMany({ where: ofEmp });
  await prisma.employeeBankDetail.deleteMany({ where: ofEmp });
  // Written by the Muscat payroll seed. Configuration-shaped rows it also
  // writes — grades, EOSB rules, the wage-file configuration — are upserted by
  // natural key and deliberately survive a reset: deleting a branch's wage-file
  // configuration would leave the pre-flight refusing to open until a re-seed.
  await prisma.leaveEncashmentRequest.deleteMany({ where: ofEmp });
  await prisma.employeeRecovery.deleteMany({ where: ofEmp });
  await prisma.employeeTransfer.deleteMany({ where: ofEmp });
  await prisma.garnishmentOrder.deleteMany({ where: ofEmp }); // -> garnishment_deductions (cascade)
  await prisma.teamMember.deleteMany({ where: ofEmp });
  await prisma.team.deleteMany({ where: sampleFilters.byCodePrefix });

  // 10. Per-user rows (users themselves survive a reset; only flush removes them).
  if (userIds.length) {
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.copilotConversation.deleteMany({ where: { userId: { in: userIds } } }); // -> messages
  }

  // 11. Branch-scoped configuration written by the seed.
  if (branchIds.length) {
    await prisma.attendanceIntegration.deleteMany({ where: { branchId: { in: branchIds } } }); // -> sync runs
    await prisma.holiday.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.payrollCalendar.deleteMany({ where: { branchId: { in: branchIds } } }); // -> periods
    await prisma.leaveTypePolicy.deleteMany({ where: { branchId: { in: branchIds } } });
    await prisma.leaveCarryForwardRun.deleteMany({ where: { branchId: { in: branchIds } } });
    // Journal entries point at loan transactions that cascade away with the
    // loans above, so leaving them behind accumulates orphans on every re-seed.
    // The chart of accounts and the mappings are configuration and are upserted,
    // so they stay.
    await prisma.journalEntry.deleteMany({ where: { branchId: { in: branchIds } } }); // -> lines
  }

  // 12. Overtime policies — detach the per-employee override before deleting.
  if (empIds.length) {
    await prisma.employee.updateMany({
      where: { id: { in: empIds } },
      data: { overtimePolicyId: null, supervisorId: null },
    });
  }
  await prisma.overtimePolicy.deleteMany({ where: { name: { startsWith: SMP } } });
}

/**
 * Full teardown of ALL sample data while leaving base data intact. Removes only
 * the sample namespace (kept for callers that want to clear demo data without a
 * full baseline reset).
 */
export async function flushSampleData(prisma: PrismaClient): Promise<void> {
  await resetSampleChildren(prisma);
  await prisma.department.updateMany({ where: sampleFilters.byCodePrefix, data: { managerId: null } });
  await prisma.branch.updateMany({ where: sampleFilters.byCodePrefix, data: { managerId: null } });
  await prisma.employee.deleteMany({ where: sampleFilters.employeeByEmail });
  await prisma.user.deleteMany({ where: sampleFilters.userByEmail });
  await prisma.branch.deleteMany({ where: sampleFilters.byCodePrefix });
  await prisma.department.deleteMany({ where: sampleFilters.byCodePrefix });
  await prisma.systemSetting.deleteMany({ where: { key: SAMPLE_MARKER_KEY } });
}
