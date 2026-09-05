import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollFixtures,
  PayrollFixtures,
  SANDBOX_COUNTRY,
  bearer,
} from './utils/payroll-fixtures';

/**
 * Bank Master, the per-country field schema, and branch banking countries —
 * Phase 4, chunk C6.
 *
 * Three surfaces that together decide which bank details an employee may hold:
 *
 *  - **`/banks`** — company-wide reference data keyed by country. Deliberately
 *    NOT branch-scoped; a bank is a bank wherever you bank with it. Readable by
 *    everyone (the bank-change form needs the list), writable by ADMIN alone.
 *  - **`/banking-config`** — the per-country FIELD schema that drives both form
 *    rendering and server-side validation. ADMIN-only to write.
 *  - **`/banks/branch-countries`** — which countries a branch's staff may bank
 *    in. Also deliberately unscoped: it manages every branch, including ones the
 *    caller cannot otherwise see.
 *
 * The shipped IN and OM field schemas are SHARED with `bank-change`,
 * `banking-config` and `wps-flow`, so every destructive field-config case here
 * uses the sandbox country instead of disturbing them.
 */
describe('Bank Master and banking configuration (e2e)', () => {
  let ctx: E2EContext;
  let fx: PayrollFixtures;

  const api = () => ctx.http();
  const as = (token: string, req: any, branchId?: string | null) => {
    req.set(bearer(token));
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };
  const asAdmin = (req: any, branchId: string | null = fx.branchA) =>
    as(fx.admin.token, req, branchId);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollFixtures(ctx);
  }, 120_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── BM-API-01..10  /banks ────────────────────────────────────────────────
  describe('BM-API-01..10 — the bank master', () => {
    let createdId: string;

    it('BM-API-01: an ADMIN adds a bank', async () => {
      const res = await asAdmin(api().post('/banks')).send({
        country: 'IN',
        name: `New Bank ${fx.runId}`,
        bankCode: 'NBK',
        swift: 'NBKIINBB',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.isActive).toBe(true);
      createdId = res.body.data.id;
    });

    it('BM-API-02: the country code is normalised to upper case', async () => {
      const res = await asAdmin(api().post('/banks')).send({
        country: 'in',
        name: `Lowercase Country Bank ${fx.runId}`,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.country).toBe('IN');
    });

    it('BM-API-03: a duplicate (country, name) is 409', async () => {
      const res = await asAdmin(api().post('/banks')).send({
        country: 'IN',
        name: `New Bank ${fx.runId}`,
      });
      expect(res.status).toBe(409);
    });

    it('BM-API-04: the SAME name in another country is allowed', async () => {
      const res = await asAdmin(api().post('/banks')).send({
        country: 'OM',
        name: `New Bank ${fx.runId}`,
      });
      expect(res.status).toBe(201);
    });

    it.each([
      ['a three-letter country', { country: 'IND', name: 'X' }],
      ['a numeric country', { country: '12', name: 'X' }],
      ['a missing name', { country: 'IN' }],
      ['an empty name', { country: 'IN', name: '' }],
      ['a too-short swift', { country: 'IN', name: 'X', swift: 'ABC' }],
      ['a too-long swift', { country: 'IN', name: 'X', swift: 'A'.repeat(12) }],
      ['an unknown key', { country: 'IN', name: 'X', website: 'http://x' }],
    ])('BM-API-05: refuses %s', async (_l, body) => {
      const res = await asAdmin(api().post('/banks')).send(body);
      expect(res.status).toBe(400);
    });

    it('BM-API-06: the list filters by country and by activeOnly', async () => {
      const inRes = await asAdmin(api().get('/banks?country=IN'));
      expect(inRes.status).toBe(200);
      for (const b of inRes.body.data) expect(b.country).toBe('IN');

      const activeOnly = await asAdmin(
        api().get('/banks?country=IN&activeOnly=true'),
      );
      const ids = activeOnly.body.data.map((b: any) => b.id);
      expect(ids).not.toContain(fx.bankInactiveId);
      expect(ids).toContain(fx.bankInId);

      const all = await asAdmin(api().get('/banks?country=IN'));
      expect(all.body.data.map((b: any) => b.id)).toContain(fx.bankInactiveId);
    });

    it('BM-API-07: a country with no banks is an empty list, not an error', async () => {
      const res = await asAdmin(api().get(`/banks?country=${SANDBOX_COUNTRY}`));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('BM-API-08: deactivate and reactivate round-trip', async () => {
      const off = await asAdmin(api().patch(`/banks/${createdId}/deactivate`));
      expect(off.status).toBe(200);
      expect(
        (await ctx.prisma.bank.findUnique({ where: { id: createdId } }))!
          .isActive,
      ).toBe(false);

      const on = await asAdmin(api().patch(`/banks/${createdId}`)).send({
        isActive: true,
      });
      expect(on.status).toBe(200);
      expect(
        (await ctx.prisma.bank.findUnique({ where: { id: createdId } }))!
          .isActive,
      ).toBe(true);
    });

    it('BM-API-09: writes are ADMIN-only; reads are open to every role', async () => {
      for (const [label, token] of [
        ['HR', fx.hr.token],
        ['MANAGER', fx.deptManager.token],
        ['EMPLOYEE', fx.employee.token],
      ] as const) {
        const read = await as(token, api().get('/banks?country=IN'));
        expect(read.status).toBe(200);
        expect(label).toBeTruthy();

        const write = await as(token, api().post('/banks')).send({
          country: 'IN',
          name: `Sneaky ${label} ${fx.runId}`,
        });
        expect(write.status).toBe(403);

        const patch = await as(token, api().patch(`/banks/${createdId}`)).send({
          name: 'renamed',
        });
        expect(patch.status).toBe(403);
      }
    });

    it('BM-API-10: an anonymous caller is 401', async () => {
      expect((await api().get('/banks')).status).toBe(401);
      expect(
        (await api().post('/banks').send({ country: 'IN', name: 'x' })).status,
      ).toBe(401);
    });
  });

  // ── BM-API-11..20  /banking-config ───────────────────────────────────────
  describe('BM-API-11..20 — the per-country field schema', () => {
    let fieldId: string;

    it('BM-API-11: an ADMIN defines a field for a country', async () => {
      const res = await asAdmin(api().put('/banking-config')).send({
        country: SANDBOX_COUNTRY,
        fieldKey: 'accountNumber',
        label: 'Account Number',
        validationType: 'NUMBER',
        required: true,
        displayOrder: 2,
        isSensitive: true,
      });
      expect(res.status).toBe(200);
      fieldId = res.body.data.id;
    });

    it('BM-API-12: PUT is an upsert on (country, fieldKey), not a duplicate', async () => {
      const res = await asAdmin(api().put('/banking-config')).send({
        country: SANDBOX_COUNTRY,
        fieldKey: 'accountNumber',
        label: 'Account No.',
        validationType: 'NUMBER',
        required: false,
        displayOrder: 2,
      });
      expect(res.status).toBe(200);

      const rows = await ctx.prisma.countryBankingField.count({
        where: { country: SANDBOX_COUNTRY, fieldKey: 'accountNumber' },
      });
      expect(rows).toBe(1);
      expect(res.body.data.label).toBe('Account No.');
      expect(res.body.data.required).toBe(false);
    });

    it('BM-API-13: fields come back in displayOrder', async () => {
      await asAdmin(api().put('/banking-config')).send({
        country: SANDBOX_COUNTRY,
        fieldKey: 'accountHolderName',
        label: 'Account Holder Name',
        validationType: 'NONE',
        required: true,
        displayOrder: 1,
        isSensitive: false,
      });

      const res = await asAdmin(
        api().get(`/banking-config/fields?country=${SANDBOX_COUNTRY}`),
      );
      expect(res.status).toBe(200);
      const orders = res.body.data.map((f: any) => f.displayOrder);
      expect(orders).toEqual([...orders].sort((a: number, b: number) => a - b));
      expect(res.body.data[0].fieldKey).toBe('accountHolderName');
    });

    it.each(['NONE', 'IBAN', 'IFSC', 'SWIFT', 'SORT_CODE', 'ROUTING', 'NUMBER'])(
      'BM-API-14: accepts validationType %s',
      async (validationType) => {
        const res = await asAdmin(api().put('/banking-config')).send({
          country: SANDBOX_COUNTRY,
          fieldKey: `probe_${validationType.toLowerCase()}`,
          label: `Probe ${validationType}`,
          validationType,
          displayOrder: 9,
        });
        expect(res.status).toBe(200);
      },
    );

    it('BM-API-15: refuses an unknown validationType and a malformed country', async () => {
      const badType = await asAdmin(api().put('/banking-config')).send({
        country: SANDBOX_COUNTRY,
        fieldKey: 'x',
        label: 'X',
        validationType: 'MAGIC',
      });
      expect(badType.status).toBe(400);

      const badCountry = await asAdmin(api().put('/banking-config')).send({
        country: 'XYZ',
        fieldKey: 'x',
        label: 'X',
        validationType: 'NONE',
      });
      expect(badCountry.status).toBe(400);
    });

    it('BM-API-16: an inactive field is hidden from the form but kept in the admin list', async () => {
      // The form-rendering door and the administration door are different views
      // on purpose: retiring a field must not erase the config that explains
      // details already captured with it.
      await asAdmin(api().put('/banking-config')).send({
        country: SANDBOX_COUNTRY,
        fieldKey: 'accountNumber',
        label: 'Account No.',
        validationType: 'NUMBER',
        displayOrder: 2,
        isActive: false,
      });

      const form = await asAdmin(
        api().get(`/banking-config/fields?country=${SANDBOX_COUNTRY}`),
      );
      expect(form.body.data.map((f: any) => f.fieldKey)).not.toContain(
        'accountNumber',
      );

      const admin = await asAdmin(
        api().get(`/banking-config?country=${SANDBOX_COUNTRY}`),
      );
      expect(admin.body.data.map((f: any) => f.fieldKey)).toContain(
        'accountNumber',
      );
    });

    it('BM-API-17: a field can be deleted', async () => {
      const res = await asAdmin(api().delete(`/banking-config/${fieldId}`));
      expect(res.status).toBe(200);
      expect(
        await ctx.prisma.countryBankingField.count({ where: { id: fieldId } }),
      ).toBe(0);
    });

    it('BM-API-18: field-schema writes are ADMIN-only; the form door is open to all', async () => {
      for (const token of [
        fx.hr.token,
        fx.deptManager.token,
        fx.employee.token,
      ]) {
        const read = await as(
          token,
          api().get(`/banking-config/fields?country=${SANDBOX_COUNTRY}`),
        );
        expect(read.status).toBe(200);

        const write = await as(token, api().put('/banking-config')).send({
          country: SANDBOX_COUNTRY,
          fieldKey: 'sneaky',
          label: 'Sneaky',
          validationType: 'NONE',
        });
        expect(write.status).toBe(403);
      }

      // The admin LIST is one step narrower than the form door.
      const hrList = await as(
        fx.hr.token,
        api().get(`/banking-config?country=${SANDBOX_COUNTRY}`),
      );
      expect(hrList.status).toBe(200);
      const empList = await as(
        fx.employee.token,
        api().get(`/banking-config?country=${SANDBOX_COUNTRY}`),
      );
      expect(empList.status).toBe(403);
    });

    it('BM-API-19: the seed is idempotent', async () => {
      const before = await ctx.prisma.countryBankingField.count();
      const first = await asAdmin(api().post('/banking-config/seed'));
      expect(first.status).toBe(201);
      const middle = await ctx.prisma.countryBankingField.count();
      const second = await asAdmin(api().post('/banking-config/seed'));
      expect(second.status).toBe(201);
      const after = await ctx.prisma.countryBankingField.count();
      expect(after).toBe(middle);
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('BM-API-20: a country with no schema answers with an empty field list', async () => {
      const res = await asAdmin(api().get('/banking-config/fields?country=ZW'));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ── BM-API-21..26  Branch banking countries ──────────────────────────────
  describe('BM-API-21..26 — branch banking countries', () => {
    it('BM-API-21: lists every branch with its allowed countries', async () => {
      const res = await asAdmin(api().get('/banks/branch-countries'));
      expect(res.status).toBe(200);
      const om = res.body.data.find((b: any) => b.id === fx.branchOm);
      expect(om.countries ?? om.bankingCountries).toContain('OM');
    });

    it('BM-API-22: a PUT normalises to ISO-2 and replaces the set', async () => {
      const res = await asAdmin(
        api().put(`/banks/branch-countries/${fx.branchB}`),
      ).send({ countries: ['in', 'AE'] });
      expect(res.status).toBe(200);

      const row = await ctx.prisma.branch.findUnique({
        where: { id: fx.branchB },
      });
      expect(row!.bankingCountries.sort()).toEqual(['AE', 'IN']);
    });

    it('BM-API-23: an all-invalid list is refused, and the old set survives', async () => {
      const res = await asAdmin(
        api().put(`/banks/branch-countries/${fx.branchB}`),
      ).send({ countries: ['XYZ', '1'] });
      expect(res.status).toBe(400);

      const row = await ctx.prisma.branch.findUnique({
        where: { id: fx.branchB },
      });
      expect(row!.bankingCountries.sort()).toEqual(['AE', 'IN']);
    });

    it('BM-API-24: an empty list clears the set', async () => {
      const res = await asAdmin(
        api().put(`/banks/branch-countries/${fx.branchB}`),
      ).send({ countries: [] });
      expect(res.status).toBe(200);
      const row = await ctx.prisma.branch.findUnique({
        where: { id: fx.branchB },
      });
      expect(row!.bankingCountries).toEqual([]);

      // Restore, so later suites see the fixture as built.
      await asAdmin(api().put(`/banks/branch-countries/${fx.branchB}`)).send({
        countries: ['IN'],
      });
    });

    it('BM-API-25: it is deliberately NOT branch-scoped', async () => {
      // A branch-scoped HR manages every branch's banking countries, including
      // branches they cannot otherwise see. That is intentional — the grant is
      // company-level configuration, not an operation on the branch's data — and
      // is asserted so a change to it has to be deliberate.
      const res = await api()
        .put(`/banks/branch-countries/${fx.branchOm}`)
        .set(bearer(fx.scopedHr.token))
        .send({ countries: ['OM'] });
      expect(res.status).toBe(200);
    });

    it('BM-API-26: MANAGER and EMPLOYEE are refused both doors', async () => {
      for (const token of [fx.deptManager.token, fx.employee.token]) {
        expect(
          (await as(token, api().get('/banks/branch-countries'))).status,
        ).toBe(403);
        expect(
          (
            await as(
              token,
              api().put(`/banks/branch-countries/${fx.branchA}`),
            ).send({ countries: ['IN'] })
          ).status,
        ).toBe(403);
      }
    });
  });
});
