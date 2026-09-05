import { test } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { ApiClient } from '../fixtures';
import {
  seedAttendance,
  seedLeave,
  seedOvertime,
  runPayroll,
  asList,
  inner,
} from '../payroll-support';

/** The manual's subject: an Omani employee at the Muscat branch. */
const SUBJECT = {
  fullName: 'Salim Al Harthy',
  email: 'salim.alharthy@company.com',
  position: 'Software Engineer',
  /** OMR per month — a realistic mid-level Muscat salary. */
  baseSalary: 950,
  password: 'Password123!',
};

/** Where the capture pass reads its session from. */
const STORAGE = resolve(__dirname, '..', '.auth', 'manual-employee.json');
/** The administrator manual's session — same stack, different book. */
const ADMIN_STORAGE = resolve(__dirname, '..', '.auth', 'manual-admin.json');
const ORIGIN = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_FRONTEND_PORT ?? 3410}`;

/**
 * Give a freshly-created employee a password anybody can log in with.
 *
 * `POST /employees` creates the linked login but there is no route — by design —
 * that sets its password: `TestEmployee.password` is deliberately the empty
 * string and reading `.api` throws `NO_LOGIN`, because the payroll suite never
 * needs to BE one of its employees. The manual does: every figure in it is the
 * portal as that employee sees it.
 *
 * So the hash is copied from a seeded account that already has a known password,
 * straight into the test container. This is a local throwaway database — the
 * same one `e2e-db.sh` drops and re-clones — and the alternative is inventing a
 * password-set endpoint in production code to serve a documentation script.
 */
function copyPasswordHash(fromEmail: string, toEmail: string): void {
  execFileSync(
    'docker',
    [
      'exec',
      'crm_postgres_test',
      'psql',
      '-U',
      'postgres',
      '-d',
      process.env.E2E_DB_NAME ?? 'ess_e2e_manual',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = '${fromEmail}'), ` +
        `is_active = true, is_email_verified = true, email_verified_at = CURRENT_TIMESTAMP ` +
        `WHERE email = '${toEmail}';`,
    ],
    { stdio: 'pipe' },
  );
}

/**
 * Write one Playwright storageState file.
 *
 * `selectedBranchId` is the part that matters for the ADMIN book. An admin who
 * has not chosen a branch sees the whole company, and several screens refuse to
 * act at all in that state — payroll is per-branch and answers "Select a
 * specific branch before generating payroll". Pinning Muscat here means every
 * administrator figure is taken in the branch the manual is about, rather than
 * with a branch picker the reader has to be told to use first.
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
 * Give the manual's subject a working life to photograph.
 *
 * The reconnaissance pass found what the e2e baseline is built for and what a
 * manual is not: `employee1@company.com` has no attendance, no payslips, no
 * claims and no documents, so twenty-odd of the portal's screens photograph as
 * "There are no ... yet". An empty state is worth exactly one figure in a
 * manual — the one that explains what an empty state means — and is actively
 * misleading everywhere else, because the reader is stuck on a screen that has
 * rows in it and the picture does not.
 *
 * So this runs first and writes a plausible few months of one employee's
 * record over the API. It is deliberately SEPARATE from the capture pass:
 * seeding is slow and mostly idempotent, capture is fast and re-run constantly
 * while the callouts are being tuned.
 *
 * Every block is independently guarded. A module whose endpoint has moved, or
 * whose feature flag is off in this environment, must not cost the other twenty
 * their data — it reports itself at the end and the manual either gets that
 * figure from a seeded neighbour or documents the empty state honestly.
 *
 *   npx playwright test -c e2e/manual/manual.config.ts seed
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

/** `YYYY-MM-DD`, `days` before or after today. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Working days, most recent first — on the OMANI week.
 *
 * Sunday to Thursday, because the Muscat branch's `weeklyOffDays` is `5,6`.
 * Booking attendance on a Friday would not merely look odd in the manual's
 * screenshots: the attendance history marks a worked weekly-off day
 * differently, so the figure would be explaining a state the reader will
 * never be in.
 */
