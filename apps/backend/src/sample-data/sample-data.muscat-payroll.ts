/**
 * Completes the PAYROLL story for the Oman (Muscat) branch.
 *
 * The rest of the sample seed populates people, attendance and pay runs. This
 * module fills the gap that stopped the Oman demo short: every payroll screen
 * downstream of a run had nothing behind it, and the pre-flight blocked the run
 * for ten of thirteen employees.
 *
 * Three classes of fix live here:
 *
 *   1. PRE-FLIGHT BLOCKERS. `EmployeeBankDetail.data` is the source of truth for
 *      every payment field; the scalar `iban` / `accountHolderName` columns are
 *      back-compat only. Rows written with the scalars alone read as "Account
 *      Holder Name is required, IBAN is required" to the pre-flight, which
 *      validates `data` against the country's live field schema. Omani IBANs
 *      also have to be 23 characters AND embed the selected bank's 3-digit CBO
 *      code, or the cross-check rejects them.
 *
 *   2. CONFIGURATION a payroll screen refuses to open without: a payroll
 *      calendar, pay grades, end-of-service rules and an encashment policy.
 *
 *   3. WORKED EXAMPLES for the flows that read those tables — encashment
 *      requests in three states, recoveries, a transfer in and one pending out.
 *
 * Idempotent and additive. It repairs rows the earlier seeds wrote and creates
 * only what it can find again, so a re-run converges instead of duplicating.
 *
 * It NEVER changes a locked payroll's money columns. Payslip LINES are the one
 * thing it writes against a locked run, and only because they are additive by
 * construction: `buildItemLines` reconciles lines TO the stored columns and
 * absorbs the rounding residual, so the totals it explains cannot move.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { validateIban } from '../bank-details/iban.util';
import {
  buildItemLines,
  type BuildLinesInput,
  type ComponentInput,
  type FigureInput,
  type LineBucket,
} from '../payrolls/payroll-item-lines.util';

/** Anything Prisma-shaped: the Nest `PrismaService` or a bare client. */
export type PrismaLike = PrismaClient;

export interface MuscatPayrollOptions {
  /** Defaults to the sample dataset's Oman branch. */
  branchCode?: string;
  /** Calendar year to lay out pay periods for. Defaults to the current year. */
  year?: number;
  say?: (message: string) => void;
  info?: (message: string) => void;
}

/** Reference prefix for the rows this module creates and re-finds. */
const TAG = 'MCT-DEMO';

const dU = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0));
const dec = (n: number) => new Prisma.Decimal(n.toFixed(2));
const n2 = (n: number) => Math.round(n * 100) / 100;

interface Emp {
  id: string;
  employeeCode: string;
  fullName: string;
  baseSalary: Prisma.Decimal | null;
  startDate: Date | null;
  departmentId: string | null;
  gradeId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// IBAN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A structurally valid Omani IBAN that embeds `bankCode`.
 *
 * OM is 23 characters: `OM` + 2 check digits + a 19-digit BBAN whose first
 * three digits are the CBO bank code (`IBAN_COUNTRY_RULES.OM.bankCodeRange`).
 * A checksum-valid IBAN of the wrong length, or one whose embedded code names a
 * different bank, still fails pre-flight — so the result is put back through
 * the app's own validator before it is stored.
 */
export function omIban(bankCode: string, accountDigits: string): string {
  const bban = `${bankCode}${accountDigits}`.padEnd(19, '0').slice(0, 19);
  const numeric = `${bban}OM00`
    .split('')
    .map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c))
    .join('');
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  const iban = `OM${String(98 - remainder).padStart(2, '0')}${bban}`;
  const res = validateIban(iban, 'OM', bankCode);
  if (!res.valid) {
    throw new Error(`Seed built an invalid OM IBAN ${iban}: ${res.message}`);
  }
  return iban;
}

/** Deterministic 16-digit account body from an employee code. */
const accountDigitsFor = (employeeCode: string, series: string): string =>
  `${series}${employeeCode.replace(/\D/g, '').slice(-3).padStart(3, '0')}`.padEnd(16, '0');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Payment details
// ─────────────────────────────────────────────────────────────────────────────

