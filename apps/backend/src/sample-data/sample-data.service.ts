import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollsService } from '../payrolls/payrolls.service';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { presetRolesCreateData } from '../projects/rbac/permissions.constants';
import {
  SMP,
  SAMPLE_MARKER_KEY,
  SAMPLE_BATCH_NAME,
  NO_BRANCH_EMPLOYEE_INDEX,
  sampleEmail,
  sampleFilters,
  mulberry32,
  randInt,
  pad3,
  FIRST_NAMES,
  LAST_NAMES,
  DEPARTMENTS,
  POSITIONS_BY_DEPT,
  BRANCHES,
  SHIFT_TYPES,
  EMPLOYEE_COUNT,
  PER_BRANCH,
  getSampleWorkingDays,
  resetSampleChildren,
} from './sample-data.constants';
import { seedSampleExtras, ExtrasProject } from './sample-data.extras';
import { seedDemoFill } from './sample-data.demo-fill';
import { seedMuscatPayrollDemo } from './sample-data.muscat-payroll';
import { seedMuscatCoverage } from './sample-data.muscat-coverage';
import * as bcrypt from 'bcrypt';
import { DateTime } from 'luxon';

/** A single streamed progress update. `step` = a narratable stage. */
export interface SampleSeedProgress {
  type: 'step' | 'info' | 'done' | 'error';
  message: string;
  /** 1-based index of the current step (for a progress bar). */
  step?: number;
  /** Total number of steps. */
  total?: number;
  data?: any;
}

export type ProgressFn = (update: SampleSeedProgress) => void;

// --- date helpers (all UTC to match the payroll engine's date math) ----------
const dU = ([y, m, d]: readonly [number, number, number]): Date =>
  new Date(Date.UTC(y, m - 1, d));
/** `n` days from today, at UTC midnight. Mirrors the helper in the extras seed. */
const dayFromToday = (n: number): Date => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
};
const atTime = (day: Date, h: number, min: number): Date =>
  new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, min, 0));
/**
 * A check-in/check-out is a real instant, not a wall clock — the attendance
 * tables render it through `formatTime()` in the company timezone. Building it
 * with `atTime()` tags the branch's local hour as UTC, so an 08:00 Muscat
 * check-in surfaced as 13:30 in the UI (the classic naive-UTC demo bug). Convert
 * through the branch's own zone so the seeded instant really is 08:00 there —
 * the same convention `seed-nexura-logins.ts` follows by hand (04:00Z = 08:00
 * Asia/Muscat).
 */
const atZonedTime = (day: Date, tz: string, h: number, min: number): Date =>
  DateTime.fromObject(
    { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: h, minute: min },
    { zone: tz },
  ).toJSDate();
const isoDay = (d: Date): string => d.toISOString().split('T')[0];
function* eachDay(start: Date, end: Date): Generator<Date> {
  const c = new Date(start);
  while (c <= end) {
    yield new Date(c);
    c.setUTCDate(c.getUTCDate() + 1);
  }
}

interface Emp {
  id: string;
  index: number;
  branchIndex: number;
  deptIndex: number;
  email: string;
  fullName: string;
  baseSalary: number;
  startDate: Date;
  leaveDates: Set<string>;
  absentDates: Set<string>;
}

const TOTAL_STEPS = 35;

