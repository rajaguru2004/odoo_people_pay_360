import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { OvertimeService } from '../overtime/overtime.service';
import { PayrollsService } from '../payrolls/payrolls.service';
import { HolidaysService } from '../holidays/holidays.service';
import { runWithBranchBypass } from '../common/branch/branch-context';

/**
 * Focused, demo-ready seed for the Singapore Overtime → Payroll showcase.
 *
 * Seeds 2 employees under the existing HEAD OFFICE branch and drives the *real*
 * request → approve → payroll-generation cycle so a live demo can show:
 *   1.8  Food allowance — OT 17:00–22:00 = none; OT ending after 22:00 = paid.
 *   1.11 Double OT       — 2× for all hours on Sundays / Public Holidays;
 *                          1.5× for weekday OT after the 17:00 shift end.
 *
 * Targets the CURRENT month by default (override with DEMO_MONTH / DEMO_YEAR) so
 * the attendance + payroll appear in the app's default view. Scenario dates are
 * chosen dynamically for the month (a Sunday, a public holiday, two weekdays).
 * Base salaries are derived from the actual working days so the overtime figures
 * stay clean (S$420 / S$525) regardless of the month.
 *
 * Adapts to Head Office's real working-week/holiday config (reuses
 * HolidaysService for attendance → zero loss-of-pay) and touches ONLY overtime
 * settings — the already-configured SG payroll/CPF/tax settings are untouched.
 *
 * Idempotent: re-running wipes the `DEMO-OT` namespace and reproduces the data.
 * The npm script pins TZ=UTC so the (deferred) local-time day classification in
 * OvertimeService resolves the demo dates correctly.
 */

const DOMAIN = 'demo-ot.hrms.local';
const DEPT_CODE = 'DEMO-OT-ENG';
const HOLIDAY_TAG = 'DEMO-OT seed'; // description marker → idempotent cleanup

// All date math in UTC to match the payroll engine (and the TZ=UTC run).
const dateUTC = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const atUTC = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min, 0));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

// Pay-rate multipliers by otType (mirror the overtime settings applied below).
const RATE_OF: Record<string, number> = { REGULAR: 1.5, LATE: 1.5, DOUBLE: 2.0, DOUBLE_LATE: 2.0 };

interface DemoEmployee {
  code: string;
  firstName: string;
  lastName: string;
  gender: string;
  hourly: number; // target hourly rate (SGD) → base is derived from workdays
}

const EMPLOYEES: DemoEmployee[] = [
  { code: 'DEMO-OT-001', firstName: 'Aarav', lastName: 'Tan', gender: 'MALE', hourly: 20 },
  { code: 'DEMO-OT-002', firstName: 'Bina', lastName: 'Lim', gender: 'FEMALE', hourly: 25 },
];

export interface DemoSummaryRow {
  employee: string;
  base: number;
  workDays: number;
  otHours: number;
  overtimePay: number;
  foodAllowance: number;
  cpf: number;
  tax: number;
  netSalary: number;
  ok: boolean;
}

@Injectable()
export class DemoOvertimeService {
  private readonly logger = new Logger(DemoOvertimeService.name);

  constructor(
    private prisma: PrismaService,
    private overtime: OvertimeService,
    private payrolls: PayrollsService,
    private holidays: HolidaysService,
  ) {}

