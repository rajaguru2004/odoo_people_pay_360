import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ACCOUNTS, createTestApp, signIn, type Session } from './setup-app';

/**
 * NOTE ON ISOLATION
 *
 * A payroll run is HISTORY the application never deletes. Once it has been
 * approved and paid there is no route that removes it, and that is the whole
 * point — so no assertion in this file may depend on a whole-table count.
 * Every one is anchored on a row this spec created, named by id or by the
 * period it was opened for.
 *
 * The PERIOD is the fixture. `@@unique([periodStart, periodEnd])` lets a month
 * hold exactly one run, so the spec claims the first FREE months out of a
 * sandbox window — 2022-02 to 2024-12 — that nothing else touches: the seed's
 * three runs are the current month and the two before it, and the payroll hub
 * only ever looks six or twelve months back. Nothing written here is visible
 * to another spec, to the hub, or to the demo data.
 *
 * A complete pass consumes two of those months for good (one run ends PAID,
 * one ends CANCELLED) and hands the rest back. `npm run e2e:db reset` (which
 * drops the container) returns the whole window.
 */

/** A payroll month, as the two date-only keys the API speaks in. */
interface Period {
  month: number;
  year: number;
  start: string;
  end: string;
}

/** Well-formed ids that belong to nothing, for the not-found paths. */
const MISSING_ID = '00000000-0000-0000-0000-000000000000';
const MISSING_ID_V4 = '11111111-1111-4111-8111-111111111111';

/** The sandbox window. February 2022 onwards, so every candidate period ends
 *  after the self-service account was hired and therefore always pays them. */
const SANDBOX_YEARS = [2022, 2023, 2024] as const;
const FIRST_SANDBOX_MONTH = 2;

/** Money is `Decimal(18, 3)`, and Prisma hands a decimal over as a string. */
const num = (value: unknown): number => Number(value ?? 0);
const money = (value: unknown): number => Math.round(num(value) * 1000) / 1000;
const total = <T>(rows: T[], pick: (row: T) => unknown): number =>
  money(rows.reduce((running, row) => running + num(pick(row)), 0));

const periodOf = (month: number, year: number): Period => {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    month,
    year,
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
};

/**
 * Payroll — runs, payslips, the hub, the reports, and the two catalogues
 * behind them — against a real, seeded database.
 *
 * Needs the test stack up: `npm run e2e:up` from the repo root, with
 * apps/backend/.env.test loaded.
 */
