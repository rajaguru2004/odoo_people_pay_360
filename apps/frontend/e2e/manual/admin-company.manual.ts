import { test } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { ApiClient } from '../fixtures';
import {
  seedAttendance,
  seedLeave,
  seedOvertime,
  addComponent,
  ensureHoliday,
  runPayroll,
  deletePayroll,
  asList,
  inner,
} from '../payroll-support';

/**
 * A company worth photographing, for the ADMINISTRATOR manual.
 *
 * `seed.manual.ts` gives ONE employee a working life, which is exactly right
 * for the employee book — every screen in it is scoped to the reader. The admin
 * book is the opposite: almost every screen in it is a LIST, and the
 * reconnaissance pass found the Muscat branch holding exactly one person. The
 * dashboard read "1 Total employees", the department donut was a single
 * unbroken ring, the attendance register had one row, and twenty screens said
 * "No records found".
 *
 * A manual whose figures show an empty product does not merely look bad. It
 * teaches the reader the wrong thing: an administrator reading the payroll
 * chapter needs to see a run with a dozen people in it, because the questions
 * they actually have — what the branch totals to, who is missing a salary
 * component — are questions a one-row table cannot show.
 *
 * So this builds a small but complete Muscat operation over the API: twelve
 * staff across three departments, a month of attendance, requests waiting in
 * every approval queue, and one of everything the sidebar can reach.
 *
 * Run AFTER `seed.manual.ts` — it needs the Muscat branch and the Oman preset
 * that seed establishes, and it deliberately leaves that seed's subject alone.
 *
 *   scripts/admin-manual.sh seed
 */

/** Everything that failed, printed together at the end rather than one per run. */
const problems: string[] = [];

/** Run `label`'s block, recording rather than throwing on failure. */
async function step(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    problems.push(`${label}: ${message}`);
    console.warn(`  ⚠ ${label} — ${message.split('\n')[0]}`);
  }
}

/**
 * Run `fn`, treating "that already exists" as success.
 *
 * This seed is re-run constantly — a figure gets re-shot, a name gets changed,
 * the whole thing goes again — and the server is right to refuse a second
 * overlapping leave request or a second overtime claim on one date. What it
 * must not do is cost the four requests queued behind it their turn, which is
 * exactly what happened on the second run: three pending leave requests
 * vanished from the approval queue because the first one was already there.
 *
 * The postcondition these blocks promise is that the record EXISTS, not that
 * this particular call is what created it.
 */
async function idempotent(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/already exists|already has|overlaps with existing|duplicate/i.test(message)) throw e;
  }
}

/** `YYYY-MM-DD`, `days` before or after today. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Friday and Saturday — 0 is Sunday. The Omani weekend. */
const OFF_DAYS = new Set([5, 6]);

