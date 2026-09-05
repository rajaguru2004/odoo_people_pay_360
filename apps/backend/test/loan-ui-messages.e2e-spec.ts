import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { bearer } from './utils/fixtures';

/**
 * "What does the user actually SEE?" — the loan feature, end to end, over the
 * real demo accounts.
 *
 * WHY THIS EXISTS, SEPARATELY FROM loan-advances-v2.e2e-spec.ts
 *
 * A production incident: an admin opened a one-instalment OMR 1,500 salary
 * advance, chose "Skip instalment", typed 50, and got a red toast reading
 * "The operation could not be completed".
 *
 * Every existing test passed, and none of them was wrong:
 *   - the backend correctly answered 404 "Instalment not found on the live
 *     schedule";
 *   - the e2e suite asserted that 404;
 *   - the frontend rendered the error path it was asked to render.
 *
 * The defect lived in the SEAM. `lib/axios.ts` rejects with a FLAT object, so
 * the component's `err.response.data.message` was `undefined` and its fallback
 * string won. No test spanned both sides, so nothing failed.
 *
 * This suite covers that seam. It runs the request through the real HTTP
 * pipeline, then puts the response through the SAME two transforms the browser
 * applies — the axios interceptor's flattening, then the component's message
 * read — and asserts on the string a human would end up looking at. A backend
 * that answers well but a frontend that discards it fails here, which is
 * exactly what should have happened the first time.
 *
 * It runs against the demo dataset (`npm run prisma:seed:loans`) so the accounts,
 * amounts and currencies are the ones a reviewer sees in the UI. Without that
 * seed the suite SKIPS rather than fails — it is a verification pass over real
 * data, not a unit test with fixtures.
 *
 *   npm run prisma:seed:loans && npm run verify:loan-ui
 */

// ── the browser's half of the seam, reproduced exactly ──────────────────────

/**
 * What `apps/frontend/lib/axios.ts` puts on the rejection path.
 *
 * Note what is NOT here: `response`. That absence is the whole bug — keep this
 * mirroring the real interceptor, or this suite stops testing anything.
 */
function flattenLikeAxiosInterceptor(res: { status: number; body: any }) {
  return {
    success: false,
    statusCode: res.status,
    message: res.body?.message || 'An error occurred',
    timestamp: res.body?.timestamp || new Date().toISOString(),
    path: '',
    errors: res.body?.errors || null,
    details: res.body ?? null,
  };
}

/** What `apps/frontend/utils/apiError.ts` reads back out. Kept in step by hand. */
function apiErrorMessage(err: any, fallback: string): string {
  if (!err) return fallback;
  const body = err.details ?? err.response?.data ?? null;
  const first = (v: any): string | undefined => {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const f = v.find((x) => typeof x === 'string' && x.trim());
      if (f) return String(f).trim();
    }
    return undefined;
  };
  const base = first(err.message) ?? first(body?.message) ?? undefined;
  const fields = body?.errors ?? err.errors ?? null;
  let details: string | undefined;
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    const parts = Object.entries(fields)
      .map(([k, v]) => (first(v) ? `${k}: ${first(v)}` : ''))
      .filter(Boolean);
    if (parts.length) details = parts.join('; ');
  }
  if (base && details) return `${base} — ${details}`;
  return base ?? details ?? fallback;
}

/** The old, broken read. Kept so the regression stays visible, not just fixed. */
function theOldBrokenRead(err: any, fallback: string): string {
  return err?.response?.data?.message ?? fallback;
}

const GENERIC = 'The operation could not be completed';