// Per-month spec factories — same shapes as before, but relative to a given
// (year, month) so we can seed both the previous and the current month.
function leaveSpecsFor(year: number, month: number) {
  return [
    { empIdx: 5, type: 'ANNUAL', start: [year, month, 10] as [number, number, number], end: [year, month, 11] as [number, number, number], days: 2, status: 'APPROVED', markLeave: true },
    { empIdx: 6, type: 'SICK', start: [year, month, 17] as [number, number, number], end: [year, month, 17] as [number, number, number], days: 1, status: 'APPROVED', markLeave: true },
    { empIdx: 8, type: 'ANNUAL', start: [year, month, 20] as [number, number, number], end: [year, month, 22] as [number, number, number], days: 3, status: 'PENDING', markLeave: false },
    { empIdx: 9, type: 'PATERNITY', start: [year, month, 25] as [number, number, number], end: [year, month, 27] as [number, number, number], days: 3, status: 'PENDING', markLeave: false },
    { empIdx: 10, type: 'UNPAID', start: [year, month, 5] as [number, number, number], end: [year, month, 6] as [number, number, number], days: 2, status: 'REJECTED', markLeave: false },
    { empIdx: 11, type: 'BEREAVEMENT', start: [year, month, 12] as [number, number, number], end: [year, month, 13] as [number, number, number], days: 2, status: 'CANCELLED', markLeave: false },
    { empIdx: 12, type: 'OTHER', start: [year, month, 3] as [number, number, number], end: [year, month, 3] as [number, number, number], days: 1, status: 'APPROVED', markLeave: false },
    // Oman branch (Sun–Thu week) — chosen dates fall on Oman working days.
    { empIdx: 18, type: 'ANNUAL', start: [year, month, 7] as [number, number, number], end: [year, month, 8] as [number, number, number], days: 2, status: 'APPROVED', markLeave: true },
    { empIdx: 19, type: 'SICK', start: [year, month, 14] as [number, number, number], end: [year, month, 14] as [number, number, number], days: 1, status: 'APPROVED', markLeave: true },
    { empIdx: 20, type: 'ANNUAL', start: [year, month, 26] as [number, number, number], end: [year, month, 28] as [number, number, number], days: 3, status: 'PENDING', markLeave: false },
  ];
}
function absentSpecsFor(year: number, month: number): Array<{ empIdx: number; dates: [number, number, number][] }> {
  return [
    { empIdx: 7, dates: [[year, month, 3], [year, month, 4]] },
    { empIdx: 13, dates: [[year, month, 9]] },
    { empIdx: 21, dates: [[year, month, 15]] }, // Oman
  ];
}
function otSpecsFor(year: number, month: number) {
  return [
    { empIdx: 0, day: [year, month, 8] as [number, number, number], hours: 2, otType: 'REGULAR', status: 'APPROVED', food: 150 },
    { empIdx: 1, day: [year, month, 15] as [number, number, number], hours: 3, otType: 'LATE', status: 'APPROVED', food: 150 },
    { empIdx: 2, day: [year, month, 20] as [number, number, number], hours: 4, otType: 'DOUBLE', status: 'APPROVED', food: 300 },
    { empIdx: 3, day: [year, month, 22] as [number, number, number], hours: 2, otType: 'DOUBLE_LATE', status: 'PENDING', food: 150 },
    { empIdx: 4, day: [year, month, 11] as [number, number, number], hours: 1.5, otType: 'REGULAR', status: 'REJECTED', food: 0 },
    { empIdx: 5, day: [year, month, 18] as [number, number, number], hours: 2, otType: 'LATE', status: 'CANCELLED', food: 0 },
    { empIdx: 6, day: [year, month, 24] as [number, number, number], hours: 3, otType: 'REGULAR', status: 'APPROVED', food: 150 },
    // Oman branch — food allowance in OMR (small local values).
    { empIdx: 18, day: [year, month, 9] as [number, number, number], hours: 2, otType: 'REGULAR', status: 'APPROVED', food: 5 },
    { empIdx: 19, day: [year, month, 16] as [number, number, number], hours: 3, otType: 'LATE', status: 'APPROVED', food: 5 },
    { empIdx: 20, day: [year, month, 23] as [number, number, number], hours: 4, otType: 'DOUBLE', status: 'APPROVED', food: 8 },
  ];
}
function reimbSpecsFor(year: number, month: number) {
  return [
    { empIdx: 0, type: 'Travel', amount: 4500, status: 'APPROVED', date: [year, month, 6] as [number, number, number] },
    { empIdx: 1, type: 'Medical', amount: 2200, status: 'APPROVED', date: [year, month, 9] as [number, number, number] },
    { empIdx: 2, type: 'Food', amount: 800, status: 'APPROVED', date: [year, month, 14] as [number, number, number] },
    { empIdx: 3, type: 'Office Supplies', amount: 1500, status: 'PENDING', date: [year, month, 19] as [number, number, number] },
    { empIdx: 4, type: 'Other', amount: 1200, status: 'REJECTED', date: [year, month, 21] as [number, number, number] },
    { empIdx: 5, type: 'Travel', amount: 3000, status: 'CANCELLED', date: [year, month, 3] as [number, number, number] },
    { empIdx: 6, type: 'Medical', amount: 5000, status: 'PAID', date: [year, month, 15] as [number, number, number] },
    // Oman branch — amounts in OMR.
    { empIdx: 21, type: 'Travel', amount: 120, status: 'APPROVED', date: [year, month, 10] as [number, number, number] },
    { empIdx: 22, type: 'Medical', amount: 80, status: 'PENDING', date: [year, month, 17] as [number, number, number] },
  ];
}

@Injectable()
export class SampleDataService {
  private readonly logger = new Logger(SampleDataService.name);

  constructor(
    private prisma: PrismaService,
    private payrolls: PayrollsService,
  ) {}

  /** Is sample data currently present? (reads the marker). */
  async status(): Promise<{ seeded: boolean; seededAt?: string; counts?: any }> {
    const marker = await this.prisma.systemSetting.findUnique({
      where: { key: SAMPLE_MARKER_KEY },
    });
    if (!marker) return { seeded: false };
    try {
      const parsed = JSON.parse(marker.value);
      return { seeded: true, seededAt: parsed.seededAt, counts: parsed.counts };
    } catch {
      return { seeded: true };
    }
  }

