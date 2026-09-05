import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFixtures, Fixtures, bearer } from './utils/fixtures';

/**
 * Backdated onboarding, end to end.
 *
 * Onboarding a hire whose start date is more than a year old used to fail with
 * "Start date cannot be more than 1 year in the past". The window now lives in
 * SystemSettings and permits any past date by default, so the flows below —
 * onboard, enter the historical contract, then the current one — have to work
 * against the real request pipeline, not just against mocks.
 */
describe('Backdated onboarding (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;
  let token: string;

  const PAST_KEY = 'employee_start_date_max_past_days';

  const daysFromToday = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  };

  let seq = 0;
  const employeePayload = (over: Record<string, any> = {}) => {
    seq += 1;
    return {
      fullName: `Backdated Hire ${seq}`,
      email: `backdated${seq}.${fx.runId}@test.local`,
      dateOfBirth: '1990-05-05',
      idCard: `BD-${fx.runId}-${seq}`,
      departmentId: fx.deptId,
      branchId: fx.branchA,
      position: 'Fitter',
      startDate: daysFromToday(-540),
      baseSalary: 50000,
      ...over,
    };
  };

  const createEmployee = (over: Record<string, any> = {}) =>
    ctx
      .http()
      .post('/employees')
      .set(bearer(token))
      .send(employeePayload(over));

  const setPastWindow = (value: string) =>
    ctx
      .http()
      .post('/system-settings')
      .set(bearer(token))
      .send({ settings: { [PAST_KEY]: value } });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);
    token = fx.globalAdmin.token;
  });

  afterAll(async () => {
    // Leave the policy as we found it — this row is shared company config.
    await ctx.prisma.systemSetting.deleteMany({ where: { key: PAST_KEY } });
    await fx.cleanup();
    await ctx.app.close();
  });

  describe('employee creation', () => {
    it('accepts a start date 18 months in the past', async () => {
      const res = await createEmployee();
      expect(res.status).toBe(201);
      expect(res.body.data.startDate).toBeTruthy();
    });

    it('accepts a start date several years in the past', async () => {
      const res = await createEmployee({ startDate: '2019-04-01' });
      expect(res.status).toBe(201);
    });

    it('still rejects a start date before the employee turned 18', async () => {
      const res = await createEmployee({
        dateOfBirth: '1990-05-05',
        startDate: '2005-01-01',
      });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/turns 18/);
    });

    it('still rejects a far-future start date', async () => {
      const res = await createEmployee({ startDate: daysFromToday(400) });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/days in the future/);
    });
  });

  /**
   * The settings page reads GET /system-settings and writes POST
   * /system-settings, and the onboarding forms read GET /system-settings/public.
   * These assert that exact contract — the page is hand-curated, so a key that
   * is missing from either payload silently renders as its default and the
   * admin's edit appears to do nothing.
   */
  describe('settings page contract', () => {
    const FUTURE_KEY = 'employee_start_date_max_future_days';
    const FLOOR_KEY = 'employee_start_date_floor';

    const settingsList = async (): Promise<Record<string, string>> => {
      const res = await ctx.http().get('/system-settings').set(bearer(token));
      expect(res.status).toBe(200);
      return Object.fromEntries(
        (res.body.data ?? []).map((s: any) => [s.key, s.value]),
      );
    };

    const publicSettings = async (): Promise<Record<string, string>> => {
      const res = await ctx.http().get('/system-settings/public');
      expect(res.status).toBe(200);
      return res.body.data ?? {};
    };

    afterEach(async () => {
      await ctx.prisma.systemSetting.deleteMany({
        where: { key: { in: [PAST_KEY, FUTURE_KEY, FLOOR_KEY] } },
      });
    });

    it('lists all three keys with their defaults for the settings page', async () => {
      const list = await settingsList();
      expect(list).toHaveProperty(PAST_KEY, '');
      expect(list).toHaveProperty(FUTURE_KEY, '180');
      expect(list).toHaveProperty(FLOOR_KEY, '1970-01-01');
    });

    it('persists an edit made from the settings page', async () => {
      const save = await ctx
        .http()
        .post('/system-settings')
        .set(bearer(token))
        .send({
          settings: {
            [PAST_KEY]: '400',
            [FUTURE_KEY]: '90',
            [FLOOR_KEY]: '2000-01-01',
          },
        });
      expect(save.status).toBeLessThan(300);

      const list = await settingsList();
      expect(list[PAST_KEY]).toBe('400');
      expect(list[FUTURE_KEY]).toBe('90');
      expect(list[FLOOR_KEY]).toBe('2000-01-01');
    });

    it('keeps a cleared backdating limit blank rather than coercing it to 0', async () => {
      // Blank is the meaningful "no limit" value. If the numeric clamp turned it
      // into "0", the field would come back filled and the meaning would flip.
      await ctx
        .http()
        .post('/system-settings')
        .set(bearer(token))
        .send({ settings: { [PAST_KEY]: '400' } });
      await setPastWindow('');

      expect((await settingsList())[PAST_KEY]).toBe('');
      const res = await createEmployee({ startDate: daysFromToday(-800) });
      expect(res.status).toBe(201);
    });

    it('publishes the bounds to the onboarding form without a token', async () => {
      const pub = await publicSettings();
      expect(pub).toHaveProperty(PAST_KEY);
      expect(pub).toHaveProperty(FUTURE_KEY);
      expect(pub).toHaveProperty(FLOOR_KEY);
    });

    it('reflects a saved edit on the public endpoint the form reads', async () => {
      await ctx
        .http()
        .post('/system-settings')
        .set(bearer(token))
        .send({ settings: { [FUTURE_KEY]: '45' } });

      expect((await publicSettings())[FUTURE_KEY]).toBe('45');
    });

    it('enforces the edited future bound end to end', async () => {
      await ctx
        .http()
        .post('/system-settings')
        .set(bearer(token))
        .send({ settings: { [FUTURE_KEY]: '30' } });

      const rejected = await createEmployee({ startDate: daysFromToday(60) });
      expect(rejected.status).toBe(400);
      expect(String(rejected.body.message)).toMatch(/30 days in the future/);

      const accepted = await createEmployee({ startDate: daysFromToday(10) });
      expect(accepted.status).toBe(201);
    });

    it('enforces the edited floor end to end', async () => {
      await ctx
        .http()
        .post('/system-settings')
        .set(bearer(token))
        .send({ settings: { [FLOOR_KEY]: '2010-01-01' } });

      const res = await createEmployee({ startDate: '2005-06-01' });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/earlier than 2010-01-01/);
    });
  });

  describe('the policy is live, not baked in', () => {
    afterEach(async () => {
      await setPastWindow('');
    });

    it('rejects a backdated hire once a past window is configured', async () => {
      expect((await setPastWindow('365')).status).toBeLessThan(300);

      const res = await createEmployee({ startDate: daysFromToday(-800) });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/days in the past/);
    });

    it('accepts the same hire again once the window is cleared', async () => {
      await setPastWindow('365');
      await setPastWindow('');

      const res = await createEmployee({ startDate: daysFromToday(-800) });
      expect(res.status).toBe(201);
    });
  });

  describe('historical contract chain', () => {
    let employeeId: string;

    beforeAll(async () => {
      const res = await createEmployee({ startDate: daysFromToday(-540) });
      expect(res.status).toBe(201);
      employeeId = res.body.data.id;
    });

    const createContract = (over: Record<string, any> = {}) =>
      ctx
        .http()
        .post('/contracts')
        .set(bearer(token))
        .send({
          employeeId,
          contractType: 'FIXED_TERM',
          startDate: daysFromToday(-540),
          endDate: daysFromToday(-180),
          salary: 50000,
          ...over,
        });

    it('creates the already-ended contract as EXPIRED', async () => {
      const res = await createContract();
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('EXPIRED');
    });

    it('then accepts the current contract alongside it', async () => {
      const res = await createContract({
        contractType: 'INDEFINITE',
        startDate: daysFromToday(-179),
        endDate: undefined,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('rejects a second contract that would also be active', async () => {
      const res = await createContract({
        contractType: 'INDEFINITE',
        startDate: daysFromToday(-10),
        endDate: undefined,
      });
      expect(res.status).toBe(409);
    });

    it('reports both contracts in the employee history', async () => {
      const res = await ctx
        .http()
        .get(`/contracts/employee/${employeeId}`)
        .set(bearer(token));
      expect(res.status).toBe(200);

      const statuses = (res.body.data ?? []).map((c: any) => c.status);
      expect(statuses).toEqual(expect.arrayContaining(['EXPIRED', 'ACTIVE']));
    });
  });
});
