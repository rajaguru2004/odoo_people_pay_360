/**
 * Sample-data EXTRAS — every module the core `SampleDataService` did not reach.
 *
 * The core seed builds the org (branches, departments, employees, contracts,
 * attendance, leave, overtime, reimbursements, advances, payroll).
 * This file fills the remaining pages so a client demo never lands on an empty
 * screen: assets, travel, training, budgets, banking, letters, grievances,
 * rewards/disciplines, documents, visas, teams, timesheets, appraisals,
 * approvals, notifications, audit logs and the rest.
 *
 * Oman weighting: the Muscat branch (branchIndex 3) is the showcase branch, so
 * it gets the deepest data — Omani banks with valid IBANs, visa lifecycle with a
 * renewal chain, an OMR budget, a completed AI appraisal run, Omani public
 * holidays and an external attendance-provider integration.
 *
 * Every row written here is inside the `SMP-` / `@sample.hrms.local` namespace
 * (or hangs off a row that is), so `resetSampleChildren()` can remove all of it
 * without touching base data. Global masters (library items, banks, country
 * banking fields, letter templates) are upserted and deliberately NOT deleted.
 */

import { AssetStatus, PrismaClient } from '@prisma/client';
import { SMP, pad3, randInt } from './sample-data.constants';
import { seedLibraryDefaults } from '../library-items/library-defaults';
import { LETTER_TEMPLATE_DEFAULTS } from '../letters/letter-defaults';
import { DEFAULT_COUNTRY_FIELDS } from '../bank-details/banking-config.service';

// ---------------------------------------------------------------------------
// Types the core service hands over
// ---------------------------------------------------------------------------

export interface ExtrasEmployee {
  id: string;
  index: number;
  branchIndex: number;
  deptIndex: number;
  email: string;
  fullName: string;
  baseSalary: number;
  startDate: Date;
}

export interface ExtrasContext {
  prisma: PrismaClient;
  employees: ExtrasEmployee[];
  deptIds: string[];
  branchIds: string[];
  /** employee index -> User.id, for every employee that has a login. */
  userIdByEmpIdx: Record<number, string>;
  hrUserId: string;
  months: { year: number; month: number }[];
  rng: () => number;
  say: (message: string) => void;
  info: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const dU = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
const atTime = (day: Date, h: number, min = 0): Date =>
  new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, min, 0));
/** `n` days from today, at UTC midnight. */
const day = (n: number): Date => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
};
const addMonths = (d: Date, n: number): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));

/** ISO-13616 check digits, so demo IBANs pass real validation. */
function ibanWithCheckDigits(country: string, bban: string): string {
  const rearranged = `${bban}${country}00`;
  const numeric = rearranged
    .toUpperCase()
    .split('')
    .map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c))
    .join('');
  // mod-97 on a string, because the value overflows Number.
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  const check = String(98 - remainder).padStart(2, '0');
  return `${country}${check}${bban}`;
}

const MUSCAT = 3; // branchIndex of the Oman branch

/** Licensed Omani banks — the demo's primary payment rails. */
const BANKS: { country: string; name: string; swift: string; bankCode: string | null }[] = [
  { country: 'OM', name: 'Bank Muscat', swift: 'BMUSOMRX', bankCode: '018' },
  { country: 'OM', name: 'National Bank of Oman', swift: 'NBOMOMRX', bankCode: '022' },
  { country: 'OM', name: 'Bank Dhofar', swift: 'BDOFOMRU', bankCode: '029' },
  { country: 'OM', name: 'Sohar International Bank', swift: 'BSHROMRU', bankCode: '046' },
  { country: 'OM', name: 'Oman Arab Bank', swift: 'OMABOMRU', bankCode: '031' },
  { country: 'OM', name: 'Ahli Bank', swift: 'AUBOMRUX', bankCode: '051' },
  { country: 'OM', name: 'Bank Nizwa', swift: 'BNIZOMRU', bankCode: '056' },
  { country: 'OM', name: 'Alizz Islamic Bank', swift: 'AIBAOMRU', bankCode: '057' },
  { country: 'IN', name: 'HDFC Bank', swift: 'HDFCINBB', bankCode: null },
  { country: 'IN', name: 'ICICI Bank', swift: 'ICICINBB', bankCode: null },
  { country: 'IN', name: 'State Bank of India', swift: 'SBININBB', bankCode: null },
  { country: 'US', name: 'JPMorgan Chase', swift: 'CHASUS33', bankCode: null },
  { country: 'US', name: 'Bank of America', swift: 'BOFAUS3N', bankCode: null },
  { country: 'AE', name: 'Emirates NBD', swift: 'EBILAEAD', bankCode: null },
];

/** Omani public holidays, branch-scoped to Muscat so other branches keep the day. */
const OMAN_HOLIDAYS: { name: string; month: number; day: number; description: string }[] = [
  { name: 'Renaissance Day', month: 7, day: 23, description: 'Oman national holiday.' },
  { name: 'National Day', month: 11, day: 18, description: 'Sultanate of Oman National Day.' },
  { name: 'National Day Holiday', month: 11, day: 19, description: 'Second day of National Day.' },
  { name: 'Islamic New Year', month: 6, day: 26, description: 'Hijri new year (observed).' },
  { name: 'Prophet’s Birthday', month: 9, day: 4, description: 'Mawlid al-Nabi (observed).' },
];

const OMANI_CITIES = ['Muscat', 'Salalah', 'Sohar', 'Nizwa', 'Sur', 'Ibri'];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function seedSampleExtras(ctx: ExtrasContext): Promise<void> {
  await seedMasters(ctx);
  await seedProfilesAndHierarchy(ctx);
  await seedBanking(ctx);
  await seedLeaveBalancesAndAccruals(ctx);
  await seedAttendanceExtras(ctx);
  await seedRewardsAndDisciplines(ctx);
  await seedDocumentsAndVisas(ctx);
  await seedLettersAndGrievances(ctx);
  await seedAssets(ctx);
  await seedTravel(ctx);
  await seedTraining(ctx);
  await seedBudgets(ctx);
  await seedApprovals(ctx);
  await seedContractLifecycle(ctx);
  await seedTimesheets(ctx);
  await seedAppraisal(ctx);
  await seedManagerHandover(ctx);
  await seedNotificationsAndAudit(ctx);
  await seedGarnishments(ctx);
}

// ---------------------------------------------------------------------------
// 1. Global masters — dropdowns, banks, letter templates, holidays, OT policies
// ---------------------------------------------------------------------------

