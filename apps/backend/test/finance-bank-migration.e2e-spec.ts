import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
  FIN_COUNTRY,
} from './utils/finance-fixtures';
import { bearer } from './utils/settings';

/**
 * Bank migration, and the cluster it cannot work without.
 *
 * "Bank migration" is two endpoints — `GET /bank-change-requests/migration/candidates`
 * and `POST /bank-change-requests/migration` — and a screen. On its own that is
 * a thin thing to test, and testing it on its own would prove almost nothing:
 * the migration path shares `assertBankEditable`, `validateAgainstConfig` and
 * the whole banking-field schema with the request path, and it is inert without
 * a bank master and a branch's allowed countries. So the suite covers the
 * cluster: banks, banking config, branch countries, the change-request lifecycle
 * and migration.
 *
 * The behaviour worth reading the file for is the **payroll-lock carve-out**.
 * Bank details are frozen while a payroll run is in flight, because an in-flight
 * run must keep paying the account it was built with. Migration is exempted from
 * that lock — but ONLY for a first-time detail, because every employee the
 * migration screen lists is by definition one with no active detail. Enforcing
 * the lock unconditionally deadlocked the screen: a single open company-wide run
 * blocked bank onboarding for the whole company while protecting nothing, since
 * a run built when the employee had no account on file cannot be "kept paying
 * the account it was built with". The employee just stayed unpayable.
 *
 * Both halves are asserted, because the carve-out is exactly the kind of
 * subtlety a later refactor flattens.
 */