  /**
   * Seed the comprehensive sample dataset, emitting friendly progress updates via
   * `onProgress`. Idempotent (re-runnable). Wrapped in `runWithBranchBypass` so
   * the branch-scoping middleware never narrows the writes/deletes to one branch.
   */
  async seedSample(onProgress: ProgressFn = () => {}): Promise<{ counts: Record<string, number> }> {
    const rng = mulberry32(20260608); // constant seed => identical data every run
    let step = 0;
    const say = (message: string) => {
      step += 1;
      onProgress({ type: 'step', message, step, total: TOTAL_STEPS });
      this.logger.log(`[sample-seed] ${message}`);
    };
    const info = (message: string) => onProgress({ type: 'info', message });

    return runWithBranchBypass(async () => {
      const prisma = this.prisma;

      say('Preparing a clean slate…');
      await resetSampleChildren(prisma);

      say('Setting up the project workflow…');
      let workflow = await prisma.workflow.findFirst({ where: { isDefault: true } });
      if (!workflow) {
        workflow = await prisma.workflow.create({
          data: {
            name: 'SMP Sample Workflow',
            description: 'Sample kanban workflow',
            statuses: {
              create: [
                { name: 'To Do', color: '#64748B', category: 'TODO', position: 0, isDefault: true },
                { name: 'In Progress', color: '#00358F', category: 'IN_PROGRESS', position: 1 },
                { name: 'In Review', color: '#f66600', category: 'IN_PROGRESS', position: 2 },
                { name: 'Done', color: '#16A34A', category: 'DONE', position: 3 },
              ],
            },
          },
        });
      }
      const statuses = await prisma.projectTaskStatus.findMany({
        where: { workflowId: workflow.id },
        orderBy: { position: 'asc' },
      });
      const colTodo = statuses.find((s) => s.category === 'TODO') ?? statuses[0];
      const colDone = statuses.find((s) => s.category === 'DONE') ?? statuses[statuses.length - 1];
      const inProg = statuses.filter((s) => s.category === 'IN_PROGRESS');
      const colInProgress = inProg[0] ?? colTodo;
      const colInReview = inProg[1] ?? inProg[0] ?? colTodo;
      const colFor = (status: string) =>
        status === 'COMPLETED' ? colDone
          : status === 'IN_PROGRESS' ? colInProgress
            : status === 'IN_REVIEW' ? colInReview
              : colTodo;

      say(`Creating ${DEPARTMENTS.length} departments…`);
      const deptIds: string[] = [];
      for (const d of DEPARTMENTS) {
        const dept = await prisma.department.upsert({
          where: { code: d.code },
          update: { name: d.name, description: d.description, isActive: true },
          create: { code: d.code, name: d.name, description: d.description, isActive: true },
        });
        deptIds.push(dept.id);
      }
      await prisma.department.update({ where: { id: deptIds[5] }, data: { parentId: deptIds[0] } });
      await prisma.department.update({ where: { id: deptIds[2] }, data: { parentId: deptIds[1] } });

      say(`Opening ${BRANCHES.length} branches…`);
      const branchIds: string[] = [];
      for (const b of BRANCHES) {
        const branch = await prisma.branch.upsert({
          where: { code: b.code },
          update: {
            name: b.name, city: b.city, state: b.state, country: b.country,
            timezone: b.timezone, officeStartTime: b.officeStartTime, officeEndTime: b.officeEndTime,
            weeklyOffDays: b.weeklyOffDays,
            latitude: b.latitude, longitude: b.longitude, geofencingEnabled: false, geofenceRadiusM: 200,
            isActive: true,
          },
          create: {
            code: b.code, name: b.name, description: `Sample branch — ${b.city}`,
            city: b.city, state: b.state, country: b.country,
            timezone: b.timezone, officeStartTime: b.officeStartTime, officeEndTime: b.officeEndTime,
            weeklyOffDays: b.weeklyOffDays,
            latitude: b.latitude, longitude: b.longitude, geofencingEnabled: false, geofenceRadiusM: 200,
            isActive: true,
          },
        });
        branchIds.push(branch.id);
      }

      say(`Hiring ${EMPLOYEE_COUNT} employees…`);
      const employees: Emp[] = [];
      for (let i = 0; i < EMPLOYEE_COUNT; i++) {
        const branchIndex = Math.floor(i / PER_BRANCH);
        const deptIndex = i % DEPARTMENTS.length;
        const first = FIRST_NAMES[i];
        const last = LAST_NAMES[i];
        const email = sampleEmail(`${first}.${last}`.toLowerCase());
        const position = POSITIONS_BY_DEPT[deptIndex];
        const isOman = branchIndex === 3;
        // Oman salaries are OMR-realistic (~400–2100, under the OM PASI cap of
        // 3000); the other branches keep the original INR-scale figures. Currency
        // itself is a single global setting, so these are stored as plain numbers.
        const baseSalary = isOman
          ? 400 + deptIndex * 220 + randInt(rng, 0, 8) * 80
          : 40000 + deptIndex * 5000 + branchIndex * 3000 + randInt(rng, 0, 8) * 1000;
        // Both branches of this must be dialable: WhatsApp delivery normalises
        // Employee.phone to E.164 and drops anything invalid. The India form
        // needs ten national digits (5 + 5) — the previous `+91-90000-NNN0`
        // produced only nine and was rejected by every phone-number validator.
        const phone = isOman ? `+968-9${pad3(i + 1)}-0000` : `+91-90000-${pad3(i + 1)}00`;
        const gender = i % 2 === 0 ? 'MALE' : 'FEMALE';
        const dateOfBirth = new Date(Date.UTC(1985 + (i % 12), (i * 2) % 12, 1 + (i % 27)));
        const startDate = new Date(Date.UTC(2022 + (i % 3), (i * 3) % 12, 1 + (i % 27)));
        const created = await prisma.employee.upsert({
          where: { email },
          update: {
            fullName: `${first} ${last}`, position, baseSalary,
            departmentId: deptIds[deptIndex], branchId: branchIds[branchIndex], status: 'ACTIVE',
          },
          create: {
            employeeCode: `${SMP}EMP-${pad3(i + 1)}`,
            fullName: `${first} ${last}`, email, idCard: `${SMP}ID-${pad3(i + 1)}`,
            dateOfBirth, gender, phone,
            position, departmentId: deptIds[deptIndex], branchId: branchIds[branchIndex],
            startDate, baseSalary, status: 'ACTIVE', hasCompleteProfile: true,
          },
        });
        employees.push({
          id: created.id, index: i, branchIndex, deptIndex, email,
          fullName: `${first} ${last}`, baseSalary, startDate,
          leaveDates: new Set(), absentDates: new Set(),
        });
      }

      // Managers (resolves the parent<->employee cycle)
      for (let d = 0; d < DEPARTMENTS.length; d++) {
        await prisma.department.update({ where: { id: deptIds[d] }, data: { managerId: employees[d].id } });
      }
      for (let b = 0; b < BRANCHES.length; b++) {
        await prisma.branch.update({ where: { id: branchIds[b] }, data: { managerId: employees[b * PER_BRANCH].id } });
      }

      say(`Creating login accounts for all ${EMPLOYEE_COUNT} employees…`);
      const password = await bcrypt.hash('Password123!', 10);
      const userIdByEmpIdx: Record<number, string> = {};
      const makeUser = async (emp: Emp, role: string) => {
        const user = await prisma.user.upsert({
          where: { email: emp.email },
          update: { passwordHash: password, role, isActive: true, isEmailVerified: true },
          create: {
            email: emp.email, passwordHash: password, role, employeeId: emp.id,
            isActive: true, isEmailVerified: true, isGlobalBranchAccess: false,
          },
        });
        const grantBranches = role === 'HR_MANAGER' ? branchIds : [branchIds[emp.branchIndex]];
        for (const branchId of grantBranches) {
          await prisma.userBranchAccess.upsert({
            where: { userId_branchId: { userId: user.id, branchId } },
            update: {},
            create: { userId: user.id, branchId },
          });
        }
        userIdByEmpIdx[emp.index] = user.id;
        return user;
      };
      // Everyone gets a login, so every self-service page ("My leaves", "My
      // assets", "My travel", …) has a real account to demo from. Department
      // managers and branch managers get MANAGER so the manager-scoped views are
      // exercisable; index 4 (People & Culture) is the HR approver.
      const hrUser = await makeUser(employees[4], 'HR_MANAGER');
      const managerIdxs = new Set([0, 1, 2, 3, 5, 6, 12, 18]);
      for (const emp of employees) {
        if (emp.index === 4) continue;
        await makeUser(emp, managerIdxs.has(emp.index) ? 'MANAGER' : 'EMPLOYEE');
      }
      const hrUserId = hrUser.id;
      info('Logins: every sample employee signs in with password "Password123!"');

      say('Generating employment contracts…');
      const contractTypes = ['PROBATION', 'FIXED_TERM', 'INDEFINITE'] as const;
      for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        const contractType = contractTypes[i % contractTypes.length];
        const workType = i % 5 === 0 ? 'PART_TIME' : 'FULL_TIME';
        const contractNumber = `${SMP}CTR-${pad3(i + 1)}`;
        const endDate = contractType === 'INDEFINITE' ? null : new Date(Date.UTC(2027, 11, 31));
        await prisma.contract.upsert({
          where: { contractNumber },
          update: { salary: emp.baseSalary, status: 'ACTIVE', contractType, workType, endDate },
          create: {
            employeeId: emp.id, contractType, workType,
            workHoursPerWeek: workType === 'PART_TIME' ? 20 : 40,
            contractNumber, startDate: emp.startDate, endDate,
            salary: emp.baseSalary, status: 'ACTIVE', terms: 'Standard employment terms.',
          },
        });
      }

      // Component-based pay for everyone, so the salary-structure screen is
      // populated for any employee the demo opens. The 60/25/15 split works at
      // any scale (INR figures and OMR figures alike).
      for (const emp of employees) {
        const basic = Math.round(emp.baseSalary * 0.6);
        const housing = Math.round(emp.baseSalary * 0.25);
        const transport = emp.baseSalary - basic - housing;
        await prisma.salaryComponent.createMany({
          data: [
            { employeeId: emp.id, componentType: 'BASIC', amount: basic, effectiveDate: emp.startDate, isActive: true },
            { employeeId: emp.id, componentType: 'HOUSING', amount: housing, effectiveDate: emp.startDate, isActive: true },
            { employeeId: emp.id, componentType: 'TRANSPORT', amount: transport, effectiveDate: emp.startDate, isActive: true },
          ],
        });
      }

      // Intelligently target the previous month AND the current month from the
      // real clock, then seed a full working-month of data for each.
      const now = new Date();
      const currentYear = now.getUTCFullYear();
      const cur = { year: currentYear, month: now.getUTCMonth() + 1 };
      const prevD = new Date(Date.UTC(cur.year, cur.month - 2, 1));
      const prev = { year: prevD.getUTCFullYear(), month: prevD.getUTCMonth() + 1 };
      const monthsToSeed = [prev, cur];
      const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const monthLabel = (m: { year: number; month: number }) => `${MONTH_NAMES[m.month - 1]} ${m.year}`;

      // Oman branch-scoped public holiday — demonstrates per-branch holidays end
      // to end (only the Muscat branch loses this working day; India/US branches
      // are unaffected). Idempotent: the Muscat branch is sample-only, so clearing
      // its holidays before re-creating is safe. Renaissance Day (23 Jul) lands in
      // the current seeded month.
      const omanBranchId = branchIds[3];
      await prisma.holiday.deleteMany({ where: { branchId: omanBranchId } });
      await prisma.holiday.create({
        data: {
          name: 'Renaissance Day', date: dU([currentYear, 7, 23]), year: currentYear,
          isRecurring: true, branchId: omanBranchId,
          description: 'Oman national holiday (sample, branch-scoped).',
        },
      });

      // Leave balances (current year).
      for (const emp of employees) {
        await prisma.leaveBalance.upsert({
          where: { employeeId_year: { employeeId: emp.id, year: currentYear } },
          update: {},
          create: {
            employeeId: emp.id, year: currentYear, annualLeave: 12, sickLeave: 30,
            usedAnnual: randInt(rng, 0, 4), usedSick: randInt(rng, 0, 3), carriedOver: randInt(rng, 0, 5),
          },
        });
      }

      // Attendance + shifts accumulate across both months, then bulk-insert once.
      const attendanceRows: any[] = [];
      const scheduleRows: any[] = [];

      for (const m of monthsToSeed) {
        // Per-branch working-day calendars: the Oman branch runs Sun–Thu and drops
        // its own branch-scoped holiday (Renaissance Day), so its seeded attendance
        // must line up with what the payroll engine (HolidaysService, branch-aware)
        // will count for that branch.
        const workingDaysByBranch: Date[][] = [];
        const workingDaySetByBranch: Set<string>[] = [];
        for (let bi = 0; bi < BRANCHES.length; bi++) {
          const wd = await getSampleWorkingDays(prisma, m.month, m.year, {
            branchId: branchIds[bi],
            weeklyOffDays: BRANCHES[bi].weeklyOffDays,
          });
          workingDaysByBranch.push(wd);
          workingDaySetByBranch.push(new Set(wd.map(isoDay)));
        }
        const workingSetForEmp = (emp: Emp) => workingDaySetByBranch[emp.branchIndex];

        // Fresh per-month LEAVE / ABSENT marks (keyed by full date, so months never
        // collide). Each mark is validated against the employee's OWN branch calendar.
        for (const emp of employees) { emp.leaveDates.clear(); emp.absentDates.clear(); }
        const leaveSpecs = leaveSpecsFor(m.year, m.month);
        for (const s of leaveSpecs) {
          if (!s.markLeave) continue;
          const set = workingSetForEmp(employees[s.empIdx]);
          for (const day of eachDay(dU(s.start), dU(s.end))) {
            if (set.has(isoDay(day))) employees[s.empIdx].leaveDates.add(isoDay(day));
          }
        }
        for (const a of absentSpecsFor(m.year, m.month)) {
          const set = workingSetForEmp(employees[a.empIdx]);
          for (const d of a.dates) {
            const key = isoDay(dU(d));
            if (set.has(key)) employees[a.empIdx].absentDates.add(key);
          }
        }

        say(`Recording ${monthLabel(m)} attendance & shifts (${workingDaysByBranch[0].length} working days, Oman ${workingDaysByBranch[3].length})…`);
        for (const emp of employees) {
          const workingDays = workingDaysByBranch[emp.branchIndex];
          const shift = SHIFT_TYPES[emp.index % SHIFT_TYPES.length];
          const branch = BRANCHES[emp.branchIndex];
          const [sh, sm] = branch.officeStartTime.split(':').map(Number);
          const [eh, em] = branch.officeEndTime.split(':').map(Number);
          for (const day of workingDays) {
            const key = isoDay(day);
            const sched: any = { employeeId: emp.id, date: day, shiftType: shift, isWorkDay: true };
            if (shift === 'FLEXIBLE') {
              sched.requiredHours = 8;
            } else if (shift === 'MORNING') {
              sched.startTime = atTime(day, 8, 0); sched.endTime = atTime(day, 12, 0);
            } else if (shift === 'AFTERNOON') {
              sched.startTime = atTime(day, 13, 0); sched.endTime = atTime(day, 17, 0);
            } else {
              sched.startTime = atTime(day, sh, sm); sched.endTime = atTime(day, eh, em);
            }
            scheduleRows.push(sched);

            if (emp.leaveDates.has(key)) {
              attendanceRows.push({ employeeId: emp.id, date: day, status: 'LEAVE', branchId: branchIds[emp.branchIndex] });
              continue;
            }
            if (emp.absentDates.has(key)) {
              attendanceRows.push({ employeeId: emp.id, date: day, status: 'ABSENT', branchId: branchIds[emp.branchIndex] });
              continue;
            }
            // Standard clock-in is a tight band just after the branch's office
            // start (Muscat 08:00 → 08:00-08:12), not a wide random spread: a
            // demo roster where everyone drifts in at a different half-hour
            // reads as broken data. A deterministic minority arrive late so the
            // "Going late today" card still has something to show; the cutoff
            // matches AttendancesService.LATE_THRESHOLD (15 min grace).
            const arrivesLate = randInt(rng, 0, 99) < 15;
            const checkIn = arrivesLate
              ? atZonedTime(day, branch.timezone, sh, sm + randInt(rng, 25, 50))
              : atZonedTime(day, branch.timezone, sh, sm + randInt(rng, 0, 12));
            const checkOut = atZonedTime(day, branch.timezone, eh, em + randInt(rng, -10, 45));
            const workHours = Math.round(((checkOut.getTime() - checkIn.getTime()) / 3_600_000) * 100) / 100;
            const isLate =
              checkIn.getTime() - atZonedTime(day, branch.timezone, sh, sm).getTime() > 15 * 60_000;
            attendanceRows.push({
              employeeId: emp.id, date: day, checkIn, checkOut, workHours, isLate,
              status: 'PRESENT', branchId: branchIds[emp.branchIndex],
            });
          }
        }

        say(`Adding ${monthLabel(m)} leave, overtime & reimbursements…`);
        for (const s of leaveSpecs) {
          const emp = employees[s.empIdx];
          const decided = s.status === 'APPROVED' || s.status === 'REJECTED';
          const lr = await prisma.leaveRequest.create({
            data: {
              employeeId: emp.id, leaveType: s.type,
              startDate: dU(s.start), endDate: dU(s.end), totalDays: s.days,
              reason: `${s.type} leave request`, status: s.status,
              approverId: decided ? hrUserId : null,
              approvedAt: s.status === 'APPROVED' ? new Date() : null,
              rejectedReason: s.status === 'REJECTED' ? 'Insufficient balance for the requested period.' : null,
            },
          });
          await prisma.leaveApproval.create({
            data: {
              leaveRequestId: lr.id, approverId: hrUserId, tier: 2,
              status: s.status === 'APPROVED' ? 'APPROVED' : s.status === 'REJECTED' ? 'REJECTED' : 'PENDING',
              comment: decided ? 'Reviewed by HR.' : null,
              decidedAt: decided ? new Date() : null,
            },
          });
        }
        for (const o of otSpecsFor(m.year, m.month)) {
          const day = dU(o.day);
          const startTime = atTime(day, 18, 30);
          const endTime = new Date(startTime.getTime() + o.hours * 3_600_000);
          const decided = o.status === 'APPROVED' || o.status === 'REJECTED';
          await prisma.overtimeRequest.create({
            data: {
              employeeId: employees[o.empIdx].id, date: day, startTime, endTime,
              hours: o.hours, foodAllowance: o.food, otType: o.otType,
              reason: 'Sprint delivery / production support', status: o.status,
              approverId: decided ? hrUserId : null,
              approvedAt: o.status === 'APPROVED' ? new Date() : null,
              rejectedReason: o.status === 'REJECTED' ? 'Not pre-approved by manager.' : null,
            },
          });
        }
        for (const r of reimbSpecsFor(m.year, m.month)) {
          const approved = r.status === 'APPROVED' || r.status === 'PAID';
          await prisma.reimbursement.create({
            data: {
              employeeId: employees[r.empIdx].id, type: r.type, amount: r.amount,
              expenseDate: dU(r.date), description: `${r.type} expense claim`, status: r.status,
              approverId: approved || r.status === 'REJECTED' ? hrUserId : null,
              approvedAt: approved ? new Date() : null,
              approverRemarks: r.status === 'APPROVED' ? 'Approved for reimbursement.' : null,
              rejectedReason: r.status === 'REJECTED' ? 'Missing receipt.' : null,
              paidAt: r.status === 'PAID' ? new Date() : null,
            },
          });
        }
      }

      await prisma.workSchedule.createMany({ data: scheduleRows });
      await prisma.attendance.createMany({ data: attendanceRows });

      say('Setting up salary advances & loans…');
      const alSpecs = [
        { empIdx: 0, type: 'LOAN', amount: 60000, installments: 12, status: 'APPROVED' },
        { empIdx: 1, type: 'ADVANCE', amount: 10000, installments: 1, status: 'APPROVED' },
        { empIdx: 2, type: 'LOAN', amount: 24000, installments: 6, status: 'APPROVED' },
        { empIdx: 3, type: 'ADVANCE', amount: 8000, installments: 1, status: 'PENDING' },
        { empIdx: 4, type: 'LOAN', amount: 30000, installments: 10, status: 'REJECTED' },
        { empIdx: 5, type: 'ADVANCE', amount: 5000, installments: 1, status: 'CANCELLED' },
        { empIdx: 6, type: 'LOAN', amount: 12000, installments: 6, status: 'COMPLETED' },
        // Oman branch — amounts in OMR.
        { empIdx: 18, type: 'ADVANCE', amount: 300, installments: 1, status: 'APPROVED' },
        { empIdx: 19, type: 'LOAN', amount: 1200, installments: 6, status: 'APPROVED' },
      ] as const;
      for (const a of alSpecs) {
        const completed = a.status === 'COMPLETED';
        const hasPlan = a.status === 'APPROVED' || completed;
        const installmentAmount = a.type === 'LOAN' ? Math.round(a.amount / a.installments) : a.amount;
        await prisma.advanceLoanRequest.create({
          data: {
            employeeId: employees[a.empIdx].id, type: a.type, amount: a.amount,
            reason: `${a.type === 'LOAN' ? 'Personal loan' : 'Salary advance'} request`,
            status: a.status, installments: a.installments,
            installmentAmount: hasPlan ? installmentAmount : null,
            amountRepaid: completed ? a.amount : 0,
            approverId: hasPlan || a.status === 'REJECTED' ? hrUserId : null,
            approvedAt: hasPlan ? new Date() : null,
            approverRemarks: a.status === 'APPROVED' ? 'Approved; recovered via payroll.' : null,
            rejectedReason: a.status === 'REJECTED' ? 'Exceeds allowed limit.' : null,
            completedAt: completed ? new Date() : null,
          },
        });
      }

      say('Running payroll (draft) for the previous & current month…');
      // ONE BATCH AND ONE RUN PER BRANCH, not one company-wide run.
      //
      // A run with no branch is a dead end for the wage file: `WpsPayloadBuilder`
      // refuses it outright — "this payroll is not attached to a branch (a legacy
      // company-wide run), so no wage file can be produced for it" — because a
      // run spanning countries and currencies cannot map to one employer's file.
      // Seeding company-wide runs therefore made the whole Oman WPS flow
      // unreachable from a freshly seeded database.
      //
      // `PayrollsService.create` stamps the branch from the request's branch
      // context, and a seed has none (it runs under `runWithBranchBypass`), so
      // the branch is stamped here instead. That is sound because the run's
      // population was already restricted to that branch by its batch — every
      // item belongs to the branch being stamped.
      for (let b = 0; b < branchIds.length; b++) {
        // One employee is deliberately left branch-less later in the seed as a
        // data-quality example. On a per-branch run that person is a BLOCKING
        // `NOT_IN_BRANCH` finding — "is not in branch X but appears on its
        // payroll" — which stops the branch's wage file, so they are not paid
        // through a branch run at all.
        const branchEmployees = employees.filter(
          (e) => e.branchIndex === b && e.index !== NO_BRANCH_EMPLOYEE_INDEX,
        );
        if (branchEmployees.length === 0) continue;
        const batch = await prisma.payrollBatch.create({
          data: {
            name: `${SAMPLE_BATCH_NAME} — ${BRANCHES[b].code}`,
            description: `Sample DRAFT payroll for ${BRANCHES[b].name} — ${monthLabel(prev)} & ${monthLabel(cur)}.`,
            isActive: true,
            createdBy: hrUserId,
            branchId: branchIds[b],
          },
        });
        await prisma.payrollBatchMember.createMany({
          data: branchEmployees.map((e) => ({ batchId: batch.id, employeeId: e.id })),
        });
        for (const m of monthsToSeed) {
          await this.payrolls.create({ month: m.month, year: m.year, batchId: batch.id });
        }
        await prisma.payroll.updateMany({
          where: { batchId: batch.id, branchId: null },
          data: { branchId: branchIds[b] },
        });
      }

      say('Building sample projects, tasks & subtasks…');
      const projectSpecs = [
        // `endsInDays` is deliberately one of each: past (overdue), inside the
        // 30-day window (due soon), and absent. No seeded project carried an end
        // date at all, so BOTH project-health figures were structurally zero and
        // the "no end date" footnote covered the whole estate — the card could
        // never say anything, true or false.
        { code: `${SMP}P1`, name: 'HRMS Revamp', slug: 'smp-hrms-revamp', taskPrefix: 'HRMS', deptIndex: 0, status: 'ACTIVE', priority: 'HIGH', memberIdxs: [0, 1, 2, 3, 4, 5], ownerIdx: 0, endsInDays: -12 },
        { code: `${SMP}P2`, name: 'Mobile App', slug: 'smp-mobile-app', taskPrefix: 'APP', deptIndex: 5, status: 'PLANNING', priority: 'MEDIUM', memberIdxs: [6, 7, 8, 9, 10, 11, 12], ownerIdx: 6, endsInDays: 21 },
        { code: `${SMP}P3`, name: 'Muscat Rollout', slug: 'smp-muscat-rollout', taskPrefix: 'MCT', deptIndex: 0, status: 'ACTIVE', priority: 'MEDIUM', memberIdxs: [18, 19, 20, 21, 22, 23], ownerIdx: 18, endsInDays: null },
      ] as const;
      const taskTemplates = [
        { title: 'Set up CI/CD pipeline', status: 'IN_PROGRESS', priority: 'HIGH', type: 'TASK' },
        { title: 'Design payroll schema', status: 'COMPLETED', priority: 'CRITICAL', type: 'STORY' },
        { title: 'Fix attendance timezone bug', status: 'TODO', priority: 'HIGH', type: 'BUG' },
        { title: 'Employee onboarding flow', status: 'IN_REVIEW', priority: 'MEDIUM', type: 'STORY' },
        { title: 'Leave approval notifications', status: 'TODO', priority: 'MEDIUM', type: 'TASK' },
        { title: 'Q3 platform epic', status: 'IN_PROGRESS', priority: 'HIGH', type: 'EPIC' },
      ] as const;
      let taskCounter = 1;
      const seededProjects: ExtrasProject[] = [];
      for (const spec of projectSpecs) {
        const project = await prisma.project.create({
          data: {
            projectCode: spec.code, name: spec.name, slug: spec.slug, taskPrefix: spec.taskPrefix,
            description: `${spec.name} — sample project.`, status: spec.status, priority: spec.priority,
            visibility: 'INTERNAL', startDate: dU([2026, 5, 1]),
            endDate: spec.endsInDays === null ? null : dayFromToday(spec.endsInDays),
            workflowId: workflow.id, departmentId: deptIds[spec.deptIndex],
            ownerId: employees[spec.ownerIdx].id, createdById: hrUserId,
            roles: { create: presetRolesCreateData() },
          },
        });
        const roles = await prisma.projectRole.findMany({ where: { projectId: project.id } });
        const roleIdBySlug = Object.fromEntries(roles.map((r) => [r.slug, r.id]));
        for (let m = 0; m < spec.memberIdxs.length; m++) {
          const emp = employees[spec.memberIdxs[m]];
          const role = m === 0 ? 'OWNER' : m === 1 ? 'MANAGER' : m === spec.memberIdxs.length - 1 ? 'VIEWER' : 'MEMBER';
          await prisma.projectMember.create({
            data: { projectId: project.id, employeeId: emp.id, role, roleId: roleIdBySlug[role.toLowerCase()] ?? null },
          });
        }
        const sprint = await prisma.sprint.create({
          data: {
            name: 'Sprint 1', slug: 'sprint-1', goal: 'Deliver the MVP slice.',
            status: 'ACTIVE', projectId: project.id, startDate: dU([2026, 6, 1]), endDate: dU([2026, 6, 14]),
          },
        });
        const labelFeature = await prisma.label.create({ data: { name: 'feature', color: '#22c55e', projectId: project.id } });
        const labelBug = await prisma.label.create({ data: { name: 'bug', color: '#ef4444', projectId: project.id } });
        const projectTaskIds: string[] = [];
        for (let t = 0; t < taskTemplates.length; t++) {
          const tmpl = taskTemplates[t];
          const assignee = employees[spec.memberIdxs[t % spec.memberIdxs.length]];
          const task = await prisma.task.create({
            data: {
              taskCode: `${SMP}T-${pad3(taskCounter++)}`,
              title: tmpl.title, description: `${tmpl.title} for ${spec.name}.`,
              priority: tmpl.priority, status: tmpl.status, type: tmpl.type,
              projectId: project.id, statusId: colFor(tmpl.status).id, sprintId: sprint.id,
              reporterId: employees[spec.ownerIdx].id, dueDate: dU([2026, 6, 15 + t]),
              storyPoints: (t % 3) + 1,
              assignees: { connect: [{ id: assignee.id }] },
            },
          });
          projectTaskIds.push(task.id);
          await prisma.taskLabel.create({ data: { taskId: task.id, labelId: t % 2 === 0 ? labelFeature.id : labelBug.id } });
          if (t === 0) {
            await prisma.taskComment.create({ data: { taskId: task.id, userId: hrUserId, comment: 'Please prioritize this for the current sprint.' } });
          }
          if (t < 2) {
            for (let k = 0; k < 2; k++) {
              const subAssignee = employees[spec.memberIdxs[(t + k + 1) % spec.memberIdxs.length]];
              await prisma.task.create({
                data: {
                  taskCode: `${SMP}T-${pad3(taskCounter++)}`,
                  title: `${tmpl.title} — subtask ${k + 1}`,
                  priority: 'MEDIUM', status: 'TODO', type: 'SUBTASK',
                  projectId: project.id, statusId: colTodo.id, sprintId: sprint.id,
                  parentTaskId: task.id, reporterId: employees[spec.ownerIdx].id,
                  assignees: { connect: [{ id: subAssignee.id }] },
                },
              });
            }
          }
        }
        seededProjects.push({
          id: project.id,
          name: spec.name,
          taskIds: projectTaskIds,
          memberIdxs: spec.memberIdxs,
        });
      }

      // Spread the payroll runs across the approval lifecycle so the payroll
      // approvals inbox is not permanently empty: the older run is already
      // approved, the newest is awaiting a decision.
      // Per BRANCH, not across the whole estate: the runs are per-branch now, so
      // ordering them globally would leave one branch's newest run approved and
      // another's oldest awaiting a decision.
      const sampleBatches = await prisma.payrollBatch.findMany({
        where: { name: { startsWith: SAMPLE_BATCH_NAME } },
        select: { id: true },
      });
      for (const b of sampleBatches) {
        const samplePayrolls = await prisma.payroll.findMany({
          where: { batchId: b.id },
          orderBy: [{ year: 'asc' }, { month: 'asc' }],
        });
        for (let i = 0; i < samplePayrolls.length; i++) {
          const isLast = i === samplePayrolls.length - 1;
          await prisma.payroll.update({
            where: { id: samplePayrolls[i].id },
            data: isLast
              ? { status: 'PENDING_APPROVAL', submittedAt: new Date(), submittedBy: hrUserId }
              : {
                  status: 'APPROVED',
                  submittedAt: new Date(),
                  submittedBy: hrUserId,
                  approvedBy: hrUserId,
                  approvedAt: new Date(),
                },
          });
        }
      }

      // Everything the core seed does not reach: assets, travel, training,
      // budgets, banking, letters, grievances, documents, visas, teams,
      // timesheets, appraisals, approvals, notifications and audit history.
      await seedSampleExtras({
        prisma: prisma as any,
        employees,
        deptIds,
        branchIds,
        userIdByEmpIdx,
        hrUserId,
        projects: seededProjects,
        statuses: statuses.map((s) => ({ id: s.id, name: s.name, category: String(s.category) })),
        months: monthsToSeed,
        rng,
        say,
        info,
      });

      // The hub dashboards read aggregates the core seed never produces —
      // LOCKED payroll runs, gratuity, settlements, wage files, loan
      // amortisation, this month's joiners, roster conflicts. Without this the
      // demo opens on a row of zeroes.
      await seedDemoFill({
        prisma: prisma as any,
        employees,
        deptIds,
        branchIds,
        userIdByEmpIdx,
        hrUserId,
        projects: seededProjects,
        statuses: statuses.map((s) => ({ id: s.id, name: s.name, category: String(s.category) })),
        months: monthsToSeed,
        rng,
        say,
        info,
      });

      // Oman is the branch the wage-file flow is demonstrated on, and it has to
      // run LAST: it repairs the payment details the extras seed wrote, decides
      // any bank change still open, and itemises the payslips demo-fill locked.
      const muscat = await seedMuscatPayrollDemo(prisma as any, {
        year: monthsToSeed[monthsToSeed.length - 1].year,
        say,
        info,
      });

      // The screens either side of payroll: approvals, loans, the ledger, the
      // onboarding queue. Runs after the payroll pass because several of its
      // rows hang off what that one creates (journal entries off loan
      // transactions, approval-state runs off the branch's batch).
      const muscatExtra = await seedMuscatCoverage(prisma as any, {
        period: monthsToSeed[monthsToSeed.length - 1],
        say,
        info,
      });

      say('Finishing up…');
      const counts = { ...(await this.collectCounts()), ...muscat, ...muscatExtra };
      await prisma.systemSetting.upsert({
        where: { key: SAMPLE_MARKER_KEY },
        update: { value: JSON.stringify({ seededAt: new Date().toISOString(), version: 1, counts }) },
        create: { key: SAMPLE_MARKER_KEY, value: JSON.stringify({ seededAt: new Date().toISOString(), version: 1, counts }) },
      });

      onProgress({ type: 'done', message: 'Sample data is ready — explore away!', data: { counts } });
      this.logger.warn('✅ Sample dataset seeded.');
      return { counts };
    });
  }

  private async collectCounts(): Promise<Record<string, number>> {
    const ofEmp = sampleFilters.ofSampleEmployee;
    const [
      employees, departments, branches, attendance, leaveRequests, overtime,
      reimbursements, advancesLoans, payrollItems, projects, tasks,
      teams, assets, travelRequests, trainingNominations, budgetLines,
      bankDetails, letters, grievances, documents, visas, rewards, disciplines,
      timesheets, workLogs, corrections, appraisalResults, notifications, auditLogs,
    ] = await Promise.all([
      this.prisma.employee.count({ where: sampleFilters.employeeByEmail }),
      this.prisma.department.count({ where: sampleFilters.byCodePrefix }),
      this.prisma.branch.count({ where: sampleFilters.byCodePrefix }),
      this.prisma.attendance.count({ where: ofEmp }),
      this.prisma.leaveRequest.count({ where: ofEmp }),
      this.prisma.overtimeRequest.count({ where: ofEmp }),
      this.prisma.reimbursement.count({ where: ofEmp }),
      this.prisma.advanceLoanRequest.count({ where: ofEmp }),
      this.prisma.payrollItem.count({ where: { payroll: { batch: { name: { startsWith: 'SMP' } } } } }),
      this.prisma.project.count({ where: sampleFilters.projectByCodePrefix }),
      this.prisma.task.count({ where: sampleFilters.taskByCodePrefix }),
      this.prisma.team.count({ where: sampleFilters.byCodePrefix }),
      this.prisma.assetItem.count({ where: { assetTag: { startsWith: SMP } } }),
      this.prisma.travelRequest.count({ where: ofEmp }),
      this.prisma.trainingNomination.count({ where: ofEmp }),
      this.prisma.budgetLine.count({ where: { budget: { name: { startsWith: SMP } } } }),
      this.prisma.employeeBankDetail.count({ where: ofEmp }),
      this.prisma.letterRequest.count({ where: ofEmp }),
      this.prisma.grievance.count({ where: ofEmp }),
      this.prisma.employeeDocument.count({ where: ofEmp }),
      this.prisma.employeeLegalDocument.count({ where: ofEmp }),
      this.prisma.reward.count({ where: ofEmp }),
      this.prisma.discipline.count({ where: ofEmp }),
      this.prisma.timesheet.count({ where: ofEmp }),
      this.prisma.workLog.count({ where: ofEmp }),
      this.prisma.attendanceCorrection.count({ where: ofEmp }),
      this.prisma.appraisalResult.count({ where: { employeeCode: { startsWith: SMP } } }),
      this.prisma.notification.count({ where: { user: sampleFilters.userByEmail } }),
      this.prisma.auditLog.count({ where: { user: sampleFilters.userByEmail } }),
    ]);
    return {
      departments, branches, employees, attendance, leaveRequests,
      overtime, reimbursements, advancesLoans, payrollItems, projects, tasks,
      teams, assets, travelRequests, trainingNominations, budgetLines,
      bankDetails, letters, grievances, documents, visas, rewards, disciplines,
      timesheets, workLogs, corrections, appraisalResults, notifications, auditLogs,
    };
  }
}