async function seedMasters(ctx: ExtrasContext): Promise<void> {
  const { prisma, branchIds, say } = ctx;
  say('Loading masters (libraries, banks, letter templates, holidays)…');

  await seedLibraryDefaults(prisma);

  for (const b of BANKS) {
    await prisma.bank.upsert({
      where: { country_name: { country: b.country, name: b.name } },
      update: { swift: b.swift, bankCode: b.bankCode, isActive: true },
      create: { country: b.country, name: b.name, swift: b.swift, bankCode: b.bankCode, isActive: true },
    });
  }

  for (const [country, fields] of Object.entries(DEFAULT_COUNTRY_FIELDS)) {
    for (const f of fields) {
      await prisma.countryBankingField.upsert({
        where: { country_fieldKey: { country, fieldKey: f.fieldKey } },
        update: {},
        create: { country, ...f } as any,
      });
    }
  }

  for (const t of LETTER_TEMPLATE_DEFAULTS) {
    await prisma.letterTemplate.upsert({
      where: { key_locale: { key: t.key, locale: t.locale } },
      update: {},
      create: t as any,
    });
  }

  // Omani public holidays for the current year, scoped to the Muscat branch.
  // Rebuilt from scratch: branch-scoped holidays are sample-only, and the
  // (date, branch) partial unique index would reject a duplicate insert.
  const year = new Date().getUTCFullYear();
  await prisma.holiday.deleteMany({ where: { branchId: branchIds[MUSCAT] } });
  for (const h of OMAN_HOLIDAYS) {
    await prisma.holiday.create({
      data: {
        name: h.name,
        date: dU(year, h.month, h.day),
        year,
        isRecurring: true,
        branchId: branchIds[MUSCAT],
        description: `${h.description} (sample, branch-scoped)`,
      },
    });
  }

  // Overtime policies. Deliberately NOT `isDefault` and NOT employment-type
  // scoped: both are guarded by partial unique indexes that a demo seed must not
  // fight with. Employees get them through the per-employee override tier.
  await prisma.overtimePolicy.upsert({
    where: { name: `${SMP}Oman Standard OT` },
    update: { isActive: true },
    create: {
      name: `${SMP}Oman Standard OT`,
      description: 'Oman Labour Law baseline — 1.25x day, 1.5x night, 2x rest day/holiday.',
      isActive: true,
      isDefault: false,
      rules: {
        regularMultiplier: 1.25,
        lateMultiplier: 1.5,
        doubleMultiplier: 2,
        doubleLateMultiplier: 2,
        weeklyOffBehaviour: 'DOUBLE',
        holidayBehavior: 'DOUBLE',
        maxHoursPerDay: 4,
        maxHoursPerMonth: 40,
      },
    },
  });
  await prisma.overtimePolicy.upsert({
    where: { name: `${SMP}Field Crew OT` },
    update: { isActive: true },
    create: {
      name: `${SMP}Field Crew OT`,
      description: 'Site/field crews — flat 1.5x with a higher monthly ceiling.',
      isActive: true,
      isDefault: false,
      rules: {
        regularMultiplier: 1.5,
        lateMultiplier: 1.5,
        doubleMultiplier: 2,
        doubleLateMultiplier: 2.5,
        weeklyOffBehaviour: 'DOUBLE',
        holidayBehavior: 'IGNORE',
        maxHoursPerDay: 6,
        maxHoursPerMonth: 80,
      },
    },
  });
  const omanPolicy = await prisma.overtimePolicy.findUnique({
    where: { name: `${SMP}Oman Standard OT` },
  });
  if (omanPolicy) {
    await prisma.employee.updateMany({
      where: { branchId: branchIds[MUSCAT] },
      data: { overtimePolicyId: omanPolicy.id },
    });
  }

  // External attendance provider on the Muscat branch — disabled, so no cron
  // ever dials out, but the integration page and its run history are populated.
  const integration = await prisma.attendanceIntegration.upsert({
    where: { branchId: branchIds[MUSCAT] },
    update: {},
    create: {
      branchId: branchIds[MUSCAT],
      provider: 'fusion-analytics',
      displayName: 'Fusion / TAGGER (Muscat)',
      enabled: false,
      baseUrl: 'https://tagger.example.om/api',
      authScheme: 'header',
      authHeaderName: 'X-Api-Key',
      externalBranchId: 'TAGGER',
      externalTenantId: '10',
      options: { calculationVersion: 2, sourceTimezone: 'Asia/Muscat', pageSize: 500 },
      conflictPolicy: 'PROVIDER_WINS_SAFE',
      syncIntervalMinutes: 15,
      lookbackDays: 3,
      lastSyncAt: day(-1),
      lastSyncStatus: 'OK',
    },
  });
  await prisma.attendanceSyncRun.deleteMany({ where: { integrationId: integration.id } });
  for (let i = 1; i <= 3; i++) {
    await prisma.attendanceSyncRun.create({
      data: {
        integrationId: integration.id,
        trigger: i === 1 ? 'MANUAL' : 'CRON',
        windowStart: day(-i - 3),
        windowEnd: day(-i),
        startedAt: day(-i),
        finishedAt: day(-i),
        status: i === 3 ? 'PARTIAL' : 'OK',
        fetched: 120 + i * 6,
        matched: 118 + i * 6,
        created: 6,
        updated: 12,
        skipped: i,
        unmapped: i === 3 ? 2 : 0,
        errorCount: 0,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Employee profiles, supervisor hierarchy, teams, face descriptors
// ---------------------------------------------------------------------------

async function seedProfilesAndHierarchy(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, deptIds, branchIds, hrUserId, rng, say } = ctx;
  say('Filling employee profiles, supervisors, teams & face enrolment…');

  const NATIONALITY = ['India', 'India', 'United States', 'Oman'];
  const EDUCATION = ['Bachelor', 'Master', 'Diploma', 'Bachelor', 'Master', 'PhD'];
  const MARITAL = ['SINGLE', 'MARRIED', 'MARRIED', 'SINGLE'];

  for (const emp of employees) {
    const isOman = emp.branchIndex === MUSCAT;
    const city = isOman ? OMANI_CITIES[emp.index % OMANI_CITIES.length] : ['Bengaluru', 'Chennai', 'New York'][emp.branchIndex];
    await prisma.employeeProfile.upsert({
      where: { employeeId: emp.id },
      update: {},
      create: {
        employeeId: emp.id,
        placeOfBirth: city,
        nationality: NATIONALITY[emp.branchIndex],
        maritalStatus: MARITAL[emp.index % MARITAL.length],
        numberOfChildren: emp.index % 3,
        permanentAddress: isOman
          ? `Way ${1000 + emp.index}, Al Khuwair, ${city}, Sultanate of Oman`
          : `${emp.index + 12} Sample Street, ${city}`,
        temporaryAddress: isOman ? `Building ${emp.index + 3}, ${city}` : null,
        passportNumber: isOman ? `OM${pad3(emp.index + 1)}4471` : `P${pad3(emp.index + 1)}88213`,
        passportExpiry: addMonths(day(0), 18 + (emp.index % 24)),
        emergencyContactName: `${emp.fullName.split(' ')[0]} (next of kin)`,
        emergencyContactRelationship: emp.index % 2 === 0 ? 'Spouse' : 'Sibling',
        emergencyContactPhone: isOman ? `+968-95${pad3(emp.index + 10)}0` : `+91-98${pad3(emp.index + 10)}000`,
        highestEducation: EDUCATION[emp.index % EDUCATION.length],
        major: ['Computer Science', 'Business Administration', 'Marketing', 'Accounting', 'Human Resources', 'Logistics'][emp.deptIndex],
        university: isOman ? 'Sultan Qaboos University' : 'National Institute of Technology',
        graduationYear: 2008 + (emp.index % 12),
        professionalCertificates: emp.index % 4 === 0 ? 'PMP, ITIL Foundation' : null,
        taxCode: isOman ? null : `TX${pad3(emp.index + 1)}55`,
        socialInsuranceNumber: isOman ? `PASI-${pad3(emp.index + 1)}${emp.index}` : `SI${pad3(emp.index + 1)}`,
        healthInsuranceNumber: `HI-${pad3(emp.index + 1)}`,
        dependents: emp.index % 4,
        profileCompletionPercentage: 70 + (emp.index % 4) * 10,
        lastProfileUpdate: day(-(emp.index % 30)),
        workExperience: [
          { company: 'Previous Employer LLC', role: 'Associate', from: 2016, to: 2019 },
          { company: 'Another Company SAOC', role: 'Senior Associate', from: 2019, to: 2021 },
        ],
      },
    });
  }

  // Supervisor chain: every employee reports to their branch manager (employee
  // at index branchIndex*6); the branch managers report to the HR business
  // partner (index 4). Dynamic assignment, not RBAC — see supervisor-teams page.
  for (const emp of employees) {
    const branchLeadIdx = emp.branchIndex * 6;
    const supervisorIdx = emp.index === branchLeadIdx ? 4 : branchLeadIdx;
    if (supervisorIdx === emp.index) continue;
    await prisma.employee.update({
      where: { id: emp.id },
      data: { supervisorId: employees[supervisorIdx].id },
    });
  }

  // Teams — one per branch plus a cross-functional Oman rollout squad.
  const teamSpecs = [
    { code: `${SMP}TEAM-BLR`, name: 'Bengaluru Platform Squad', deptIndex: 0, leadIdx: 0, memberIdxs: [0, 1, 2, 3, 4, 5], type: 'PERMANENT' },
    { code: `${SMP}TEAM-MAA`, name: 'Chennai Delivery Squad', deptIndex: 5, leadIdx: 6, memberIdxs: [6, 7, 8, 9, 10, 11], type: 'PERMANENT' },
    { code: `${SMP}TEAM-NYC`, name: 'New York Revenue Desk', deptIndex: 1, leadIdx: 12, memberIdxs: [12, 13, 14, 15, 16, 17], type: 'PERMANENT' },
    { code: `${SMP}TEAM-MCT`, name: 'Muscat Operations Team', deptIndex: 5, leadIdx: 18, memberIdxs: [18, 19, 20, 21, 22, 23], type: 'PERMANENT' },
    { code: `${SMP}TEAM-XF1`, name: 'Oman Rollout Taskforce', deptIndex: 0, leadIdx: 18, memberIdxs: [18, 19, 0, 6, 12], type: 'CROSS_FUNCTIONAL' },
  ];
  for (const t of teamSpecs) {
    const team = await prisma.team.upsert({
      where: { code: t.code },
      update: { name: t.name, teamLeadId: employees[t.leadIdx].id, isActive: true },
      create: {
        code: t.code,
        name: t.name,
        description: `${t.name} — sample team.`,
        departmentId: deptIds[t.deptIndex],
        teamLeadId: employees[t.leadIdx].id,
        type: t.type,
        isActive: true,
      },
    });
    for (const idx of t.memberIdxs) {
      const startDate = dU(2025, 1 + (idx % 12), 1);
      await prisma.teamMember.upsert({
        where: { teamId_employeeId_startDate: { teamId: team.id, employeeId: employees[idx].id, startDate } },
        update: {},
        create: {
          teamId: team.id,
          employeeId: employees[idx].id,
          role: idx === t.leadIdx ? 'LEAD' : idx % 3 === 0 ? 'CONTRIBUTOR' : 'MEMBER',
          allocationPercentage: t.type === 'CROSS_FUNCTIONAL' ? 25 : 100,
          startDate,
          isActive: true,
        },
      });
    }
  }

  // Face enrolment for the Muscat branch + two India logins, so the face
  // management screen has records to review.
  for (const idx of [18, 19, 20, 21, 0, 1]) {
    const descriptor = Array.from({ length: 128 }, () => Math.round((rng() * 2 - 1) * 1e4) / 1e4);
    await prisma.faceDescriptor.create({
      data: {
        employeeId: employees[idx].id,
        descriptor,
        quality: 0.82 + Math.round(rng() * 15) / 100,
      },
    });
  }

  // Employee activity + change history feed the employee detail timeline.
  for (const emp of employees) {
    await prisma.employeeActivity.createMany({
      data: [
        {
          employeeId: emp.id,
          activityType: 'profile_update',
          action: 'updated',
          description: `${emp.fullName} completed their personal profile.`,
          performedBy: hrUserId,
          createdAt: day(-(20 + (emp.index % 10))),
        },
        {
          employeeId: emp.id,
          activityType: 'attendance',
          action: 'created',
          description: 'Checked in from the branch office.',
          performedBy: hrUserId,
          createdAt: day(-(2 + (emp.index % 5))),
        },
        {
          employeeId: emp.id,
          activityType: 'leave_request',
          action: emp.index % 2 === 0 ? 'approved' : 'created',
          description: emp.index % 2 === 0 ? 'Annual leave approved by HR.' : 'Annual leave request submitted.',
          performedBy: hrUserId,
          createdAt: day(-(6 + (emp.index % 8))),
        },
      ],
    });
    await prisma.employeeHistory.createMany({
      data: [
        {
          employeeId: emp.id,
          field: 'position',
          oldValue: 'Junior ' + ['Software Engineer', 'Account Executive', 'Marketing Specialist', 'Financial Analyst', 'HR Business Partner', 'Operations Associate'][emp.deptIndex],
          newValue: ['Software Engineer', 'Account Executive', 'Marketing Specialist', 'Financial Analyst', 'HR Business Partner', 'Operations Associate'][emp.deptIndex],
          changedBy: hrUserId,
          changedAt: day(-(200 + emp.index)),
        },
        {
          employeeId: emp.id,
          field: 'baseSalary',
          oldValue: String(Math.round(emp.baseSalary * 0.92)),
          newValue: String(emp.baseSalary),
          changedBy: hrUserId,
          changedAt: day(-(120 + emp.index)),
        },
      ],
    });
  }

  // Department governance trail — a pending and an approved restructure.
  await prisma.departmentChangeRequest.createMany({
    data: [
      {
        departmentId: deptIds[5],
        requestType: 'MANAGER_CHANGE',
        requestedBy: hrUserId,
        oldManagerId: employees[5].id,
        newManagerId: employees[23].id,
        reason: 'Operations leadership moving to the Muscat branch after the rollout.',
        status: 'PENDING',
        effectiveDate: day(21),
      },
      {
        departmentId: deptIds[2],
        requestType: 'PARENT_CHANGE',
        requestedBy: hrUserId,
        oldParentId: deptIds[1],
        newParentId: deptIds[0],
        reason: 'Marketing realigned under the product organisation.',
        status: 'APPROVED',
        reviewedBy: hrUserId,
        reviewedAt: day(-9),
        reviewNote: 'Approved at the quarterly org review.',
        effectiveDate: day(-5),
      },
      {
        departmentId: deptIds[3],
        requestType: 'MANAGER_CHANGE',
        requestedBy: hrUserId,
        oldManagerId: employees[3].id,
        newManagerId: employees[9].id,
        reason: 'Finance manager relocating; cover requested.',
        status: 'REJECTED',
        reviewedBy: hrUserId,
        reviewedAt: day(-3),
        reviewNote: 'Deferred to the next fiscal year.',
        effectiveDate: day(30),
      },
    ],
  });
  await prisma.departmentHistory.createMany({
    data: [
      {
        departmentId: deptIds[2],
        changeType: 'PARENT_CHANGE',
        changedBy: hrUserId,
        oldValue: { parent: 'Sales' },
        newValue: { parent: 'Engineering' },
        changeReason: 'Quarterly org review.',
        createdAt: day(-5),
      },
      {
        departmentId: deptIds[5],
        changeType: 'CREATED',
        changedBy: hrUserId,
        newValue: { name: 'Operations' },
        changeReason: 'Initial setup.',
        createdAt: day(-400),
      },
    ],
  });

  // Copilot + chatbot history, so the assistant screens open with a thread.
  await prisma.copilotConversation.create({
    data: {
      userId: hrUserId,
      title: 'Muscat headcount & OT spend',
      branchId: branchIds[MUSCAT],
      messages: {
        create: [
          { role: 'user', content: 'How many active employees do we have in the Muscat branch?' },
          { role: 'assistant', content: 'The Muscat branch currently has 6 active employees across 6 departments.' },
          { role: 'user', content: 'What did we spend on overtime there last month?' },
          { role: 'assistant', content: 'Approved overtime in Muscat last month came to 9 hours across 3 requests, plus OMR 18 in food allowance.' },
        ],
      },
    },
  });
  for (const idx of [18, 19, 0]) {
    await prisma.chatHistory.createMany({
      data: [
        {
          employeeId: employees[idx].id,
          userMessage: 'How many annual leave days do I have left?',
          botResponse: 'You have 9 annual leave days remaining for this year.',
          createdAt: day(-4),
        },
        {
          employeeId: employees[idx].id,
          userMessage: 'When is the next public holiday?',
          botResponse: 'The next public holiday for your branch is National Day on 18 November.',
          createdAt: day(-2),
        },
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Bank master, employee bank details, change requests
// ---------------------------------------------------------------------------

async function seedBanking(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, branchIds, hrUserId, say } = ctx;
  say('Wiring payment details (Bank Master, IBANs, change requests)…');

  const banksByCountry: Record<string, { id: string; name: string; bankCode: string | null }[]> = {};
  for (const country of ['OM', 'IN', 'US']) {
    banksByCountry[country] = await prisma.bank.findMany({
      where: { country, isActive: true },
      select: { id: true, name: true, bankCode: true },
      orderBy: { name: 'asc' },
    });
  }
  const countryOfBranch = ['IN', 'IN', 'US', 'OM'];

  // Which field schemas each branch's employees may use. Muscat also allows AE,
  // because staff on the UAE rotation are paid into Emirates accounts.
  for (let b = 0; b < branchIds.length; b++) {
    await prisma.branch.update({
      where: { id: branchIds[b] },
      data: { bankingCountries: b === MUSCAT ? ['OM', 'AE'] : [countryOfBranch[b]] },
    });
  }

  // Three employees keep only LEGACY free-text bank data and get no active
  // EmployeeBankDetail — they are the migration queue on the Bank Master
  // migrate screen. Everyone else is already on the versioned model.
  //
  // All three are deliberately OUTSIDE Muscat (indices 18-23). An employee with
  // no active bank detail is a BLOCKING `NO_ACTIVE_BANK_DETAIL` finding on the
  // wage file, and Muscat is the branch whose file the demo has to generate —
  // so the migration queue is shown on a branch that produces no wage file.
  const legacyOnly = new Set([15, 16, 17]);

  for (const emp of employees) {
    const country = countryOfBranch[emp.branchIndex];
    const pool = banksByCountry[country];
    if (!pool?.length) continue;
    const bank = pool[emp.index % pool.length];

    let data: Record<string, string>;
    let iban: string | null = null;
    let accountNumber: string | null = null;
    if (country === 'OM') {
      // OM IBAN: OM + 2 check + 3-digit bank code + 16-digit account = 23 chars.
      const bban = `${bank.bankCode ?? '018'}${String(1000000000000000 + emp.index * 7919).slice(0, 16)}`;
      iban = ibanWithCheckDigits('OM', bban);
      data = { accountHolderName: emp.fullName, iban };
    } else if (country === 'IN') {
      accountNumber = `5011${pad3(emp.index + 1)}0099${emp.index}`;
      data = {
        accountHolderName: emp.fullName,
        accountNumber,
        ifsc: `${bank.name.slice(0, 4).toUpperCase()}0${pad3(emp.index + 1)}123`.slice(0, 11),
      };
    } else {
      accountNumber = `0001${pad3(emp.index + 1)}4455`;
      data = { accountHolderName: emp.fullName, accountNumber, routingNumber: '021000021' };
    }

    // Legacy free-text copy always exists on the profile — that is what the
    // pre-Bank-Master system stored, and what the migrate screen reads.
    await prisma.employeeProfile.update({
      where: { employeeId: emp.id },
      data: {
        bankName: bank.name,
        bankAccountNumber: accountNumber ?? iban,
        bankAccountHolderName: emp.fullName,
        bankBranch: country === 'OM' ? 'Al Khuwair Branch' : 'Main Branch',
      },
    });

    if (legacyOnly.has(emp.index)) continue;

    await prisma.employeeBankDetail.create({
      data: {
        employeeId: emp.id,
        bankId: bank.id,
        data,
        iban,
        accountNumber,
        accountHolderName: emp.fullName,
        isActive: true,
        effectiveFrom: emp.startDate,
        source: 'APPROVAL',
        branchId: branchIds[emp.branchIndex],
      },
    });
  }

  // Change requests across every state. Only ONE may be PENDING per employee
  // (partial unique index), so each state goes to a different person.
  //
  // The two PENDING requests sit on INDIA employees on purpose. A pending bank
  // change is a BLOCKING wage-file finding — "decide it before generating, or
  // the file may pay the wrong account" — and it blocked ten of Muscat's
  // thirteen employees before this. The approval queue is the same screen
  // wherever the requester works, and India produces no wage file, so the
  // reviewer demo and the Oman file demo stop fighting each other.
  const omBanks = banksByCountry['OM'];
  const inBanks = banksByCountry['IN'];
  const reqSpecs = [
    { empIdx: 2, bank: inBanks?.[1], country: 'IN', status: 'PENDING', decidedAt: null as Date | null },
    { empIdx: 5, bank: inBanks?.[2], country: 'IN', status: 'PENDING', decidedAt: null as Date | null },
    { empIdx: 22, bank: omBanks[3], country: 'OM', status: 'APPROVED', decidedAt: day(-6) },
    { empIdx: 23, bank: omBanks[4], country: 'OM', status: 'REJECTED', decidedAt: day(-4) },
    { empIdx: 19, bank: omBanks[5], country: 'OM', status: 'CANCELLED', decidedAt: day(-2) },
  ];
  for (const r of reqSpecs) {
    if (!r.bank) continue;
    const emp = employees[r.empIdx];
    let data: Record<string, string>;
    let iban: string | null = null;
    let accountNumber: string | null = null;
    if (r.country === 'OM') {
      const bban = `${r.bank.bankCode ?? '018'}${String(2000000000000000 + r.empIdx * 6337).slice(0, 16)}`;
      iban = ibanWithCheckDigits('OM', bban);
      data = { accountHolderName: emp.fullName, iban };
    } else {
      accountNumber = `6022${pad3(r.empIdx + 1)}0088${r.empIdx}`;
      data = {
        accountHolderName: emp.fullName,
        accountNumber,
        ifsc: `${r.bank.name.slice(0, 4).toUpperCase()}0${pad3(r.empIdx + 1)}456`.slice(0, 11),
      };
    }
    await prisma.bankChangeRequest.create({
      data: {
        employeeId: emp.id,
        bankId: r.bank.id,
        data,
        iban,
        accountNumber,
        accountHolderName: emp.fullName,
        status: r.status,
        requestedById: hrUserId,
        branchId: branchIds[emp.branchIndex],
        decidedAt: r.decidedAt,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Per-leave-type balances + accrual history
// ---------------------------------------------------------------------------

async function seedLeaveBalancesAndAccruals(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, hrUserId, rng, say } = ctx;
  say('Allocating per-type leave balances & accrual history…');

  const leaveTypes = await prisma.libraryItem.findMany({
    where: { libraryType: 'LEAVE_TYPE', isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
  const year = new Date().getUTCFullYear();

  for (const emp of employees) {
    for (const lt of leaveTypes) {
      // Gender-restricted types only go to the eligible half of the population.
      if (lt.genderRestriction === 'FEMALE' && emp.index % 2 === 0) continue;
      if (lt.genderRestriction === 'MALE' && emp.index % 2 !== 0) continue;
      const allocated = lt.defaultDays ?? 0;
      const used = allocated > 0 ? randInt(rng, 0, Math.min(4, allocated)) : 0;
      await prisma.leaveTypeBalance.upsert({
        where: { employeeId_year_leaveTypeKey: { employeeId: emp.id, year, leaveTypeKey: lt.label } },
        update: {},
        create: {
          employeeId: emp.id,
          year,
          leaveTypeKey: lt.label,
          allocated,
          used,
          carriedOver: lt.label === 'Annual Leave' ? randInt(rng, 0, 5) : 0,
        },
      });
    }

    // Monthly annual-leave accrual for the last three months.
    for (let back = 3; back >= 1; back--) {
      const d = addMonths(day(0), -back);
      const before = 12 - back;
      await prisma.leaveAccrualHistory.create({
        data: {
          employeeId: emp.id,
          year: d.getUTCFullYear(),
          month: d.getUTCMonth() + 1,
          daysAdded: 1,
          balanceBefore: before,
          balanceAfter: before + 1,
          accrualType: 'MONTHLY',
          triggeredBy: hrUserId,
          notes: 'Automatic monthly annual-leave accrual.',
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Attendance corrections
// ---------------------------------------------------------------------------

async function seedAttendanceExtras(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, hrUserId, say } = ctx;
  say('Raising attendance correction requests…');

  const specs = [
    { empIdx: 18, status: 'PENDING' },
    { empIdx: 19, status: 'PENDING' },
    { empIdx: 20, status: 'APPROVED' },
    { empIdx: 21, status: 'REJECTED' },
    { empIdx: 0, status: 'PENDING' },
    { empIdx: 1, status: 'APPROVED' },
    { empIdx: 2, status: 'REJECTED' },
    { empIdx: 6, status: 'PENDING' },
  ];
  for (const s of specs) {
    const emp = employees[s.empIdx];
    // Anchor on a real attendance row so the correction shows before/after.
    const att = await prisma.attendance.findFirst({
      where: { employeeId: emp.id, status: 'PRESENT' },
      orderBy: { date: 'desc' },
    });
    if (!att) continue;
    const decided = s.status !== 'PENDING';
    await prisma.attendanceCorrection.create({
      data: {
        employeeId: emp.id,
        attendanceId: att.id,
        date: att.date,
        originalCheckIn: att.checkIn,
        originalCheckOut: att.checkOut,
        requestedCheckIn: att.checkIn ? new Date(att.checkIn.getTime() - 25 * 60_000) : null,
        requestedCheckOut: att.checkOut ? new Date(att.checkOut.getTime() + 40 * 60_000) : null,
        reason: 'Biometric terminal was offline; punch recorded by the site supervisor.',
        status: s.status,
        approverId: decided ? hrUserId : null,
        approvedAt: s.status === 'APPROVED' ? day(-1) : null,
        approverNotes: s.status === 'APPROVED' ? 'Verified against the gate register.' : null,
        rejectedReason: s.status === 'REJECTED' ? 'No supporting evidence attached.' : null,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 6. Rewards & disciplines
// ---------------------------------------------------------------------------

async function seedRewardsAndDisciplines(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, hrUserId, say } = ctx;
  say('Recording rewards & disciplinary actions…');

  const rewardSpecs = [
    { empIdx: 18, type: 'BONUS', amount: 250, reason: 'Delivered the Muscat rollout two weeks ahead of plan.', daysAgo: 12 },
    { empIdx: 19, type: 'RECOGNITION', amount: 100, reason: 'Employee of the month — customer escalation handling.', daysAgo: 30 },
    { empIdx: 20, type: 'BONUS', amount: 180, reason: 'Zero defects across the quarter’s releases.', daysAgo: 45 },
    { empIdx: 22, type: 'ALLOWANCE', amount: 75, reason: 'Additional site coverage during National Day week.', daysAgo: 20 },
    { empIdx: 0, type: 'BONUS', amount: 15000, reason: 'Platform migration completed without downtime.', daysAgo: 25 },
    { empIdx: 1, type: 'RECOGNITION', amount: 5000, reason: 'Largest new logo of the quarter.', daysAgo: 40 },
    { empIdx: 6, type: 'BONUS', amount: 12000, reason: 'Rescued an at-risk delivery.', daysAgo: 60 },
    { empIdx: 12, type: 'RECOGNITION', amount: 800, reason: 'Mentored three new joiners through onboarding.', daysAgo: 15 },
  ];
  for (const r of rewardSpecs) {
    await prisma.reward.create({
      data: {
        employeeId: employees[r.empIdx].id,
        reason: r.reason,
        amount: r.amount,
        rewardDate: day(-r.daysAgo),
        rewardType: r.type,
        createdBy: hrUserId,
      },
    });
  }

  const disciplineSpecs = [
    { empIdx: 21, type: 'VERBAL_WARNING', amount: 0, reason: 'Repeated late arrival over three consecutive days.', daysAgo: 18 },
    { empIdx: 23, type: 'WRITTEN_WARNING', amount: 0, reason: 'Left the site without notifying the supervisor.', daysAgo: 35 },
    { empIdx: 7, type: 'DEDUCTION', amount: 1500, reason: 'Unauthorised absence — two working days.', daysAgo: 22 },
    { empIdx: 13, type: 'VERBAL_WARNING', amount: 0, reason: 'Failure to submit the weekly timesheet.', daysAgo: 10 },
    { empIdx: 10, type: 'WRITTEN_WARNING', amount: 0, reason: 'Breach of the clean-desk policy during an audit.', daysAgo: 55 },
    { empIdx: 16, type: 'DEDUCTION', amount: 900, reason: 'Damage to company equipment through negligence.', daysAgo: 48 },
  ];
  for (const d of disciplineSpecs) {
    await prisma.discipline.create({
      data: {
        employeeId: employees[d.empIdx].id,
        reason: d.reason,
        disciplineType: d.type,
        amount: d.amount,
        disciplineDate: day(-d.daysAgo),
        createdBy: hrUserId,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 7. Document vault + visa lifecycle
// ---------------------------------------------------------------------------

async function seedDocumentsAndVisas(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, hrUserId, say } = ctx;
  say('Filing personal documents & the Oman visa lifecycle…');

  for (const emp of employees) {
    const isOman = emp.branchIndex === MUSCAT;
    const docs = [
      {
        documentType: 'Passport',
        fileName: `passport-${emp.index + 1}.pdf`,
        issueDate: addMonths(emp.startDate, -12),
        expiryDate: addMonths(day(0), 14 + (emp.index % 30)),
      },
      {
        documentType: 'National ID',
        fileName: `id-card-${emp.index + 1}.pdf`,
        issueDate: emp.startDate,
        expiryDate: addMonths(day(0), 24 + (emp.index % 12)),
      },
      {
        documentType: 'Employment Contract',
        fileName: `contract-${SMP}CTR-${pad3(emp.index + 1)}.pdf`,
        issueDate: emp.startDate,
        expiryDate: null as Date | null,
      },
    ];
    if (isOman) {
      docs.push({
        documentType: 'Health Certificate',
        fileName: `health-card-${emp.index + 1}.pdf`,
        issueDate: addMonths(day(0), -10),
        expiryDate: addMonths(day(0), 2),
      });
    }
    for (const d of docs) {
      await prisma.employeeDocument.create({
        data: {
          employeeId: emp.id,
          documentType: d.documentType,
          fileName: d.fileName,
          fileUrl: `/sample/documents/${d.fileName}`,
          fileSize: BigInt(180_000 + emp.index * 1_500),
          mimeType: 'application/pdf',
          description: `${d.documentType} on file for ${emp.fullName}.`,
          issueDate: d.issueDate,
          expiryDate: d.expiryDate,
          isSystemGenerated: d.documentType === 'Employment Contract',
          uploadedBy: hrUserId,
          uploadedAt: day(-(10 + (emp.index % 40))),
        },
      });
    }
  }

  // Oman visas — one per Muscat employee, spread across the lifecycle, plus a
  // full renewal chain (old RENEWED record -> new ACTIVE record).
  const visaSpecs = [
    { empIdx: 18, type: 'Employment Visa', expiryMonths: 14, status: 'ACTIVE' },
    { empIdx: 19, type: 'Employment Visa', expiryMonths: 2, status: 'ACTIVE' }, // inside alert window
    { empIdx: 20, type: 'Employment Visa', expiryMonths: 1, status: 'ACTIVE' }, // expiring soon
    { empIdx: 21, type: 'Investor Visa', expiryMonths: 20, status: 'ACTIVE' },
    { empIdx: 22, type: 'Employment Visa', expiryMonths: -2, status: 'EXPIRED' },
    { empIdx: 23, type: 'Family Joining Visa', expiryMonths: 8, status: 'ACTIVE' },
  ];
  for (const v of visaSpecs) {
    const emp = employees[v.empIdx];
    await prisma.employeeLegalDocument.create({
      data: {
        employeeId: emp.id,
        category: 'VISA',
        documentNumber: `${SMP}VISA-${pad3(v.empIdx + 1)}`,
        documentType: v.type,
        country: 'Oman',
        issueDate: addMonths(day(0), v.expiryMonths - 24),
        expiryDate: addMonths(day(0), v.expiryMonths),
        issuingAuthority: 'Royal Oman Police — Directorate General of Passports',
        placeOfIssue: 'Muscat',
        sponsor: 'Sample HRMS LLC',
        status: v.status,
        isCurrent: v.status !== 'EXPIRED',
        createdById: hrUserId,
      },
    });
  }

  // Renewal chain on employee 18: the superseded record must NOT be current.
  const current18 = await prisma.employeeLegalDocument.findFirst({
    where: { employeeId: employees[18].id, isCurrent: true },
  });
  if (current18) {
    const old = await prisma.employeeLegalDocument.create({
      data: {
        employeeId: employees[18].id,
        category: 'VISA',
        documentNumber: `${SMP}VISA-018-PREV`,
        documentType: 'Employment Visa',
        country: 'Oman',
        issueDate: addMonths(day(0), -48),
        expiryDate: addMonths(day(0), -10),
        issuingAuthority: 'Royal Oman Police — Directorate General of Passports',
        placeOfIssue: 'Muscat',
        sponsor: 'Sample HRMS LLC',
        status: 'RENEWED',
        isCurrent: false,
        createdById: hrUserId,
      },
    });
    await prisma.employeeLegalDocument.update({
      where: { id: current18.id },
      data: { renewedFromId: old.id },
    });
  }
}

// ---------------------------------------------------------------------------
// 8. Letters + grievances
// ---------------------------------------------------------------------------

async function seedLettersAndGrievances(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, hrUserId, say } = ctx;
  say('Issuing self-service letters & opening grievance cases…');

  const letterSpecs = [
    { empIdx: 18, key: 'SALARY_CERTIFICATE', locale: 'en', status: 'ISSUED', addressedTo: 'Bank Muscat', purpose: 'Personal loan application' },
    { empIdx: 19, key: 'SALARY_CERTIFICATE', locale: 'ar', status: 'PENDING', addressedTo: 'بنك ظفار', purpose: 'طلب تمويل شخصي' },
    { empIdx: 20, key: 'NOC', locale: 'en', status: 'ISSUED', addressedTo: 'Royal Oman Police', purpose: 'Driving licence transfer' },
    { empIdx: 21, key: 'EXPERIENCE', locale: 'en', status: 'PENDING', addressedTo: 'To whom it may concern', purpose: 'Professional membership' },
    { empIdx: 22, key: 'EMBASSY', locale: 'en', status: 'REJECTED', addressedTo: 'Embassy of France', purpose: 'Schengen visa' },
    { empIdx: 0, key: 'SALARY_CERTIFICATE', locale: 'en', status: 'ISSUED', addressedTo: 'HDFC Bank', purpose: 'Home loan' },
    { empIdx: 1, key: 'NOC', locale: 'en', status: 'PENDING', addressedTo: 'Regional Transport Office', purpose: 'Vehicle registration' },
    { empIdx: 6, key: 'EXPERIENCE', locale: 'en', status: 'ISSUED', addressedTo: 'To whom it may concern', purpose: 'Higher studies application' },
  ];
  const templates = await prisma.letterTemplate.findMany({ select: { key: true, locale: true } });
  const hasTemplate = (key: string, locale: string) =>
    templates.some((t) => t.key === key && t.locale === locale);

  let serial = 1;
  for (const l of letterSpecs) {
    const locale = hasTemplate(l.key, l.locale) ? l.locale : 'en';
    if (!hasTemplate(l.key, locale)) continue;
    const issued = l.status === 'ISSUED';
    await prisma.letterRequest.create({
      data: {
        employeeId: employees[l.empIdx].id,
        templateKey: l.key,
        locale,
        purpose: l.purpose,
        addressedTo: l.addressedTo,
        status: l.status,
        serialNumber: issued ? `${SMP}${l.key.split('_')[0].slice(0, 6).toUpperCase()}-${pad3(serial++)}` : null,
        fileRef: issued ? `private://sample/letters/${l.key.toLowerCase()}-${l.empIdx}.pdf` : null,
        issuedById: issued ? hrUserId : null,
        issuedAt: issued ? day(-(3 + l.empIdx % 10)) : null,
        rejectedReason: l.status === 'REJECTED' ? 'Purpose could not be verified; please re-submit with the appointment letter.' : null,
      },
    });
  }

  const grievanceSpecs = [
    {
      empIdx: 21, againstIdx: 18, category: 'Management Practice', status: 'OPEN', confidential: true,
      subject: 'Unequal allocation of weekend shifts',
      description: 'Weekend shifts have been allocated to me three weeks running while the rota shows others were available.',
      resolution: null as string | null,
    },
    {
      empIdx: 22, againstIdx: null, category: 'Workplace Safety', status: 'INVESTIGATING', confidential: false,
      subject: 'Air-conditioning failure in the Muscat warehouse',
      description: 'The warehouse cooling has been out for a week; afternoon temperatures make the area unsafe to work in.',
      resolution: null as string | null,
    },
    {
      empIdx: 7, againstIdx: null, category: 'Compensation', status: 'RESOLVED', confidential: false,
      subject: 'Overtime hours missing from last month’s payslip',
      description: 'Three approved overtime requests do not appear in the payslip for last month.',
      resolution: 'Payroll re-run corrected the omission; the arrears were paid with the current cycle.',
    },
    {
      empIdx: 13, againstIdx: 12, category: 'Harassment', status: 'CLOSED', confidential: true,
      subject: 'Inappropriate remarks during a team meeting',
      description: 'Comments made during the weekly team meeting were personal and unprofessional.',
      resolution: 'Investigated and substantiated; a written warning was issued and mediation completed.',
    },
    {
      empIdx: 10, againstIdx: null, category: 'Facilities', status: 'ACKNOWLEDGED', confidential: false,
      subject: 'Insufficient parking at the Chennai office',
      description: 'Parking capacity has not kept up with headcount; staff are parking on the access road.',
      resolution: null as string | null,
    },
  ];
  for (const g of grievanceSpecs) {
    const resolved = g.status === 'RESOLVED' || g.status === 'CLOSED';
    await prisma.grievance.create({
      data: {
        employeeId: employees[g.empIdx].id,
        category: g.category,
        subject: g.subject,
        description: g.description,
        isConfidential: g.confidential,
        againstEmployeeId: g.againstIdx == null ? null : employees[g.againstIdx].id,
        status: g.status,
        assignedToId: hrUserId,
        resolution: g.resolution,
        resolvedAt: resolved ? day(-4) : null,
        events: {
          create: [
            { type: 'STATUS_CHANGE', toStatus: 'OPEN', note: 'Grievance raised.', actorUserId: hrUserId, createdAt: day(-20) },
            { type: 'ASSIGNED', note: 'Assigned to the HR business partner.', actorUserId: hrUserId, createdAt: day(-19) },
            ...(g.status === 'OPEN'
              ? []
              : [{ type: 'STATUS_CHANGE', fromStatus: 'OPEN', toStatus: g.status, note: `Moved to ${g.status}.`, actorUserId: hrUserId, createdAt: day(-8) }]),
            ...(resolved
              ? [{ type: 'NOTE', note: g.resolution ?? 'Case closed.', isInternal: false, actorUserId: hrUserId, createdAt: day(-4) }]
              : []),
          ],
        },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 9. Assets & custody
// ---------------------------------------------------------------------------

async function seedAssets(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, branchIds, hrUserId, say } = ctx;
  say('Registering company assets & custody records…');

  const catalogue = [
    { category: 'Laptop', name: 'Dell Latitude 5540', cost: 850 },
    { category: 'Laptop', name: 'MacBook Pro 14"', cost: 1900 },
    { category: 'Mobile Phone', name: 'iPhone 15', cost: 520 },
    { category: 'Mobile Phone', name: 'Samsung Galaxy S24', cost: 430 },
    { category: 'Vehicle', name: 'Toyota Hilux (site pickup)', cost: 12500 },
    { category: 'SIM Card', name: 'Corporate SIM — Omantel', cost: 15 },
    { category: 'Access Card', name: 'Site access badge', cost: 5 },
    { category: 'Monitor', name: 'Dell 27" UltraSharp', cost: 210 },
  ];

  let tag = 1;
  const assets: { id: string; branchIndex: number; status: AssetStatus }[] = [];
  for (let b = 0; b < branchIds.length; b++) {
    for (let i = 0; i < catalogue.length; i++) {
      const c = catalogue[i];
      const status: AssetStatus =
        i === 6
          ? 'IN_REPAIR'
          : i === 7 && b === 1
            ? 'RETIRED'
            : // One LOST asset in the whole estate. `LOST` had no rows on any
              // seeded database, so the Workplace hub's exception panel and its
              // value-at-risk figure were both structurally unreachable — a
              // status nothing can ever be is indistinguishable from a bug.
              i === 5 && b === 2
              ? 'LOST'
              : 'AVAILABLE';
      const asset = await prisma.assetItem.upsert({
        // R2 — asset_tag is unique per BRANCH, so the pair identifies the row.
        where: {
          branchId_assetTag: {
            branchId: branchIds[b],
            assetTag: `${SMP}AST-${pad3(tag)}`,
          },
        },
        update: {},
        create: {
          assetTag: `${SMP}AST-${pad3(tag)}`,
          category: c.category,
          name: c.name,
          serialNumber: `SN-${SMP}${pad3(tag)}`,
          branchId: branchIds[b],
          status,
          purchaseDate: day(-(200 + tag * 5)),
          purchaseCost: c.cost,
          // Spread warranties so some land inside the reminder tiers.
          warrantyExpiry: day([20, 55, 200, 400, 15, 700, 90, 300][i]),
          notes: status === 'IN_REPAIR' ? 'With the vendor for a display fault.' : null,
        },
      });
      assets.push({ id: asset.id, branchIndex: b, status });
      tag += 1;
    }
  }

  // Hand out the first three assets in every branch; return one of them, so the
  // custody history has both open and closed periods (open = blocks clearance).
  for (let b = 0; b < branchIds.length; b++) {
    const branchAssets = assets.filter((a) => a.branchIndex === b && a.status === 'AVAILABLE');
    for (let k = 0; k < 3 && k < branchAssets.length; k++) {
      const asset = branchAssets[k];
      const holder = employees[b * 6 + k];
      const returned = k === 2;
      // The middle handover in each branch is left UNSIGNED. Every assignment
      // used to set `acknowledgedAt`, which meant "assets handed over but never
      // signed for" — a real worklist, and the hub's own headline — was zero on
      // every demo database. A KPI that cannot move is not a KPI.
      const acknowledged = k !== 1;
      await prisma.assetAssignment.create({
        data: {
          assetId: asset.id,
          employeeId: holder.id,
          assignedAt: day(-(60 + k * 10)),
          assignedById: hrUserId,
          conditionOut: 'New',
          acknowledgedAt: acknowledged ? day(-(59 + k * 10)) : null,
          acknowledgedNote: acknowledged ? 'Received in good condition.' : null,
          returnedAt: returned ? day(-5) : null,
          conditionIn: returned ? 'Good — minor wear' : null,
          returnReceivedById: returned ? hrUserId : null,
        },
      });
      if (!returned) {
        await prisma.assetItem.update({ where: { id: asset.id }, data: { status: 'ASSIGNED' } });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 10. Travel requests
// ---------------------------------------------------------------------------

async function seedTravel(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, hrUserId, say } = ctx;
  say('Booking business travel (trips, itineraries & per-diem claims)…');

  const destinations = await prisma.libraryItem.findMany({
    where: { libraryType: 'PER_DIEM_DESTINATION', isActive: true },
  });
  const rateOf = (label: string) =>
    Number(destinations.find((d) => d.label === label)?.perDiemRate ?? 60);

  const trips = [
    {
      empIdx: 18, purpose: 'Client onboarding workshop', type: 'INTERNATIONAL', destination: 'GCC',
      country: 'United Arab Emirates', from: 12, to: 16, status: 'PENDING', advance: 300,
      legs: [
        { mode: 'FLIGHT', fromPlace: 'Muscat', toPlace: 'Dubai', ref: 'WY-611' },
        { mode: 'HOTEL', toPlace: 'Dubai', ref: 'HTL-88213' },
        { mode: 'FLIGHT', fromPlace: 'Dubai', toPlace: 'Muscat', ref: 'WY-616' },
      ],
    },
    {
      empIdx: 19, purpose: 'Regional HR conference', type: 'INTERNATIONAL', destination: 'GCC',
      country: 'Qatar', from: -20, to: -16, status: 'COMPLETED', advance: 250,
      legs: [
        { mode: 'FLIGHT', fromPlace: 'Muscat', toPlace: 'Doha', ref: 'QR-1137' },
        { mode: 'HOTEL', toPlace: 'Doha', ref: 'HTL-55401' },
      ],
    },
    {
      empIdx: 20, purpose: 'Salalah site inspection', type: 'DOMESTIC', destination: 'Domestic - Other City',
      country: 'Oman', from: 5, to: 7, status: 'APPROVED', advance: 80,
      legs: [
        { mode: 'FLIGHT', fromPlace: 'Muscat', toPlace: 'Salalah', ref: 'WY-901' },
        { mode: 'ROAD', fromPlace: 'Salalah Airport', toPlace: 'Raysut site', ref: null },
      ],
    },
    {
      empIdx: 22, purpose: 'Vendor negotiation', type: 'INTERNATIONAL', destination: 'Asia',
      country: 'India', from: 25, to: 30, status: 'REJECTED', advance: null,
      legs: [{ mode: 'FLIGHT', fromPlace: 'Muscat', toPlace: 'Mumbai', ref: 'AI-984' }],
    },
    {
      empIdx: 0, purpose: 'Annual engineering summit', type: 'INTERNATIONAL', destination: 'Europe',
      country: 'Germany', from: 40, to: 46, status: 'PENDING', advance: 600,
      legs: [
        { mode: 'FLIGHT', fromPlace: 'Bengaluru', toPlace: 'Frankfurt', ref: 'LH-755' },
        { mode: 'TRAIN', fromPlace: 'Frankfurt', toPlace: 'Berlin', ref: 'ICE-1042' },
      ],
    },
    {
      empIdx: 12, purpose: 'Key account QBR', type: 'DOMESTIC', destination: 'Domestic - Other City',
      country: 'United States', from: -8, to: -6, status: 'CANCELLED', advance: null,
      legs: [{ mode: 'FLIGHT', fromPlace: 'New York', toPlace: 'Chicago', ref: 'UA-402' }],
    },
  ];

  for (const t of trips) {
    const days = Math.max(1, t.to - t.from + 1);
    const rate = rateOf(t.destination);
    const decided = t.status === 'APPROVED' || t.status === 'REJECTED' || t.status === 'COMPLETED';
    const trip = await prisma.travelRequest.create({
      data: {
        employeeId: employees[t.empIdx].id,
        purpose: t.purpose,
        travelType: t.type,
        destination: t.destination,
        country: t.country,
        departureDate: day(t.from),
        returnDate: day(t.to),
        perDiemRate: rate,
        perDiemDays: days,
        estimatedCost: Math.round(rate * days + 350),
        advanceAmount: t.advance,
        status: t.status,
        approverId: decided ? hrUserId : null,
        approvedAt: t.status === 'APPROVED' || t.status === 'COMPLETED' ? day(t.from - 5) : null,
        approverRemarks: t.status === 'APPROVED' ? 'Approved; book through the corporate travel desk.' : null,
        rejectedReason: t.status === 'REJECTED' ? 'Budget for the quarter is already committed.' : null,
        itinerary: {
          create: t.legs.map((l, i) => ({
            legOrder: i + 1,
            mode: l.mode,
            fromPlace: (l as any).fromPlace ?? null,
            toPlace: l.toPlace ?? null,
            startAt: atTime(day(t.from + i), 8 + i * 3),
            endAt: l.mode === 'HOTEL' ? atTime(day(t.to), 12) : null,
            reference: l.ref,
          })),
        },
      },
    });

    // An approved/completed trip spawns its per-diem claim on the reimbursement
    // ledger — the same path payroll already pays out.
    if (t.status === 'APPROVED' || t.status === 'COMPLETED') {
      await prisma.reimbursement.create({
        data: {
          employeeId: employees[t.empIdx].id,
          type: 'Travel',
          amount: rate * days,
          expenseDate: day(t.to),
          description: `Per diem — ${t.purpose} (${days} days @ ${rate}/day)`,
          status: t.status === 'COMPLETED' ? 'PAID' : 'APPROVED',
          approverId: hrUserId,
          approvedAt: day(t.to),
          approverRemarks: 'Per-diem entitlement for an approved trip.',
          paidAt: t.status === 'COMPLETED' ? day(t.to + 3) : null,
          sourceType: 'TRAVEL',
          sourceId: trip.id,
          budgetCategory: 'Travel',
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 11. Training — courses, sessions, nominations, certificates
// ---------------------------------------------------------------------------

async function seedTraining(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, branchIds, hrUserId, say } = ctx;
  say('Scheduling training courses, sessions & nominations…');

  const courseSpecs = [
    { code: `${SMP}SEC-101`, title: 'Information Security Awareness', category: 'Compliance', provider: 'Internal L&D', hours: 8, cost: 150, validMonths: 12 },
    { code: `${SMP}LEAD-201`, title: 'First-Line Leadership', category: 'Leadership', provider: 'Oman Management Institute', hours: 16, cost: 400, validMonths: null },
    { code: `${SMP}OSH-110`, title: 'Occupational Health & Safety (Oman)', category: 'Compliance', provider: 'Ministry of Labour approved', hours: 12, cost: 220, validMonths: 24 },
    { code: `${SMP}FIN-130`, title: 'IFRS for Non-Finance Managers', category: 'Technical', provider: 'External', hours: 10, cost: 310, validMonths: null },
    { code: `${SMP}LNG-140`, title: 'Business Arabic', category: 'Soft Skills', provider: 'Internal L&D', hours: 30, cost: 180, validMonths: null },
  ];
  const courses: Record<string, string> = {};
  for (const c of courseSpecs) {
    const course = await prisma.course.upsert({
      where: { code: c.code },
      update: { isActive: true },
      create: {
        code: c.code,
        title: c.title,
        category: c.category,
        provider: c.provider,
        description: `${c.title} — sample catalogue entry.`,
        durationHours: c.hours,
        defaultCost: c.cost,
        certValidMonths: c.validMonths,
        isActive: true,
      },
    });
    courses[c.code] = course.id;
  }

  const sessionSpecs = [
    { code: `${SMP}SEC-101`, branchIndex: MUSCAT, from: 18, to: 19, location: 'Muscat HQ — Training Room 2', trainer: 'Said Al-Kindi', seats: 12, cost: 150, status: 'SCHEDULED' },
    { code: `${SMP}SEC-101`, branchIndex: MUSCAT, from: -340, to: -339, location: 'Muscat HQ', trainer: 'Said Al-Kindi', seats: 12, cost: 150, status: 'COMPLETED' },
    { code: `${SMP}OSH-110`, branchIndex: MUSCAT, from: -5, to: -3, location: 'Sohar Industrial Estate', trainer: 'Nasser Al-Rawahi', seats: 20, cost: 220, status: 'COMPLETED' },
    { code: `${SMP}LEAD-201`, branchIndex: MUSCAT, from: 32, to: 34, location: 'Muscat — Crowne Plaza', trainer: 'External faculty', seats: 15, cost: 400, status: 'SCHEDULED' },
    { code: `${SMP}FIN-130`, branchIndex: 0, from: 10, to: 11, location: 'Bengaluru Hub — Auditorium', trainer: 'External faculty', seats: 25, cost: 310, status: 'SCHEDULED' },
    { code: `${SMP}LNG-140`, branchIndex: null, from: 2, to: 40, location: 'Online', trainer: 'Internal L&D', seats: 40, cost: 180, status: 'RUNNING' },
  ];
  const sessions: { id: string; code: string; status: string; cost: number; endsAt: Date; validMonths: number | null }[] = [];
  for (const s of sessionSpecs) {
    const spec = courseSpecs.find((c) => c.code === s.code)!;
    const existing = await prisma.trainingSession.findFirst({
      where: { courseId: courses[s.code], startDate: day(s.from) },
    });
    const session =
      existing ??
      (await prisma.trainingSession.create({
        data: {
          courseId: courses[s.code],
          branchId: s.branchIndex == null ? null : branchIds[s.branchIndex],
          startDate: day(s.from),
          endDate: day(s.to),
          location: s.location,
          trainer: s.trainer,
          seats: s.seats,
          costPerSeat: s.cost,
          status: s.status,
        },
      }));
    sessions.push({ id: session.id, code: s.code, status: s.status, cost: s.cost, endsAt: day(s.to), validMonths: spec.validMonths });
  }

  const nominationSpecs = [
    { sessionIdx: 0, empIdxs: [18, 19, 20], status: 'APPROVED' },
    { sessionIdx: 0, empIdxs: [21], status: 'PENDING' },
    { sessionIdx: 1, empIdxs: [18, 22], status: 'ATTENDED' },
    { sessionIdx: 1, empIdxs: [23], status: 'NO_SHOW' },
    { sessionIdx: 2, empIdxs: [20, 21, 23], status: 'ATTENDED' },
    { sessionIdx: 3, empIdxs: [18], status: 'PENDING' },
    { sessionIdx: 3, empIdxs: [19], status: 'REJECTED' },
    { sessionIdx: 4, empIdxs: [0, 1], status: 'APPROVED' },
    { sessionIdx: 5, empIdxs: [22, 23], status: 'APPROVED' },
  ];
  for (const n of nominationSpecs) {
    const session = sessions[n.sessionIdx];
    for (const empIdx of n.empIdxs) {
      const attended = n.status === 'ATTENDED';
      const decided = ['APPROVED', 'REJECTED', 'ATTENDED', 'NO_SHOW'].includes(n.status);
      const nomination = await prisma.trainingNomination.upsert({
        where: { sessionId_employeeId: { sessionId: session.id, employeeId: employees[empIdx].id } },
        update: {},
        create: {
          sessionId: session.id,
          employeeId: employees[empIdx].id,
          nominatedById: ctx.hrUserId,
          source: 'MANUAL',
          justification: 'Role requirement identified in the development plan.',
          cost: session.cost,
          status: n.status,
          approverId: decided ? hrUserId : null,
          approvedAt: decided && n.status !== 'REJECTED' ? day(-30) : null,
          rejectedReason: n.status === 'REJECTED' ? 'Seat cap reached for this cohort.' : null,
          attendedAt: attended ? session.endsAt : null,
          score: attended ? 78 + (empIdx % 5) * 4 : null,
          passed: attended ? true : null,
          certificateExpiry:
            attended && session.validMonths ? addMonths(session.endsAt, session.validMonths) : null,
        },
      });

      // Attended training bills back through the reimbursement ledger.
      if (attended) {
        await prisma.reimbursement.create({
          data: {
            employeeId: employees[empIdx].id,
            type: 'Training',
            amount: session.cost,
            expenseDate: session.endsAt,
            description: `Training fee — ${courseSpecs.find((c) => c.code === session.code)?.title}`,
            status: 'PAID',
            approverId: hrUserId,
            approvedAt: session.endsAt,
            paidAt: day(-2),
            sourceType: 'TRAINING',
            sourceId: nomination.id,
            budgetCategory: 'Training',
          },
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 12. Budgets, lines and commitments
// ---------------------------------------------------------------------------

async function seedBudgets(ctx: ExtrasContext): Promise<void> {
  const { prisma, deptIds, branchIds, hrUserId, say } = ctx;
  say('Setting fiscal-year budgets & commitments…');

  const fiscalYear = new Date().getUTCFullYear();
  const currencyOf = ['INR', 'INR', 'USD', 'OMR'];
  // Muscat is the showcase branch: an OMR budget with realistic Omani figures.
  const plannedByBranch = [
    { Payroll: 9_600_000, Overtime: 480_000, Travel: 350_000, Training: 300_000, Recruitment: 200_000 },
    { Payroll: 8_400_000, Overtime: 420_000, Travel: 300_000, Training: 260_000, Recruitment: 180_000 },
    { Payroll: 1_200_000, Overtime: 60_000, Travel: 90_000, Training: 70_000, Recruitment: 50_000 },
    { Payroll: 96_000, Overtime: 7_200, Travel: 12_000, Training: 9_000, Recruitment: 5_000 },
  ];

  for (let b = 0; b < branchIds.length; b++) {
    const budget = await prisma.budget.upsert({
      where: {
        branchId_fiscalYear_name: {
          branchId: branchIds[b],
          fiscalYear,
          name: `${SMP}FY${fiscalYear} Operating Budget`,
        },
      },
      update: { status: 'ACTIVE' },
      create: {
        name: `${SMP}FY${fiscalYear} Operating Budget`,
        fiscalYear,
        startDate: dU(fiscalYear, 1, 1),
        endDate: dU(fiscalYear, 12, 31),
        branchId: branchIds[b],
        currency: currencyOf[b],
        status: 'ACTIVE',
        createdById: hrUserId,
      },
    });

    const planned = plannedByBranch[b];
    for (const [category, total] of Object.entries(planned)) {
      // A company-wide fallback line plus per-department splits. The fallback
      // line cannot be upserted by key — Postgres treats NULL as distinct, so
      // the (budget, department, category) unique index never matches it.
      const fallback = await prisma.budgetLine.findFirst({
        where: { budgetId: budget.id, departmentId: null, category },
      });
      if (!fallback) {
        await prisma.budgetLine.create({
          data: {
            budgetId: budget.id,
            departmentId: null,
            category,
            plannedAmount: Math.round(total * 0.1),
            notes: 'Unallocated / company-wide contingency.',
          },
        });
      }

      for (let d = 0; d < deptIds.length; d++) {
        await prisma.budgetLine.upsert({
          where: { budgetId_departmentId_category: { budgetId: budget.id, departmentId: deptIds[d], category } },
          update: {},
          create: {
            budgetId: budget.id,
            departmentId: deptIds[d],
            category,
            plannedAmount: Math.round((total * 0.9) / deptIds.length),
          },
        });
      }
    }
  }

  // Commitments: every approved trip and nomination reserves its money against
  // the matching Travel/Training line on its own branch's budget.
  const omanBudget = await prisma.budget.findFirst({
    where: { branchId: branchIds[MUSCAT], fiscalYear, name: { startsWith: SMP } },
    include: { lines: true },
  });
  if (omanBudget) {
    const travelLine = omanBudget.lines.find((l) => l.category === 'Travel' && l.departmentId === deptIds[5])
      ?? omanBudget.lines.find((l) => l.category === 'Travel');
    const trainingLine = omanBudget.lines.find((l) => l.category === 'Training' && l.departmentId === deptIds[5])
      ?? omanBudget.lines.find((l) => l.category === 'Training');

    const trips = await prisma.travelRequest.findMany({
      where: { status: { in: ['APPROVED', 'COMPLETED', 'REJECTED'] }, employee: { branchId: branchIds[MUSCAT] } },
    });
    for (const t of trips) {
      if (!travelLine) break;
      await prisma.budgetCommitment.upsert({
        where: { sourceType_sourceId: { sourceType: 'TRAVEL', sourceId: t.id } },
        update: {},
        create: {
          budgetLineId: travelLine.id,
          sourceType: 'TRAVEL',
          sourceId: t.id,
          amount: t.estimatedCost,
          status: t.status === 'COMPLETED' ? 'REALIZED' : t.status === 'REJECTED' ? 'RELEASED' : 'OPEN',
          resolvedAt: t.status === 'APPROVED' ? null : day(-3),
          resolvedNote:
            t.status === 'COMPLETED' ? 'Per-diem claim landed in actuals.'
              : t.status === 'REJECTED' ? 'Request rejected; commitment released.'
                : null,
        },
      });
    }

    const noms = await prisma.trainingNomination.findMany({
      where: { status: { in: ['APPROVED', 'ATTENDED'] }, employee: { branchId: branchIds[MUSCAT] } },
    });
    for (const n of noms) {
      if (!trainingLine) break;
      await prisma.budgetCommitment.upsert({
        where: { sourceType_sourceId: { sourceType: 'TRAINING', sourceId: n.id } },
        update: {},
        create: {
          budgetLineId: trainingLine.id,
          sourceType: 'TRAINING',
          sourceId: n.id,
          amount: n.cost ?? 0,
          status: n.status === 'ATTENDED' ? 'REALIZED' : 'OPEN',
          resolvedAt: n.status === 'ATTENDED' ? day(-2) : null,
          resolvedNote: n.status === 'ATTENDED' ? 'Training fee reimbursed.' : null,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 13. Approval engine — workflows, steps, live approval trails
// ---------------------------------------------------------------------------

async function seedApprovals(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, hrUserId, say } = ctx;
  say('Configuring approval chains & pending approval trails…');

  const chains: { type: any; name: string; steps: any[] }[] = [
    { type: 'LEAVE', name: 'Leave — Supervisor then HR', steps: ['SUPERVISOR', 'HR_MANAGER'] },
    { type: 'OVERTIME', name: 'Overtime — Supervisor then Manager', steps: ['SUPERVISOR', 'MANAGER'] },
    { type: 'TRAVEL', name: 'Travel — Manager then HR', steps: ['MANAGER', 'HR_MANAGER'] },
    { type: 'TRAINING', name: 'Training — Manager then HR', steps: ['MANAGER', 'HR_MANAGER'] },
    { type: 'BANK_CHANGE', name: 'Bank change — HR then Admin', steps: ['HR_MANAGER', 'ADMIN'] },
  ];
  for (const c of chains) {
    const existing = await prisma.approvalWorkflow.findFirst({ where: { requestType: c.type } });
    if (existing) continue;
    await prisma.approvalWorkflow.create({
      data: {
        requestType: c.type,
        name: c.name,
        mode: 'SEQUENTIAL',
        isActive: true,
        steps: { create: c.steps.map((s, i) => ({ stepOrder: i + 1, approverType: s })) },
      },
    });
  }

  // Materialised trails for every request still awaiting a decision, so the
  // Approvals inbox is populated rather than theoretically populated.
  const supervisorUserId = ctx.userIdByEmpIdx[18] ?? hrUserId;
  const sampleEmpIds = employees.map((e) => e.id);

  const pendingLeave = await prisma.leaveRequest.findMany({
    where: { status: 'PENDING', employeeId: { in: sampleEmpIds } },
    select: { id: true },
  });
  const pendingOt = await prisma.overtimeRequest.findMany({
    where: { status: 'PENDING', employeeId: { in: sampleEmpIds } },
    select: { id: true },
  });
  const pendingTravel = await prisma.travelRequest.findMany({
    where: { status: 'PENDING', employeeId: { in: sampleEmpIds } },
    select: { id: true },
  });
  const pendingTraining = await prisma.trainingNomination.findMany({
    where: { status: 'PENDING', employeeId: { in: sampleEmpIds } },
    select: { id: true },
  });
  const pendingBank = await prisma.bankChangeRequest.findMany({
    where: { status: 'PENDING', employeeId: { in: sampleEmpIds } },
    select: { id: true },
  });

  const trail = async (requestType: any, ids: { id: string }[], steps: string[]) => {
    for (const r of ids) {
      for (let i = 0; i < steps.length; i++) {
        await prisma.requestApproval.create({
          data: {
            requestType,
            requestId: r.id,
            stepOrder: i + 1,
            approverType: steps[i] as any,
            // Step 1 is live and snapshotted; later steps wait their turn.
            resolvedApproverId: i === 0 ? (steps[0] === 'SUPERVISOR' ? supervisorUserId : hrUserId) : null,
            status: i === 0 ? 'ACTIVE' : 'PENDING',
          },
        });
      }
    }
  };
  await trail('LEAVE', pendingLeave, ['SUPERVISOR', 'HR_MANAGER']);
  await trail('OVERTIME', pendingOt, ['SUPERVISOR', 'MANAGER']);
  await trail('TRAVEL', pendingTravel, ['MANAGER', 'HR_MANAGER']);
  await trail('TRAINING', pendingTraining, ['MANAGER', 'HR_MANAGER']);
  await trail('BANK_CHANGE', pendingBank, ['HR_MANAGER', 'ADMIN']);

  // One fully-decided trail so the history view is not empty either.
  const approvedLeave = await prisma.leaveRequest.findFirst({
    where: { status: 'APPROVED', employeeId: { in: sampleEmpIds } },
    select: { id: true },
  });
  if (approvedLeave) {
    for (let i = 0; i < 2; i++) {
      await prisma.requestApproval.create({
        data: {
          requestType: 'LEAVE',
          requestId: approvedLeave.id,
          stepOrder: i + 1,
          approverType: (i === 0 ? 'SUPERVISOR' : 'HR_MANAGER') as any,
          resolvedApproverId: i === 0 ? supervisorUserId : hrUserId,
          status: 'APPROVED',
          comment: i === 0 ? 'Cover arranged within the team.' : 'Balance verified — approved.',
          decidedById: i === 0 ? supervisorUserId : hrUserId,
          decidedAt: day(-(3 - i)),
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 14. Contract lifecycle — appendices and terminations
// ---------------------------------------------------------------------------

async function seedContractLifecycle(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, hrUserId, say } = ctx;
  say('Amending & terminating contracts (appendices, exits)…');

  const contractOf = async (empIdx: number) =>
    prisma.contract.findFirst({ where: { employeeId: employees[empIdx].id } });

  const appendixSpecs = [
    { empIdx: 18, fields: { salary: { from: 1400, to: 1610 } }, reason: 'Annual increment following the appraisal cycle.', daysAgo: 60 },
    { empIdx: 20, fields: { position: { from: 'Marketing Specialist', to: 'Senior Marketing Specialist' } }, reason: 'Promotion effective this quarter.', daysAgo: 30 },
    { empIdx: 0, fields: { workHoursPerWeek: { from: 40, to: 36 } }, reason: 'Moved to a compressed working week.', daysAgo: 90 },
  ];
  let appendixNo = 1;
  for (const a of appendixSpecs) {
    const contract = await contractOf(a.empIdx);
    if (!contract) continue;
    await prisma.contractAppendix.create({
      data: {
        contractId: contract.id,
        appendixNumber: `${SMP}APX-${pad3(appendixNo++)}`,
        effectiveDate: day(-a.daysAgo),
        modifiedFields: a.fields,
        reason: a.reason,
        createdBy: hrUserId,
      },
    });
  }

  const terminationSpecs = [
    { empIdx: 23, category: 'RESIGNATION', status: 'PENDING_APPROVAL', reason: 'Employee resigned to relocate abroad; 30-day notice served.', notice: -5, exit: 25 },
    { empIdx: 17, category: 'END_OF_CONTRACT', status: 'APPROVED', reason: 'Fixed-term contract reaching its natural end.', notice: -40, exit: -10 },
    { empIdx: 11, category: 'MUTUAL_AGREEMENT', status: 'REJECTED', reason: 'Requested early release; business cover not available.', notice: -20, exit: 10 },
  ];
  for (const t of terminationSpecs) {
    const contract = await contractOf(t.empIdx);
    if (!contract) continue;
    const decided = t.status !== 'PENDING_APPROVAL';
    await prisma.terminationRequest.create({
      data: {
        contractId: contract.id,
        requestedBy: hrUserId,
        terminationCategory: t.category,
        noticeDate: day(t.notice),
        terminationDate: day(t.exit),
        reason: t.reason,
        status: t.status,
        approverId: decided ? hrUserId : null,
        approvedAt: t.status === 'APPROVED' ? day(t.exit - 5) : null,
        approverComments: t.status === 'APPROVED' ? 'Clearance completed; final settlement scheduled.' : null,
        rejectionReason: t.status === 'REJECTED' ? 'No replacement identified; revisit next quarter.' : null,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 15. Timesheets
// ---------------------------------------------------------------------------

async function seedTimesheets(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, hrUserId, rng, say } = ctx;
  say('Logging timesheets…');

  const STATUS_CYCLE = ['APPROVED', 'APPROVED', 'SUBMITTED', 'DRAFT', 'REJECTED'] as const;

  for (const emp of employees) {
    // A working week of timesheets, ending yesterday.
    for (let back = 1; back <= 5; back++) {
      const workDate = day(-back);
      const status = STATUS_CYCLE[(emp.index + back) % STATUS_CYCLE.length];
      const decided = status === 'APPROVED' || status === 'REJECTED';
      await prisma.timesheet.create({
        data: {
          employeeId: emp.id,
          workDate,
          hoursWorked: 6 + randInt(rng, 0, 3),
          description: 'Regular duties and scheduled work.',
          status,
          submittedAt: status === 'DRAFT' ? null : day(-back + 1),
          approvedAt: status === 'APPROVED' ? day(-back + 1) : null,
          approvedBy: decided ? hrUserId : null,
          rejectionReason:
            status === 'REJECTED' ? 'Hours exceed the approved allocation for this day.' : null,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 16. AI appraisal run over the Muscat branch
// ---------------------------------------------------------------------------

async function seedAppraisal(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, deptIds, branchIds, hrUserId, rng, say } = ctx;
  say('Publishing an AI appraisal & ranking run for Muscat…');

  const now = new Date();
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const periodStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 5, 1));
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const periodLabel = `${MONTHS[periodStart.getUTCMonth()]}–${MONTHS[periodEnd.getUTCMonth()]} ${periodEnd.getUTCFullYear()}`;

  const DEPT_NAMES = ['Engineering', 'Sales', 'Marketing', 'Finance', 'People & Culture', 'Operations'];
  const POSITIONS = ['Software Engineer', 'Account Executive', 'Marketing Specialist', 'Financial Analyst', 'HR Business Partner', 'Operations Associate'];
  const omanEmployees = employees.filter((e) => e.branchIndex === MUSCAT);

  const run = await prisma.appraisalRun.create({
    data: {
      status: 'COMPLETED',
      periodStart,
      periodEnd,
      periodLabel,
      branchId: branchIds[MUSCAT],
      scopeJson: { departmentIds: deptIds },
      createdById: hrUserId,
      model: 'claude-sonnet-5',
      weightsJson: {
        attendance: 0.15, punctuality: 0.1, productivity: 0.2, taskCompletion: 0.2,
        projectContribution: 0.15, disciplineConsistency: 0.1, teamContribution: 0.1,
      },
      toolPlanJson: [
        { tool: 'attendance_employee_summary', reason: 'Attendance and punctuality baseline.' },
        { tool: 'task_employee_stats', reason: 'Delivery throughput and completion rate.' },
        { tool: 'leave_employee_usage', reason: 'Leave pattern and availability.' },
        { tool: 'overtime_employee_summary', reason: 'Discretionary effort.' },
        { tool: 'discipline_employee_history', reason: 'Conduct consistency.' },
      ],
      executiveSummary:
        'Muscat branch performance is stable across the period. Attendance is strong (94% average) and delivery throughput improved after the rollout. Two employees are flagged for coaching on punctuality; one is a clear promotion candidate.',
      orgInsightsJson: {
        strengths: ['Consistently high attendance across all departments', 'Overtime is well controlled and pre-approved'],
        risks: ['Single-person dependency in Finance', 'Certificate expiries clustered in the next quarter'],
        recommendations: ['Cross-train a Finance backup', 'Schedule the OSH refresher cohort early'],
      },
      totalEmployees: omanEmployees.length,
      completedEmployees: omanEmployees.length,
      toolCallCount: 5 * omanEmployees.length,
      currentPhase: 'SYNTHESIZE',
      startedAt: day(-2),
      completedAt: day(-2),
    },
  });

  const RECOMMENDATIONS = ['PROMOTE', 'REWARD', 'MAINTAIN', 'MAINTAIN', 'COACH', 'PIP'];
  const scored = omanEmployees.map((emp, i) => {
    const base = 88 - i * 6 + randInt(rng, -2, 2);
    const scores = {
      attendance: Math.min(100, base + 6),
      punctuality: Math.max(35, base - 3),
      productivity: base,
      taskCompletion: Math.min(100, base + 2),
      projectContribution: Math.max(35, base - 5),
      disciplineConsistency: Math.min(100, base + 8),
      teamContribution: base,
    };
    const overall = Math.round(
      scores.attendance * 0.15 + scores.punctuality * 0.1 + scores.productivity * 0.2 +
      scores.taskCompletion * 0.2 + scores.projectContribution * 0.15 +
      scores.disciplineConsistency * 0.1 + scores.teamContribution * 0.1,
    );
    return { emp, i, scores: { ...scores, overall }, overall };
  });
  scored.sort((a, b) => b.overall - a.overall);

  const results: { id: string; empIdx: number; recommendation: string }[] = [];
  for (let rank = 0; rank < scored.length; rank++) {
    const s = scored[rank];
    const recommendation = RECOMMENDATIONS[Math.min(rank, RECOMMENDATIONS.length - 1)];
    const result = await prisma.appraisalResult.create({
      data: {
        runId: run.id,
        employeeId: s.emp.id,
        employeeCode: `${SMP}EMP-${pad3(s.emp.index + 1)}`,
        employeeName: s.emp.fullName,
        position: POSITIONS[s.emp.deptIndex],
        departmentId: deptIds[s.emp.deptIndex],
        departmentName: DEPT_NAMES[s.emp.deptIndex],
        scoresJson: s.scores,
        strengthsJson: [
          'Reliable attendance with no unplanned absence in the period.',
          'Closes assigned work inside the sprint commitment.',
          'Responsive to cross-branch requests during the Muscat rollout.',
        ].slice(0, 3 - (rank % 2)),
        improvementsJson: [
          'Punctuality on early-shift days.',
          'Timesheet submission before the weekly cut-off.',
          'Depth of written handover notes.',
        ].slice(0, 1 + (rank % 3)),
        risksJson: rank >= 4
          ? ['Sustained dip in delivery throughput over the last two months.']
          : rank === 3
            ? ['Sole owner of a critical process — no documented backup.']
            : [],
        summary:
          rank === 0
            ? `${s.emp.fullName} is the strongest performer in the branch this period — consistently high delivery with no conduct issues. Ready for a broader remit.`
            : `${s.emp.fullName} performed in line with expectations. Scores are steady across dimensions with targeted areas to develop.`,
        recommendation,
        rankOverall: rank + 1,
        rankDepartment: 1,
        metricsJson: {
          attendance: { presentDays: 108 - rank * 3, absentDays: rank, lateDays: rank * 2, punctualityRate: s.scores.punctuality },
          tasks: { assigned: 22 - rank, completed: 20 - rank * 2, completionRate: s.scores.taskCompletion },
          leave: { annualUsed: 4 + rank, sickUsed: rank },
          overtime: { approvedHours: 12 - rank, requests: 3 },
          discipline: { warnings: rank >= 4 ? 1 : 0, rewards: rank <= 1 ? 1 : 0 },
        },
        toolCallCount: 5,
        status: 'COMPLETED',
      },
    });
    results.push({ id: result.id, empIdx: s.emp.index, recommendation });
  }

  const events = [
    { type: 'RUN_STARTED', payload: { message: 'Appraisal run started for the Muscat branch.' } },
    { type: 'PHASE', payload: { phase: 'PLAN', message: 'Selected 5 analytics tools.' } },
    { type: 'PHASE', payload: { phase: 'COLLECT', message: `Collected metrics for ${omanEmployees.length} employees.` } },
    { type: 'PHASE', payload: { phase: 'ANALYZE', message: 'Scored 7 dimensions per employee.' } },
    { type: 'PHASE', payload: { phase: 'RANK', message: 'Ranked employees overall and by department.' } },
    { type: 'PHASE', payload: { phase: 'SYNTHESIZE', message: 'Executive summary and org insights generated.' } },
    { type: 'RUN_COMPLETED', payload: { message: 'Run completed.', completed: omanEmployees.length } },
  ];
  for (let i = 0; i < events.length; i++) {
    await prisma.appraisalEvent.create({
      data: { runId: run.id, seq: i + 1, type: events[i].type, payload: events[i].payload },
    });
  }

  // Appraisal-derived training needs — the provenance link the feature exists for.
  const leadershipSession = await prisma.trainingSession.findFirst({
    where: { course: { code: `${SMP}LEAD-201` } },
  });
  if (leadershipSession) {
    for (const r of results.filter((x) => x.recommendation === 'COACH' || x.recommendation === 'PIP')) {
      await prisma.trainingNomination.upsert({
        where: { sessionId_employeeId: { sessionId: leadershipSession.id, employeeId: employees[r.empIdx].id } },
        update: {},
        create: {
          sessionId: leadershipSession.id,
          employeeId: employees[r.empIdx].id,
          nominatedById: hrUserId,
          source: 'APPRAISAL',
          appraisalResultId: r.id,
          justification: 'Development need identified by the appraisal run.',
          cost: 400,
          status: 'PENDING',
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 17. The manager-handover trail on the department that changed hands.
// ---------------------------------------------------------------------------

async function seedManagerHandover(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, deptIds, say } = ctx;
  say('Back-filling the manager handover trail…');

  // Manager handover in flight on the department whose change request is pending.
  const pendingChange = await prisma.departmentChangeRequest.findFirst({
    where: { departmentId: deptIds[5], status: 'PENDING' },
  });
  await prisma.managerTransition.create({
    data: {
      departmentId: deptIds[5],
      changeRequestId: pendingChange?.id ?? null,
      oldManagerId: employees[5].id,
      newManagerId: employees[23].id,
      status: 'IN_PROGRESS',
      handoverTasks: [
        { key: 'team_1on1s', label: 'Introduce the incoming manager to every report' },
        { key: 'open_approvals', label: 'Hand over all open leave and overtime approvals' },
        { key: 'budget', label: 'Walk through the department budget and commitments' },
        { key: 'vendor_contacts', label: 'Transfer vendor and supplier contacts' },
      ],
      completedTasks: [{ key: 'team_1on1s' }, { key: 'open_approvals' }],
      progressPercentage: 50,
      startDate: day(-7),
      targetEndDate: day(21),
      notes: 'Handover running alongside the Muscat rollout; on track.',
    },
  });
}

// ---------------------------------------------------------------------------
// 18. Notifications & audit trail
// ---------------------------------------------------------------------------

async function seedNotificationsAndAudit(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, branchIds, userIdByEmpIdx, hrUserId, say } = ctx;
  say('Delivering notifications & writing the audit trail…');

  const templates = [
    { title: 'Leave request approved', message: 'Your annual leave request has been approved by HR.', type: 'SUCCESS', link: '/dashboard/my-leaves' },
    { title: 'Overtime pending approval', message: 'You have an overtime request awaiting your decision.', type: 'WARNING', link: '/dashboard/overtime' },
    { title: 'Payslip available', message: 'Your payslip for last month is ready to view.', type: 'INFO', link: '/dashboard/my-payroll' },
    { title: 'Visa expiring soon', message: 'An employment visa in your branch expires within 60 days.', type: 'WARNING', link: '/dashboard/visa-reports' },
    { title: 'Asset assigned to you', message: 'A company laptop has been assigned to you — please acknowledge.', type: 'INFO', link: '/dashboard/my-assets' },
    { title: 'Training nomination', message: 'You have been nominated for Information Security Awareness.', type: 'INFO', link: '/dashboard/my-training' },
    { title: 'Timesheet rejected', message: 'A timesheet entry was returned for correction.', type: 'ERROR', link: '/dashboard/my-timesheets' },
    { title: 'Trip approved', message: 'Your travel request to Salalah has been approved.', type: 'SUCCESS', link: '/dashboard/my-travel' },
  ];

  const userIds = Array.from(new Set(Object.values(userIdByEmpIdx).concat(hrUserId)));
  for (const userId of userIds) {
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      const read = i % 3 === 0;
      await prisma.notification.create({
        data: {
          userId,
          title: t.title,
          message: t.message,
          type: t.type,
          link: t.link,
          isRead: read,
          readAt: read ? day(-i) : null,
          createdAt: day(-i - 1),
        },
      });
    }
  }

  const auditSpecs = [
    { action: 'CREATE', resourceType: 'Employee' },
    { action: 'UPDATE', resourceType: 'Employee' },
    { action: 'APPROVE', resourceType: 'LeaveRequest' },
    { action: 'REJECT', resourceType: 'LeaveRequest' },
    { action: 'APPROVE', resourceType: 'OvertimeRequest' },
    { action: 'CREATE', resourceType: 'Payroll' },
    { action: 'UPDATE', resourceType: 'Payroll' },
    { action: 'CREATE', resourceType: 'TravelRequest' },
    { action: 'APPROVE', resourceType: 'TravelRequest' },
    { action: 'CREATE', resourceType: 'AssetItem' },
    { action: 'ASSIGN', resourceType: 'AssetAssignment' },
    { action: 'CREATE', resourceType: 'Grievance' },
    { action: 'ISSUE', resourceType: 'LetterRequest' },
    { action: 'UPDATE', resourceType: 'Branch' },
    { action: 'CREATE', resourceType: 'Budget' },
    { action: 'LOGIN', resourceType: 'Auth' },
  ];
  for (let i = 0; i < 48; i++) {
    const s = auditSpecs[i % auditSpecs.length];
    const emp = employees[i % employees.length];
    await prisma.auditLog.create({
      data: {
        userId: userIdByEmpIdx[emp.index] ?? hrUserId,
        action: s.action,
        resourceType: s.resourceType,
        resourceId: emp.id,
        newData: { note: `${s.action} on ${s.resourceType} (sample audit entry).`, actor: emp.fullName },
        ipAddress: `10.0.${i % 8}.${(i % 200) + 10}`,
        userAgent: 'Mozilla/5.0 (Sample Demo Browser)',
        branchId: branchIds[emp.branchIndex],
        createdAt: day(-(i % 30)),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 19. Garnishment orders — court / authority deductions applied via payroll
// ---------------------------------------------------------------------------

async function seedGarnishments(ctx: ExtrasContext): Promise<void> {
  const { prisma, employees, say } = ctx;
  say('Filing garnishment orders (court-ordered deductions)…');

  const now = new Date();
  const curYear = now.getUTCFullYear();

  // One order per spec — spread across branches and lifecycle states so every
  // column on the garnishments page has a value and the filters work.
  //
  // Muscat (branchIndex 3) uses OMR-scale amounts and ROP (Royal Oman Police)
  // court references; India / US branches use INR / USD-scale figures.
  const specs: {
    empIdx: number;
    reference: string;
    authority: string | null;
    amount: number | null;
    percentOfNet: number | null;
    totalCap: number | null;
    collected: number;
    startDaysAgo: number;
    endDaysFromNow: number | null;
    isActive: boolean;
    priority: number;
    notes: string | null;
  }[] = [
    // ── Muscat branch (OMR) ────────────────────────────────────────────────
    {
      empIdx: 18,
      reference: 'ROP-MCT-2024-00781',
      authority: 'Royal Oman Police — Civil Court Muscat',
      amount: 80,
      percentOfNet: null,
      totalCap: 960,
      collected: 480,       // 6 months in, half-way to cap
      startDaysAgo: 180,
      endDaysFromNow: 180,
      isActive: true,
      priority: 10,
      notes: 'Civil debt recovery. Month 7 of 12.',
    },
    {
      empIdx: 19,
      reference: 'ROP-MCT-2025-00044',
      authority: 'Muscat Magistrate Court',
      amount: null,
      percentOfNet: 10,     // 10 % of net each cycle
      totalCap: null,       // runs until end date
      collected: 150,
      startDaysAgo: 90,
      endDaysFromNow: 270,
      isActive: true,
      priority: 20,
      notes: 'Percentage-of-net order; no cap.',
    },
    {
      empIdx: 20,
      reference: 'ROP-MCT-2023-11902',
      authority: 'Court of Appeal — Sultanate of Oman',
      amount: 200,
      percentOfNet: null,
      totalCap: 2400,
      collected: 2400,      // fully recovered — keeps the page interesting
      startDaysAgo: 400,
      endDaysFromNow: null,
      isActive: false,      // deactivated once cap hit
      priority: 10,
      notes: 'Fully recovered. Order closed.',
    },
    {
      empIdx: 21,
      reference: 'ROP-MCT-2025-00201',
      authority: 'Muscat Primary Court',
      amount: 50,
      percentOfNet: null,
      totalCap: null,
      collected: 0,
      startDaysAgo: 14,
      endDaysFromNow: 350,
      isActive: true,
      priority: 30,
      notes: 'New order; first deduction next payroll cycle.',
    },
    // ── Bengaluru branch (INR) ─────────────────────────────────────────────
    {
      empIdx: 0,
      reference: 'DRT-BLR-2024-003812',
      authority: 'Debt Recovery Tribunal — Bengaluru',
      amount: 5000,
      percentOfNet: null,
      totalCap: 60000,
      collected: 25000,
      startDaysAgo: 150,
      endDaysFromNow: 210,
      isActive: true,
      priority: 10,
      notes: 'Bank loan recovery via DRT order.',
    },
    {
      empIdx: 2,
      reference: 'CRT-BLR-2025-007744',
      authority: 'City Civil Court Bengaluru',
      amount: 3000,
      percentOfNet: null,
      totalCap: null,
      collected: 9000,
      startDaysAgo: 270,
      endDaysFromNow: 90,
      isActive: true,
      priority: 20,
      notes: null,
    },
    // ── Chennai branch (INR) ───────────────────────────────────────────────
    {
      empIdx: 6,
      reference: 'CRT-MAA-2024-015532',
      authority: 'Madras High Court',
      amount: null,
      percentOfNet: 8,
      totalCap: 48000,
      collected: 16000,
      startDaysAgo: 200,
      endDaysFromNow: null,
      isActive: true,
      priority: 10,
      notes: 'Percentage order — court-ordered maintenance payment.',
    },
    // ── New York branch (USD) ──────────────────────────────────────────────
    {
      empIdx: 12,
      reference: 'NY-GARNISH-2024-88231',
      authority: 'New York Supreme Court — Civil Division',
      amount: 400,
      percentOfNet: null,
      totalCap: 4800,
      collected: 800,
      startDaysAgo: 60,
      endDaysFromNow: 300,
      isActive: true,
      priority: 10,
      notes: 'Federal student-loan garnishment under Title IV.',
    },
    {
      empIdx: 14,
      reference: 'NY-GARNISH-2023-71104',
      authority: 'New York Civil Court',
      amount: 250,
      percentOfNet: null,
      totalCap: 3000,
      collected: 3000,
      startDaysAgo: 500,
      endDaysFromNow: null,
      isActive: false,
      priority: 10,
      notes: 'Order satisfied — cap reached.',
    },
  ];

  for (const s of specs) {
    const emp = employees[s.empIdx];
    if (!emp) continue;
    const startDate = new Date(Date.UTC(curYear, now.getUTCMonth(), now.getUTCDate() - s.startDaysAgo));
    const endDate = s.endDaysFromNow == null
      ? null
      : new Date(Date.UTC(curYear, now.getUTCMonth(), now.getUTCDate() + s.endDaysFromNow));

    await prisma.garnishmentOrder.create({
      data: {
        employeeId: emp.id,
        reference: s.reference,
        authority: s.authority,
        amount: s.amount != null ? s.amount : undefined,
        percentOfNet: s.percentOfNet != null ? s.percentOfNet : undefined,
        totalCap: s.totalCap != null ? s.totalCap : undefined,
        collected: s.collected,
        startDate,
        endDate,
        isActive: s.isActive,
        priority: s.priority,
        notes: s.notes,
      },
    });
  }
}