async function repairBankDetails(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
): Promise<number> {
  const banks = await prisma.bank.findMany({ where: { country: 'OM', isActive: true } });
  const byId = new Map(banks.map((b) => [b.id, b]));
  const fallback = banks.find((b) => b.bankCode === '018') ?? banks.find((b) => b.bankCode);
  if (!fallback?.bankCode) {
    throw new Error('No active OM bank carries a bankCode — run the Oman Bank Master seed first.');
  }

  const today = new Date();
  let touched = 0;
  for (const e of emps) {
    // A FUTURE JOINER is skipped on purpose. They are on no payroll run, so
    // their missing bank details cannot block a run — and they are the Bank
    // Master migration queue's only candidate. Repairing them here would empty
    // that screen on every re-seed.
    if (e.startDate && e.startDate > today) continue;
    const detail = await prisma.employeeBankDetail.findFirst({
      where: { employeeId: e.id, isActive: true },
    });
    // A bank with no CBO code can never pass the IBAN cross-check, so a row on
    // one is moved to a coded bank rather than left silently unpayable.
    const chosen = detail ? byId.get(detail.bankId) ?? fallback : fallback;
    const bank = chosen.bankCode ? chosen : fallback;
    const accountDigits = accountDigitsFor(e.employeeCode, '1');
    const iban = omIban(bank.bankCode!, accountDigits);
    const data = { accountHolderName: e.fullName, iban };

    if (detail) {
      const unchanged =
        detail.bankId === bank.id &&
        detail.iban === iban &&
        detail.accountHolderName === e.fullName &&
        JSON.stringify(detail.data ?? {}) === JSON.stringify(data);
      if (unchanged) continue;
      await prisma.employeeBankDetail.update({
        where: { id: detail.id },
        data: { bankId: bank.id, data, iban, accountHolderName: e.fullName, branchId },
      });
    } else {
      await prisma.employeeBankDetail.create({
        data: {
          employeeId: e.id,
          bankId: bank.id,
          branchId,
          data,
          iban,
          accountNumber: accountDigits,
          accountHolderName: e.fullName,
          isActive: true,
          effectiveFrom: e.startDate ?? dU(2024, 1, 1),
          source: 'MIGRATION',
        },
      });
    }
    touched += 1;
  }
  return touched;
}

/**
 * Decide any bank-change request still open in this branch.
 *
 * A PENDING request is a BLOCKING pre-flight finding by design — the run would
 * otherwise pay an account the employee is in the middle of replacing. The
 * approval-queue demo lives on another branch; here the queue is left empty so
 * the Oman run passes pre-flight.
 */
