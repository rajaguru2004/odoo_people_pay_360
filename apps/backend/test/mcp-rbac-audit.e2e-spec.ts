import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { bootMcpHarness, McpHarness } from './utils/mcp-harness';

/**
 * Non-functional guarantees: auth, RBAC denial, branch isolation, the
 * confirm-first gate, audit-log generation, and input validation / error
 * handling / edge cases.
 */
describe('MCP RBAC, branch isolation, audit & edge cases (e2e)', () => {
  let h: McpHarness;
  let admin: Client;
  let hr: Client;
  let employee: Client;

  /** Resolve to a throw or an isError content result — RBAC-hidden tools throw
   *  (unknown tool), domain/business errors come back as isError content. */
  const attempt = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    try {
      const r = await h.call(c, name, args);
      return { threw: false, isError: r.isError, body: r.body };
    } catch (e) {
      return { threw: true, isError: true, body: (e as Error).message };
    }
  };

  /** Poll a query until a predicate holds (audit writes are now async). */
  async function pollRows<T extends any[]>(
    query: () => Promise<T>,
    ok: (rows: T) => boolean,
    tries = 15,
    delayMs = 150,
  ): Promise<T> {
    let rows = await query();
    for (let i = 0; i < tries && !ok(rows); i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      rows = await query();
    }
    return rows;
  }

  /**
   * `mcp.auditReads` decides whether a read tool writes an audit row at all,
   * and it is a row in system_settings — environment-wide shared state.
   *
   * The audit cases below assert that reading through MCP IS audited, so they
   * silently depend on it being on. When copilot-settings.e2e-spec.ts is killed
   * mid-run its teardown never restores the snapshot, the setting stays
   * `false`, and this suite then fails on an empty result set that looks
   * exactly like a regression in the tool it is testing. Owning the setting for
   * the duration of the suite makes the outcome depend on the code rather than
   * on what ran before it.
   */
  const AUDIT_READS_KEY = 'mcp.auditReads';
  let previousAuditReads: string | null = null;

  beforeAll(async () => {
    h = await bootMcpHarness();
    admin = await h.client(h.fx.globalAdmin.token);
    hr = await h.client(h.fx.scopedHr.token);
    employee = await h.client(h.fx.plainEmployee.token);

    const row = await h.prisma.systemSetting.findUnique({
      where: { key: AUDIT_READS_KEY },
    });
    previousAuditReads = row?.value ?? null;
    // Through the API, not straight into Prisma: CopilotSettingsService caches
    // its resolved config for 30s and only drops the cache on its own writes. A
    // direct row update would be read back as the stale value for the length of
    // this suite.
    await h.ctx
      .http()
      .put('/copilot-settings')
      .set({ Authorization: `Bearer ${h.fx.globalAdmin.token}` })
      .send({ mcpAuditReads: true });
  }, 120000);

  afterAll(async () => {
    // null means the row did not exist — deleting is what restores that, and an
    // update would be a no-op that leaves our value behind.
    if (previousAuditReads === null) {
      await h?.prisma.systemSetting
        .delete({ where: { key: AUDIT_READS_KEY } })
        .catch(() => undefined);
    } else {
      await h?.ctx
        .http()
        .put('/copilot-settings')
        .set({ Authorization: `Bearer ${h.fx.globalAdmin.token}` })
        .send({ mcpAuditReads: previousAuditReads === 'true' })
        .catch(() => undefined);
    }
    await h?.teardown();
  }, 120000);

  // -------------------------------------------------------------------- auth
  describe('authentication & transport', () => {
    it('rejects requests without a bearer token (401)', async () => {
      const res = await fetch(`${h.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects a garbage bearer token (401)', async () => {
      const res = await fetch(`${h.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer not.a.jwt',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(401);
    });

    it('GET and DELETE are 405 (stateless, POST-only)', async () => {
      for (const method of ['GET', 'DELETE']) {
        const res = await fetch(`${h.baseUrl}/mcp`, {
          method,
          headers: { Authorization: `Bearer ${h.fx.globalAdmin.token}` },
        });
        expect(res.status).toBe(405);
      }
    });
  });

  // -------------------------------------------------------------------- RBAC
  describe('RBAC denial', () => {
    it('EMPLOYEE cannot reach admin/HR tools', async () => {
      for (const t of ['employee_delete', 'payroll_run', 'employee_list']) {
        const r = await attempt(employee, t, { id: h.fx.empAId });
        expect(r.isError).toBe(true);
      }
    });

    it('HR_MANAGER cannot reach ADMIN-only tools', async () => {
      for (const t of ['payroll_approve', 'payroll_reject', 'employee_delete', 'department_delete']) {
        const r = await attempt(hr, t, { id: h.fx.empAId });
        expect(r.isError).toBe(true);
      }
    });

    it('MANAGER cannot run payroll', async () => {
      const r = await attempt(await h.client(h.manager.token), 'payroll_run', { month: 1, year: 2099 });
      expect(r.isError).toBe(true);
    });
  });

  // --------------------------------------------------------- branch isolation
  describe('branch isolation', () => {
    it('scoped HR sees only its branch in employee_list', async () => {
      const body = await h.callOk(hr, 'employee_list', { search: h.fx.runId, limit: 50 });
      const ids = body.data.map((e: any) => e.id);
      expect(ids).toContain(h.fx.empAId);
      expect(ids).not.toContain(h.fx.empBId);
    });

    it('scoped HR gets 404 (not 403) for an out-of-branch employee — no existence leak', async () => {
      const r = await attempt(hr, 'employee_get', { id: h.fx.empBId });
      expect(r.isError).toBe(true);
      expect(r.body?.error?.status ?? 404).toBe(404);
    });

    it('a cross-branch X-Branch-Id header is rejected at connect (403)', async () => {
      const res = await fetch(`${h.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${h.fx.scopedHr.token}`,
          'X-Branch-Id': h.fx.branchB,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(403);
    });

    it('global admin sees both branches', async () => {
      const body = await h.callOk(admin, 'employee_list', { search: h.fx.runId, limit: 50 });
      const ids = body.data.map((e: any) => e.id);
      expect(ids).toEqual(expect.arrayContaining([h.fx.empAId, h.fx.empBId]));
    });
  });

  // ------------------------------------------------------------- confirm-first
  describe('confirm-first gate', () => {
    const holiday = () => `GateHoliday ${h.fx.runId}`;

    it('a write without confirm previews and persists nothing', async () => {
      const pv = await h.preview(admin, 'holiday_create', { name: holiday(), date: '2099-01-02' });
      expect(pv.requiresConfirmation).toBe(true);
      expect(await h.prisma.holiday.count({ where: { name: holiday() } })).toBe(0);
    });

    it('confirm:true executes exactly once', async () => {
      await h.callOk(admin, 'holiday_create', { name: holiday(), date: '2099-01-02', confirm: true });
      expect(await h.prisma.holiday.count({ where: { name: holiday() } })).toBe(1);
    });

    it('confirm on a read tool is a no-op (reads never gate)', async () => {
      const body = await h.callOk(admin, 'employee_list', { search: h.fx.runId, confirm: true } as any);
      expect(Array.isArray(body.data)).toBe(true);
    });

    afterAll(async () => {
      await h.prisma.holiday.deleteMany({ where: { name: { contains: h.fx.runId } } }).catch(() => 0);
    });
  });

  // -------------------------------------------------------------------- audit
  describe('audit logging', () => {
    it('writes MCP_TOOL rows for PREVIEW and SUCCESS', async () => {
      const name = `AuditHoliday ${h.fx.runId}`;
      await h.callOk(admin, 'holiday_create', { name, date: '2099-02-02' });
      await h.callOk(admin, 'holiday_create', { name, date: '2099-02-02', confirm: true });

      // Audit is fire-and-forget for non-destructive tools — poll until it lands.
      const rows = await pollRows(
        () =>
          h.prisma.auditLog.findMany({
            where: { userId: h.fx.globalAdmin.userId, action: 'MCP_TOOL', resourceType: 'Holiday' },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
        (rs) => {
          const outcomes = rs.map((r: any) => (r.newData as any)?.outcome);
          return outcomes.includes('PREVIEW') && outcomes.includes('SUCCESS');
        },
      );
      const outcomes = rows.map((r: any) => (r.newData as any)?.outcome);
      expect(outcomes).toEqual(expect.arrayContaining(['PREVIEW', 'SUCCESS']));
      expect((rows[0].newData as any)?.tool).toBe('holiday_create');

      await h.prisma.holiday.deleteMany({ where: { name } }).catch(() => 0);
    });

    it('records the actor and never leaks secrets in args', async () => {
      await h.callOk(admin, 'employee_list', { search: h.fx.runId });
      const rows = await pollRows(
        () =>
          h.prisma.auditLog.findMany({
            where: { userId: h.fx.globalAdmin.userId, action: 'MCP_TOOL', resourceType: 'Employee' },
            orderBy: { createdAt: 'desc' },
            take: 1,
          }),
        (rs) => rs.length > 0,
      );
      const row = rows[0];
      expect(row?.userId).toBe(h.fx.globalAdmin.userId);
      expect(JSON.stringify(row?.newData)).not.toMatch(/password|passwordHash|secret/i);
    });
  });

  // -------------------------------------------------- validation & edge cases
  describe('input validation & error handling', () => {
    it('rejects a malformed UUID argument', async () => {
      const r = await attempt(admin, 'employee_get', { id: 'not-a-uuid' });
      expect(r.isError).toBe(true);
    });

    it('rejects a missing required argument', async () => {
      const r = await attempt(admin, 'employee_get', {});
      expect(r.isError).toBe(true);
    });

    it('rejects an out-of-range number (payroll month 13)', async () => {
      const r = await attempt(admin, 'payroll_run', { month: 13, year: 2099 });
      expect(r.isError).toBe(true);
    });

    it('rejects an unknown enum value', async () => {
      const r = await attempt(admin, 'leave_request_list', { status: 'BOGUS' });
      expect(r.isError).toBe(true);
    });

    it('maps a not-found domain error to a 404 tool error (not a protocol crash)', async () => {
      const r = await h.call(admin, 'employee_get', { id: '00000000-0000-0000-0000-000000000000' });
      expect(r.isError).toBe(true);
      expect(r.body.error.status).toBe(404);
    });

    it('rejects an unknown tool name', async () => {
      const r = await attempt(admin, 'does_not_exist', {});
      expect(r.isError).toBe(true);
    });

    it('strips unknown/extra arguments (zod whitelist) without executing side effects', async () => {
      // employee_get ignores the injected extra field and still resolves the row.
      const body = await h.callOk(admin, 'employee_get', { id: h.fx.empAId, evil: 'DROP TABLE' } as any);
      expect(body.data?.id ?? body.id).toBe(h.fx.empAId);
    });
  });
});