describe('Finance — Bank master, config & migration (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any): any => res.body?.data ?? res.body;
  const rowsOf = (res: any): any[] => {
    const d = dataOf(res);
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  const expectStatus = (
    res: any,
    expected: number | number[],
    label = '',
  ): void => {
    const want = Array.isArray(expected) ? expected : [expected];
    if (!want.includes(res.status)) {
      throw new Error(
        `${label ? `${label} — ` : ''}expected ${want.join(' or ')}, got ${res.status}: ${body(res)}`,
      );
    }
  };

  /**
   * A structurally valid Omani IBAN for a given 3-digit bank code, built the
   * way the server checks it: mod-97 over the rearranged string. Generated
   * rather than hardcoded, because a hardcoded one silently rots the day the
   * fixture's bank code changes — and because a "looks plausible" IBAN fails
   * validation for the wrong reason and makes the test lie.
   */
  const OM_IBAN_LENGTH = 23; // IBAN_COUNTRY_RULES.OM
  const omIban = (bankCode: string, account = '0000012991234'): string => {
    // 23 total = "OM" + 2 check digits + 19 BBAN, of which the bank code
    // occupies positions 5-7 (the util's `bankCodeRange`).
    const bban = `${bankCode.padStart(3, '0')}${account}`
      .padEnd(OM_IBAN_LENGTH - 4, '0')
      .slice(0, OM_IBAN_LENGTH - 4);
    const rearranged = `${bban}OM00`;
    const numeric = rearranged
      .split('')
      .map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c))
      .join('');
    let remainder = 0;
    for (const digit of numeric) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
    const check = String(98 - remainder).padStart(2, '0');
    return `OM${check}${bban}`;
  };

  /**
   * A complete, valid payload for `FIN_COUNTRY`. The field schema is
   * configuration, not code — the baseline seeds `accountHolderName` as
   * required alongside `iban` — so a test that sends only an IBAN fails
   * validation for a reason that has nothing to do with what it is testing.
   */
  const bankData = (over: Record<string, string> = {}) => ({
    iban: omIban(fx.bankCode),
    accountHolderName: `E2E Holder ${fx.runId}`,
    ...over,
  });

  const principals = () => [
    ['admin', fx.admin] as const,
    ['hrGlobal', fx.hrGlobal] as const,
    ['hrScoped', fx.hrScoped] as const,
    ['manager', fx.manager] as const,
    ['employee', fx.employee] as const,
  ];

  /** Clears an employee's active detail so they become a migration candidate. */
  const clearBankDetails = (employeeId: string) =>
    ctx.prisma.employeeBankDetail.deleteMany({ where: { employeeId } });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Bank master ───────────────────────────────────────────────────────────
  describe('the bank master', () => {
    it('BNK-API-01 every signed-in role may READ the bank list', async () => {
      // Deliberately unscoped: `Bank` is global reference data. Scoping it by
      // branch would empty the bank picker for every branch that has no bank
      // rows of its own, which is all of them.
      for (const [label, who] of principals()) {
        const res = await ctx
          .http()
          .get(`/banks?country=${FIN_COUNTRY}`)
          .set(bearer(who.token));
        expectStatus(res, 200, label);
        expect(rowsOf(res).length).toBeGreaterThan(0);
      }
      expect((await ctx.http().get('/banks')).status).toBe(401);
    });

    it('BNK-API-02 activeOnly hides a deactivated bank from the picker but not from the admin list', async () => {
      const active = await ctx
        .http()
        .get(`/banks?country=${FIN_COUNTRY}&activeOnly=true`)
        .set(bearer(fx.admin.token));
      expectStatus(active, 200);
      expect(rowsOf(active).map((b) => b.id)).not.toContain(fx.inactiveBankId);

      const all = await ctx
        .http()
        .get(`/banks?country=${FIN_COUNTRY}`)
        .set(bearer(fx.admin.token));
      expect(rowsOf(all).map((b) => b.id)).toContain(fx.inactiveBankId);
    });

    it('BNK-API-03 writing the master is ADMIN alone — HR reads it and cannot change it', async () => {
      const create = () =>
        ctx.http().post('/banks').send({
          country: FIN_COUNTRY,
          name: `E2E Denied ${fx.runId}`,
        });

      for (const who of [fx.hrGlobal, fx.hrScoped, fx.manager, fx.employee]) {
        expectStatus(await create().set(bearer(who.token)), 403, who.email);
      }

      const asAdmin = await create().set(bearer(fx.admin.token));
      expectStatus(asAdmin, 201);
      await ctx.prisma.bank.delete({ where: { id: dataOf(asAdmin).id } });
    });

    it('BNK-API-04 a duplicate (country, name) is a 409 that names the clash', async () => {
      const name = `E2E Dup Bank ${fx.runId}`;
      const first = await ctx
        .http()
        .post('/banks')
        .set(bearer(fx.admin.token))
        .send({ country: FIN_COUNTRY, name });
      expectStatus(first, 201);
      try {
        const second = await ctx
          .http()
          .post('/banks')
          .set(bearer(fx.admin.token))
          .send({ country: FIN_COUNTRY, name });
        expectStatus(second, 409);
        expect(String(second.body.message)).toContain(name);

        // The same name in another country is a different bank.
        const elsewhere = await ctx
          .http()
          .post('/banks')
          .set(bearer(fx.admin.token))
          .send({ country: 'AE', name });
        expectStatus(elsewhere, 201);
        await ctx.prisma.bank.delete({ where: { id: dataOf(elsewhere).id } });
      } finally {
        await ctx.prisma.bank.delete({ where: { id: dataOf(first).id } });
      }
    });

    it('BNK-API-05 deactivating is reversible and never deletes — history must survive', async () => {
      const created = await ctx
        .http()
        .post('/banks')
        .set(bearer(fx.admin.token))
        .send({ country: FIN_COUNTRY, name: `E2E Toggle ${fx.runId}` });
      expectStatus(created, 201);
      const id = dataOf(created).id;
      try {
        expectStatus(
          await ctx
            .http()
            .patch(`/banks/${id}/deactivate`)
            .set(bearer(fx.admin.token)),
          200,
        );
        expect(
          (await ctx.prisma.bank.findUnique({ where: { id } }))!.isActive,
        ).toBe(false);

        expectStatus(
          await ctx
            .http()
            .patch(`/banks/${id}`)
            .set(bearer(fx.admin.token))
            .send({ isActive: true }),
          200,
        );
        expect(
          (await ctx.prisma.bank.findUnique({ where: { id } }))!.isActive,
        ).toBe(true);
      } finally {
        await ctx.prisma.bank.delete({ where: { id } });
      }
    });

    it('BNK-API-06 an unknown bank 404s with a sentence', async () => {
      const res = await ctx
        .http()
        .patch('/banks/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token))
        .send({ name: 'nope' });
      expectStatus(res, 404);
      expect(res.body.message).toBe('Bank not found');
    });
  });

  // ── Branch banking countries ──────────────────────────────────────────────
  describe('branch banking countries', () => {
    it('BNK-API-07 reading and writing are ADMIN/HR; MANAGER and EMPLOYEE are refused', async () => {
      for (const [label, who] of principals()) {
        const res = await ctx
          .http()
          .get('/banks/branch-countries')
          .set(bearer(who.token));
        const want = ['admin', 'hrGlobal', 'hrScoped'].includes(label)
          ? 200
          : 403;
        expectStatus(res, want, label);
      }
    });

    it('BNK-API-08 countries must be ISO-2, and the refusal says so', async () => {
      const res = await ctx
        .http()
        .put(`/banks/branch-countries/${fx.branchA}`)
        .set(bearer(fx.admin.token))
        .send({ countries: ['OMAN'] });
      expectStatus(res, 400);
      expect(res.body.message).toBe('Countries must be ISO-2 codes');
    });

    it('BNK-API-09 the allowed set drives which banks an employee may be given', async () => {
      // A bank in a country the branch does not allow must be refused — this
      // is what stops a UAE account being attached to an Omani wage file.
      await clearBankDetails(fx.earnerId);
      const res = await ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.earnerId,
          bankId: fx.foreignCountryBankId,
          data: bankData(),
        });
      expectStatus(res, 400);
      expect(String(res.body.message)).toContain(
        "not among the branch's allowed countries",
      );
    });

    it('BNK-API-10 an unknown branch 404s', async () => {
      const res = await ctx
        .http()
        .put('/banks/branch-countries/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token))
        .send({ countries: [FIN_COUNTRY] });
      expectStatus(res, 404);
      expect(res.body.message).toBe('Branch not found');
    });
  });

  // ── Banking field config ──────────────────────────────────────────────────
  describe('the banking field schema', () => {
    it('BNK-API-11 every role may READ the field schema; only ADMIN may write it', async () => {
      for (const [label, who] of principals()) {
        const read = await ctx
          .http()
          .get(`/banking-config/fields?country=${FIN_COUNTRY}`)
          .set(bearer(who.token));
        expectStatus(read, 200, `${label} read fields`);
      }

      for (const who of [fx.hrGlobal, fx.manager, fx.employee]) {
        const write = await ctx
          .http()
          .put('/banking-config')
          .set(bearer(who.token))
          .send({
            country: FIN_COUNTRY,
            fieldKey: 'denied',
            label: 'Denied',
          });
        expectStatus(write, 403, who.email);
      }
    });

    it('BNK-API-12 fields render in display order, and an inactive field is not rendered', async () => {
      const res = await ctx
        .http()
        .get(`/banking-config/fields?country=${FIN_COUNTRY}`)
        .set(bearer(fx.employee.token));
      expectStatus(res, 200);
      const orders = rowsOf(res).map((f) => f.displayOrder);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
      expect(rowsOf(res).every((f) => f.isActive !== false)).toBe(true);
    });

    it('BNK-API-13 the field key is constrained, and unknown enums are refused by name', async () => {
      // A complete, otherwise-valid payload per case, so each 400 is caused by
      // the one thing under test rather than by a missing sibling field.
      const base = {
        country: FIN_COUNTRY,
        label: 'E2E Field',
        fieldType: 'TEXT',
        validationType: 'NONE',
        required: false,
        displayOrder: 99,
      };
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ['bad key', { fieldKey: '9nope!' }, /alphanumeric\/underscore/i],
        [
          'unknown fieldType',
          { fieldKey: 'e2e_ok1', fieldType: 'COLOUR' },
          /Unknown fieldType/i,
        ],
        [
          'unknown validationType',
          { fieldKey: 'e2e_ok2', validationType: 'MAGIC' },
          /Unknown validationType/i,
        ],
      ];
      for (const [label, over, pattern] of cases) {
        const res = await ctx
          .http()
          .put('/banking-config')
          .set(bearer(fx.admin.token))
          .send({ ...base, ...over });
        expectStatus(res, 400, label);
        expect(String(res.body.message)).toMatch(pattern);
      }
    });

    it('BNK-API-14 a re-PUT upserts on (country, fieldKey) rather than duplicating', async () => {
      const fieldKey = `e2e_extra_${Date.now().toString(36)}`;
      const put = (label: string) =>
        ctx
          .http()
          .put('/banking-config')
          .set(bearer(fx.admin.token))
          .send({
            country: FIN_COUNTRY,
            fieldKey,
            label,
            fieldType: 'TEXT',
            validationType: 'NONE',
            required: false,
            displayOrder: 9,
          });
      expectStatus(await put('First'), 200);
      expectStatus(await put('Second'), 200);

      const rows = await ctx.prisma.countryBankingField.findMany({
        where: { country: FIN_COUNTRY, fieldKey },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].label).toBe('Second');

      await ctx.prisma.countryBankingField.delete({ where: { id: rows[0].id } });
    });
  });

  // ── Migration candidates ──────────────────────────────────────────────────
  describe('migration candidates', () => {
    it('BNK-API-15 the candidate list is ADMIN/HR only', async () => {
      for (const [label, who] of principals()) {
        const res = await ctx
          .http()
          .get('/bank-change-requests/migration/candidates')
          .set(bearer(who.token));
        const want = ['admin', 'hrGlobal', 'hrScoped'].includes(label)
          ? 200
          : 403;
        expectStatus(res, want, label);
      }
    });

    it('BNK-API-16 an employee with an active detail is no longer a candidate', async () => {
      await clearBankDetails(fx.earnerId);
      await ctx.prisma.employeeProfile.upsert({
        where: { employeeId: fx.earnerId },
        create: { employeeId: fx.earnerId, bankName: 'Legacy Bank plc' },
        update: { bankName: 'Legacy Bank plc' },
      });

      const before = await ctx
        .http()
        .get('/bank-change-requests/migration/candidates')
        .set(bearer(fx.admin.token));
      expectStatus(before, 200);
      expect(rowsOf(before).map((c) => c.id)).toContain(fx.earnerId);

      const migrate = await ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.earnerId,
          bankId: fx.bankId,
          data: bankData(),
        });
      expectStatus(migrate, [200, 201]);

      const after = await ctx
        .http()
        .get('/bank-change-requests/migration/candidates')
        .set(bearer(fx.admin.token));
      expect(rowsOf(after).map((c) => c.id)).not.toContain(fx.earnerId);
    });

    it('BNK-API-17 a scoped HR sees only its own branch’s candidates', async () => {
      await clearBankDetails(fx.foreignId);
      await ctx.prisma.employeeProfile.upsert({
        where: { employeeId: fx.foreignId },
        create: { employeeId: fx.foreignId, bankName: 'Legacy Bank plc' },
        update: { bankName: 'Legacy Bank plc' },
      });

      const scoped = await ctx
        .http()
        .get('/bank-change-requests/migration/candidates')
        .set(bearer(fx.hrScoped.token));
      expectStatus(scoped, 200);
      expect(rowsOf(scoped).map((c) => c.id)).not.toContain(fx.foreignId);

      const global = await ctx
        .http()
        .get('/bank-change-requests/migration/candidates')
        .set(bearer(fx.hrGlobal.token));
      expect(rowsOf(global).map((c) => c.id)).toContain(fx.foreignId);
    });
  });

  // ── Migrating ─────────────────────────────────────────────────────────────
  describe('migrating a detail', () => {
    it('BNK-API-18 a migration writes exactly one active detail, stamped MIGRATION', async () => {
      await clearBankDetails(fx.newJoinerId);
      const res = await ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.newJoinerId,
          bankId: fx.bankId,
          data: bankData(),
        });
      expectStatus(res, [200, 201]);

      const details = await ctx.prisma.employeeBankDetail.findMany({
        where: { employeeId: fx.newJoinerId },
      });
      const active = details.filter((d) => d.isActive);
      expect(active).toHaveLength(1);
      expect(active[0].source).toBe('MIGRATION');
      // Stamped with the employee's branch so the row is reachable by the same
      // scoping every other employee-owned model uses.
      expect(active[0].branchId).toBeTruthy();
    });

    it('BNK-API-19 migrating again deactivates the previous detail rather than deleting it', async () => {
      await clearBankDetails(fx.newJoinerId);
      const send = (account: string) =>
        ctx
          .http()
          .post('/bank-change-requests/migration')
          .set(bearer(fx.admin.token))
          .send({
            employeeId: fx.newJoinerId,
            bankId: fx.bankId,
            data: bankData({ iban: omIban(fx.bankCode, account) }),
          });
      expectStatus(await send('0000012991234'), [200, 201]);
      expectStatus(await send('0000012991235'), [200, 201]);

      const details = await ctx.prisma.employeeBankDetail.findMany({
        where: { employeeId: fx.newJoinerId },
      });
      // History is preserved — payroll runs that already referenced the old row
      // must still resolve it.
      expect(details.length).toBe(2);
      expect(details.filter((d) => d.isActive)).toHaveLength(1);
    });

    it('BNK-API-20 an inactive bank is refused', async () => {
      await clearBankDetails(fx.newJoinerId);
      const res = await ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.newJoinerId,
          bankId: fx.inactiveBankId,
          data: bankData({ iban: omIban('046') }),
        });
      expectStatus(res, 400);
      expect(res.body.message).toBe('Selected bank not found or inactive');
    });

    it('BNK-API-21 a scoped HR cannot migrate an employee in another branch', async () => {
      await clearBankDetails(fx.foreignId);
      const res = await ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(fx.hrScoped.token))
        .send({
          employeeId: fx.foreignId,
          bankId: fx.bankId,
          data: bankData(),
        });
      expectStatus(res, 404);
    });

    it('BNK-API-22 MANAGER and EMPLOYEE cannot migrate at all', async () => {
      for (const who of [fx.manager, fx.employee]) {
        const res = await ctx
          .http()
          .post('/bank-change-requests/migration')
          .set(bearer(who.token))
          .send({
            employeeId: fx.earnerId,
            bankId: fx.bankId,
            data: bankData(),
          });
        expectStatus(res, 403, who.email);
      }
    });
  });

  // ── IBAN validation ───────────────────────────────────────────────────────
  describe('IBAN validation', () => {
    const migrate = (data: Record<string, string>) =>
      ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(fx.admin.token))
        .send({ employeeId: fx.newJoinerId, bankId: fx.bankId, data });

    beforeEach(async () => {
      await clearBankDetails(fx.newJoinerId);
    });

    it('BNK-API-23 a structurally valid IBAN whose bank code matches is accepted', async () => {
      expectStatus(await migrate(bankData({ iban: omIban(fx.bankCode) })), [200, 201]);
    });

    it('BNK-API-24 a single mistyped digit is refused — the checksum, not merely the length', async () => {
      // The defect this guards: `validateIban` was dead code and the live path
      // checked format, prefix and length only. One wrong digit passed, and the
      // bank rejects the ENTIRE wage file, not just the offending row.
      const good = omIban(fx.bankCode);
      const last = good.slice(-1);
      const bad = good.slice(0, -1) + (last === '0' ? '1' : '0');

      const res = await migrate(bankData({ iban: bad }));
      expectStatus(res, 400);
      expect(body(res)).toMatch(/check digit|invalid|mistyped/i);
    });

    it('BNK-API-25 a transposition is caught, which a length check cannot see', async () => {
      const good = omIban(fx.bankCode);
      const swapped =
        good.slice(0, -2) + good.slice(-1) + good.slice(-2, -1);
      if (swapped === good) return; // last two characters identical; nothing to swap
      const res = await migrate(bankData({ iban: swapped }));
      expectStatus(res, 400);
    });

    it('BNK-API-26 the wrong length is reported ahead of the checksum, because it is more actionable', async () => {
      const res = await migrate(bankData({ iban: omIban(fx.bankCode).slice(0, 20) }));
      expectStatus(res, 400);
      expect(body(res)).toMatch(/23 characters|length/i);
    });

    it('BNK-API-27 an IBAN whose embedded bank code names a different bank is refused', async () => {
      // Structurally perfect, checksum correct, and routed to the wrong bank.
      // Only the cross-check catches this one.
      const res = await migrate(bankData({ iban: omIban('046') }));
      expectStatus(res, 400);
      expect(body(res)).toMatch(/bank code/i);
    });

    it('BNK-API-28 a missing required field is refused, and the error names the field', async () => {
      const res = await migrate({ accountName: 'E2E Only', accountHolderName: 'E2E Holder' });
      expectStatus(res, 400);
      // The structured shape the screen renders per-field, not a flat string.
      expect(res.body.message ?? '').toBeTruthy();
      expect(body(res)).toMatch(/iban/i);
    });
  });

  // ── The payroll and WPS locks ─────────────────────────────────────────────
  describe('the edit locks', () => {
    let payrollId: string | null = null;

    const openPayrollFor = async (employeeId: string) => {
      const now = new Date();
      const payroll = await ctx.prisma.payroll.create({
        data: {
          month: now.getMonth() + 1,
          year: now.getFullYear() + 5, // clear of any real run
          status: 'DRAFT',
          branchId: fx.branchA,
        },
      });
      await ctx.prisma.payrollItem.create({
        data: {
          payrollId: payroll.id,
          employeeId,
          baseSalary: 1000,
          workDays: 30,
          actualWorkDays: 30,
          netSalary: 1000,
        },
      });
      payrollId = payroll.id;
      return payroll.id;
    };

    afterEach(async () => {
      if (payrollId) {
        await ctx.prisma.payrollItem.deleteMany({ where: { payrollId } });
        await ctx.prisma.payroll.delete({ where: { id: payrollId } }).catch(() => undefined);
        payrollId = null;
      }
    });

    it('BNK-API-29 a FIRST-TIME migration is allowed while a payroll run is in flight', async () => {
      // The carve-out. Every employee the migration screen lists has no active
      // detail, so an unconditional lock would deadlock bank onboarding for the
      // whole company behind one open run — while protecting nothing, because a
      // run built when the employee had no account on file cannot be "kept
      // paying the account it was built with".
      await clearBankDetails(fx.newJoinerId);
      await openPayrollFor(fx.newJoinerId);

      const res = await ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.newJoinerId,
          bankId: fx.bankId,
          data: bankData(),
        });
      expectStatus(res, [200, 201]);
      const active = await ctx.prisma.employeeBankDetail.findMany({
        where: { employeeId: fx.newJoinerId, isActive: true },
      });
      expect(active).toHaveLength(1);
      expect(active[0].source).toBe('MIGRATION');
    });

    it('BNK-API-30 the SAME call is refused once it would OVERWRITE an existing detail', async () => {
      await clearBankDetails(fx.newJoinerId);
      // Give them a detail first, with no run open.
      expectStatus(
        await ctx
          .http()
          .post('/bank-change-requests/migration')
          .set(bearer(fx.admin.token))
          .send({
            employeeId: fx.newJoinerId,
            bankId: fx.bankId,
            data: bankData(),
          }),
        [200, 201],
      );

      await openPayrollFor(fx.newJoinerId);

      const res = await ctx
        .http()
        .post('/bank-change-requests/migration')
        .set(bearer(fx.admin.token))
        .send({
          employeeId: fx.newJoinerId,
          bankId: fx.bankId,
          data: bankData({ iban: omIban(fx.bankCode, '0000012991239') }),
        });
      expectStatus(res, 409);
      expect(res.body.message).toBe(
        'Bank details are locked while a payroll run is in progress',
      );
    });

    it('BNK-API-31 the request path keeps its unconditional lock', async () => {
      // `POST /bank-change-requests` predates the carve-out and does not share
      // it: a self-service change while a run is open is refused outright.
      await clearBankDetails(fx.earnerId);
      await openPayrollFor(fx.earnerId);

      const res = await ctx
        .http()
        .post('/bank-change-requests')
        .set(bearer(fx.employee.token))
        .send({
          bankId: fx.bankId,
          data: bankData(),
        });
      expectStatus(res, 409);
      expect(res.body.message).toBe(
        'Bank details are locked while a payroll run is in progress',
      );
    });
  });

  // ── The change-request lifecycle ──────────────────────────────────────────
  describe('the bank change request', () => {
    const raise = async (token: string, over: Record<string, unknown> = {}) =>
      ctx
        .http()
        .post('/bank-change-requests')
        .set(bearer(token))
        .send({
          bankId: fx.bankId,
          data: bankData(),
          ...over,
        });

    /**
     * A configured chain, so a request can actually sit PENDING. Without one
     * the engine reports `engaged: false` and the service applies the change on
     * the spot (BNK-API-32) — which makes every lifecycle case below untestable.
     */
    let workflowId: string | null = null;

    it('BNK-API-32 with no chain configured, a self-service change APPLIES IMMEDIATELY', async () => {
      // The bank-change precedent, and the one Travel copied: `!engaged` means
      // "nothing governs this, so do it now". It is deliberate — a site that
      // has not configured an approval chain has not asked for one — but it
      // means the default install lets an employee redirect their own salary
      // without review. Asserted so the default is a decision rather than a
      // surprise, and so a change to it is visible here.
      //
      // Runs BEFORE the chain below is configured; Jest executes `it` blocks in
      // declaration order and `beforeAll` for the chain is registered after it.
      await clearBankDetails(fx.earnerId);
      await ctx.prisma.bankChangeRequest.deleteMany({
        where: { employeeId: fx.earnerId },
      });
      const res = await raise(fx.employee.token);
      expectStatus(res, 201);

      const row = await ctx.prisma.bankChangeRequest.findFirstOrThrow({
        where: { employeeId: fx.earnerId },
      });
      expect(row.status).toBe('APPROVED');
      const active = await ctx.prisma.employeeBankDetail.findMany({
        where: { employeeId: fx.earnerId, isActive: true },
      });
      expect(active).toHaveLength(1);
      expect(active[0].source).toBe('APPROVAL');
    });

    const configureChain = async () => {
      const wf = await ctx
        .http()
        .put('/approval-workflows')
        .set(bearer(fx.admin.token))
        .send({
          requestType: 'BANK_CHANGE',
          name: `wf-bank-${fx.runId}`,
          steps: [{ approverType: 'HR_MANAGER' }],
        });
      expectStatus(wf, [200, 201]);
      workflowId = dataOf(wf)?.id ?? null;

      await ctx
        .http()
        .post('/system-settings')
        .set(bearer(fx.admin.token))
        .send({ settings: { supervisor_approval_enabled: 'true' } });
    };

    afterAll(async () => {
      // The switch is global and `maxWorkers: 1` shares it with every suite
      // that runs after this one. Put it back exactly as the baseline pins it.
      await ctx
        .http()
        .post('/system-settings')
        .set(bearer(fx.admin.token))
        .send({ settings: { supervisor_approval_enabled: 'false' } });
      if (workflowId) {
        await ctx.prisma.approvalStep
          .deleteMany({ where: { workflowId } })
          .catch(() => undefined);
        await ctx.prisma.approvalWorkflow
          .delete({ where: { id: workflowId } })
          .catch(() => undefined);
      }
    });

    beforeEach(async () => {
      await ctx.prisma.requestApproval.deleteMany({
        where: { requestType: 'BANK_CHANGE' },
      });
      await ctx.prisma.bankChangeRequest.deleteMany({
        where: { employeeId: { in: [fx.earnerId, fx.foreignId] } },
      });
      await clearBankDetails(fx.earnerId);
    });

    it('BNK-API-32b once a chain IS configured, the same request waits', async () => {
      await configureChain();
      const res = await raise(fx.employee.token);
      expectStatus(res, 201);

      const row = await ctx.prisma.bankChangeRequest.findFirstOrThrow({
        where: { employeeId: fx.earnerId },
      });
      expect(row.status).toBe('PENDING');
      // Nothing is written until the chain finishes — the whole point.
      expect(
        await ctx.prisma.employeeBankDetail.findMany({
          where: { employeeId: fx.earnerId, isActive: true },
        }),
      ).toEqual([]);

      // ...and the trail materialised, one row per configured step.
      const trail = await ctx.prisma.requestApproval.findMany({
        where: { requestType: 'BANK_CHANGE', requestId: row.id },
      });
      expect(trail.length).toBe(1);
      expect(trail[0].status).toBe('ACTIVE');
    });

    it('BNK-API-33 an employee cannot raise one for somebody else', async () => {
      const res = await raise(fx.employee.token, {
        employeeId: fx.newJoinerId,
      });
      expectStatus(res, 403);
      expect(res.body.message).toBe('You may only change your own bank details');
    });

    it('BNK-API-34 only one request may be open per employee', async () => {
      expectStatus(await raise(fx.employee.token), 201);
      const second = await raise(fx.employee.token);
      expectStatus(second, 409);
      expect(String(second.body.message)).toContain(
        'already pending for this employee',
      );
    });

    it('BNK-API-35 approval writes exactly ONE active detail and closes the request', async () => {
      await clearBankDetails(fx.earnerId);
      const created = await raise(fx.employee.token);
      expectStatus(created, 201);
      const id = (
        await ctx.prisma.bankChangeRequest.findFirstOrThrow({
          where: { employeeId: fx.earnerId },
        })
      ).id;

      const approve = await ctx
        .http()
        .post(`/bank-change-requests/${id}/approve`)
        .set(bearer(fx.admin.token))
        .send({ comment: 'verified against the passbook' });
      expectStatus(approve, [200, 201]);

      const active = await ctx.prisma.employeeBankDetail.findMany({
        where: { employeeId: fx.earnerId, isActive: true },
      });
      expect(active).toHaveLength(1);
      // Approved details are stamped APPROVAL, not MIGRATION — the two paths
      // stay distinguishable in an audit.
      expect(active[0].source).toBe('APPROVAL');
      expect(
        (await ctx.prisma.bankChangeRequest.findUnique({ where: { id } }))!
          .status,
      ).toBe('APPROVED');
    });

    it('BNK-API-36 rejection writes no detail at all', async () => {
      await clearBankDetails(fx.earnerId);
      expectStatus(await raise(fx.employee.token), 201);
      const id = (
        await ctx.prisma.bankChangeRequest.findFirstOrThrow({
          where: { employeeId: fx.earnerId },
        })
      ).id;

      expectStatus(
        await ctx
          .http()
          .post(`/bank-change-requests/${id}/reject`)
          .set(bearer(fx.admin.token))
          .send({ comment: 'IBAN does not match the passbook' }),
        [200, 201],
      );
      expect(
        await ctx.prisma.employeeBankDetail.findMany({
          where: { employeeId: fx.earnerId, isActive: true },
        }),
      ).toEqual([]);
    });

    it('BNK-API-37 a MANAGER cannot decide a bank change', async () => {
      expectStatus(await raise(fx.employee.token), 201);
      const id = (
        await ctx.prisma.bankChangeRequest.findFirstOrThrow({
          where: { employeeId: fx.earnerId },
        })
      ).id;
      const res = await ctx
        .http()
        .post(`/bank-change-requests/${id}/approve`)
        .set(bearer(fx.manager.token))
        .send({});
      expectStatus(res, 403);
      // With a chain engaged the refusal comes from the ENGINE (the manager is
      // not the resolved approver for the active step); with no chain it comes
      // from the service's own role check. Both are specific sentences, and
      // which one fires depends on configuration rather than on the rule.
      expect(String(res.body.message)).toMatch(
        /eligible approver for the current step|Not permitted to decide this request/,
      );
    });

    it('BNK-API-38 a settled request cannot be decided or cancelled again', async () => {
      expectStatus(await raise(fx.employee.token), 201);
      const id = (
        await ctx.prisma.bankChangeRequest.findFirstOrThrow({
          where: { employeeId: fx.earnerId },
        })
      ).id;
      await ctx
        .http()
        .post(`/bank-change-requests/${id}/reject`)
        .set(bearer(fx.admin.token))
        .send({});

      const decide = await ctx
        .http()
        .post(`/bank-change-requests/${id}/approve`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(decide, 400);
      expect(String(decide.body.message)).toContain('Cannot decide a rejected');

      const cancel = await ctx
        .http()
        .post(`/bank-change-requests/${id}/cancel`)
        .set(bearer(fx.employee.token));
      expectStatus(cancel, 400);
      expect(cancel.body.message).toBe(
        'Only a pending request can be cancelled',
      );
    });

    it('BNK-API-39 the list masks account values, and narrows to self for a non-approver', async () => {
      expectStatus(await raise(fx.employee.token), 201);

      const asEmployee = await ctx
        .http()
        .get('/bank-change-requests')
        .set(bearer(fx.employee.token));
      expectStatus(asEmployee, 200);
      const foreign = rowsOf(asEmployee).filter(
        (r) => r.employeeId !== fx.earnerId,
      );
      expect(foreign).toEqual([]);

      // Payment details are PII: the list carries the fact of a change, never
      // the account it points at.
      const serialized = JSON.stringify(rowsOf(asEmployee));
      expect(serialized).not.toContain(omIban(fx.bankCode));
    });

    it('BNK-API-40 F4 — a stranger cannot read another employee’s request', async () => {
      // `@Roles` admits all four roles and the service used to perform no
      // owner check. Values are masked, so this was a metadata leak rather than
      // an account leak — existence, employee, bank name and status — but the
      // envelope is nobody else's business either.
      expectStatus(await raise(fx.employee.token), 201);
      const id = (
        await ctx.prisma.bankChangeRequest.findFirstOrThrow({
          where: { employeeId: fx.earnerId },
        })
      ).id;

      const stranger = await ctx
        .http()
        .get(`/bank-change-requests/${id}`)
        .set(bearer(fx.auditor.token));
      expectStatus(stranger, 403);

      // The owner and the administrators still read it.
      for (const who of [fx.employee, fx.admin, fx.hrGlobal]) {
        const ok = await ctx
          .http()
          .get(`/bank-change-requests/${id}`)
          .set(bearer(who.token));
        expectStatus(ok, 200, who.email);
        expect(dataOf(ok).id).toBe(id);
      }
    });

  });

  // ── Refusals and audit ────────────────────────────────────────────────────
  describe('every refusal explains itself', () => {
    const GENERIC =
      /^(bad request|forbidden|not found|conflict|error|internal server error)$/i;

    it('BNK-API-41 every reachable refusal carries a specific sentence', async () => {
      await clearBankDetails(fx.newJoinerId);

      const probes: Array<[string, () => Promise<any>]> = [
        [
          'inactive bank',
          () =>
            ctx
              .http()
              .post('/bank-change-requests/migration')
              .set(bearer(fx.admin.token))
              .send({
                employeeId: fx.newJoinerId,
                bankId: fx.inactiveBankId,
                data: bankData({ iban: omIban('046') }),
              }),
        ],
        [
          'bank in a disallowed country',
          () =>
            ctx
              .http()
              .post('/bank-change-requests/migration')
              .set(bearer(fx.admin.token))
              .send({
                employeeId: fx.newJoinerId,
                bankId: fx.foreignCountryBankId,
                data: bankData(),
              }),
        ],
        [
          'unknown employee',
          () =>
            ctx
              .http()
              .post('/bank-change-requests/migration')
              .set(bearer(fx.admin.token))
              .send({
                employeeId: '00000000-0000-0000-0000-000000000000',
                bankId: fx.bankId,
                data: bankData(),
              }),
        ],
        [
          'unknown bank',
          () =>
            ctx
              .http()
              .patch('/banks/00000000-0000-0000-0000-000000000000')
              .set(bearer(fx.admin.token))
              .send({ name: 'nope' }),
        ],
        [
          'non ISO-2 country',
          () =>
            ctx
              .http()
              .put(`/banks/branch-countries/${fx.branchA}`)
              .set(bearer(fx.admin.token))
              .send({ countries: ['OMAN'] }),
        ],
        [
          'unknown request id',
          () =>
            ctx
              .http()
              .get('/bank-change-requests/00000000-0000-0000-0000-000000000000')
              .set(bearer(fx.admin.token)),
        ],
      ];

      const offenders: string[] = [];
      for (const [label, call] of probes) {
        const res = await call();
        if (res.status < 400) {
          throw new Error(`${label} did not refuse: ${body(res)}`);
        }
        const message = Array.isArray(res.body?.message)
          ? res.body.message.join('; ')
          : res.body?.message;
        if (!message || String(message).trim().length < 10) {
          offenders.push(`${label}: empty or too short (${message})`);
        } else if (GENERIC.test(String(message).trim())) {
          offenders.push(`${label}: generic (${message})`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('BNK-API-42 a migration is audited, and the audit does NOT carry the account number', async () => {
      await clearBankDetails(fx.newJoinerId);
      const iban = omIban(fx.bankCode);
      expectStatus(
        await ctx
          .http()
          .post('/bank-change-requests/migration')
          .set(bearer(fx.admin.token))
          .send({
            employeeId: fx.newJoinerId,
            bankId: fx.bankId,
            data: bankData({ iban }),
          }),
        [200, 201],
      );

      const rows = await ctx.prisma.auditLog.findMany({
        where: {
          action: 'BANK_DETAIL_MIGRATED',
          resourceId: fx.newJoinerId,
        },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => !!r.userId)).toBe(true);
      // An audit trail that records the full account number is a second copy
      // of the thing the masking exists to protect.
      expect(JSON.stringify(rows.map((r) => r.newData))).not.toContain(iban);
    });
  });
});