/** Every working day of one month, on the Omani week. */
function workingDaysOfMonth(year: number, month: number, until?: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(year, month - 1, 1));
  while (d.getUTCMonth() === month - 1) {
    if (until && d.getTime() > until.getTime()) break;
    if (!OFF_DAYS.has(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * The Muscat payroll, as a manual wants to see it.
 *
 * Names, nationalities and salaries are deliberately plausible rather than
 * generated: these appear in every figure in the book, and `E2E abc123` printed
 * across forty screenshots is how a documentation set announces that nobody
 * looked at it. The mix of Omani and expatriate staff is not decoration either
 * — PASI applies to Omani nationals only, so a payroll register showing both is
 * the one that lets the statutory chapter be written honestly.
 */
interface Staff {
  fullName: string;
  email: string;
  position: string;
  dept: 'HRD' | 'E2E-FIN' | 'E2E-OPS';
  baseSalary: number;
  dateOfBirth: string;
  startDate: string;
  nationality: string;
  nationalityCode: string;
  nationalityClass: 'NATIONAL' | 'EXPAT' | 'GCC';
  /** Give this one a usable login — they file things employees file. */
  login?: boolean;
  role?: 'HR_MANAGER' | 'MANAGER';
}

const STAFF: Staff[] = [
  {
    fullName: 'Aisha Al Balushi', email: 'aisha.albalushi@company.com',
    position: 'Human Resources Manager', dept: 'HRD', baseSalary: 1450,
    dateOfBirth: '1986-09-02', startDate: '2018-02-11',
    nationality: 'Omani', nationalityCode: 'OM', nationalityClass: 'NATIONAL',
    role: 'HR_MANAGER',
  },
  {
    fullName: 'Khalid Al Rashdi', email: 'khalid.alrashdi@company.com',
    position: 'Finance Manager', dept: 'E2E-FIN', baseSalary: 1600,
    dateOfBirth: '1983-04-19', startDate: '2016-08-01',
    nationality: 'Omani', nationalityCode: 'OM', nationalityClass: 'NATIONAL',
    role: 'MANAGER',
  },
  {
    fullName: 'Yousuf Al Amri', email: 'yousuf.alamri@company.com',
    position: 'Operations Supervisor', dept: 'E2E-OPS', baseSalary: 1100,
    dateOfBirth: '1988-11-25', startDate: '2019-01-06',
    nationality: 'Omani', nationalityCode: 'OM', nationalityClass: 'NATIONAL',
    role: 'MANAGER',
  },
  {
    fullName: 'Fatma Al Zadjali', email: 'fatma.alzadjali@company.com',
    position: 'Payroll Officer', dept: 'E2E-FIN', baseSalary: 850,
    dateOfBirth: '1993-06-30', startDate: '2021-09-12',
    nationality: 'Omani', nationalityCode: 'OM', nationalityClass: 'NATIONAL',
    login: true,
  },
  {
    fullName: 'Maryam Al Kindi', email: 'maryam.alkindi@company.com',
    position: 'Recruitment Officer', dept: 'HRD', baseSalary: 780,
    dateOfBirth: '1995-01-17', startDate: '2022-03-01',
    nationality: 'Omani', nationalityCode: 'OM', nationalityClass: 'NATIONAL',
    login: true,
  },
  {
    fullName: 'Rashid Al Hinai', email: 'rashid.alhinai@company.com',
    position: 'Maintenance Technician', dept: 'E2E-OPS', baseSalary: 620,
    dateOfBirth: '1991-07-08', startDate: '2020-05-17',
    nationality: 'Omani', nationalityCode: 'OM', nationalityClass: 'NATIONAL',
    login: true,
  },
  {
    fullName: 'Said Al Mahrouqi', email: 'said.almahrouqi@company.com',
    position: 'Storekeeper', dept: 'E2E-OPS', baseSalary: 540,
    dateOfBirth: '1994-02-23', startDate: '2023-01-08',
    nationality: 'Omani', nationalityCode: 'OM', nationalityClass: 'NATIONAL',
  },
  {
    fullName: 'Noura Al Siyabi', email: 'noura.alsiyabi@company.com',
    position: 'Administrative Assistant', dept: 'HRD', baseSalary: 500,
    dateOfBirth: '1997-10-05', startDate: '2024-02-04',
    nationality: 'Omani', nationalityCode: 'OM', nationalityClass: 'NATIONAL',
  },
  {
    fullName: 'Anil Kumar', email: 'anil.kumar@company.com',
    position: 'Senior Software Engineer', dept: 'E2E-OPS', baseSalary: 980,
    dateOfBirth: '1989-12-14', startDate: '2020-10-01',
    nationality: 'Indian', nationalityCode: 'IN', nationalityClass: 'EXPAT',
    login: true,
  },
  {
    fullName: 'Maria Santos', email: 'maria.santos@company.com',
    position: 'Accountant', dept: 'E2E-FIN', baseSalary: 720,
    dateOfBirth: '1992-08-21', startDate: '2022-06-19',
    nationality: 'Filipino', nationalityCode: 'PH', nationalityClass: 'EXPAT',
  },
  {
    fullName: 'Ahmed Hassan', email: 'ahmed.hassan@company.com',
    position: 'Health & Safety Officer', dept: 'E2E-OPS', baseSalary: 690,
    dateOfBirth: '1987-03-09', startDate: '2021-11-14',
    nationality: 'Egyptian', nationalityCode: 'EG', nationalityClass: 'EXPAT',
  },
];

/** The password every seeded login shares, copied from a known-good hash. */
const PASSWORD = 'Password123!';

/** Where the HR manual's capture pass reads its session from. */
const HR_STORAGE = resolve(__dirname, '..', '.auth', 'manual-hr.json');
const ORIGIN =
  process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_FRONTEND_PORT ?? 3420}`;

/**
 * Write one Playwright storageState file.
 *
 * Same shape as `seed.manual.ts` writes for the employee and the administrator,
 * and `selectedBranchId` matters for the same reason: an account that has not
 * chosen a branch sees the whole company, and several screens refuse to act at
 * all in that state.
 */
function writeSession(file: string, token: string, user: unknown, branchId: string | null): void {
  mkdirSync(resolve(__dirname, '..', '.auth'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        cookies: [],
        origins: [
          {
            origin: ORIGIN,
            localStorage: [
              { name: 'accessToken', value: token },
              { name: 'refreshToken', value: token },
              { name: 'user', value: JSON.stringify(user) },
              {
                name: 'auth-storage',
                value: JSON.stringify({ state: { user, isAuthenticated: true }, version: 0 }),
              },
              { name: 'locale-storage', value: JSON.stringify({ state: { locale: 'en' }, version: 0 }) },
              {
                name: 'branch-storage',
                value: JSON.stringify({ state: { selectedBranchId: branchId }, version: 0 }),
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
}

/**
 * Give a freshly-created employee a password anybody can log in with.
 *
 * Same trick, and the same justification, as `seed.manual.ts`: `POST /employees`
 * creates the linked login but nothing sets its password, and inventing a
 * password-set endpoint in production code to serve a documentation script
 * would be the wrong trade. This is a local throwaway database.
 */
function copyPasswordHash(fromEmail: string, toEmail: string): void {
  execFileSync(
    'docker',
    [
      'exec', 'crm_postgres_test', 'psql', '-U', 'postgres',
      '-d', process.env.E2E_DB_NAME ?? 'ess_e2e_manual_admin',
      '-v', 'ON_ERROR_STOP=1',
      '-c',
      `UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = '${fromEmail}'), ` +
        `is_active = true, is_email_verified = true, email_verified_at = CURRENT_TIMESTAMP ` +
        `WHERE email = '${toEmail}';`,
    ],
    { stdio: 'pipe' },
  );
}

// API only — no browser, no session file to load.
test.use({ storageState: undefined });

test('a Muscat operation for the administrator manual to photograph', async () => {
  test.setTimeout(900_000);

  const admin = await ApiClient.as('admin');

  // ── the branch and its departments ────────────────────────────────────────
  const branches = asList<{ id: string; code: string }>(await admin.get('/branches'));
  const branchId = branches.find((b) => b.code === 'MCT')?.id;
  if (!branchId) {
    throw new Error('No Muscat branch — run `scripts/admin-manual.sh seed` first (seed.manual.ts creates it)');
  }

  // Unscoped: `GET /departments` is branch-scoped and `withBranch` mutates the
  // client, so asking a Muscat-scoped client for departments returns Muscat's,
  // which is not where the baseline's main departments live. Same trap
  // `firstDepartmentId` documents.
  const unscoped = await ApiClient.as('admin');
  const departments = asList<{ id: string; code: string; parentId?: string | null }>(
    await unscoped.get('/departments'),
  ).filter((d) => !d.parentId);
  const deptId = (code: string): string => {
    const found = departments.find((d) => d.code === code)?.id ?? departments[0]?.id;
    if (!found) throw new Error(`no department for ${code}`);
    return found;
  };

  const scoped = (await ApiClient.as('admin')).withBranch(branchId);

  console.log(`\n  branch=${branchId} (Muscat)  departments=${departments.map((d) => d.code).join(', ')}\n`);

  // ── the workforce ─────────────────────────────────────────────────────────
  /** email → employee id, for everything that follows. */
  const people = new Map<string, string>();
  /** Logins for the handful who file things employees file. */
  const logins = new Map<string, ApiClient>();

  await step(`${STAFF.length} staff at Muscat`, async () => {
    const failed: string[] = [];

    for (const person of STAFF) {
      // Guarded PER PERSON, not per block. The first attempt at this seed sent
      // the nationality fields on the create and the whole loop died on
      // employee one, so the branch ended with nobody in it and the eight
      // blocks downstream all reported "X was not created" instead of the one
      // thing that was actually wrong.
      try {
        const found = asList<{ id: string; email?: string }>(
          await scoped.get(`/employees?search=${encodeURIComponent(person.email)}&limit=5`).catch(() => null),
        ).find((e) => e.email === person.email);

        if (found) {
          people.set(person.email, found.id);
          continue;
        }

        const made = await scoped.post<{ id: string }>('/employees', {
          fullName: person.fullName,
          email: person.email,
          dateOfBirth: person.dateOfBirth,
          startDate: person.startDate,
          position: person.position,
          baseSalary: person.baseSalary,
          branchId,
          departmentId: deptId(person.dept),
          autoGenerateIdCard: true,
        });
        const id = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
        if (id) people.set(person.email, id);
      } catch (e) {
        failed.push(`${person.email}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
      }
    }

    console.log(`     ${people.size} of ${STAFF.length} present`);
    if (failed.length) throw new Error(failed.join(' | '));
  });

  // Nationality is NOT on `CreateEmployeeDto` — it lives on the profile, and
  // the create endpoint runs with `forbidNonWhitelisted`, so sending it there
  // is a 400 rather than an ignored field. It matters enough to be worth the
  // second call: PASI is charged on Omani nationals only, so a register that
  // cannot tell a national from an expatriate cannot illustrate the statutory
  // chapter at all.
  await step('nationality and class, so the statutory figures make sense', async () => {
    for (const person of STAFF) {
      const id = people.get(person.email);
      if (!id) continue;
      await admin
        .patch(`/employees/${id}/profile`, {
          nationality: person.nationality,
          nationalityCode: person.nationalityCode,
          nationalityClass: person.nationalityClass,
        })
        .catch(() => undefined);
    }
  });

  await step('roles — one HR manager and two line managers', async () => {
    for (const person of STAFF.filter((s) => s.role)) {
      const users = asList<{ id: string; email: string }>(
        await admin.get(`/users?search=${encodeURIComponent(person.email)}&limit=5`).catch(() => null),
      );
      const userId = users.find((u) => u.email === person.email)?.id;
      if (!userId) continue;
      await admin.patch(`/users/${userId}/role`, { role: person.role }).catch(() => undefined);
    }
  });

  // ── the HR manager's session ───────────────────────────────────────────────
  // Minted HERE rather than in `seed.manual.ts` because the HR manager IS one of
  // this seed's staff: Aisha Al Balushi, created a few lines above and given the
  // HR_MANAGER role a moment ago. The HR book is the admin book seen from an
  // account that cannot reach the audit log — and that HAS an Approvals inbox
  // the administrator does not. Every figure in it therefore has to be taken as
  // her: the sidebar and the account menu are in every screenshot, so an HR
  // manual built from the admin captures would show a reader a menu they do
  // not have.
  await step('an HR-manager session pinned to the Muscat branch', async () => {
    const HR = 'aisha.albalushi@company.com';
    if (!people.has(HR)) throw new Error(`${HR} was not created`);

    copyPasswordHash('employee1@company.com', HR);
    const session = await ApiClient.asAccount(HR, PASSWORD);
    const me = await session.get<Record<string, any>>('/auth/me');
    writeSession(HR_STORAGE, session.token, inner<any>(me) ?? me, branchId);
    await session.dispose?.();
  });

  await step('logins for the staff who file their own requests', async () => {
    for (const person of STAFF.filter((s) => s.login)) {
      if (!people.has(person.email)) continue;
      copyPasswordHash('employee1@company.com', person.email);
      const session = await ApiClient.asAccount(person.email, PASSWORD).catch(() => null);
      if (session) logins.set(person.email, session);
    }
    console.log(`     ${logins.size} usable logins`);
  });

  const ids = [...people.values()];
  const idOf = (email: string): string => {
    const id = people.get(email);
    if (!id) throw new Error(`${email} was not created`);
    return id;
  };

  // ── attendance ────────────────────────────────────────────────────────────
  // Two months, and both are needed for different figures. The PREVIOUS month
  // in full is what makes a payroll run priceable — payroll charges absence, so
  // an unattended month prints a 95% loss-of-pay line across every payslip in
  // the register. The CURRENT month to yesterday is what the attendance
  // register, the monthly log and the attendance report actually show.
  const now = new Date();
  const thisMonth = now.getUTCMonth() + 1;
  const thisYear = now.getUTCFullYear();
  const prev = new Date(Date.UTC(thisYear, thisMonth - 2, 1));
  const prevMonth = prev.getUTCMonth() + 1;
  const prevYear = prev.getUTCFullYear();

  const yesterday = new Date(Date.now() - 86_400_000);

  await step(`attendance — all of ${prevMonth}/${prevYear}, for ${ids.length} staff`, async () => {
    const days = workingDaysOfMonth(prevYear, prevMonth);
    for (const id of ids) {
      await seedAttendance(admin, branchId, id, days, {
        checkIn: '08:00', checkOut: '17:00', notes: 'Regular day',
      });
    }
  });

  await step(`attendance — ${thisMonth}/${thisYear} to yesterday`, async () => {
    const days = workingDaysOfMonth(thisYear, thisMonth, yesterday);
    for (const id of ids) {
      await seedAttendance(admin, branchId, id, days, {
        checkIn: '08:00', checkOut: '17:00', notes: 'Regular day',
      });
    }
  });

  // A register in which every single row is identical teaches the reader
  // nothing about the screen's filters. Three people are late, one is absent.
  await step('attendance — a few late arrivals and one absence, so the filters have something to filter', async () => {
    const recent = workingDaysOfMonth(thisYear, thisMonth, yesterday).slice(-4);
    if (!recent.length) return;

    // LATE is NOT a status the manual-entry endpoint accepts — it takes only
    // PRESENT, ABSENT, LEAVE and HOLIDAY. Lateness is DERIVED, by comparing the
    // check-in against the branch's `officeStartTime` (08:00 at Muscat), which
    // is why these rows are PRESENT with a late clock.
    await seedAttendance(admin, branchId, idOf('rashid.alhinai@company.com'), [recent[recent.length - 1]], {
      checkIn: '09:12', checkOut: '17:05', notes: 'Traffic on Sultan Qaboos Street',
    });
    await seedAttendance(admin, branchId, idOf('said.almahrouqi@company.com'), [recent[recent.length - 2]], {
      checkIn: '08:47', checkOut: '17:00', notes: 'Late arrival',
    });
    await seedAttendance(admin, branchId, idOf('maria.santos@company.com'), [recent[recent.length - 1]], {
      checkIn: '08:35', checkOut: '16:20', notes: 'Late arrival, early departure',
    });
    await seedAttendance(admin, branchId, idOf('ahmed.hassan@company.com'), [recent[recent.length - 3]], {
      checkIn: '08:00', checkOut: '08:00', status: 'ABSENT', notes: 'No show, unreported',
    });
  });

  // ── leave ─────────────────────────────────────────────────────────────────
  // The pending ones are the point: `/dashboard/leaves/pending` and the leave
  // hub's "Pending approvals" tile are the two screens an administrator opens
  // most, and both are empty without them.
  await step('leave — four requests waiting for a decision', async () => {
    await idempotent(() => seedLeave(admin, branchId, idOf('anil.kumar@company.com'), 'ANNUAL', day(21), day(28), {
      reason: 'Annual holiday with family in Kerala.', approve: false,
    }));
    await idempotent(() => seedLeave(admin, branchId, idOf('maryam.alkindi@company.com'), 'SICK', day(1), day(2), {
      reason: 'Medical certificate attached.', approve: false,
    }));
    await idempotent(() => seedLeave(admin, branchId, idOf('rashid.alhinai@company.com'), 'ANNUAL', day(35), day(39), {
      reason: 'Family wedding in Nizwa.', approve: false,
    }));
    await idempotent(() => seedLeave(admin, branchId, idOf('maria.santos@company.com'), 'ANNUAL', day(60), day(74), {
      reason: 'Home leave — annual ticket entitlement.', approve: false,
    }));
  });

  await step('leave — approved and rejected examples, so the status filters mean something', async () => {
    // Not ANNUAL: `annual_leave_min_notice_days` is 3, and the portal applies
    // it to the FILING date — so annual leave cannot be back-dated at all, and
    // a history of approved annual leave has to be built out of the types that
    // carry no notice rule.
    await idempotent(() => seedLeave(admin, branchId, idOf('fatma.alzadjali@company.com'), 'OTHER', day(-30), day(-27), {
      reason: 'Compassionate leave — family matter.',
    }));
    await idempotent(() => seedLeave(admin, branchId, idOf('ahmed.hassan@company.com'), 'SICK', day(-12), day(-11), {
      reason: 'Fever.',
    }));

    await idempotent(async () => {
      const rejected = await seedLeave(admin, branchId, idOf('said.almahrouqi@company.com'), 'ANNUAL', day(9), day(16), {
        reason: 'Personal travel.', approve: false,
      });
      await admin
        .withBranch(branchId)
        .post(`/leave-requests/${rejected}/reject`, { comment: 'Stores cover is already short that week.' })
        .catch(() => undefined);
    });
  });

  // ── overtime ──────────────────────────────────────────────────────────────
  await step('overtime — claims in both states', async () => {
    const d1 = day(-3);
    const d2 = day(-4);
    const d3 = day(-9);
    await idempotent(() => seedOvertime(admin, branchId, idOf('rashid.alhinai@company.com'), d1,
      `${d1}T17:30:00.000Z`, `${d1}T21:00:00.000Z`, 3.5,
      { reason: 'Emergency chiller repair, third floor.', approve: false }));
    await idempotent(() => seedOvertime(admin, branchId, idOf('said.almahrouqi@company.com'), d2,
      `${d2}T17:00:00.000Z`, `${d2}T20:00:00.000Z`, 3,
      { reason: 'Quarterly stock count.', approve: false }));
    await idempotent(() => seedOvertime(admin, branchId, idOf('anil.kumar@company.com'), d3,
      `${d3}T18:00:00.000Z`, `${d3}T22:00:00.000Z`, 4,
      { reason: 'Production release window.' }));
  });

  // ── pay structure ─────────────────────────────────────────────────────────
  // Housing and transport are the two allowances every Gulf payroll carries, and
  // the salary-structure screen is a table of nothing without them.
  await step('salary components — housing and transport allowances', async () => {
    const effectiveDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
    for (const person of STAFF) {
      const id = people.get(person.email);
      if (!id) continue;
      await addComponent(admin, id, 'HOUSING', Math.round(person.baseSalary * 0.25), {
        effectiveDate, note: 'Housing allowance — 25% of basic.',
      });
      await addComponent(admin, id, 'TRANSPORT', person.baseSalary >= 1000 ? 100 : 60, {
        effectiveDate, note: 'Transport allowance.',
      });
    }
  });

  // ── the calendar ──────────────────────────────────────────────────────────
  // Oman's public holidays. Without them the schedule screens show a working
  // month with no holidays at all, and the holiday tab in Settings is bare.
  await step('Oman public holidays', async () => {
    const HOLIDAYS: Array<[string, string]> = [
      [`${thisYear}-11-18`, 'National Day'],
      [`${thisYear}-11-19`, 'National Day Holiday'],
      [`${thisYear}-01-01`, "New Year's Day"],
      [`${thisYear}-07-23`, 'Renaissance Day'],
    ];
    for (const [date, name] of HOLIDAYS) {
      await ensureHoliday(admin, date, name, {
        branchId,
        description: 'Public holiday — Sultanate of Oman.',
      });
    }
  });

  // ── contracts ─────────────────────────────────────────────────────────────
  await step('contracts — five on file, and one termination waiting for approval', async () => {
    const WITH_CONTRACTS: Array<[string, string]> = [
      ['aisha.albalushi@company.com', 'INDEFINITE'],
      ['khalid.alrashdi@company.com', 'INDEFINITE'],
      ['anil.kumar@company.com', 'FIXED_TERM'],
      ['maria.santos@company.com', 'FIXED_TERM'],
      ['ahmed.hassan@company.com', 'FIXED_TERM'],
    ];

    const made = new Map<string, string>();
    for (const [email, contractType] of WITH_CONTRACTS) {
      const employeeId = people.get(email);
      if (!employeeId) continue;
      const person = STAFF.find((s) => s.email === email)!;
      const body: Record<string, unknown> = {
        employeeId,
        contractType,
        startDate: person.startDate,
        salary: person.baseSalary,
      };
      // A fixed-term contract without an end date is not fixed-term; the two
      // expiring ones are also what puts rows on "Contracts about to expire".
      if (contractType === 'FIXED_TERM') body.endDate = day(120);

      const row = await scoped.post<{ id: string }>('/contracts', body).catch(() => null);
      const id = row && (inner<{ id: string }>(row)?.id ?? (row as any)?.id);
      if (id) made.set(email, id);
    }

    const leaving = made.get('ahmed.hassan@company.com');
    if (!leaving) return;
    const me = await admin.get<Record<string, any>>('/auth/me');
    await scoped.post('/contracts/termination-requests', {
      contractId: leaving,
      requestedBy: (inner<any>(me) ?? me)?.id,
      terminationCategory: 'RESIGNATION',
      noticeDate: day(0),
      terminationDate: day(30),
      reason: 'Resignation — returning home at the end of the current contract.',
    });
  });

  // ── the approval queues ───────────────────────────────────────────────────
  await step('letters — two requests waiting to be issued', async () => {
    // Checked before writing, not merely tolerated on failure.
    //
    // `POST /letters` is perfectly happy to accept the same request twice —
    // an employee really may ask for two salary certificates — so the
    // idempotent() wrapper cannot help here. Re-running the seed four times
    // produced four identical "Anil Kumar · Vehicle finance application" rows,
    // and the manual's Letter Requests figure went out showing them. A figure
    // that looks like a duplicate-submission bug teaches the reader that the
    // product has one.
    const existing = asList<{ purpose?: string }>(
      await scoped.get('/letters?limit=100').catch(() => null),
    );
    const alreadyAsked = (purpose: string): boolean =>
      existing.some((l) => l.purpose === purpose);

    const anil = logins.get('anil.kumar@company.com');
    if (anil && !alreadyAsked('Vehicle finance application')) {
      await anil.post('/letters', {
        templateKey: 'SALARY_CERTIFICATE', locale: 'en',
        purpose: 'Vehicle finance application', addressedTo: 'Bank Muscat',
      });
    }
    // `EXPERIENCE`, not `EXPERIENCE_LETTER` — the seeded templates are
    // EMBASSY, EXPERIENCE, NOC and SALARY_CERTIFICATE, and an unknown key is a
    // 404 rather than a fallback.
    const fatma = logins.get('fatma.alzadjali@company.com');
    if (fatma && !alreadyAsked('Professional membership application')) {
      await fatma.post('/letters', {
        templateKey: 'EXPERIENCE', locale: 'en',
        purpose: 'Professional membership application', addressedTo: 'To whom it may concern',
      });
    }
  });

  // ── talent ────────────────────────────────────────────────────────────────
  await step('grievances — two open cases', async () => {
    // The existence check that belongs here CANNOT be written, and the reason
    // is finding P1: `GET /grievances` applies `NOT (againstEmployeeId = me)`,
    // which in SQL discards every row where that column is NULL — and it is
    // NULL for any complaint not aimed at a named person. So the list comes
    // back empty for the admin, for the complainant, for everybody. There is no
    // second endpoint to ask.
    //
    // Re-running this seed therefore adds two more grievances every time. That
    // is tolerated rather than fixed here, for the same reason it cannot be
    // checked: nothing in the console can see them, so nothing in the manual
    // shows them. When P1 is fixed, replace this with the `filed.includes(...)`
    // shape used by the letters above.
    const raised = asList<{ subject?: string }>(
      await scoped.get('/grievances').catch(() => null),
    ).map((g) => g.subject);
    const alreadyRaised = (subject: string): boolean => raised.includes(subject);

    const rashid = logins.get('rashid.alhinai@company.com');
    if (rashid && !alreadyRaised('Workshop ventilation')) {
      await rashid.post('/grievances', {
        category: 'FACILITIES',
        subject: 'Workshop ventilation',
        description:
          'The extraction fan in the maintenance workshop has been out of service for three weeks. ' +
          'The room fills with fumes when the generators are tested.',
        isConfidential: false,
      });
    }
    const maryam = logins.get('maryam.alkindi@company.com');
    if (maryam && !alreadyRaised('Interview room double-booked')) {
      await maryam.post('/grievances', {
        category: 'WORKPLACE',
        subject: 'Interview room double-booked',
        description:
          'The ground floor interview room is being booked for team meetings during scheduled ' +
          'interview slots, and candidates have twice been left waiting in reception.',
        isConfidential: true,
      });
    }
  });

  await step('rewards — two commendations on record', async () => {
    const given = asList<{ reason?: string }>(
      await scoped.get('/rewards').catch(() => null),
    ).map((r) => r.reason);
    if (given.some((r) => r?.startsWith('Led the office relocation'))) return;

    await scoped.post('/rewards', {
      employeeId: idOf('yousuf.alamri@company.com'),
      reason: 'Led the office relocation over a single weekend with no loss of service.',
      amount: 250, rewardDate: day(-40), rewardType: 'BONUS',
    }).catch(() => undefined);
    await scoped.post('/rewards', {
      employeeId: idOf('maria.santos@company.com'),
      reason: 'Closed the year-end reconciliation four days ahead of schedule.',
      amount: 0, rewardDate: day(-18), rewardType: 'CERTIFICATE',
    }).catch(() => undefined);
  });

  await step('training — a scheduled session with nominations', async () => {
    const courses = asList<{ id: string; code?: string }>(
      await scoped.get('/training/courses').catch(() => null),
    );
    let courseId = courses.find((c) => c.code === 'HSE-201')?.id;
    if (!courseId) {
      const made = await scoped.post<{ id: string }>('/training/courses', {
        code: 'HSE-201',
        title: 'Workplace Health & Safety — Refresher',
        category: 'Compliance',
        provider: 'Oman Safety Institute',
        description: 'Mandatory annual refresher covering site safety, fire drill and first response.',
        durationHours: 6,
        defaultCost: 45,
        certValidMonths: 12,
      });
      courseId = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
    }
    if (!courseId) throw new Error('no course to schedule');

    const scheduled = asList<{ id: string; courseId?: string }>(
      await scoped.get('/training/sessions').catch(() => null),
    ).find((s) => s.courseId === courseId);

    const made = scheduled ?? await scoped.post<{ id: string }>('/training/sessions', {
      courseId, branchId,
      startDate: `${day(24)}T08:00:00.000Z`,
      endDate: `${day(24)}T14:00:00.000Z`,
      location: 'Training Room 1, Al Khuwair',
      trainer: 'Oman Safety Institute',
      seats: 15, costPerSeat: 45,
    });
    const sessionId = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
    if (!sessionId) throw new Error('no training session created');

    const nominated = new Set(
      asList<{ employeeId?: string }>(
        await scoped.get('/training/nominations').catch(() => null),
      ).map((n) => n.employeeId),
    );

    for (const email of [
      'rashid.alhinai@company.com',
      'said.almahrouqi@company.com',
      'ahmed.hassan@company.com',
      'yousuf.alamri@company.com',
    ]) {
      if (nominated.has(idOf(email))) continue;
      await scoped
        .post('/training/nominations', {
          sessionId, employeeId: idOf(email), justification: 'Annual mandatory refresher.',
        })
        .catch(() => undefined);
    }
  });

  // ── workplace ─────────────────────────────────────────────────────────────
  await step('assets — a register with six items, four of them issued', async () => {
    const ITEMS: Array<[string, string, string | null]> = [
      ['Dell Latitude 5450', 'LAPTOP', 'aisha.albalushi@company.com'],
      ['MacBook Pro 14"', 'LAPTOP', 'anil.kumar@company.com'],
      ['iPhone 15', 'MOBILE', 'khalid.alrashdi@company.com'],
      ['Toyota Hilux — 4821 MC', 'VEHICLE', 'yousuf.alamri@company.com'],
      ['Dell Latitude 5450', 'LAPTOP', null],
      ['Zebra ZT230 label printer', 'OTHER', null],
    ];

    let n = 0;
    for (const [name, category, holder] of ITEMS) {
      n += 1;
      const assetTag = `MCT-${category.slice(0, 3)}-${String(n).padStart(3, '0')}`;
      const existing = asList<{ id: string; assetTag?: string }>(
        await scoped.get('/assets?limit=100').catch(() => null),
      ).find((a) => a.assetTag === assetTag);

      let assetId = existing?.id;
      if (!assetId) {
        const made = await scoped.post<{ id: string }>('/assets', {
          name, assetTag, category, branchId,
        });
        assetId = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
      }
      if (!assetId || !holder || !people.has(holder)) continue;

      await scoped
        .post('/assets/assignments', {
          assetId, employeeId: idOf(holder), assignedAt: day(-60), notes: 'Issued for daily use.',
        })
        .catch(() => undefined);
    }
  });

  await step('a supervisor team', async () => {
    const existing = asList<{ code?: string }>(await scoped.get('/teams').catch(() => null));
    if (existing.some((t) => t.code === 'MCT-OPS')) return;
    await scoped.post('/teams', {
      name: 'Muscat Operations',
      code: 'MCT-OPS',
      departmentId: deptId('E2E-OPS'),
    });
  });

  // ── payroll ───────────────────────────────────────────────────────────────
  // A run for the whole branch, left in DRAFT. The payroll chapter walks the
  // administrator through generate → validate → approve → pay, and every one of
  // those figures needs a run sitting at the step BEFORE the one being shown.
  // The employee book's seed already approved two months for its own subject,
  // so both a finished run and an unfinished one are on the screen at once —
  // which is what the status filter chapter needs.
  await step(`payroll — a draft run for ${prevMonth}/${prevYear} covering the whole branch`, async () => {
    // `seed.manual.ts` already approved this period — for its own subject
    // ALONE, because the employee book only ever needed one payslip. That run
    // is the wrong picture for this book and it also blocks a second one: the
    // period is taken. So it is replaced rather than added to.
    //
    // What is left afterwards is the pair the payroll chapter is written
    // around: 6/2026 APPROVED and finished, this month DRAFT and still being
    // worked. A single run in a single state cannot illustrate a pipeline.
    // `GET /payrolls` takes `year` and `status` and NOTHING else — the query
    // DTO is whitelisted, so a `month=` parameter is not merely ignored, it
    // fails the request. Filter the month here instead.
    const runs = asList<{ id: string; month?: number; year?: number; status?: string }>(
      await scoped.get(`/payrolls?year=${prevYear}`).catch(() => null),
    ).filter((r) => Number(r.month) === prevMonth && Number(r.year) === prevYear);

    for (const run of runs) {
      await deletePayroll(admin.withBranch(branchId), run.id).catch(() => undefined);
    }

    const made = await runPayroll(admin, {
      month: prevMonth,
      year: prevYear,
      branchId,
      employeeIds: ids,
    });
    console.log(`     run ${made.id} · ${made.status} · ${made.items.length} payslip(s)`);
  });

  await admin.dispose?.();
  await unscoped.dispose?.();
  await scoped.dispose?.();
  for (const api of logins.values()) await api.dispose?.();

  console.log('\n──────────────────────────────────────────────────────────');
  if (problems.length) {
    console.log(`  ${problems.length} block(s) did not seed:\n`);
    for (const p of problems) console.log(`   • ${p}`);
  } else {
    console.log('  Every block seeded.');
  }
  console.log('──────────────────────────────────────────────────────────\n');
});