  /** The n-th (1-based) occurrence of a weekday (0=Sun…6=Sat) in a month, as day-of-month. */
  private nthWeekday(year: number, month: number, weekday: number, n: number): number {
    let seen = 0;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let d = 1; d <= last; d++) {
      if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday) {
        if (++seen === n) return d;
      }
    }
    return -1;
  }

  async seedDemo(
    onStep: (msg: string) => void = () => {},
  ): Promise<{ summary: DemoSummaryRow[]; allOk: boolean; branch: string; period: string; scenarioDates: string[] }> {
    return runWithBranchBypass(async () => {
      const prisma = this.prisma;
      const say = (m: string) => {
        onStep(m);
        this.logger.log(`[demo-ot] ${m}`);
      };

      // Period: current month by default (UTC), overridable for reproducibility.
      const now = new Date();
      const YEAR = Number(process.env.DEMO_YEAR) || now.getUTCFullYear();
      const MONTH = Number(process.env.DEMO_MONTH) || now.getUTCMonth() + 1;
      const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const BATCH_NAME = `DEMO-OT ${MONTH_NAMES[MONTH - 1]} ${YEAR}`;

      say('Resetting previous DEMO-OT data…');
      await this.reset();

      say('Ensuring overtime settings (rates, thresholds, caps)…');
      await this.applyOvertimeSettings();

      say('Resolving the Head Office branch…');
      const branch = await this.resolveHeadOfficeBranch();
      say(`Using branch: ${branch.name} (${branch.code})`);

      const monthStart = dateUTC(YEAR, MONTH, 1);
      const monthEnd = dateUTC(YEAR, MONTH, new Date(Date.UTC(YEAR, MONTH, 0)).getUTCDate());
      const hpd = Number(
        (await prisma.systemSetting.findUnique({ where: { key: 'payroll_work_hours_per_day' } }))?.value || '8',
      );

      // Choose scenario days from the branch's GENUINE working days (already
      // excludes weekends AND any existing public holidays), so the weekday
      // REGULAR/LATE scenarios never accidentally land on a real holiday.
      const workingBefore = await this.holidays.getWorkingDatesBetween(monthStart, monthEnd, branch.id);
      if (workingBefore.length < 9) {
        throw new Error(`Not enough working days in ${MONTH_NAMES[MONTH - 1]} ${YEAR} to build the demo`);
      }
      const wd = workingBefore.map((d) => d.getUTCDate());
      const regularDay = wd[3];
      const lateDay = wd[wd.length - 3];
      const holidayDay = wd[Math.floor(wd.length / 2)]; // a working weekday we turn INTO a holiday
      const doubleDay = this.nthWeekday(YEAR, MONTH, 0, 3); // 3rd Sunday (a rest day)

      say(`Ensuring a public holiday on ${MONTH_NAMES[MONTH - 1]} ${holidayDay}…`);
      const holidayDate = dateUTC(YEAR, MONTH, holidayDay);
      const existingHoliday = await prisma.holiday.findFirst({
        where: { date: holidayDate, OR: [{ branchId: null }, { branchId: branch.id }] },
      });
      if (!existingHoliday) {
        await prisma.holiday.create({
          data: { name: 'Public Holiday (Demo)', date: holidayDate, year: YEAR, branchId: branch.id, description: HOLIDAY_TAG },
        });
      }

      // Working days AFTER the demo holiday — attendance + payroll workdays align (zero LOP).
      const workingDates = await this.holidays.getWorkingDatesBetween(monthStart, monthEnd, branch.id);
      const workDays = workingDates.length;

      // OT scenarios (built now that the days are known).
      const scenarios = [
        { empIdx: 0, day: regularDay, startH: 17, endH: 19, hours: 2, expectType: 'REGULAR', expectFood: 0, label: 'Weekday OT 17:00–19:00 (no food)' },
        { empIdx: 0, day: doubleDay, startH: 8, endH: 17, hours: 9, expectType: 'DOUBLE', expectFood: 0, label: 'Sunday full-shift 08:00–17:00 (2×, no food)' },
        { empIdx: 1, day: lateDay, startH: 17, endH: 23, hours: 6, expectType: 'LATE', expectFood: 150, label: 'Weekday OT 17:00–23:00 (1.5× + food)' },
        { empIdx: 1, day: holidayDay, startH: 17, endH: 23, hours: 6, expectType: 'DOUBLE_LATE', expectFood: 150, label: 'Holiday OT 17:00–23:00 (2× + food)' },
      ];

      say('Creating the demo department…');
      const dept = await prisma.department.upsert({
        where: { code: DEPT_CODE },
        update: { name: 'Engineering (Demo)', isActive: true },
        create: { code: DEPT_CODE, name: 'Engineering (Demo)', description: 'DEMO-OT department', isActive: true },
      });

      say('Creating HR approver account…');
      const password = await bcrypt.hash('Password123!', 10);
      const hrUser = await prisma.user.upsert({
        where: { email: `hr@${DOMAIN}` },
        update: { passwordHash: password, role: 'HR_MANAGER', isActive: true, isEmailVerified: true, isGlobalBranchAccess: true },
        create: {
          email: `hr@${DOMAIN}`, passwordHash: password, role: 'HR_MANAGER',
          isActive: true, isEmailVerified: true, isGlobalBranchAccess: true,
        },
      });

      say(`Hiring 2 employees with active contracts (${workDays} working days, ${hpd}h/day)…`);
      const empRecords: { id: string; code: string; base: number; hourly: number }[] = [];
      for (let i = 0; i < EMPLOYEES.length; i++) {
        const e = EMPLOYEES[i];
        const base = e.hourly * workDays * hpd; // → payroll hourlyRate === e.hourly
        const email = `${e.firstName.toLowerCase()}.${e.lastName.toLowerCase()}@${DOMAIN}`;
        const emp = await prisma.employee.upsert({
          where: { email },
          update: {
            fullName: `${e.firstName} ${e.lastName}`, position: 'Software Engineer',
            baseSalary: base, departmentId: dept.id, branchId: branch.id, status: 'ACTIVE',
          },
          create: {
            employeeCode: e.code, fullName: `${e.firstName} ${e.lastName}`, email,
            idCard: `${e.code}-ID`, dateOfBirth: dateUTC(1990, 1, 1 + i), gender: e.gender,
            phone: `+65-8000-000${i + 1}`, position: 'Software Engineer',
            departmentId: dept.id, branchId: branch.id, startDate: dateUTC(2023, 1, 2),
            baseSalary: base, status: 'ACTIVE', hasCompleteProfile: true,
          },
        });
        await prisma.contract.upsert({
          where: { contractNumber: `${e.code}-CTR` },
          update: { salary: base, status: 'ACTIVE' },
          create: {
            employeeId: emp.id, contractType: 'INDEFINITE', workType: 'FULL_TIME',
            workHoursPerWeek: 40, contractNumber: `${e.code}-CTR`,
            startDate: dateUTC(2023, 1, 2), salary: base, status: 'ACTIVE',
            terms: 'Demo employment terms.',
          },
        });
        empRecords.push({ id: emp.id, code: e.code, base, hourly: e.hourly });
      }

      say(`Recording attendance for ${workDays} working days…`);
      const attendanceRows = empRecords.flatMap((emp) =>
        workingDates.map((d) => ({
          employeeId: emp.id, date: d,
          checkIn: atUTC(YEAR, MONTH, d.getUTCDate(), 8, 0),
          checkOut: atUTC(YEAR, MONTH, d.getUTCDate(), 17, 0),
          workHours: 9, isLate: false, status: 'PRESENT', branchId: branch.id,
        })),
      );
      await prisma.attendance.createMany({ data: attendanceRows });

      say('Submitting overtime requests through the real OvertimeService…');
      const createdIds: string[] = [];
      for (const s of scenarios) {
        const emp = empRecords[s.empIdx];
        const ot = await this.overtime.create(
          emp.id,
          {
            date: isoDate(dateUTC(YEAR, MONTH, s.day)),
            startTime: atUTC(YEAR, MONTH, s.day, s.startH, 0).toISOString(),
            endTime: atUTC(YEAR, MONTH, s.day, s.endH, 0).toISOString(),
            hours: s.hours,
            reason: `Demo OT — ${s.label}`,
          },
          'ADMIN',
        );
        const gotFood = Number(ot.foodAllowance);
        if (ot.otType !== s.expectType || gotFood !== s.expectFood) {
          this.logger.warn(
            `⚠ OT classification mismatch for ${emp.code} on day ${s.day}: ` +
              `got ${ot.otType}/${gotFood}, expected ${s.expectType}/${s.expectFood}`,
          );
        }
        createdIds.push(ot.id);
      }

      say('Approving overtime requests…');
      await prisma.overtimeRequest.updateMany({
        where: { id: { in: createdIds } },
        data: { status: 'APPROVED', approverId: hrUser.id, approvedAt: new Date() },
      });

      say(`Generating payroll (draft) for ${MONTH_NAMES[MONTH - 1]} ${YEAR}…`);
      const batch = await prisma.payrollBatch.create({
        data: {
          name: BATCH_NAME, description: `Demo OT payroll — ${MONTH_NAMES[MONTH - 1]} ${YEAR}`,
          isActive: true, createdBy: hrUser.id,
        },
      });
      await prisma.payrollBatchMember.createMany({
        data: empRecords.map((e) => ({ batchId: batch.id, employeeId: e.id })),
      });
      await this.payrolls.create({ month: MONTH, year: YEAR, batchId: batch.id });

      say('Collecting results…');
      const summary = await this.buildSummary(batch.id, empRecords, scenarios);
      const allOk = summary.every((r) => r.ok);
      if (allOk) this.logger.warn('✅ DEMO-OT seeded — all OT/food figures match the SG rules.');
      else this.logger.error('❌ DEMO-OT seeded but OT/food figures diverged — inspect the table.');

      const scenarioDates = scenarios.map(
        (s) => `${empRecords[s.empIdx].code} ${MONTH_NAMES[MONTH - 1]} ${s.day} — ${s.expectType} (${s.label})`,
      );
      return { summary, allOk, branch: `${branch.name} (${branch.code})`, period: `${MONTH_NAMES[MONTH - 1]} ${YEAR}`, scenarioDates };
    });
  }

  /** Find the existing Head Office branch, or create one if none exists. */
  private async resolveHeadOfficeBranch(): Promise<{ id: string; code: string; name: string }> {
    const found = await this.prisma.branch.findFirst({
      where: {
        OR: [
          { code: 'HO' },
          { name: { contains: 'Head Office', mode: 'insensitive' } },
          { name: { contains: 'Headquarters', mode: 'insensitive' } },
        ],
      },
      select: { id: true, code: true, name: true, weeklyOffDays: true },
    });
    if (found) {
      // If the branch never set a working week, default it to the SG 5-day week
      // (Sat+Sun off) so the demo shows a clean month. An explicit config is respected.
      if (found.weeklyOffDays == null) {
        await this.prisma.branch.update({ where: { id: found.id }, data: { weeklyOffDays: '0,6' } });
      }
      return { id: found.id, code: found.code, name: found.name };
    }
    const created = await this.prisma.branch.create({
      data: {
        code: 'HO', name: 'Head Office', description: 'Head Office',
        country: 'SG', city: 'Singapore', timezone: 'Asia/Singapore',
        officeStartTime: '08:00', officeEndTime: '17:00', weeklyOffDays: '0,6', isActive: true,
      },
      select: { id: true, code: true, name: true },
    });
    return created;
  }

  /** FK-safe teardown of the DEMO-OT namespace (parents are upserted, not deleted). */
  private async reset(): Promise<void> {
    const prisma = this.prisma;
    await prisma.payrollItem.deleteMany({ where: { payroll: { batch: { name: { startsWith: 'DEMO-OT ' } } } } });
    await prisma.payroll.deleteMany({ where: { batch: { name: { startsWith: 'DEMO-OT ' } } } });
    await prisma.payrollBatch.deleteMany({ where: { name: { startsWith: 'DEMO-OT ' } } });
    const ofDemoEmployee = { employee: { email: { endsWith: `@${DOMAIN}` } } };
    await prisma.attendance.deleteMany({ where: ofDemoEmployee });
    await prisma.overtimeRequest.deleteMany({ where: ofDemoEmployee });
    // Only holidays this seed created (tagged) — never a pre-existing one we reused.
    await prisma.holiday.deleteMany({ where: { description: HOLIDAY_TAG } });
  }

  /**
   * Ensure the overtime settings the demo relies on. Payroll/CPF/tax settings are
   * NOT touched — those are already configured for Singapore on this database.
   */
  private async applyOvertimeSettings(): Promise<void> {
    const settings: Record<string, string> = {
      overtime_enabled: 'true',
      overtime_shift_end_time: '17:00',
      overtime_regular_rate: '1.5',
      overtime_late_rate: '1.5',
      overtime_late_threshold: '22:00',
      overtime_food_allowance_enabled: 'true',
      overtime_food_allowance_amount: '150',
      overtime_double_ot_enabled: 'true',
      overtime_double_rate: '2.0',
      overtime_double_food_allowance_any_time: 'false',
      overtime_double_ot_allow_anytime: 'true',
      overtime_max_hours_per_day: '8',
      overtime_max_hours_per_double_day: '12',
      overtime_max_hours_per_month: '40',
      overtime_max_hours_per_year: '200',
      overtime_require_manager_approval: 'true',
      overtime_allow_employee_submit: 'true',
    };
    for (const [key, value] of Object.entries(settings)) {
      await this.prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
  }

  private async buildSummary(
    batchId: string,
    empRecords: { code: string; base: number; hourly: number }[],
    scenarios: { empIdx: number; hours: number; expectType: string; expectFood: number }[],
  ): Promise<DemoSummaryRow[]> {
    const items = await this.prisma.payrollItem.findMany({
      where: { payroll: { batchId } },
      include: { employee: { select: { employeeCode: true, fullName: true } } },
      orderBy: { employee: { employeeCode: 'asc' } },
    });
    return items.map((it) => {
      const code = it.employee.employeeCode;
      const rec = empRecords.find((e) => e.code === code);
      const hourly = rec?.hourly ?? 0;
      const mine = scenarios.filter((s) => empRecords[s.empIdx]?.code === code);
      const expHours = mine.reduce((sum, s) => sum + s.hours, 0);
      const expFood = mine.reduce((sum, s) => sum + s.expectFood, 0);
      const expPay = round2(mine.reduce((sum, s) => sum + s.hours * hourly * RATE_OF[s.expectType], 0));

      const otHours = Number(it.overtimeHours);
      const overtimePay = Number(it.overtimePay);
      const foodAllowance = Number(it.foodAllowance);
      const ok =
        Math.abs(otHours - expHours) < 0.01 &&
        Math.abs(overtimePay - expPay) < 0.02 &&
        Math.abs(foodAllowance - expFood) < 0.01;

      return {
        employee: it.employee.fullName,
        base: Number(it.baseSalary),
        workDays: Number(it.workDays),
        otHours,
        overtimePay,
        foodAllowance,
        cpf: Number(it.insurance),
        tax: Number(it.tax),
        netSalary: Number(it.netSalary),
        ok,
      };
    });
  }
}