async function decideBankChanges(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
): Promise<number> {
  const byId = new Map(emps.map((e) => [e.id, e]));
  const pending = await prisma.bankChangeRequest.findMany({
    where: { employeeId: { in: emps.map((e) => e.id) }, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  });
  if (pending.length === 0) return 0;

  const banks = await prisma.bank.findMany({ where: { country: 'OM', isActive: true } });

  for (const [i, req] of pending.entries()) {
    const emp = byId.get(req.employeeId);
    if (!emp) continue;

    // One approved (so the versioned-detail history has a real entry) and the
    // rest rejected, which is the outcome that needs no follow-up.
    if (i > 0) {
      // `BankChangeRequest` carries no reason column — the decision path records
      // the why in the audit log, so the seed sets only the outcome.
      await prisma.bankChangeRequest.update({
        where: { id: req.id },
        data: { status: 'REJECTED', decidedAt: new Date() },
      });
      continue;
    }

    const bank =
      banks.find((b) => b.id === req.bankId && b.bankCode) ?? banks.find((b) => b.bankCode)!;
    const accountDigits = accountDigitsFor(emp.employeeCode, '2');
    const iban = omIban(bank.bankCode!, accountDigits);

    // The partial unique index allows exactly one active row per employee, so
    // the superseded one is retired first — as the approval path does.
    await prisma.employeeBankDetail.updateMany({
      where: { employeeId: emp.id, isActive: true },
      data: { isActive: false },
    });
    await prisma.employeeBankDetail.create({
      data: {
        employeeId: emp.id,
        bankId: bank.id,
        branchId,
        data: { accountHolderName: emp.fullName, iban },
        iban,
        accountNumber: accountDigits,
        accountHolderName: emp.fullName,
        isActive: true,
        effectiveFrom: new Date(),
        source: 'APPROVAL',
        sourceRequestId: req.id,
      },
    });
    await prisma.bankChangeRequest.update({
      where: { id: req.id },
      data: {
        status: 'APPROVED',
        decidedAt: new Date(),
        data: { accountHolderName: emp.fullName, iban },
        iban,
      },
    });
  }
  return pending.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Statutory identifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LABOUR_CARD and CIVIL_ID are WARNING-severity pre-flight identifiers in Oman.
 * They do not block a run, but with neither on file every employee raised two
 * warnings and the demo had to be talked past them.
 * `Employee.idCard` cannot stand in — onboarding sets it to the employee code,
 * so it is an internal code, not a government number.
 */
async function seedIdentifiers(
  prisma: PrismaLike,
  emps: Emp[],
  createdById: string | null,
): Promise<number> {
  let created = 0;
  for (const e of emps) {
    const suffix = e.employeeCode.replace(/\D/g, '').slice(-3).padStart(3, '0');
    const series = e.employeeCode.startsWith('NX') ? '1' : '2';
    const wanted = [
      {
        category: 'LABOUR_CARD' as const,
        documentNumber: `OMLC${series}${suffix}`,
        documentType: 'Labour Card',
        issuingAuthority: 'Ministry of Labour',
        issueDate: dU(2025, 1, 15),
        // Far past any demo payment date: an expired identifier is its own
        // finding, and this is not the place to demonstrate that one.
        expiryDate: dU(2029, 1, 14),
      },
      {
        category: 'CIVIL_ID' as const,
        documentNumber: `${series}${suffix}${series}${suffix}`.slice(0, 8),
        documentType: 'Civil ID',
        issuingAuthority: 'Royal Oman Police — Civil Status',
        issueDate: dU(2024, 6, 1),
        expiryDate: dU(2029, 5, 31),
      },
    ];

    for (const w of wanted) {
      const exists = await prisma.employeeLegalDocument.findFirst({
        where: { employeeId: e.id, category: w.category, isCurrent: true },
      });
      if (exists) continue;
      await prisma.employeeLegalDocument.create({
        data: {
          employeeId: e.id,
          category: w.category,
          documentNumber: w.documentNumber,
          documentType: w.documentType,
          country: 'Oman',
          nationality: 'OM',
          issueDate: w.issueDate,
          expiryDate: w.expiryDate,
          issuingAuthority: w.issuingAuthority,
          placeOfIssue: 'Muscat',
          status: 'ACTIVE',
          isCurrent: true,
          createdById,
          remarks: TAG,
        },
      });
      created += 1;
    }
  }
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Payroll calendar
// ─────────────────────────────────────────────────────────────────────────────

/** Oman practice: the period is the calendar month and inputs close on the 25th. */
async function seedCalendar(
  prisma: PrismaLike,
  branchId: string,
  year: number,
): Promise<number> {
  const calendar = await prisma.payrollCalendar.upsert({
    where: { branchId_year: { branchId, year } },
    update: { isActive: true },
    create: { branchId, year, name: `Muscat ${year}`, isActive: true },
  });

  let created = 0;
  for (let month = 1; month <= 12; month++) {
    const exists = await prisma.payrollCalendarPeriod.findUnique({
      where: { calendarId_month: { calendarId: calendar.id, month } },
    });
    if (exists) continue;
    await prisma.payrollCalendarPeriod.create({
      data: {
        calendarId: calendar.id,
        month,
        periodStart: dU(year, month, 1),
        periodEnd: lastDay(year, month),
        cutOffDate: dU(year, month, 25),
        paymentDate: lastDay(year, month),
        // Enforcement is per period on purpose, so one month can pilot it.
        // August does, which is what makes the refusal path demonstrable.
        enforceCutOff: month === 8,
      },
    });
    created += 1;
  }
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Grades
// ─────────────────────────────────────────────────────────────────────────────

const GRADES = [
  { code: 'OM-G1', name: 'Support', level: 1, min: 325, max: 600 },
  { code: 'OM-G2', name: 'Officer', level: 2, min: 600, max: 1000 },
  { code: 'OM-G3', name: 'Senior Officer', level: 3, min: 1000, max: 1500 },
  { code: 'OM-G4', name: 'Manager', level: 4, min: 1500, max: 2200 },
  { code: 'OM-G5', name: 'Senior Manager', level: 5, min: 2200, max: 3200 },
];

/**
 * A grade is a TEMPLATE, never a payroll input: `SalaryComponent` stays the only
 * thing the engine reads, which is what keeps grade out of the calculation. The
 * 60 / 25 / 15 split is the one the branch's existing salary components already
 * use, expressed against basic so a band change re-derives instead of carrying
 * hard-coded money.
 */
async function seedGrades(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
): Promise<{ grades: number; placed: number }> {
  const idByCode = new Map<string, string>();

  for (const g of GRADES) {
    const row = await prisma.grade.upsert({
      where: { code: g.code },
      update: {
        name: g.name,
        level: g.level,
        minSalary: dec(g.min),
        maxSalary: dec(g.max),
        branchId,
        isActive: true,
      },
      create: {
        code: g.code,
        name: g.name,
        level: g.level,
        minSalary: dec(g.min),
        maxSalary: dec(g.max),
        branchId,
        isActive: true,
        description: `Muscat pay band ${g.level} — OMR ${g.min}–${g.max} gross.`,
      },
    });
    idByCode.set(g.code, row.id);

    const components = [
      {
        componentType: 'BASIC',
        valueType: 'FIXED',
        value: n2(((g.min + g.max) / 2) * 0.6),
        isMandatory: true,
      },
      // 25% and 15% of gross, which is 41.6667% and 25% of a 60%-of-gross basic.
      { componentType: 'HOUSING', valueType: 'PERCENT_OF_BASIC', value: 41.6667, isMandatory: true },
      { componentType: 'TRANSPORT', valueType: 'PERCENT_OF_BASIC', value: 25, isMandatory: false },
    ];
    for (const c of components) {
      await prisma.gradeSalaryComponent.upsert({
        where: { gradeId_componentType: { gradeId: row.id, componentType: c.componentType } },
        update: {
          valueType: c.valueType,
          value: new Prisma.Decimal(c.value.toFixed(4)),
          isMandatory: c.isMandatory,
        },
        create: {
          gradeId: row.id,
          componentType: c.componentType,
          valueType: c.valueType,
          value: new Prisma.Decimal(c.value.toFixed(4)),
          isMandatory: c.isMandatory,
        },
      });
    }
  }

  // Place each employee in the band their existing pay already falls in, so the
  // grade agrees with the money instead of overriding it.
  let placed = 0;
  for (const e of emps) {
    if (e.gradeId) continue;
    const pay = Number(e.baseSalary ?? 0);
    const band = GRADES.find((g) => pay >= g.min && pay < g.max) ?? GRADES[GRADES.length - 1];
    await prisma.employee.update({
      where: { id: e.id },
      data: { gradeId: idByCode.get(band.code)! },
    });
    placed += 1;
  }
  return { grades: GRADES.length, placed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. End-of-service rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Oman end-of-service, in the shape the settlement engine reads.
 *
 * Expats accrue 15 days of basic per year for the first three years and a month
 * per year after that. Omani nationals are covered by the Social Protection
 * Fund, which the schema models as a NATIONAL rule with `employerShare = 0` —
 * the liability is still accrued and reported, the employer does not carry it.
 *
 * Demo defaults, not legal advice: a customer's own rule set has to be
 * confirmed before a real settlement is paid from them.
 */
const GRATUITY_RULES = [
  {
    nationalityClass: 'EXPAT',
    fromYears: 0,
    toYears: 3,
    daysPerYear: 15,
    employerShare: 1,
    notes: 'Oman: 15 days of basic per year for the first three years of service.',
  },
  {
    nationalityClass: 'EXPAT',
    fromYears: 3,
    toYears: null as number | null,
    daysPerYear: 30,
    employerShare: 1,
    notes: 'Oman: one month of basic per year from the fourth year onward.',
  },
  {
    nationalityClass: 'NATIONAL',
    fromYears: 0,
    toYears: null as number | null,
    daysPerYear: 30,
    employerShare: 0,
    notes:
      'Omani nationals sit under the Social Protection Fund — accrued and reported, employer share 0.',
  },
];

async function seedGratuityRules(prisma: PrismaLike): Promise<number> {
  let created = 0;
  for (const r of GRATUITY_RULES) {
    const exists = await prisma.gratuityRule.findFirst({
      where: {
        country: 'OM',
        nationalityClass: r.nationalityClass,
        fromYears: new Prisma.Decimal(r.fromYears),
      },
    });
    if (exists) continue;
    await prisma.gratuityRule.create({
      data: {
        country: 'OM',
        nationalityClass: r.nationalityClass,
        fromYears: new Prisma.Decimal(r.fromYears),
        toYears: r.toYears == null ? null : new Prisma.Decimal(r.toYears),
        daysPerYear: new Prisma.Decimal(r.daysPerYear),
        basis: 'BASIC',
        monthDays: new Prisma.Decimal(30),
        employerShare: new Prisma.Decimal(r.employerShare),
        effectiveFrom: dU(2020, 1, 1),
        isActive: true,
        notes: r.notes,
      },
    });
    created += 1;
  }
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Leave encashment
// ─────────────────────────────────────────────────────────────────────────────

async function seedEncashment(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
  year: number,
  approverId: string | null,
): Promise<{ policies: number; requests: number }> {
  // Without a policy row every encashment request is refused, so the screen has
  // nothing to show. Sick leave gets an explicit non-encashable row: the refusal
  // is as much a part of the demo as the approval.
  const policies = [
    {
      leaveTypeKey: 'Annual Leave',
      encashable: true,
      maxEncashDaysPerYear: 15,
      allowInService: true,
      allowOnExit: true,
      carryForwardEnabled: true,
      carryForwardMaxDays: 10,
      carryForwardExpiryMonths: 6,
    },
    {
      leaveTypeKey: 'Sick Leave',
      encashable: false,
      maxEncashDaysPerYear: null as number | null,
      allowInService: false,
      allowOnExit: false,
      carryForwardEnabled: false,
      carryForwardMaxDays: null as number | null,
      carryForwardExpiryMonths: null as number | null,
    },
  ];

  let created = 0;
  for (const p of policies) {
    const exists = await prisma.leaveTypePolicy.findFirst({
      where: { leaveTypeKey: p.leaveTypeKey, branchId },
    });
    if (exists) continue;
    await prisma.leaveTypePolicy.create({
      data: {
        leaveTypeKey: p.leaveTypeKey,
        branchId,
        encashable: p.encashable,
        maxEncashDaysPerYear: p.maxEncashDaysPerYear,
        encashBasis: 'BASIC',
        monthDays: new Prisma.Decimal(30),
        accruedOnly: true,
        allowInService: p.allowInService,
        allowOnExit: p.allowOnExit,
        carryForwardEnabled: p.carryForwardEnabled,
        carryForwardMaxDays: p.carryForwardMaxDays,
        carryForwardExpiryMonths: p.carryForwardExpiryMonths,
        isActive: true,
      },
    });
    created += 1;
  }

  // One request per state a reviewer can be looking at.
  const states = [
    { status: 'PENDING', days: 5, paid: false },
    { status: 'APPROVED', days: 8, paid: false },
    { status: 'PAID', days: 6, paid: true },
  ];
  let requests = 0;
  for (const [i, e] of emps.slice(0, states.length).entries()) {
    const s = states[i];
    const exists = await prisma.leaveEncashmentRequest.findFirst({
      where: { employeeId: e.id, year, leaveTypeKey: 'Annual Leave' },
    });
    if (exists) continue;
    // Rate is snapshotted at approval, as the engine does: basic ÷ 30, where
    // basic is 60% of gross in this branch's structure. A PENDING request has
    // no rate yet — that is the point of snapshotting it on the decision.
    const basic = Number(e.baseSalary ?? 0) * 0.6;
    const rate = s.status === 'PENDING' ? null : n2(basic / 30);
    await prisma.leaveEncashmentRequest.create({
      data: {
        employeeId: e.id,
        branchId,
        leaveTypeKey: 'Annual Leave',
        year,
        days: new Prisma.Decimal(s.days),
        ratePerDay: rate == null ? null : dec(rate),
        amount: rate == null ? null : dec(n2(rate * s.days)),
        status: s.status,
        reason: `Encashing ${s.days} days of untaken annual leave (${TAG}).`,
        approvedBy: s.status === 'PENDING' ? null : approverId,
        approvedAt: s.status === 'PENDING' ? null : dU(year, 8, 10),
        paidAt: s.paid ? lastDay(year, 8) : null,
      },
    });
    requests += 1;
  }
  return { policies: created, requests };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Recoveries
// ─────────────────────────────────────────────────────────────────────────────

async function seedRecoveries(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
  year: number,
  createdBy: string | null,
): Promise<number> {
  const assignments = await prisma.assetAssignment.findMany({
    where: { employeeId: { in: emps.map((e) => e.id) } },
    select: { id: true, employeeId: true },
  });
  const assignmentOf = new Map(assignments.map((a) => [a.employeeId, a.id]));

  const specs = [
    {
      offset: 3,
      kind: 'ASSET_DAMAGE',
      total: 180,
      instalment: 45,
      status: 'ACTIVE',
      withAsset: true,
      reason: 'Cracked laptop screen — repair invoiced to the company.',
    },
    {
      offset: 4,
      kind: 'TRAINING_BOND',
      total: 600,
      instalment: 100,
      status: 'ACTIVE',
      withAsset: false,
      reason: 'Forklift certification bond, recovered over six months.',
    },
    {
      offset: 5,
      kind: 'NOTICE_SHORTFALL',
      total: 240,
      instalment: null as number | null,
      status: 'COMPLETED',
      withAsset: false,
      reason: 'Nine days of notice not served; recovered in full.',
    },
  ];

  let created = 0;
  for (const s of specs) {
    // Wrap rather than index blindly: a branch with fewer people than the spec
    // list would otherwise silently seed nothing for the later kinds.
    const e = emps[s.offset % emps.length];
    if (!e) continue;
    const reference = `${TAG}-REC-${s.kind}-${e.employeeCode}`;
    const exists = await prisma.employeeRecovery.findFirst({ where: { reference } });
    if (exists) continue;
    await prisma.employeeRecovery.create({
      data: {
        employeeId: e.id,
        branchId,
        kind: s.kind,
        assetAssignmentId: s.withAsset ? assignmentOf.get(e.id) ?? null : null,
        reference,
        totalAmount: dec(s.total),
        amountRecovered: dec(s.status === 'COMPLETED' ? s.total : s.total / 4),
        instalmentAmount: s.instalment == null ? null : dec(s.instalment),
        startDate: dU(year, 6, 1),
        endDate: s.status === 'COMPLETED' ? lastDay(year, 8) : null,
        priority: 200,
        status: s.status,
        reason: s.reason,
        createdBy,
      },
    });
    created += 1;
  }
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Transfers
// ─────────────────────────────────────────────────────────────────────────────

async function seedTransfers(
  prisma: PrismaLike,
  branchId: string,
  emps: Emp[],
  year: number,
  actorId: string | null,
): Promise<number> {
  const other = await prisma.branch.findFirst({
    where: { id: { not: branchId }, country: { not: null } },
    orderBy: { code: 'asc' },
  });
  if (!other) return 0;

  const specs = [
    {
      offset: 6,
      status: 'PENDING',
      from: branchId,
      to: other.id,
      effective: dU(year, 10, 1),
      reason: 'Covering the regional warehouse rollout for two quarters.',
    },
    {
      offset: 7,
      status: 'APPLIED',
      from: other.id,
      to: branchId,
      effective: dU(year - 1, 4, 1),
      reason: 'Permanent relocation to the Muscat operation.',
    },
  ];

  let created = 0;
  for (const s of specs) {
    const e = emps[s.offset % emps.length];
    if (!e) continue;
    const exists = await prisma.employeeTransfer.findFirst({
      where: { employeeId: e.id, effectiveDate: s.effective },
    });
    if (exists) continue;
    await prisma.employeeTransfer.create({
      data: {
        employeeId: e.id,
        fromBranchId: s.from,
        toBranchId: s.to,
        fromDepartmentId: e.departmentId,
        toDepartmentId: e.departmentId,
        effectiveDate: s.effective,
        reason: s.reason,
        status: s.status,
        requestedBy: actorId,
        approvedBy: s.status === 'APPLIED' ? actorId : null,
        approvedAt: s.status === 'APPLIED' ? s.effective : null,
        // APPLIED is a historical record only — the employee is ALREADY in the
        // branch it names. A seeded transfer that actually moved someone would
        // change branch scoping underneath the rest of the demo.
        appliedAt: s.status === 'APPLIED' ? s.effective : null,
        notes: TAG,
      },
    });
    created += 1;
  }
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Payslip breakdown lines
// ─────────────────────────────────────────────────────────────────────────────

/** Which PayrollItem column becomes which line, and what a payslip calls it. */
const FIGURE_LINES: {
  bucket: LineBucket;
  column: string;
  code: string;
  label: string;
  sourceType: FigureInput['sourceType'];
}[] = [
  { bucket: 'bonus', column: 'bonus', code: 'BONUS', label: 'Bonus', sourceType: 'REWARD' },
  { bucket: 'overtimePay', column: 'overtimePay', code: 'OVERTIME', label: 'Overtime', sourceType: 'OVERTIME' },
  { bucket: 'foodAllowance', column: 'foodAllowance', code: 'FOOD_ALLOWANCE', label: 'Food Allowance', sourceType: 'OVERTIME' },
  { bucket: 'siteAllowance', column: 'siteAllowance', code: 'SITE_ALLOWANCE', label: 'Site Allowance', sourceType: 'SALARY_COMPONENT' },
  { bucket: 'leaveEncashment', column: 'leaveEncashment', code: 'LEAVE_ENCASHMENT', label: 'Leave Encashment', sourceType: 'ENCASHMENT' },
  { bucket: 'deduction', column: 'deduction', code: 'DEDUCTION', label: 'Deduction', sourceType: 'MANUAL' },
  { bucket: 'garnishment', column: 'garnishment', code: 'GARNISHMENT', label: 'Garnishment', sourceType: 'GARNISHMENT' },
  { bucket: 'otherRecovery', column: 'otherRecovery', code: 'RECOVERY', label: 'Recovery', sourceType: 'RECOVERY' },
  { bucket: 'insurance', column: 'insurance', code: 'SPF', label: 'Social Protection Fund', sourceType: 'STATUTORY' },
  { bucket: 'tax', column: 'tax', code: 'TAX', label: 'Tax', sourceType: 'STATUTORY' },
];

/**
 * Backfill the itemisation for payslips generated before
 * `payroll_item_lines_enabled` was switched on — without it the breakdown on
 * every existing payslip is empty while the flag says the feature is live.
 *
 * Safe on a LOCKED run precisely because lines are additive: the columns stay
 * authoritative, `buildItemLines` reconciles the lines to them and absorbs the
 * rounding residual. No money moves.
 */
async function backfillItemLines(
  prisma: PrismaLike,
  branchId: string,
): Promise<{ items: number; lines: number }> {
  const payrolls = await prisma.payroll.findMany({
    where: { branchId },
    select: { id: true },
  });

  let items = 0;
  let lines = 0;
  for (const p of payrolls) {
    const rows = await prisma.payrollItem.findMany({ where: { payrollId: p.id } });
    for (const item of rows) {
      const already = await prisma.payrollItemLine.count({ where: { payrollItemId: item.id } });
      if (already > 0) continue;

      const components = await prisma.salaryComponent.findMany({
        where: { employeeId: item.employeeId, isActive: true },
      });
      const baseColumn = Number(item.baseSalary ?? 0);
      const allowanceColumn = Number(item.allowances ?? 0);

      // Scale the contracted components onto the stored columns. The columns are
      // what was paid; the components are the shape of it. Scaling keeps the
      // proportions the employee's structure actually has rather than inventing
      // one unnamed "Basic" line for the whole amount.
      const scale = (
        list: typeof components,
        target: number,
        bucket: ComponentInput['bucket'],
      ): ComponentInput[] => {
        if (target <= 0) return [];
        const sum = list.reduce((a, c) => a + Number(c.amount), 0);
        if (list.length === 0 || sum <= 0) {
          return bucket === 'baseSalary'
            ? [{ code: 'BASIC', label: 'Basic', amount: target, bucket }]
            : [{ code: 'ALLOWANCE', label: 'Allowance', amount: target, bucket }];
        }
        const factor = target / sum;
        return list.map((c) => ({
          code: c.componentType,
          amount: Number(c.amount) * factor,
          bucket,
          sourceId: c.id,
        }));
      };

      const input: BuildLinesInput = {
        components: [
          ...scale(components.filter((c) => c.componentType === 'BASIC'), baseColumn, 'baseSalary'),
          ...scale(components.filter((c) => c.componentType !== 'BASIC'), allowanceColumn, 'allowances'),
        ],
        figures: {},
        totals: { baseSalary: baseColumn, allowances: allowanceColumn },
      };
      for (const f of FIGURE_LINES) {
        const amount = Number((item as unknown as Record<string, unknown>)[f.column] ?? 0);
        if (amount <= 0) continue;
        input.figures[f.bucket] = [
          { code: f.code, label: f.label, amount, sourceType: f.sourceType },
        ];
        input.totals[f.bucket] = amount;
      }

      const built = buildItemLines(input);
      if (built.length === 0) continue;
      await prisma.payrollItemLine.createMany({
        data: built.map((l) => ({
          payrollItemId: item.id,
          code: l.code,
          label: l.label,
          category: l.category,
          bucket: l.bucket,
          amount: dec(l.amount),
          sourceType: l.sourceType,
          sourceId: l.sourceId ?? null,
          displayOrder: l.displayOrder,
        })),
      });
      items += 1;
      lines += built.length;
    }
  }
  return { items, lines };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function seedMuscatPayrollDemo(
  prisma: PrismaLike,
  opts: MuscatPayrollOptions = {},
): Promise<Record<string, number>> {
  const branchCode = opts.branchCode ?? 'SMP-MCT';
  const year = opts.year ?? new Date().getUTCFullYear();
  const say = opts.say ?? (() => {});
  const info = opts.info ?? (() => {});

  const branch = await prisma.branch.findUnique({ where: { code: branchCode } });
  if (!branch) {
    info(`Muscat payroll demo skipped — branch ${branchCode} does not exist.`);
    return {};
  }

  say('Completing the Muscat payroll story (payment details, grades, EOSB)…');

  const emps: Emp[] = await prisma.employee.findMany({
    where: { branchId: branch.id },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      baseSalary: true,
      startDate: true,
      departmentId: true,
      gradeId: true,
    },
    orderBy: { employeeCode: 'asc' },
  });
  if (emps.length === 0) {
    info(`Muscat payroll demo skipped — no employees in ${branchCode}.`);
    return {};
  }

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' as never },
    select: { id: true },
  });
  const actorId = admin?.id ?? null;

  const bankDetails = await repairBankDetails(prisma, branch.id, emps);
  const bankChanges = await decideBankChanges(prisma, branch.id, emps);
  const identifiers = await seedIdentifiers(prisma, emps, actorId);
  const calendarPeriods = await seedCalendar(prisma, branch.id, year);
  const { grades, placed } = await seedGrades(prisma, branch.id, emps);
  const gratuityRules = await seedGratuityRules(prisma);
  const encashment = await seedEncashment(prisma, branch.id, emps, year, actorId);
  const recoveries = await seedRecoveries(prisma, branch.id, emps, year, actorId);
  const transfers = await seedTransfers(prisma, branch.id, emps, year, actorId);
  const payslipLines = await backfillItemLines(prisma, branch.id);

  info(
    `Muscat payroll: ${bankDetails} payment detail(s) repaired, ${bankChanges} bank change(s) decided, ` +
      `${identifiers} identifier(s), ${calendarPeriods} pay period(s), ${grades} grade(s), ` +
      `${gratuityRules} EOSB rule(s), ${encashment.requests} encashment request(s), ` +
      `${recoveries} recovery(ies), ${transfers} transfer(s), ${payslipLines.lines} payslip line(s).`,
  );

  return {
    muscatBankDetails: bankDetails,
    muscatBankChangesDecided: bankChanges,
    muscatIdentifiers: identifiers,
    muscatPayPeriods: calendarPeriods,
    muscatGrades: grades,
    muscatGradePlacements: placed,
    muscatEosbRules: gratuityRules,
    muscatEncashmentPolicies: encashment.policies,
    muscatEncashmentRequests: encashment.requests,
    muscatRecoveries: recoveries,
    muscatTransfers: transfers,
    muscatPayslipLines: payslipLines.lines,
  };
}