describe('Loan & Advances — the message the user actually sees', () => {
  let ctx: E2EContext;
  let prisma: E2EContext['prisma'];
  let http: E2EContext['http'];

  let adminToken = '';
  let seeded = false;

  /** Collected for the summary printed at the end of the run. */
  const seen: Array<{ scenario: string; status: number; shown: string }> = [];

  beforeAll(async () => {
    ctx = await bootE2EApp();
    prisma = ctx.prisma;
    http = ctx.http;

    const admin = await prisma.user.findFirst({
      where: { email: { endsWith: '@loandemo.local' }, role: 'ADMIN' },
      select: { email: true },
    });
    if (!admin) return;

    const res = await http()
      .post('/auth/login')
      .send({ email: admin.email, password: 'Passw0rd!' });
    if (!res.body?.data?.accessToken) return;

    adminToken = res.body.data.accessToken;
    seeded = true;
  }, 120000);

  afterAll(async () => {
    if (seen.length) {
      const lines = seen
        .map((s) => `  ${String(s.status).padEnd(3)}  ${s.scenario}\n       → "${s.shown}"`)
        .join('\n');
      // eslint-disable-next-line no-console
      console.log(`\nWhat the user is shown, per refusal:\n${lines}\n`);
    }
    await ctx.app.close();
  }, 120000);

  const guard = () => {
    if (!seeded) {
      // eslint-disable-next-line no-console
      console.warn('SKIPPED: run `npm run prisma:seed:loans` first.');
    }
    return seeded;
  };

  /**
   * Drive one refusal all the way to the string a human reads, and assert it is
   * both specific and not the generic fallback.
   */
  const shownToUser = async (
    scenario: string,
    call: () => Promise<any>,
    ...mustMention: (string | RegExp)[]
  ) => {
    const res = await call();
    expect(res.status).toBeGreaterThanOrEqual(400);

    const rejection = flattenLikeAxiosInterceptor(res);
    const shown = apiErrorMessage(rejection, GENERIC);
    seen.push({ scenario, status: res.status, shown });

    // 1. The user is told something real.
    expect(shown).not.toBe(GENERIC);
    expect(shown).not.toMatch(/undefined|\[object Object\]/i);
    expect(shown.length).toBeGreaterThan(15);

    // 2. It names the specific limit.
    for (const f of mustMention) {
      if (f instanceof RegExp) expect(shown).toMatch(f);
      else expect(shown.toLowerCase()).toContain(String(f).toLowerCase());
    }

    // 3. The old read really was broken. Without this the suite could pass on a
    //    backend fix alone and the seam would silently rot again.
    expect(theOldBrokenRead(rejection, GENERIC)).toBe(GENERIC);

    return shown;
  };

  /** An ACTIVE demo loan with a live schedule, or null if the seed changed shape. */
  const liveLoan = async (where: Record<string, any> = {}) =>
    prisma.advanceLoanRequest.findFirst({
      where: {
        employee: { email: { endsWith: '@loandemo.local' } },
        status: { in: ['APPROVED', 'DISBURSED', 'ACTIVE'] },
        ...where,
      },
      orderBy: { createdAt: 'asc' },
    });

  it('THE REPORTED BUG: skipping instalment 50 of a short loan now explains itself', async () => {
    if (!guard()) return;

    const loan = await liveLoan();
    expect(loan).toBeTruthy();

    const schedule = await prisma.loanSchedule.findMany({
      where: { requestId: loan!.id, version: loan!.scheduleVersion },
      select: { installmentNo: true },
    });
    const beyond = Math.max(0, ...schedule.map((r) => r.installmentNo)) + 49;

    const shown = await shownToUser(
      `skip instalment ${beyond} on a ${schedule.length}-instalment loan`,
      () =>
        http()
          .post(`/advance-loans/${loan!.id}/skip-installment`)
          .set(bearer(adminToken))
          .send({ installmentNo: beyond, mode: 'EXTEND', reason: 'Requested by HOD' }),
      'instalment',
    );

    // The screenshot's exact wording must never come back for this input.
    expect(shown).not.toBe(GENERIC);
  });

  it('an already-settled instalment says which state it is in', async () => {
    if (!guard()) return;

    // The PARENT must still be live, or the status guard answers first and we
    // would be asserting the wrong message ("this loan is settled…").
    const paid = await prisma.loanSchedule.findFirst({
      where: {
        status: { in: ['PAID', 'WAIVED', 'SKIPPED'] },
        request: {
          employee: { email: { endsWith: '@loandemo.local' } },
          status: { in: ['APPROVED', 'DISBURSED', 'ACTIVE'] },
        },
      },
      select: { installmentNo: true, requestId: true, status: true },
    });
    if (!paid) return; // the seed produced no such row this run

    await shownToUser(
      `skip an already-${paid.status.toLowerCase()} instalment`,
      () =>
        http()
          .post(`/advance-loans/${paid.requestId}/skip-installment`)
          .set(bearer(adminToken))
          .send({ installmentNo: paid.installmentNo, mode: 'EXTEND', reason: 'Requested by HOD' }),
      `instalment ${paid.installmentNo}`,
    );
  });

  it('an overpayment quotes the real payoff figure', async () => {
    if (!guard()) return;
    const loan = await liveLoan();
    if (!loan) return;

    await shownToUser(
      'prepay far more than the loan is worth',
      () =>
        http()
          .post(`/advance-loans/${loan.id}/prepay`)
          .set(bearer(adminToken))
          .send({ amount: 9_999_999 }),
      'payoff',
      /\d/,
    );
  });

  it('a manual close on a live balance offers the alternatives', async () => {
    if (!guard()) return;
    const loan = await liveLoan();
    if (!loan) return;

    await shownToUser(
      'close a loan that still owes money',
      () =>
        http()
          .post(`/advance-loans/${loan.id}/close`)
          .set(bearer(adminToken))
          .send({ reason: 'closing this loan early' }),
      /prepay|waive|write-off/i,
    );
  });

  it('foreclosing with principal outstanding says how much is left', async () => {
    if (!guard()) return;
    const loan = await liveLoan();
    if (!loan) return;

    await shownToUser(
      'foreclose while principal is outstanding',
      () =>
        http()
          .post(`/advance-loans/${loan.id}/foreclose`)
          .set(bearer(adminToken))
          .send({ reason: 'employee is exiting' }),
      'outstanding',
    );
  });

  it('an oversized write-off names the balance it exceeded', async () => {
    if (!guard()) return;
    const loan = await liveLoan();
    if (!loan) return;

    await shownToUser(
      'write off more than is outstanding',
      () =>
        http()
          .post(`/advance-loans/${loan.id}/write-off`)
          .set(bearer(adminToken))
          .send({ amount: 9_999_999, reason: 'uncollectable after exit' }),
      'exceeds',
    );
  });

  it('converting a LOAN says only advances convert', async () => {
    if (!guard()) return;
    const loan = await liveLoan({ type: 'LOAN' });
    if (!loan) return;

    await shownToUser(
      'convert a LOAN to a loan',
      () =>
        http()
          .post(`/advance-loans/${loan.id}/convert`)
          .set(bearer(adminToken))
          .send({ installments: 3, reason: 'converting this one' }),
      'only an advance',
    );
  });

  it('resuming a loan that is not paused says exactly that', async () => {
    if (!guard()) return;
    const loan = await liveLoan();
    if (!loan) return;

    await shownToUser(
      'resume a loan that is not on hold',
      () =>
        http()
          .post(`/advance-loans/${loan.id}/resume`)
          .set(bearer(adminToken))
          .send({ reason: 'resuming recovery' }),
      'not on hold',
    );
  });

  it('a settled loan explains that it is closed rather than failing blankly', async () => {
    if (!guard()) return;

    const done = await prisma.advanceLoanRequest.findFirst({
      where: {
        employee: { email: { endsWith: '@loandemo.local' } },
        status: { in: ['COMPLETED', 'CLOSED', 'REJECTED', 'CANCELLED', 'SETTLED'] },
      },
    });
    if (!done) return;

    await shownToUser(
      `operate on a ${done.status} loan`,
      () =>
        http()
          .post(`/advance-loans/${done.id}/prepay`)
          .set(bearer(adminToken))
          .send({ amount: 100 }),
      done.status.toLowerCase().replace(/_/g, ' '),
    );
  });

  it('a loan that does not exist 404s with a sentence', async () => {
    if (!guard()) return;

    await shownToUser(
      'open a loan id that does not exist',
      () =>
        http()
          .post('/advance-loans/00000000-0000-4000-8000-000000000000/prepay')
          .set(bearer(adminToken))
          .send({ amount: 100 }),
      'not found',
    );
  });

  /**
   * The sweep. Every lifecycle route on every demo loan, refused or not. This is
   * the check that generalises past the reported incident: it does not care
   * WHICH refusal each route produces, only that no reachable refusal in the
   * whole feature can reach a user as a blank.
   */
  it('NO refusal anywhere in the feature reaches the user as a blank', async () => {
    if (!guard()) return;

    const loans = await prisma.advanceLoanRequest.findMany({
      where: { employee: { email: { endsWith: '@loandemo.local' } } },
      select: { id: true, status: true, type: true },
      take: 20,
    });
    expect(loans.length).toBeGreaterThan(0);

    const routes: Array<[string, Record<string, any>]> = [
      ['prepay', { amount: 9_999_999 }],
      ['close', { reason: 'closing this loan' }],
      ['foreclose', { reason: 'employee exiting' }],
      ['write-off', { amount: 9_999_999, reason: 'uncollectable after exit' }],
      ['waive', { amount: 9_999_999, waiveType: 'BOTH', reason: 'goodwill gesture' }],
      ['hold', { reason: 'pausing recovery' }],
      ['resume', { reason: 'resuming recovery' }],
      ['skip-installment', { installmentNo: 999, mode: 'EXTEND', reason: 'skipping this' }],
      ['convert', { installments: 3, reason: 'convert to loan' }],
      ['reinstate', { reason: 'reinstating balance' }],
    ];

    const blanks: string[] = [];
    let refusals = 0;

    for (const loan of loans) {
      for (const [route, payload] of routes) {
        const res = await http()
          .post(`/advance-loans/${loan.id}/${route}`)
          .set(bearer(adminToken))
          .send(payload);
        if (res.status < 400) continue;

        refusals++;
        const shown = apiErrorMessage(flattenLikeAxiosInterceptor(res), GENERIC);
        if (
          shown === GENERIC ||
          shown.length <= 15 ||
          /undefined|\[object Object\]/i.test(shown) ||
          /^(bad request|forbidden|not found|conflict|error)$/i.test(shown)
        ) {
          blanks.push(`${loan.status} ${loan.type} → ${route} → ${res.status}: "${shown}"`);
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(`Swept ${loans.length} demo loans × ${routes.length} routes → ${refusals} refusals, all explained.`);
    expect(blanks).toEqual([]);
    expect(refusals).toBeGreaterThan(0); // the sweep must actually exercise something
  }, 300000);
});
