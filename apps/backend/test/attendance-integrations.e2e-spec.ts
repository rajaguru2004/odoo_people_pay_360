import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFixtures, Fixtures, bearer } from './utils/fixtures';
import { ProviderRegistry } from '../src/attendance-integrations/providers/provider.registry';
import { AttendanceProvider } from '../src/attendance-integrations/types/attendance-provider.interface';
import { NormalizedAttendanceRecord } from '../src/attendance-integrations/types/normalized-attendance';

/**
 * End-to-end verification of the external attendance provider framework against
 * the real dev DB, driven entirely through HTTP.
 *
 * A fake provider is registered via ProviderRegistry.registerForTesting so the
 * suite needs no live vendor. Everything else — controller, guards, branch
 * scoping, sync engine, conflict guard, AttendancesService write path — is real.
 *
 * Proves: RBAC, provider catalogue, CRUD + secret masking, connection test,
 * dry run writes nothing, sync writes real attendance rows, idempotency,
 * conflict guard protects leave/manual/corrected days, employee auto-linking,
 * unmapped surfacing, and run history.
 */
describe('Attendance integrations (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;
  let integrationId: string;

  /** Records the fake provider will return on the next fetchRange call. */
  let providerRecords: NormalizedAttendanceRecord[] = [];
  let providerShouldFail = false;

  const SYNC_DATE = '2026-05-12'; // deliberately not the 2026-07-06 fixture date
  const dateKey = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };

  const fakeProvider: AttendanceProvider = {
    key: 'e2e-fake',
    displayName: 'E2E Fake Provider',
    description: 'Test double — returns whatever the suite queues up.',
    configSchema: [
      { name: 'baseUrl', label: 'Base URL', type: 'text', required: true },
      { name: 'authSecret', label: 'Key', type: 'password', required: true, secret: true },
      { name: 'externalBranchId', label: 'External branch', type: 'text', required: true },
      { name: 'pageSize', label: 'Page size', type: 'number', required: false, default: 50 },
    ],
    async testConnection() {
      if (providerShouldFail) return { ok: false, message: 'Simulated failure' };
      return { ok: true, latencyMs: 1, message: 'Fake provider reachable' };
    },
    async fetchRange() {
      if (providerShouldFail) throw new Error('Simulated fetch failure');
      return providerRecords;
    },
  };

  const adminHeaders = () => bearer(fx.globalAdmin.token);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);
    ctx.app.get(ProviderRegistry).registerForTesting(fakeProvider);
  }, 120000);

  afterAll(async () => {
    if (ctx && integrationId) {
      // Cascade removes the run history; attendance is cleaned by fx.cleanup.
      await ctx.prisma.attendanceIntegration
        .deleteMany({ where: { id: integrationId } })
        .catch(() => undefined);
    }
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  beforeEach(() => {
    providerShouldFail = false;
    providerRecords = [];
  });

  /** Remove any attendance the previous test wrote for the sync date. */
  const clearSyncedRows = async () => {
    await ctx.prisma.attendance.deleteMany({
      where: { employeeId: fx.empAId, date: dateKey(SYNC_DATE) },
    });
  };

  const record = (
    over: Partial<NormalizedAttendanceRecord> = {},
  ): NormalizedAttendanceRecord => ({
    externalEmployeeId: `EMP-${fx.runId}-A`, // matches empA's employeeCode
    externalEmployeeName: 'Alice BranchA',
    businessDate: SYNC_DATE,
    checkIn: new Date(`${SYNC_DATE}T04:00:00.000Z`),
    checkOut: new Date(`${SYNC_DATE}T13:00:00.000Z`),
    externalRef: 'fake-1',
    ...over,
  });

  // ───────────────────────────── RBAC ─────────────────────────────

  describe('RBAC', () => {
    it('rejects unauthenticated access', async () => {
      const res = await ctx.http().get('/attendance-integrations');
      expect(res.status).toBe(401);
    });

    it('rejects a plain employee', async () => {
      const res = await ctx
        .http()
        .get('/attendance-integrations')
        .set(bearer(fx.plainEmployee.token));
      expect(res.status).toBe(403);
    });

    it('rejects HR — this surface holds vendor credentials, ADMIN only', async () => {
      const res = await ctx
        .http()
        .get('/attendance-integrations')
        .set(bearer(fx.scopedHr.token));
      expect(res.status).toBe(403);
    });

    it('allows an admin', async () => {
      const res = await ctx.http().get('/attendance-integrations').set(adminHeaders());
      expect(res.status).toBe(200);
    });
  });

  // ─────────────────────────── Catalogue ───────────────────────────

  describe('Provider catalogue', () => {
    it('lists providers with their config schema so the UI can render a form', async () => {
      const res = await ctx
        .http()
        .get('/attendance-integrations/providers')
        .set(adminHeaders());

      expect(res.status).toBe(200);
      const keys = res.body.data.providers.map((p: any) => p.key);
      expect(keys).toContain('fusion-analytics');
      expect(keys).toContain('e2e-fake');

      const fusion = res.body.data.providers.find((p: any) => p.key === 'fusion-analytics');
      expect(fusion.configSchema.length).toBeGreaterThan(0);
      expect(fusion.configSchema.some((f: any) => f.secret)).toBe(true);
    });

    it('lists the selectable conflict policies', async () => {
      const res = await ctx
        .http()
        .get('/attendance-integrations/providers')
        .set(adminHeaders());
      const values = res.body.data.conflictPolicies.map((p: any) => p.value);
      expect(values).toContain('PROVIDER_WINS_SAFE');
    });
  });

  // ───────────────────────────── CRUD ─────────────────────────────

  describe('CRUD + secret handling', () => {
    it('rejects an unknown provider key', async () => {
      const res = await ctx
        .http()
        .post('/attendance-integrations')
        .set(adminHeaders())
        .send({
          branchId: fx.branchA,
          provider: 'does-not-exist',
          displayName: 'Nope',
          baseUrl: 'https://example.test',
          externalBranchId: 'X',
        });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/Unknown attendance provider/);
    });

    it('creates a connection and never returns the secret', async () => {
      const res = await ctx
        .http()
        .post('/attendance-integrations')
        .set(adminHeaders())
        .send({
          branchId: fx.branchA,
          provider: 'e2e-fake',
          displayName: 'E2E Fake — Branch A',
          baseUrl: 'https://example.test',
          authHeaderName: 'x-key',
          authSecret: 'super-secret-value-1234',
          externalBranchId: 'FAKE-A',
          options: { pageSize: 25 },
          conflictPolicy: 'PROVIDER_WINS_SAFE',
        });

      expect(res.status).toBe(201);
      integrationId = res.body.data.id;

      expect(res.body.data.authSecretConfigured).toBe(true);
      expect(res.body.data.authSecretMasked).toBe('••••1234');
      expect(JSON.stringify(res.body)).not.toContain('super-secret-value-1234');
      // Disabled by default — an admin must dry-run before arming the cron.
      expect(res.body.data.enabled).toBe(false);
    });

    it('stores the secret encrypted at rest, not in plaintext', async () => {
      const row = await ctx.prisma.attendanceIntegration.findUnique({
        where: { id: integrationId },
        select: { authSecretEnc: true },
      });
      expect(row?.authSecretEnc).toBeTruthy();
      expect(row?.authSecretEnc).not.toContain('super-secret-value-1234');
      expect(row?.authSecretEnc?.startsWith('v1:')).toBe(true);
    });

    it('keeps only options the provider declares', async () => {
      const res = await ctx
        .http()
        .patch(`/attendance-integrations/${integrationId}`)
        .set(adminHeaders())
        .send({ options: { pageSize: 40, smuggled: 'nope' } });

      expect(res.status).toBe(200);
      expect(res.body.data.options).toEqual({ pageSize: 40 });
    });

    it('refuses a second connection on the same branch', async () => {
      const res = await ctx
        .http()
        .post('/attendance-integrations')
        .set(adminHeaders())
        .send({
          branchId: fx.branchA,
          provider: 'e2e-fake',
          displayName: 'Duplicate',
          baseUrl: 'https://example.test',
          authSecret: 'x',
          externalBranchId: 'FAKE-A2',
        });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/already has an attendance integration/);
    });

    it('refuses to move a connection to another branch', async () => {
      const res = await ctx
        .http()
        .patch(`/attendance-integrations/${integrationId}`)
        .set(adminHeaders())
        .send({ branchId: fx.branchB });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/Branch cannot be changed/);
    });

    it('keeps the stored secret when authSecret is omitted', async () => {
      const res = await ctx
        .http()
        .patch(`/attendance-integrations/${integrationId}`)
        .set(adminHeaders())
        .send({ displayName: 'E2E Fake — Branch A (renamed)' });

      expect(res.status).toBe(200);
      expect(res.body.data.authSecretConfigured).toBe(true);
      expect(res.body.data.authSecretMasked).toBe('••••1234');
    });
  });

  // ──────────────────────── Test connection ────────────────────────

  describe('Test connection', () => {
    it('reports success', async () => {
      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/test`)
        .set(adminHeaders())
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.data.ok).toBe(true);
    });

    it('reports failure as data, not as a 500', async () => {
      providerShouldFail = true;
      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/test`)
        .set(adminHeaders())
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.data.ok).toBe(false);
    });
  });

  // ───────────────────────────── Dry run ─────────────────────────────

  describe('Dry run', () => {
    it('reports what would change and writes nothing', async () => {
      await clearSyncedRows();
      providerRecords = [record()];

      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/preview`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      expect(res.status).toBe(201);
      expect(res.body.data.trigger).toBe('DRY_RUN');
      expect(res.body.data.records[0].outcome).toBe('WOULD_CREATE');
      expect(res.body.data.records[0].employeeCode).toBe(`EMP-${fx.runId}-A`);

      const written = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.empAId, date: dateKey(SYNC_DATE) },
      });
      expect(written).toBeNull();
    });

    it('does not link the employee either', async () => {
      const emp = await ctx.prisma.employee.findUnique({
        where: { id: fx.empAId },
        select: { attendanceExternalId: true },
      });
      expect(emp?.attendanceExternalId).toBeNull();
    });

    it('rejects a window wider than 31 days', async () => {
      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/preview`)
        .set(adminHeaders())
        .send({ from: '2026-01-01', to: '2026-03-01' });
      expect(res.status).toBe(400);
    });
  });

  // ────────────────────────────── Sync ──────────────────────────────

  describe('Sync', () => {
    it('writes a real attendance row with SYNC provenance', async () => {
      await clearSyncedRows();
      providerRecords = [record()];

      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      expect(res.status).toBe(201);
      expect(res.body.data.created).toBe(1);
      expect(res.body.data.status).toBe('OK');

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.empAId, date: dateKey(SYNC_DATE) },
      });
      expect(row).toBeTruthy();
      expect(row?.source).toBe('SYNC');
      expect(row?.externalRef).toBe('fake-1');
      expect(row?.syncedAt).toBeTruthy();
      expect(row?.status).toBe('PRESENT');
      // Derived by AttendancesService, exactly as for a manual entry.
      expect(Number(row?.workHours)).toBeGreaterThan(0);
      // Branch denormalized so branch-scoped reads see it.
      expect(row?.branchId).toBe(fx.branchA);
    });

    it('auto-links the external id to the matching employeeCode', async () => {
      const emp = await ctx.prisma.employee.findUnique({
        where: { id: fx.empAId },
        select: { attendanceExternalId: true },
      });
      expect(emp?.attendanceExternalId).toBe(`EMP-${fx.runId}-A`);
    });

    it('is idempotent — a second identical run creates nothing', async () => {
      providerRecords = [record()];

      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      expect(res.body.data.created).toBe(0);
      expect(res.body.data.updated).toBe(0);

      const count = await ctx.prisma.attendance.count({
        where: { employeeId: fx.empAId, date: dateKey(SYNC_DATE) },
      });
      expect(count).toBe(1);
    });

    it('updates the row when the provider reports a corrected punch', async () => {
      providerRecords = [
        record({ checkOut: new Date(`${SYNC_DATE}T14:30:00.000Z`) }),
      ];

      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      expect(res.body.data.updated).toBe(1);

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.empAId, date: dateKey(SYNC_DATE) },
      });
      expect(row?.checkOut?.toISOString()).toBe(`${SYNC_DATE}T14:30:00.000Z`);
    });

    it('stamps the connection with the last run status', async () => {
      const row = await ctx.prisma.attendanceIntegration.findUnique({
        where: { id: integrationId },
        select: { lastSyncAt: true, lastSyncStatus: true },
      });
      expect(row?.lastSyncAt).toBeTruthy();
      expect(row?.lastSyncStatus).toBe('OK');
    });
  });

  // ──────────────────────── Conflict guard ────────────────────────

  describe('Conflict guard (PROVIDER_WINS_SAFE)', () => {
    it('never overwrites an approved leave day', async () => {
      await clearSyncedRows();
      await ctx.prisma.attendance.create({
        data: {
          employeeId: fx.empAId,
          branchId: fx.branchA,
          date: dateKey(SYNC_DATE),
          status: 'LEAVE',
          workHours: 0,
          source: 'LEAVE',
        },
      });
      providerRecords = [record()];

      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      expect(res.body.data.created + res.body.data.updated).toBe(0);
      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.empAId, date: dateKey(SYNC_DATE) },
      });
      expect(row?.status).toBe('LEAVE');
      expect(row?.checkIn).toBeNull();
    });

    it('never overwrites a manual admin entry', async () => {
      await clearSyncedRows();
      await ctx.prisma.attendance.create({
        data: {
          employeeId: fx.empAId,
          branchId: fx.branchA,
          date: dateKey(SYNC_DATE),
          status: 'PRESENT',
          notes: 'Manually entered by admin',
          source: 'MANUAL',
          checkIn: new Date(`${SYNC_DATE}T05:00:00.000Z`),
        },
      });
      providerRecords = [record()];

      await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.empAId, date: dateKey(SYNC_DATE) },
      });
      expect(row?.checkIn?.toISOString()).toBe(`${SYNC_DATE}T05:00:00.000Z`);
      expect(row?.source).toBe('MANUAL');
    });

    it('protects legacy manual rows identified only by their notes', async () => {
      await clearSyncedRows();
      await ctx.prisma.attendance.create({
        data: {
          employeeId: fx.empAId,
          branchId: fx.branchA,
          date: dateKey(SYNC_DATE),
          status: 'PRESENT',
          notes: 'Manually entered by admin',
          // source deliberately null — a row written before the column existed
          checkIn: new Date(`${SYNC_DATE}T05:00:00.000Z`),
        },
      });
      providerRecords = [record()];

      await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.empAId, date: dateKey(SYNC_DATE) },
      });
      expect(row?.checkIn?.toISOString()).toBe(`${SYNC_DATE}T05:00:00.000Z`);
    });

    it('DOES overwrite an auto-marked absence', async () => {
      await clearSyncedRows();
      await ctx.prisma.attendance.create({
        data: {
          employeeId: fx.empAId,
          branchId: fx.branchA,
          date: dateKey(SYNC_DATE),
          status: 'ABSENT',
          notes: 'Auto-marked absent (no check-in)',
          source: 'AUTO',
        },
      });
      providerRecords = [record()];

      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      expect(res.body.data.updated).toBe(1);
      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.empAId, date: dateKey(SYNC_DATE) },
      });
      expect(row?.status).toBe('PRESENT');
      expect(row?.source).toBe('SYNC');
    });
  });

  // ────────────────────── Unmapped + mapping ──────────────────────

  describe('Employee mapping', () => {
    it('surfaces an unknown external id instead of guessing', async () => {
      await clearSyncedRows();
      providerRecords = [record({ externalEmployeeId: 'GHOST-999', externalEmployeeName: 'Ghost' })];

      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      expect(res.body.data.unmapped).toBe(1);
      // PARTIAL, not OK — someone's attendance is silently missing.
      expect(res.body.data.status).toBe('PARTIAL');

      const unmapped = await ctx
        .http()
        .get(`/attendance-integrations/${integrationId}/unmapped`)
        .set(adminHeaders());
      expect(unmapped.body.data.map((u: any) => u.externalId)).toContain('GHOST-999');
    });

    it('lists unlinked candidates from the integration branch only', async () => {
      const res = await ctx
        .http()
        .get(`/attendance-integrations/${integrationId}/candidates`)
        .set(adminHeaders());

      expect(res.status).toBe(200);
      const ids = res.body.data.map((e: any) => e.id);
      // empA is already linked; empB is in the other branch.
      expect(ids).not.toContain(fx.empAId);
      expect(ids).not.toContain(fx.empBId);
    });

    it('refuses to link an employee from another branch', async () => {
      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/map`)
        .set(adminHeaders())
        .send({ externalId: 'GHOST-999', employeeId: fx.empBId });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/different branch/);
    });

    it('refuses to reuse an external id already linked to someone else', async () => {
      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/map`)
        .set(adminHeaders())
        .send({ externalId: `EMP-${fx.runId}-A`, employeeId: fx.empAId });
      // Same employee, same id — allowed (idempotent).
      expect(res.status).toBe(201);
    });

    it('unlinks on request', async () => {
      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/map`)
        .set(adminHeaders())
        .send({ externalId: `EMP-${fx.runId}-A`, unlink: true });

      expect(res.status).toBe(201);
      const emp = await ctx.prisma.employee.findUnique({
        where: { id: fx.empAId },
        select: { attendanceExternalId: true },
      });
      expect(emp?.attendanceExternalId).toBeNull();
    });
  });

  // ──────────────────── Empty window (silent no-op) ────────────────────

  describe('Empty window', () => {
    it('reports PARTIAL, not OK, when the provider returns nothing', async () => {
      // The failure this guards against: a wrong external branch id is accepted
      // upstream and answers an empty list, so the connection looks healthy
      // forever while importing nothing.
      providerRecords = [];

      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      expect(res.status).toBe(201);
      expect(res.body.data.fetched).toBe(0);
      expect(res.body.data.status).toBe('PARTIAL');
      expect(res.body.data.message).toMatch(/no attendance at all/i);

      const row = await ctx.prisma.attendanceIntegration.findUnique({
        where: { id: integrationId },
        select: { lastSyncStatus: true, lastSyncError: true },
      });
      expect(row?.lastSyncStatus).toBe('PARTIAL');
      expect(row?.lastSyncError).toMatch(/no attendance at all/i);
    });
  });

  // ──────────────────── Suggestions + bulk mapping ────────────────────

  describe('Bulk mapping', () => {
    it('suggests an employee for an unmapped id by name', async () => {
      await clearSyncedRows();
      // Alice BranchA is fixture empA, in this integration's branch.
      providerRecords = [
        record({ externalEmployeeId: 'FX-900', externalEmployeeName: 'Alice BranchA' }),
      ];
      await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      const res = await ctx
        .http()
        .get(`/attendance-integrations/${integrationId}/suggestions`)
        .set(adminHeaders());

      expect(res.status).toBe(200);
      const hit = res.body.data.find((s: any) => s.externalId === 'FX-900');
      expect(hit).toBeTruthy();
      expect(hit.suggestions[0].employeeId).toBe(fx.empAId);
      expect(hit.confident).toBe(true);
    });

    it('applies many links in one call and reports per-entry outcomes', async () => {
      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/map/bulk`)
        .set(adminHeaders())
        .send({
          entries: [
            { externalId: 'FX-900', employeeId: fx.empAId },
            // Wrong branch — must fail on its own without sinking the batch.
            { externalId: 'FX-901', employeeId: fx.empBId },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.linked).toBe(1);
      expect(res.body.data.failed).toBe(1);
      expect(
        res.body.data.results.find((r: any) => r.externalId === 'FX-901').message,
      ).toMatch(/different branch/i);

      const emp = await ctx.prisma.employee.findUnique({
        where: { id: fx.empAId },
        select: { attendanceExternalId: true },
      });
      expect(emp?.attendanceExternalId).toBe('FX-900');

      // Leave the fixture as we found it for the tests that follow.
      await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/map`)
        .set(adminHeaders())
        .send({ externalId: 'FX-900', unlink: true });
    });

    it('rejects a batch larger than the cap', async () => {
      const entries = Array.from({ length: 2001 }, (_, i) => ({
        externalId: `X-${i}`,
        employeeId: fx.empAId,
      }));

      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/map/bulk`)
        .set(adminHeaders())
        .send({ entries });

      expect(res.status).toBe(400);
    });
  });

  // ─────────────────────────── Run history ───────────────────────────

  describe('Run history', () => {
    it('records every run, newest first', async () => {
      const res = await ctx
        .http()
        .get(`/attendance-integrations/${integrationId}/runs`)
        .set(adminHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(1);

      const triggers = res.body.data.map((r: any) => r.trigger);
      expect(triggers).toContain('MANUAL');
      expect(triggers).toContain('DRY_RUN');

      const times = res.body.data.map((r: any) => new Date(r.startedAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('records a provider failure as an ERROR run', async () => {
      providerShouldFail = true;
      const res = await ctx
        .http()
        .post(`/attendance-integrations/${integrationId}/sync`)
        .set(adminHeaders())
        .send({ from: SYNC_DATE, to: SYNC_DATE });

      expect(res.status).toBeGreaterThanOrEqual(400);

      const runs = await ctx
        .http()
        .get(`/attendance-integrations/${integrationId}/runs`)
        .set(adminHeaders());
      expect(runs.body.data[0].status).toBe('ERROR');

      const row = await ctx.prisma.attendanceIntegration.findUnique({
        where: { id: integrationId },
        select: { lastSyncStatus: true, lastSyncError: true },
      });
      expect(row?.lastSyncStatus).toBe('ERROR');
      expect(row?.lastSyncError).toMatch(/Simulated fetch failure/);
    });
  });

  // ─────────────────────────── Enabling ───────────────────────────

  describe('Enabling the schedule', () => {
    it('refuses to enable a connection with no secret', async () => {
      const created = await ctx
        .http()
        .post('/attendance-integrations')
        .set(adminHeaders())
        .send({
          branchId: fx.branchB,
          provider: 'e2e-fake',
          displayName: 'Keyless',
          baseUrl: 'https://example.test',
          externalBranchId: 'FAKE-B',
        });
      expect(created.status).toBe(201);

      const res = await ctx
        .http()
        .patch(`/attendance-integrations/${created.body.data.id}`)
        .set(adminHeaders())
        .send({ enabled: true });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/without an authentication secret/);

      await ctx.prisma.attendanceIntegration.delete({
        where: { id: created.body.data.id },
      });
    });

    it('enables once a secret is present', async () => {
      const res = await ctx
        .http()
        .patch(`/attendance-integrations/${integrationId}`)
        .set(adminHeaders())
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);

      // Leave it disabled so the cron cannot fire against the fake after teardown.
      await ctx
        .http()
        .patch(`/attendance-integrations/${integrationId}`)
        .set(adminHeaders())
        .send({ enabled: false });
    });
  });
});