describe('Payroll (e2e)', () => {
  let app: INestApplication;
  let admin: Session;
  let hr: Session;
  let payroll: Session;
  let employee: Session;

  /** The employee behind `employee@`. Every self-service assertion is theirs. */
  let meId = '';
  /** Somebody the run pays who is NOT the self-service account. */
  let lopSubjectId = '';
  /** The seeded person deliberately left without a salary structure. */
  let outsiderId = '';

  let componentIds: Record<string, string> = {};
  let payable: Array<{ id: string }> = [];

  let lifecycle: Period;
  let cancelPeriod: Period;
  let scratch: Period;

  /** Written by the lifecycle, read by everything below it. */
  let runId = '';
  let runLabel = '';
  let myPayslipId = '';
  let foreignPayslipId = '';
  let cancelledRunId = '';

  const http = () => request(app.getHttpServer());

  /**
   * The first `count` months of the sandbox window with no run against them.
   *
   * Asked of the API rather than assumed, because a previous pass of this spec
   * has already used some of them and a run is never deleted.
   */
  const claimPeriods = async (count: number): Promise<Period[]> => {
    const taken = new Set<string>();
    for (const year of SANDBOX_YEARS) {
      const res = await admin
        .auth(http().get(`/payroll-runs?year=${year}&limit=200`))
        .expect(200);
      for (const run of res.body.data) {
        taken.add(String(run.periodStart).slice(0, 7));
      }
    }

    const free: Period[] = [];
    for (const year of SANDBOX_YEARS) {
      const from = year === SANDBOX_YEARS[0] ? FIRST_SANDBOX_MONTH : 1;
      for (let month = from; month <= 12; month += 1) {
        const period = periodOf(month, year);
        if (!taken.has(period.start.slice(0, 7))) free.push(period);
        if (free.length === count) return free;
      }
    }
    throw new Error(
      'The payroll sandbox window (2022-02 … 2024-12) is full. ' +
        'Run `npm run e2e:db reset` to start from a clean slate.',
    );
  };

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signIn(app, ACCOUNTS.admin);
    hr = await signIn(app, ACCOUNTS.hr);
    payroll = await signIn(app, ACCOUNTS.payroll);
    employee = await signIn(app, ACCOUNTS.employee);

    const me = await employee.auth(http().get('/auth/me')).expect(200);
    meId = me.body.data.employee.id;

    const catalogue = await admin
      .auth(http().get('/salary-components?limit=200'))
      .expect(200);
    componentIds = Object.fromEntries(
      catalogue.body.data.map((c: { code: string; id: string }) => [
        c.code,
        c.id,
      ]),
    );

    [lifecycle, cancelPeriod, scratch] = await claimPeriods(3);

    const workforce = await admin
      .auth(http().get('/employees?limit=200'))
      .expect(200);
    const staff: Array<{
      id: string;
      status: string;
      hireDate: string | null;
    }> = workforce.body.data;
    const hiredBy = (person: { hireDate: string | null }, day: string) =>
      !person.hireDate || String(person.hireDate).slice(0, 10) <= day;

    // The same population the run itself resolves: on the books, and employed
    // before the period closed.
    payable = staff.filter(
      (person) =>
        person.status !== 'TERMINATED' && hiredBy(person, lifecycle.end),
    );
    expect(payable.length).toBeGreaterThan(1);
    lopSubjectId = payable.find((person) => person.id !== meId)!.id;

    // Somebody this run will not pay AND who has never been paid at all, so a
    // structure can be created and deleted against them without a payslip ever
    // having pointed at it. The seed leaves exactly one such person.
    for (const person of staff) {
      if (person.status === 'TERMINATED') continue;
      if (hiredBy(person, lifecycle.end)) continue;
      const paid = await admin
        .auth(http().get(`/payslips?employeeId=${person.id}&limit=1`))
        .expect(200);
      if (paid.body.meta.total === 0) {
        outsiderId = person.id;
        break;
      }
    }
    expect(outsiderId).not.toBe('');

    // Everybody in the period needs a structure or generation is refused, and
    // the seed leaves one person without one on purpose. Created through the
    // real endpoint rather than the database.
    for (const person of payable) {
      const existing = await payroll.auth(
        http().get(`/salary-structures/employee/${person.id}`),
      );
      if (existing.status === 200) continue;
      await payroll
        .auth(http().post('/salary-structures'))
        .send({
          employeeId: person.id,
          effectiveFrom: `${lifecycle.year}-01-01`,
          lines: [
            { componentId: componentIds.BASIC, amount: 600 },
            { componentId: componentIds.HRA, amount: 200 },
            { componentId: componentIds.SOCIAL_SEC_EE, amount: 42 },
            { componentId: componentIds.SOCIAL_SEC_ER, amount: 63 },
          ],
        })
        .expect(201);
    }

    // A whole calendar week of absence for one person. Seven consecutive days
    // cannot all be weekly offs, so the run has real loss of pay to prorate —
    // and, just as importantly, the period has SOME attendance, without which
    // generation is refused outright rather than quietly paying a full month
    // against a month nobody processed.
    for (let day = 8; day <= 14; day += 1) {
      await admin
        .auth(http().post('/attendances/bulk'))
        .send({
          date: `${lifecycle.start.slice(0, 8)}${String(day).padStart(2, '0')}`,
          entries: [{ employeeId: lopSubjectId, status: 'ABSENT' }],
        })
        .expect(201);
    }

    // The structure test below creates this person's first structure, so it
    // must start without one however the previous pass ended.
    const strayStructure = await admin.auth(
      http().get(`/salary-structures/employee/${outsiderId}`),
    );
    if (strayStructure.status === 200) {
      await admin
        .auth(
          http().delete(`/salary-structures/${strayStructure.body.data.id}`),
        )
        .expect(200);
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------------------
  // 1. The lifecycle, in order. Jest runs these in declaration order and each
  //    step depends on the one above it.
  // ---------------------------------------------------------------------------

  describe('a run from an empty month to money paid', () => {
    it('has a salary structure for everybody the period will pay', async () => {
      for (const person of payable) {
        const res = await payroll
          .auth(http().get(`/salary-structures/employee/${person.id}`))
          .expect(200);

        expect(res.body.data.employeeId).toBe(person.id);
        // A structure with no earning line passes "has a structure" and pays
        // nothing, which is why the lines come back with the assignment.
        expect(
          res.body.data.lines.some(
            (line: { component: { type: string } }) =>
              line.component.type === 'EARNING',
          ),
        ).toBe(true);
      }
    }, 60_000);

    it('reports what the period would refuse without writing anything', async () => {
      const res = await payroll
        .auth(http().post('/payroll-runs/preflight'))
        .send({ month: lifecycle.month, year: lifecycle.year })
        .expect(200);

      const data = res.body.data;
      expect(data.period.periodStart).toBe(lifecycle.start);
      expect(data.period.periodEnd).toBe(lifecycle.end);
      expect(data.employeeCount).toBe(payable.length);
      expect(Array.isArray(data.findings)).toBe(true);
      expect(data.canGenerate).toBe(true);

      // "Writes nothing" is the contract, and the way to see it is that the
      // month is still empty afterwards.
      const runs = await admin
        .auth(http().get(`/payroll-runs?year=${lifecycle.year}&limit=200`))
        .expect(200);
      expect(
        runs.body.data.some(
          (run: { periodStart: string }) => run.periodStart === lifecycle.start,
        ),
      ).toBe(false);
    });

    it('refuses a create body carrying a property nobody declared', async () => {
      // forbidNonWhitelisted. A typo'd field silently ignored is a run that
      // covered a different population from the one the caller asked for.
      const res = await payroll
        .auth(http().post('/payroll-runs'))
        .send({
          month: lifecycle.month,
          year: lifecycle.year,
          includeEverybody: true,
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/should not exist/i);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
    });

    it('opens a DRAFT run for the period', async () => {
      const res = await payroll
        .auth(http().post('/payroll-runs'))
        .send({
          month: lifecycle.month,
          year: lifecycle.year,
          notes: 'Opened by the payroll e2e spec.',
        })
        .expect(201);

      expect(res.body).toMatchObject({
        success: true,
        message: expect.any(String),
      });
      expect(res.body.data).toMatchObject({
        status: 'DRAFT',
        periodStart: lifecycle.start,
        periodEnd: lifecycle.end,
        // The label arrives formatted: the browser does no calendar maths.
        periodLabel: expect.any(String),
      });

      runId = res.body.data.id;
      runLabel = res.body.data.periodLabel;
    });

    it('refuses a second run for the same period, naming the period', async () => {
      const res = await payroll
        .auth(http().post('/payroll-runs'))
        .send({ month: lifecycle.month, year: lifecycle.year })
        .expect(409);

      // A constraint name tells a payroll clerk nothing. The sentence has to
      // say which month already has a run.
      expect(res.body.message).toContain(runLabel);
      expect(res.body).toMatchObject({ success: false, statusCode: 409 });
    });

    it('calculates it into payslips whose lines add up to their own totals', async () => {
      const calculated = await payroll
        .auth(http().post(`/payroll-runs/${runId}/calculate`))
        .expect(200);

      expect(calculated.body.data.status).toBe('CALCULATED');
      expect(calculated.body.data.calculatedAt).not.toBeNull();
      expect(calculated.body.data.payslips.length).toBeGreaterThan(0);

      const slips = await admin
        .auth(http().get(`/payslips?runId=${runId}&limit=200`))
        .expect(200);

      // Counted in the database rather than taken from the page length.
      expect(slips.body.meta.total).toBe(calculated.body.data.payslips.length);
      expect(calculated.body.data.employeeCount).toBe(slips.body.meta.total);

      for (const slip of slips.body.data) {
        const bucket = (type: string) =>
          total(
            slip.lines.filter((line: { type: string }) => line.type === type),
            (line: { amount: unknown }) => line.amount,
          );

        // A payslip whose rows do not add up to its own header is the first
        // thing anybody notices, and the last thing anybody can explain.
        expect(bucket('EARNING')).toBe(money(slip.grossPay));
        expect(bucket('DEDUCTION')).toBe(money(slip.totalDeductions));
        expect(bucket('EMPLOYER_CONTRIBUTION')).toBe(
          money(slip.totalEmployerCost),
        );
        // Employer contributions are recorded, never paid: they are in neither
        // the gross nor the net.
        expect(money(num(slip.grossPay) - num(slip.totalDeductions))).toBe(
          money(slip.netPay),
        );
        expect(num(slip.totalEmployerCost)).toBeGreaterThan(0);
      }

      const runTotals = await admin
        .auth(http().get(`/payroll-runs/${runId}`))
        .expect(200);
      expect(money(runTotals.body.data.totalGross)).toBe(
        total(slips.body.data, (slip: { grossPay: unknown }) => slip.grossPay),
      );
      expect(money(runTotals.body.data.totalNet)).toBe(
        total(slips.body.data, (slip: { netPay: unknown }) => slip.netPay),
      );

      myPayslipId = slips.body.data.find(
        (slip: { employeeId: string }) => slip.employeeId === meId,
      ).id;
      foreignPayslipId = slips.body.data.find(
        (slip: { employeeId: string }) => slip.employeeId !== meId,
      ).id;
      expect(myPayslipId).toEqual(expect.any(String));
    }, 120_000);

    it('docks the week of absence as a single loss-of-pay deduction', async () => {
      const res = await admin
        .auth(http().get(`/payslips?runId=${runId}&employeeId=${lopSubjectId}`))
        .expect(200);

      const slip = res.body.data[0];
      expect(num(slip.lopDays)).toBeGreaterThan(0);
      expect(num(slip.paidDays)).toBeLessThan(num(slip.workDays));

      const lop = slip.lines.filter(
        (line: { code: string }) => line.code === 'LOP',
      );
      // ONE line, on the deduction side. Prorating each earning down instead
      // would leave a payslip that cannot show what was withheld or why.
      expect(lop).toHaveLength(1);
      expect(lop[0].type).toBe('DEDUCTION');
      expect(num(lop[0].amount)).toBeGreaterThan(0);
    });

    it('does not show an employee their own payslip from an unapproved run', async () => {
      // A draft figure is still being corrected. An employee who reads one and
      // then reads a different approved figure has been told two different
      // things about the same month.
      await employee
        .auth(http().get(`/payslips/my/${myPayslipId}`))
        .expect(404);
      await employee.auth(http().get(`/payslips/${myPayslipId}`)).expect(404);

      const mine = await employee
        .auth(http().get('/payslips/my?limit=200'))
        .expect(200);
      expect(
        mine.body.data.some((slip: { id: string }) => slip.id === myPayslipId),
      ).toBe(false);
      for (const slip of mine.body.data) {
        expect(['APPROVED', 'PAID']).toContain(slip.payrollRun.status);
      }
    });

    it('refuses the payroll officer who ran it the right to sign it off', async () => {
      // Separation of duties, and the one 403 that matters most here: the
      // officer holds MANAGE_PAYROLL and deliberately not APPROVE_PAYROLL.
      await payroll
        .auth(http().post(`/payroll-runs/${runId}/approve`))
        .expect(403);

      const untouched = await admin
        .auth(http().get(`/payroll-runs/${runId}`))
        .expect(200);
      expect(untouched.body.data.status).toBe('CALCULATED');
    });

    it('refuses a rejection that gives the officer nothing to correct', async () => {
      await admin
        .auth(http().post(`/payroll-runs/${runId}/reject`))
        .send({})
        .expect(400);
      await admin
        .auth(http().post(`/payroll-runs/${runId}/reject`))
        .send({ reason: '' })
        .expect(400);
      await admin
        .auth(http().post(`/payroll-runs/${runId}/reject`))
        .send({ reason: 'x' })
        .expect(400);
    });

    it('sends the run back to DRAFT with the reason attached', async () => {
      const reason = 'The overtime for the Sohar branch is missing.';
      const res = await admin
        .auth(http().post(`/payroll-runs/${runId}/reject`))
        .send({ reason })
        .expect(200);

      expect(res.body.data).toMatchObject({
        status: 'DRAFT',
        rejectionReason: reason,
        approvedAt: null,
        approvedById: null,
      });
    });

    it('clears the old objection when the run is recalculated', async () => {
      const res = await payroll
        .auth(http().post(`/payroll-runs/${runId}/calculate`))
        .expect(200);

      expect(res.body.data.status).toBe('CALCULATED');
      // A reason left over from a previous rejection, sitting beside fresh
      // figures, reads as a live objection to them.
      expect(res.body.data.rejectionReason).toBeNull();

      // Recalculating REPLACES the payslips rather than editing them, so every
      // id captured before the rejection is now stale. Holding one would be a
      // spec asserting against a row the application has already dropped.
      const slips = await admin
        .auth(http().get(`/payslips?runId=${runId}&limit=200`))
        .expect(200);
      myPayslipId = slips.body.data.find(
        (slip: { employeeId: string }) => slip.employeeId === meId,
      ).id;
      foreignPayslipId = slips.body.data.find(
        (slip: { employeeId: string }) => slip.employeeId !== meId,
      ).id;
    }, 120_000);

    it('is approved by an admin', async () => {
      const res = await admin
        .auth(http().post(`/payroll-runs/${runId}/approve`))
        .expect(200);

      expect(res.body.data.status).toBe('APPROVED');
      expect(res.body.data.approvedAt).not.toBeNull();
      expect(res.body.data.approvedById).toEqual(expect.any(String));
      expect(res.body.message).toEqual(expect.any(String));
    });

    it('cannot be recalculated once it has been signed off', async () => {
      const res = await payroll
        .auth(http().post(`/payroll-runs/${runId}/calculate`))
        .expect(400);
      expect(res.body.message).toMatch(/approved/i);
    });

    it('is marked paid by an admin', async () => {
      const res = await admin
        .auth(http().post(`/payroll-runs/${runId}/mark-paid`))
        .expect(200);

      expect(res.body.data.status).toBe('PAID');
      expect(res.body.data.paidAt).not.toBeNull();
    });

    it('shows the employee their own payslip once the run has settled', async () => {
      const mine = await employee
        .auth(http().get(`/payslips/my/${myPayslipId}`))
        .expect(200);
      expect(mine.body.data.employeeId).toBe(meId);
      expect(mine.body.data.payrollRun.status).toBe('PAID');
      expect(mine.body.data.payrollRun.periodLabel).toBe(runLabel);
      expect(mine.body.data.lines.length).toBeGreaterThan(0);

      await employee.auth(http().get(`/payslips/${myPayslipId}`)).expect(200);
    });

    it('downloads the run as a spreadsheet', async () => {
      const res = await payroll
        .auth(http().get(`/payroll-runs/${runId}/export`))
        .expect(200);

      expect(res.headers['content-type']).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. The envelope. Half of what the frontend does depends on this shape.
  // ---------------------------------------------------------------------------

  describe('the response envelope', () => {
    it('wraps a list in success, data and pagination meta', async () => {
      const res = await payroll
        .auth(http().get('/payroll-runs?limit=5'))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toMatchObject({
        total: expect.any(Number),
        page: 1,
        limit: 5,
        totalPages: expect.any(Number),
      });
    });

    it('wraps a single resource in success and data', async () => {
      const res = await payroll
        .auth(http().get(`/payroll-runs/${runId}`))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(runId);
    });

    it('answers a failure with the failure envelope, not the success one', async () => {
      const res = await admin
        .auth(http().get(`/payroll-runs/${MISSING_ID}`))
        .expect(404);

      expect(res.body).toMatchObject({
        success: false,
        statusCode: 404,
        message: expect.any(String),
        timestamp: expect.any(String),
        path: `/payroll-runs/${MISSING_ID}`,
      });
      expect(res.body.errors).toBeNull();
      expect(res.body.data).toBeUndefined();
    });

    it('flattens a validation failure into a sentence and keeps the list', async () => {
      const res = await payroll
        .auth(http().post('/salary-components'))
        .send({ code: 'BAD CODE', name: 'Nope', type: 'EARNING', stray: 1 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.statusCode).toBe(400);
      expect(typeof res.body.message).toBe('string');
      expect(Array.isArray(res.body.errors)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Runs that never reach payment.
  // ---------------------------------------------------------------------------

  describe('a run that is cancelled, and a draft that is deleted', () => {
    it('cancels a run instead of deleting it, and then refuses to delete it', async () => {
      const created = await admin
        .auth(http().post('/payroll-runs'))
        .send({ month: cancelPeriod.month, year: cancelPeriod.year })
        .expect(201);
      cancelledRunId = created.body.data.id;

      await hr
        .auth(http().post(`/payroll-runs/${cancelledRunId}/cancel`))
        .expect(403);

      const cancelled = await payroll
        .auth(http().post(`/payroll-runs/${cancelledRunId}/cancel`))
        .expect(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');

      // Deleting is for a draft nobody has looked at. A cancelled run is a
      // decision, and the record of it stays.
      const refused = await admin
        .auth(http().delete(`/payroll-runs/${cancelledRunId}`))
        .expect(400);
      expect(refused.body.message).toMatch(/draft/i);
    });

    it('deletes a draft, and gives its period back', async () => {
      await hr
        .auth(http().post('/payroll-runs'))
        .send({ month: scratch.month, year: scratch.year })
        .expect(403);

      const created = await payroll
        .auth(http().post('/payroll-runs'))
        .send({ month: scratch.month, year: scratch.year })
        .expect(201);
      const draftId = created.body.data.id;

      await payroll.auth(http().delete(`/payroll-runs/${draftId}`)).expect(403);

      const removed = await admin
        .auth(http().delete(`/payroll-runs/${draftId}`))
        .expect(200);
      expect(removed.body.success).toBe(true);

      await admin.auth(http().get(`/payroll-runs/${draftId}`)).expect(404);

      // The month is empty again, which is what lets this spec run twice.
      const reopened = await admin
        .auth(http().post('/payroll-runs'))
        .send({ month: scratch.month, year: scratch.year })
        .expect(201);
      await admin
        .auth(http().delete(`/payroll-runs/${reopened.body.data.id}`))
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Payslips: who may read whose.
  // ---------------------------------------------------------------------------

  describe('payslips', () => {
    it("refuses an employee somebody else's payslip", async () => {
      // The other 403 that matters. A payslip names what a colleague earns.
      await employee
        .auth(http().get(`/payslips/${foreignPayslipId}`))
        .expect(403);
      await employee
        .auth(http().get(`/payslips/employee/${lopSubjectId}`))
        .expect(403);
    });

    it('lets a payroll role read anybody, and an employee read themselves', async () => {
      await payroll
        .auth(http().get(`/payslips/${foreignPayslipId}`))
        .expect(200);
      await hr
        .auth(http().get(`/payslips/employee/${lopSubjectId}`))
        .expect(200);

      const own = await employee
        .auth(http().get(`/payslips/employee/${meId}`))
        .expect(200);
      for (const slip of own.body.data) {
        expect(slip.employeeId).toBe(meId);
      }
    });

    it('closes the workforce-wide list to an employee', async () => {
      await employee.auth(http().get('/payslips')).expect(403);

      const listed = await hr
        .auth(http().get(`/payslips?runId=${runId}&limit=200`))
        .expect(200);
      expect(listed.body.meta.total).toBeGreaterThan(0);
      for (const slip of listed.body.data) {
        expect(slip.payrollRun.id).toBe(runId);
      }
    });

    it('has nothing to serve an account with no employee record behind it', async () => {
      const me = await admin.auth(http().get('/auth/me')).expect(200);
      // The seeded admin is a bare login, not a member of staff.
      expect(me.body.data.employee ?? null).toBeNull();
      await admin.auth(http().get('/payslips/my')).expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. The hub.
  // ---------------------------------------------------------------------------

  describe('hub summary', () => {
    it('answers for the window it was asked for', async () => {
      for (const months of [6, 12]) {
        const res = await payroll
          .auth(http().get(`/payroll/hub-summary?months=${months}`))
          .expect(200);

        expect(res.body.data.months).toBe(months);
        expect(res.body.data.trend).toHaveLength(months);
        for (const bucket of res.body.data.trend) {
          // The server owns every bucket label.
          expect(bucket.label).toEqual(expect.any(String));
        }
      }
    });

    it('defaults to six months when the window is left out', async () => {
      const res = await hr.auth(http().get('/payroll/hub-summary')).expect(200);
      expect(res.body.data.months).toBe(6);
      expect(res.body.data.period.label).toEqual(expect.any(String));
      expect(res.body.data.previousPeriod.label).toEqual(expect.any(String));
    });

    it('refuses a window it does not offer instead of quietly answering for six', async () => {
      const res = await admin
        .auth(http().get('/payroll/hub-summary?months=7'))
        .expect(400);
      expect(res.body.message).toMatch(/6 or 12/);
    });

    it('reports a rate as null rather than zero, and caps a name sample without capping its count', async () => {
      const res = await admin
        .auth(http().get('/payroll/hub-summary?months=6'))
        .expect(200);

      const changePct = res.body.data.money.changePct;
      // 0% is a claim that pay did not move. "Nothing to compare against" is a
      // different claim, and the card must be able to say so.
      expect(changePct === null || typeof changePct === 'number').toBe(true);

      for (const item of res.body.data.attention) {
        expect(item.names.length).toBeLessThanOrEqual(item.count);
      }
      expect(
        res.body.data.employees.withoutStructureNames.length,
      ).toBeLessThanOrEqual(res.body.data.employees.withoutStructure);
    });

    it('is closed to an employee', () =>
      employee.auth(http().get('/payroll/hub-summary')).expect(403));
  });

  // ---------------------------------------------------------------------------
  // 6. Reports.
  // ---------------------------------------------------------------------------

  describe('reports', () => {
    it('registers every payslip in the run exactly as it was snapshotted', async () => {
      const res = await hr
        .auth(http().get(`/payroll/reports/register?runId=${runId}`))
        .expect(200);

      expect(res.body.data.run.id).toBe(runId);
      expect(res.body.data.count).toBe(res.body.data.rows.length);
      expect(res.body.data.rows.length).toBeGreaterThan(0);
      expect(money(res.body.data.totals.net)).toBe(
        total(res.body.data.rows, (row: { net: unknown }) => row.net),
      );
    });

    it('cuts the cost along the axis it was asked for', async () => {
      for (const groupBy of ['department', 'branch']) {
        const res = await payroll
          .auth(
            http().get(
              `/payroll/reports/cost?runId=${runId}&groupBy=${groupBy}`,
            ),
          )
          .expect(200);

        expect(res.body.data.groupBy).toBe(groupBy);
        expect(res.body.data.rows.length).toBeGreaterThan(0);
      }
    });

    it('totals the statutory lines by the code they were paid under', async () => {
      const res = await hr
        .auth(http().get(`/payroll/reports/statutory?runId=${runId}`))
        .expect(200);

      expect(Array.isArray(res.body.data.deductions)).toBe(true);
      expect(Array.isArray(res.body.data.employerContributions)).toBe(true);
      expect(money(res.body.data.totals.combined)).toBe(
        money(
          num(res.body.data.totals.deductions) +
            num(res.body.data.totals.employerContributions),
        ),
      );
    });

    it('answers year-to-date for the calendar year it was named', async () => {
      const res = await hr
        .auth(http().get(`/payroll/reports/ytd/${meId}?year=${lifecycle.year}`))
        .expect(200);

      expect(res.body.data.year).toBe(lifecycle.year);
      expect(res.body.data.employee.id).toBe(meId);
      expect(res.body.data.periodsPaid).toBeGreaterThan(0);
      expect(res.body.data.periods.length).toBe(res.body.data.periodsPaid);
    });

    it('reads locked runs only, and says so', async () => {
      const res = await hr
        .auth(http().get(`/payroll/reports/register?runId=${cancelledRunId}`))
        .expect(400);
      // A draft is a working figure still being corrected; a report built on
      // one is a document nobody can file.
      expect(res.body.message).toMatch(/APPROVED or PAID/);
    });

    it('demands the run it is reporting on', async () => {
      await hr.auth(http().get('/payroll/reports/register')).expect(400);
      await hr
        .auth(http().get(`/payroll/reports/register?runId=${MISSING_ID_V4}`))
        .expect(404);
    });

    it('is closed to an employee', async () => {
      await employee
        .auth(http().get(`/payroll/reports/register?runId=${runId}`))
        .expect(403);
      await employee
        .auth(http().get(`/payroll/reports/cost?runId=${runId}`))
        .expect(403);
      await employee
        .auth(http().get(`/payroll/reports/statutory?runId=${runId}`))
        .expect(403);
      await employee
        .auth(http().get(`/payroll/reports/ytd/${meId}`))
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. The salary-component catalogue.
  // ---------------------------------------------------------------------------

  describe('salary components', () => {
    // Unique per pass: the catalogue has no delete, so a fixed code would
    // clash with itself the second time this spec ran.
    const code = `E2E${Date.now().toString(36).toUpperCase()}`;
    let componentId = '';

    it('is created by a payroll role and refused to an HR manager', async () => {
      await hr
        .auth(http().post('/salary-components'))
        .send({ code, name: 'E2E allowance', type: 'EARNING' })
        .expect(403);

      const res = await payroll
        .auth(http().post('/salary-components'))
        .send({
          code: code.toLowerCase(),
          name: 'E2E allowance',
          type: 'EARNING',
        })
        .expect(201);

      // Uppercased on the way in: a payslip line joins on the code, so it must
      // not depend on how somebody typed it.
      expect(res.body.data.code).toBe(code);
      componentId = res.body.data.id;
    });

    it('refuses a second component with the same code, naming it', async () => {
      const res = await payroll
        .auth(http().post('/salary-components'))
        .send({ code, name: 'A duplicate', type: 'EARNING' })
        .expect(409);
      expect(res.body.message).toContain(code);
    });

    it('is edited by a payroll role and refused to an HR manager', async () => {
      await hr
        .auth(http().patch(`/salary-components/${componentId}`))
        .send({ name: 'Not allowed' })
        .expect(403);

      const res = await payroll
        .auth(http().patch(`/salary-components/${componentId}`))
        .send({ name: 'E2E allowance (revised)', sequence: 90 })
        .expect(200);
      expect(res.body.data).toMatchObject({
        name: 'E2E allowance (revised)',
        sequence: 90,
      });
    });

    it('is retired and reinstated rather than deleted', async () => {
      await hr
        .auth(http().post(`/salary-components/${componentId}/deactivate`))
        .expect(403);

      const retired = await payroll
        .auth(http().post(`/salary-components/${componentId}/deactivate`))
        .expect(201);
      expect(retired.body.data.isActive).toBe(false);

      const back = await payroll
        .auth(http().post(`/salary-components/${componentId}/activate`))
        .expect(201);
      expect(back.body.data.isActive).toBe(true);
    });

    it('is listed by any payroll-facing role and closed to an employee', async () => {
      const res = await hr
        .auth(http().get(`/salary-components?search=${code}`))
        .expect(200);
      expect(res.body.data[0].code).toBe(code);

      await payroll
        .auth(http().get(`/salary-components/${componentId}`))
        .expect(200);
      await employee.auth(http().get('/salary-components')).expect(403);
      await employee
        .auth(http().get(`/salary-components/${componentId}`))
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Salary structures.
  // ---------------------------------------------------------------------------

  describe('salary structures', () => {
    let structureId = '';

    it('refuses a structure that pays nothing', async () => {
      // A deduction-only structure passes "has a structure" in the pre-flight
      // and then produces a payslip that pays the employee nothing at all.
      const res = await payroll
        .auth(http().post('/salary-structures'))
        .send({
          employeeId: outsiderId,
          effectiveFrom: `${lifecycle.year}-01-01`,
          lines: [{ componentId: componentIds.SOCIAL_SEC_EE, amount: 42 }],
        })
        .expect(400);
      expect(res.body.message).toMatch(/earning/i);
    });

    it('is assigned by a payroll role and refused to an HR manager', async () => {
      const body = {
        employeeId: outsiderId,
        effectiveFrom: `${lifecycle.year}-01-01`,
        lines: [{ componentId: componentIds.BASIC, amount: 500 }],
      };

      await hr.auth(http().post('/salary-structures')).send(body).expect(403);

      const res = await payroll
        .auth(http().post('/salary-structures'))
        .send(body)
        .expect(201);

      expect(res.body.data.employeeId).toBe(outsiderId);
      expect(res.body.data.lines).toHaveLength(1);
      structureId = res.body.data.id;
    });

    it('refuses a second structure for somebody who already has one', async () => {
      const res = await payroll
        .auth(http().post('/salary-structures'))
        .send({
          employeeId: outsiderId,
          effectiveFrom: `${lifecycle.year}-01-01`,
          lines: [{ componentId: componentIds.BASIC, amount: 500 }],
        })
        .expect(409);
      // Two definitions of one person's pay, with nothing to choose between
      // them. The answer names the route that edits the one they have.
      expect(res.body.message).toContain(structureId);
    });

    it('replaces the whole line set rather than merging into it', async () => {
      await hr
        .auth(http().patch(`/salary-structures/${structureId}`))
        .send({ lines: [{ componentId: componentIds.BASIC, amount: 1 }] })
        .expect(403);

      const res = await payroll
        .auth(http().patch(`/salary-structures/${structureId}`))
        .send({
          lines: [
            { componentId: componentIds.BASIC, amount: 550 },
            { componentId: componentIds.HRA, amount: 150 },
          ],
        })
        .expect(200);

      // A merge cannot express a removal, and a rise that drops an allowance
      // is exactly what this screen is for.
      expect(res.body.data.lines).toHaveLength(2);
    });

    it('is read by every payroll-facing role and closed to an employee', async () => {
      await hr.auth(http().get('/salary-structures?limit=5')).expect(200);
      await hr
        .auth(http().get(`/salary-structures/employee/${outsiderId}`))
        .expect(200);
      await payroll
        .auth(http().get(`/salary-structures/${structureId}`))
        .expect(200);

      await employee.auth(http().get('/salary-structures')).expect(403);
      await employee
        .auth(http().get(`/salary-structures/employee/${meId}`))
        .expect(403);
      await employee
        .auth(http().get(`/salary-structures/${structureId}`))
        .expect(403);
    });

    it('refuses to delete the structure of somebody who has been paid', async () => {
      const mine = await admin
        .auth(http().get(`/salary-structures/employee/${meId}`))
        .expect(200);

      const res = await admin
        .auth(http().delete(`/salary-structures/${mine.body.data.id}`))
        .expect(400);
      // Every later question about a payslip is asked against the assignment
      // that produced it.
      expect(res.body.message).toMatch(/payslip/i);
    });

    it('is deleted by an admin only, while it has never paid anybody', async () => {
      await payroll
        .auth(http().delete(`/salary-structures/${structureId}`))
        .expect(403);

      await admin
        .auth(http().delete(`/salary-structures/${structureId}`))
        .expect(200);
      await admin
        .auth(http().get(`/salary-structures/${structureId}`))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. The rest of the role matrix, on the routes the lifecycle did not cover
  //    from both sides.
  // ---------------------------------------------------------------------------

  describe('who may reach which run route', () => {
    it('opens the run list to the three payroll-facing roles and to nobody else', async () => {
      await hr.auth(http().get('/payroll-runs?limit=1')).expect(200);
      await payroll.auth(http().get(`/payroll-runs/${runId}`)).expect(200);

      await employee.auth(http().get('/payroll-runs')).expect(403);
      await employee.auth(http().get(`/payroll-runs/${runId}`)).expect(403);
      await employee
        .auth(http().get(`/payroll-runs/${runId}/export`))
        .expect(403);
    });

    it('keeps pre-flight and generation to the people who run payroll', async () => {
      // An HR manager may read payroll; they do not operate it.
      await hr
        .auth(http().post('/payroll-runs/preflight'))
        .send({ month: scratch.month, year: scratch.year })
        .expect(403);
      await hr
        .auth(http().post(`/payroll-runs/${runId}/calculate`))
        .expect(403);
    });

    it('keeps every decision on a run to an admin', async () => {
      await payroll
        .auth(http().post(`/payroll-runs/${runId}/approve`))
        .expect(403);
      await payroll
        .auth(http().post(`/payroll-runs/${runId}/reject`))
        .send({ reason: 'The officer must not be able to do this either.' })
        .expect(403);
      await hr
        .auth(http().post(`/payroll-runs/${runId}/mark-paid`))
        .expect(403);
      await payroll
        .auth(http().post(`/payroll-runs/${runId}/mark-paid`))
        .expect(403);
      await payroll.auth(http().delete(`/payroll-runs/${runId}`)).expect(403);

      // And none of it moved the run.
      const after = await admin
        .auth(http().get(`/payroll-runs/${runId}`))
        .expect(200);
      expect(after.body.data.status).toBe('PAID');
    });

    it('answers an unauthenticated caller with 401, not with data', async () => {
      await http().get('/payroll-runs').expect(401);
      await http().get('/payslips/my').expect(401);
      await http().get('/payroll/hub-summary').expect(401);
    });
  });
});