const OFF_DAYS = new Set([5, 6]); // Friday, Saturday — 0 is Sunday.

function workingDaysBack(count: number, skipToday = true): string[] {
  const out: string[] = [];
  for (let i = skipToday ? 1 : 0; out.length < count && i < count * 3; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    if (OFF_DAYS.has(d.getUTCDay())) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Every working day of one month.
 *
 * Needed because payroll prices ABSENCE. Seeding only the current month's
 * attendance and then running payroll for the two months before it produced
 * payslips reading `Absence (LOP) 906.820` against a 950.000 basic — a 95%
 * deduction, printed in the manual as though it were what a normal month looks
 * like. A payslip figure that alarming teaches the reader the wrong thing about
 * their own pay, so the months a payslip covers are attended in full.
 */
function workingDaysOfMonth(year: number, month: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(year, month - 1, 1));
  while (d.getUTCMonth() === month - 1) {
    if (!OFF_DAYS.has(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// This spec MINTS the session the rest of the config consumes, so it must not
// require it to already exist — a chicken-and-egg that shows up as an
// unreadable-storageState error on a clean checkout rather than as anything
// resembling its cause.
test.use({ storageState: undefined });

test('seed one employee’s working life, for the manual to photograph', async () => {
  test.setTimeout(600_000);

  const admin = await ApiClient.as('admin');

  // ── Oman / Muscat ─────────────────────────────────────────────────────────
  // The manual ships to an Oman client, so every figure in it has to be an
  // Omani one: OMR and not rupees, a Sunday–Thursday working week, and none of
  // the Indian statutory lines (EPF, ESI, Section 87A) that the default preset
  // prints across the payslip screen.
  //
  // Both halves are needed and they are unrelated. `apply-preset` rewrites the
  // GLOBAL payroll settings — currency, overtime multiplier, PASI — while the
  // BRANCH carries the calendar: timezone and the weekly off days that decide
  // which of the employee's days are working ones.
  await step('Oman payroll preset (OMR, PASI, no Indian statutory lines)', async () => {
    await admin.post('/system-settings/apply-preset', { preset: 'OM' });
  });

  let branchId = await admin.firstBranchId();

  await step('Muscat branch', async () => {
    const branches = asList<{ id: string; code: string }>(await admin.get('/branches'));
    const existing = branches.find((b) => b.code === 'MCT');

    if (existing) {
      branchId = existing.id;
      return;
    }

    const made = await admin.post<{ id: string }>('/branches', {
      code: 'MCT',
      name: 'Muscat',
      description: 'Head office for Oman operations.',
      addressLine: 'Building 124, Al Khuwair',
      city: 'Muscat',
      country: 'OM',
      postalCode: '133',
      timezone: 'Asia/Muscat',
      officeStartTime: '08:00',
      officeEndTime: '17:00',
      // 0 = Sunday, so Friday and Saturday are 5 and 6 — the Omani weekend.
      // The working week is therefore Sunday to Thursday.
      weeklyOffDays: '5,6',
    });
    const id = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
    if (id) branchId = id;
  });

  // ── the subject ───────────────────────────────────────────────────────────
  // A NEW employee rather than the suite's `employee1@company.com`, for two
  // reasons. `branchId` is deliberately absent from `UpdateEmployeeDto` —
  // "moving an employee between branches crosses the isolation axis … needs its
  // own reviewed flow" — so employee1 cannot simply be re-pointed at Muscat.
  // And the manual reads better for its audience with an Omani name on an OMR
  // salary than with a transferred fixture.
  let employeeId = '';

  const scoped = admin.withBranch(branchId);
  const existing = asList<{ id: string; email?: string }>(
    await scoped.get(`/employees?search=${encodeURIComponent(SUBJECT.email)}&limit=5`).catch(() => null),
  ).find((e) => e.email === SUBJECT.email);

  if (existing) {
    employeeId = existing.id;
    console.log(`\n  subject: reusing ${SUBJECT.email}`);
  } else {
    // `GET /departments` is BRANCH-SCOPED and `withBranch` mutates the client,
    // so asking `admin` now returns Muscat's departments — of which a brand new
    // branch has none. The lookup has to be made unscoped; a department is
    // valid for any branch. (Same trap `firstDepartmentId` documents.)
    // A department with a `parentId` is a TEAM, and `POST /employees` refuses
    // those outright, so only top-level departments are candidates.
    const unscoped = await ApiClient.as('admin');
    const departments = asList<{ id: string; code: string; parentId?: string | null }>(
      await unscoped.get('/departments').catch(() => null),
    ).filter((d) => !d.parentId);

    if (!departments.length) {
      throw new Error('no top-level department exists to place the subject in');
    }

    const made = await scoped.post<{ id: string }>('/employees', {
      fullName: SUBJECT.fullName,
      email: SUBJECT.email,
      dateOfBirth: '1992-03-14',
      startDate: '2021-06-01',
      position: SUBJECT.position,
      baseSalary: SUBJECT.baseSalary,
      branchId,
      departmentId: departments.find((d) => d.code === 'HRD')?.id ?? departments[0]?.id,
      autoGenerateIdCard: true,
    });
    employeeId = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
    if (!employeeId) throw new Error(`could not create ${SUBJECT.email}`);
    console.log(`\n  subject: created ${SUBJECT.email}`);
  }

  // Give the login a password, then prove it works and keep the session for the
  // capture pass. Doing this here — rather than in the capture spec — means a
  // capture run needs no database access at all.
  /** The subject's OWN client — everything they file is filed as them. */
  let employee!: ApiClient;

  await step('a usable login for the subject, and a saved session', async () => {
    copyPasswordHash('employee1@company.com', SUBJECT.email);

    const session = await ApiClient.asAccount(SUBJECT.email, SUBJECT.password);
    employee = session;
    const me = await session.get<Record<string, any>>('/auth/me');
    const user = inner<any>(me) ?? me;

    writeSession(STORAGE, session.token, user, branchId);
  });

  await step('an administrator session pinned to the Muscat branch', async () => {
    const session = await ApiClient.as('admin');
    const me = await session.get<Record<string, any>>('/auth/me');
    writeSession(ADMIN_STORAGE, session.token, inner<any>(me) ?? me, branchId);
  });

  console.log(`  employee=${employeeId} branch=${branchId} (Muscat, OM)\n`);

  const now = new Date();
  const thisMonth = now.getUTCMonth() + 1;
  const thisYear = now.getUTCFullYear();
  /** The month before this one, which is what a finished payslip covers. */
  const prev = new Date(Date.UTC(thisYear, thisMonth - 2, 1));

  // ── attendance ────────────────────────────────────────────────────────────
  // Today is left DELIBERATELY unmarked. The attendance chapter's first figure
  // is the check-in button in its ready state, and its second is the same card
  // after the capture pass clicks it — neither of which exists if the seed has
  // already booked today.
  await step('attendance — 14 worked days, today left open', async () => {
    await seedAttendance(admin, branchId, employeeId, workingDaysBack(14), {
      checkIn: '09:02',
      checkOut: '18:04',
      status: 'PRESENT',
      notes: 'Regular shift',
    });
  });

  await step('attendance — one late day, for the correction chapter', async () => {
    await seedAttendance(admin, branchId, employeeId, [workingDaysBack(6)[5]], {
      checkIn: '10:47',
      checkOut: '18:10',
      status: 'PRESENT',
      notes: 'Traffic delay',
    });
  });

  // ── leave ─────────────────────────────────────────────────────────────────
  // The leave list is the manual's showcase for "what the statuses mean", so it
  // wants one of each. Note the dates: `Annual Leave requires at least 3 days
  // notice` is enforced on CREATE, so a back-dated approved request cannot be
  // filed through the API at all — the approved example is a future one.
  await step('leave — an approved annual request', async () => {
    await seedLeave(admin, branchId, employeeId, 'ANNUAL', day(45), day(47), {
      reason: 'Family wedding out of town — travel booked.',
      approve: true,
    });
  });

  await step('leave — a pending sick request', async () => {
    await seedLeave(admin, branchId, employeeId, 'SICK', day(4), day(5), {
      reason: 'Scheduled dental procedure and one day of recovery.',
      approve: false,
    });
  });

  await step('leave — a second pending request, further out', async () => {
    await seedLeave(admin, branchId, employeeId, 'ANNUAL', day(30), day(34), {
      reason: 'Annual family holiday — flights already booked.',
      approve: false,
    });
  });

  await step('leave — one rejected request, so the status table has an example', async () => {
    const id = await seedLeave(admin, branchId, employeeId, 'ANNUAL', day(20), day(21), {
      reason: 'Long weekend.',
      approve: false,
    });
    await admin
      .withBranch(branchId)
      .post(`/leave-requests/${id}/reject`, {
        comment: 'Two colleagues are already away in that week — please re-file for a later date.',
      });
  });

  // ── overtime ──────────────────────────────────────────────────────────────
  await step('overtime — one approved claim', async () => {
    const d = workingDaysBack(9)[8];
    await seedOvertime(admin, branchId, employeeId, d, `${d}T18:30:00.000Z`, `${d}T21:30:00.000Z`, 3, {
      reason: 'Release deployment support outside business hours.',
      approve: true,
    });
  });

  await step('overtime — one pending claim', async () => {
    const d = workingDaysBack(3)[2];
    await seedOvertime(admin, branchId, employeeId, d, `${d}T18:00:00.000Z`, `${d}T20:00:00.000Z`, 2, {
      reason: 'Month-end reconciliation with the finance team.',
      approve: false,
    });
  });

  // ── payslips ──────────────────────────────────────────────────────────────
  // Two finished months, so the payslip list has history and the "last month"
  // and "average" tiles on the pay screen are not both zero.
  //
  // Generating the run is NOT enough. `my-payslips/*` deliberately shows an
  // employee only what is APPROVED or LOCKED — a DRAFT is a figure HR is still
  // working on and no employee should see. A seed that stops at DRAFT therefore
  // photographs "There are no salary slips yet" while the runs plainly exist,
  // which is what the first pass did. Walk the whole chain: submit → approve.
  for (const back of [1, 2]) {
    const period = new Date(Date.UTC(thisYear, thisMonth - 1 - back, 1));
    const month = period.getUTCMonth() + 1;
    const year = period.getUTCFullYear();

    // Attend the whole month FIRST, or the run prices it as absence.
    await step(`attendance — the whole of ${month}/${year}`, async () => {
      await seedAttendance(admin, branchId, employeeId, workingDaysOfMonth(year, month), {
        checkIn: '08:00',
        checkOut: '17:00',
        status: 'PRESENT',
        notes: 'Regular shift',
      });
    });

    await step(`payroll — an approved run for ${month}/${year}`, async () => {
      const scoped = admin.withBranch(branchId);

      // Discard any run from an earlier seed pass and generate fresh.
      //
      // Reusing one is tempting and wrong: a run is a SNAPSHOT priced from the
      // attendance that existed when it was generated. The first pass of this
      // seed ran payroll before booking those months' attendance, so its runs
      // are permanently stamped with a 95% absence deduction — and reusing them
      // means the figures never improve however many times the seed is re-run.
      //
      // `ListPayrollsQueryDto` takes `year` and `status` only; `month` is
      // refused by the whitelist, so it is filtered here.
      const existing = asList<{ id: string; month?: number }>(
        await scoped.get(`/payrolls?year=${year}`).catch(() => null),
      ).filter((r) => Number(r.month) === month);

      for (const stale of existing) {
        // A LOCKED run must be unlocked first; APPROVED and below delete directly.
        await scoped
          .post(`/payrolls/${stale.id}/unlock`, { reason: 'Regenerating the manual’s sample payslip.' })
          .catch(() => undefined);
        await scoped.delete(`/payrolls/${stale.id}`).catch(() => undefined);
      }

      const run = await runPayroll(admin, { month, year, branchId, employeeIds: [employeeId] });
      const payrollId = run.id;
      if (!payrollId) throw new Error(`no payroll id for ${month}/${year}`);

      // Each step is a no-op if the run is already past it, so re-seeding is safe.
      await scoped.post(`/payrolls/${payrollId}/submit`, {}).catch(() => undefined);
      await scoped
        .post(`/payrolls/${payrollId}/approve`, { notes: 'Approved for disbursement.' })
        .catch(() => undefined);

      const after = await scoped.get<{ status?: string }>(`/payrolls/${payrollId}`);
      const status = inner<{ status?: string }>(after)?.status ?? (after as any)?.status;
      if (status !== 'APPROVED' && status !== 'LOCKED') {
        throw new Error(
          `run ${month}/${year} is ${status} — the employee's payslip list only shows APPROVED or LOCKED`,
        );
      }
    });
  }

  // ── grievance ─────────────────────────────────────────────────────────────
  await step('grievance — one open case', async () => {
    await employee.post('/grievances', {
      category: 'WORKPLACE',
      subject: 'Air conditioning on the third floor',
      description:
        'The air conditioning on the third floor has been switched off since last week and the room gets uncomfortably warm after midday. Raising this on behalf of the team seated near the window.',
      isConfidential: false,
    });
  });

  // ── letters ───────────────────────────────────────────────────────────────
  await step('letter — a salary certificate request', async () => {
    await employee.post('/letters', {
      templateKey: 'SALARY_CERTIFICATE',
      locale: 'en',
      purpose: 'Home loan application',
      addressedTo: 'The Manager, State Bank',
    });
  });

  // ── assets ────────────────────────────────────────────────────────────────
  await step('asset — a laptop assigned to the employee', async () => {
    const scoped = admin.withBranch(branchId);
    const existing = asList<{ id: string; status?: string }>(
      await scoped.get('/assets?limit=50').catch(() => null),
    );
    let assetId = existing.find((a) => (a.status ?? '').toUpperCase() === 'AVAILABLE')?.id;

    if (!assetId) {
      const made = await scoped.post<{ id: string }>('/assets', {
        name: 'Dell Latitude 5440',
        assetTag: `LAP-${Date.now().toString(36).toUpperCase().slice(-5)}`,
        category: 'LAPTOP',
        branchId,
      });
      assetId = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
    }
    if (!assetId) return;

    await scoped.post('/assets/assignments', {
      assetId,
      employeeId,
      assignedAt: day(-90),
      notes: 'Issued on joining.',
    });
  });

  // ── training ──────────────────────────────────────────────────────────────
  await step('training — one nomination', async () => {
    const scoped = admin.withBranch(branchId);
    const courses = asList<{ id: string }>(await scoped.get('/training/courses').catch(() => null));
    let courseId = courses[0]?.id;

    if (!courseId) {
      const made = await scoped.post<{ id: string }>('/training/courses', {
        // `code` is mandatory and is the catalogue's own identifier.
        code: 'SEC-101',
        title: 'Secure Coding Fundamentals',
        category: 'Technical',
        provider: 'Internal Academy',
        description: 'A one-day workshop on the OWASP Top 10 and secure review practice.',
        durationHours: 8,
      });
      courseId = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
    }
    if (!courseId) return;

    // A nomination attaches to a SESSION — a scheduled sitting of the course —
    // not to the course itself. The catalogue entry alone gives the employee
    // nothing to see on My Training.
    const sessions = asList<{ id: string; courseId?: string }>(
      await scoped.get('/training/sessions').catch(() => null),
    );
    let sessionId = sessions.find((s) => s.courseId === courseId)?.id ?? sessions[0]?.id;

    if (!sessionId) {
      const made = await scoped.post<{ id: string }>('/training/sessions', {
        courseId,
        branchId,
        startDate: `${day(18)}T09:00:00.000Z`,
        endDate: `${day(18)}T17:00:00.000Z`,
        location: 'Training Room 2, Muscat Office',
        trainer: 'Aisha Al Balushi',
        seats: 20,
      });
      sessionId = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
    }
    if (!sessionId) throw new Error('no training session to nominate into');

    await scoped.post('/training/nominations', { sessionId, employeeId });
  });

  // ── timesheet ─────────────────────────────────────────────────────────────
  // ── project, task and timesheet ───────────────────────────────────────────
  // A timesheet line books hours against a TASK, not a project — `taskId` is
  // the one required UUID on the DTO. So the chain has to exist before the
  // Projects and Timesheets chapters have anything to picture: a project the
  // employee is a member of, a task assigned to them, then the line itself.
  await step('project, task and a booked timesheet line', async () => {
    const scoped = admin.withBranch(branchId);

    const projects = asList<{ id: string; slug?: string; name?: string }>(
      await scoped.get('/projects').catch(() => null),
    );

    // Rename the baseline's test projects.
    //
    // The e2e seed ships "E2E Baseline Project" and "E2E Baseline Private
    // Project", and the Projects screen shows them to the subject — so the
    // manual's Projects figure went out to an Oman client with test-harness
    // names printed across it. Renaming is enough: nothing in this manual
    // depends on their identifiers, only on their labels.
    const REAL_NAMES: Record<string, { name: string; description: string }> = {
      'E2E Baseline Project': {
        name: 'Muscat Office Fit-out',
        description: 'Relocation and fit-out of the Al Khuwair floor.',
      },
      'E2E Baseline Private Project': {
        name: 'Employee Portal 2.0',
        description: 'Self-service portal rework — attendance, leave and payslip screens.',
      },
    };

    for (const project of projects) {
      const better = REAL_NAMES[project.name ?? ''];
      if (!better) continue;
      await scoped.patch(`/projects/${project.id}`, better).catch(() => undefined);
    }

    let projectId = projects[0]?.id;

    if (!projectId) {
      const made = await scoped.post<{ id: string }>('/projects', {
        name: 'Employee Portal 2.0',
        slug: 'employee-portal-2',
        taskPrefix: 'EP',
        description: 'Self-service portal rework — attendance, leave and payslip screens.',
        color: '#1D4ED8',
      });
      projectId = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
    }
    if (!projectId) throw new Error('no project to hang a task on');

    // Membership is what makes the project visible on the employee's own
    // Projects screen; without it the chapter photographs an empty list.
    await scoped
      .post(`/projects/${projectId}/members`, { employeeId, role: 'MEMBER' })
      .catch(() => undefined);

    const made = await scoped.post<{ id: string }>('/tasks', {
      title: 'Payslip PDF export',
      description: 'Generate the payslip PDF server-side and stream it to the browser.',
      priority: 'MEDIUM',
      projectId,
      assigneeId: employeeId,
      estimatedHours: 16,
      dueDate: `${day(9)}T00:00:00.000Z`,
    });
    const taskId = inner<{ id: string }>(made)?.id ?? (made as any)?.id;
    if (!taskId) throw new Error('task was created but returned no id');

    // Booked inside the CURRENT week, because that is the week My Timesheets
    // opens on. `/timesheets/summary/weekly` answers for the week containing
    // today, so lines a few days back — which is what "the last working days"
    // gave — fall in the previous week and the screen photographs as 0.0h with
    // an empty breakdown. The figure has to show hours or it teaches nothing.
    const weekStart = new Date();
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay()); // back to Sunday
    const inWeek = (offset: number) => {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + offset);
      return d.toISOString().slice(0, 10);
    };

    for (const [offset, hours, what] of [
      [0, 8, 'Implemented the payslip export endpoint and reviewed two pull requests.'],
      [1, 6.5, 'Wired the export button and added the loading state.'],
      [2, 7.5, 'Fixed the payslip currency formatting and wrote the unit tests.'],
    ] as const) {
      await employee
        .post('/timesheets', {
          taskId,
          workDate: inWeek(offset),
          hoursWorked: hours,
          description: what,
        })
        .catch(() => undefined);
    }
  });

  // ── the report ────────────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────');
  if (problems.length) {
    console.log(`  ${problems.length} block(s) did not seed:\n`);
    for (const p of problems) console.log(`   • ${p.split('\n')[0]}`);
    console.log('\n  These screens will photograph as empty states. Decide per');
    console.log('  screen whether to fix the payload or document the empty view.');
  } else {
    console.log('  Every block seeded.');
  }
  console.log('──────────────────────────────────────────────────────────\n');
});
