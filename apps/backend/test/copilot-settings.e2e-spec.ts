import { bootMcpHarness, McpHarness } from './utils/mcp-harness';
import { bearer } from './utils/fixtures';

/**
 * Settings API round-trip: DB persistence, API-key encryption at rest, RBAC,
 * and the live MCP kill-switch. Snapshots and restores any pre-existing
 * mcp.* / copilot.* rows so it never clobbers real configuration.
 */
describe('Copilot settings (e2e)', () => {
  let h: McpHarness;
  let snapshot: { key: string; value: string }[] = [];

  const isCopilotKey = (k: string) => k.startsWith('mcp.') || k.startsWith('copilot.');

  beforeAll(async () => {
    h = await bootMcpHarness();
    snapshot = (
      await h.prisma.systemSetting.findMany({
        where: { OR: [{ key: { startsWith: 'mcp.' } }, { key: { startsWith: 'copilot.' } }] },
      })
    ).map((r) => ({ key: r.key, value: r.value }));
  }, 120000);

  afterAll(async () => {
    // Restore exactly: wipe our keys, then re-create the snapshot.
    await h.prisma.systemSetting
      .deleteMany({ where: { OR: [{ key: { startsWith: 'mcp.' } }, { key: { startsWith: 'copilot.' } }] } })
      .catch(() => 0);
    for (const row of snapshot.filter((r) => isCopilotKey(r.key))) {
      await h.prisma.systemSetting.create({ data: row }).catch(() => 0);
    }
    await h?.teardown();
  }, 120000);

  const adminGet = () => h.ctx.http().get('/copilot-settings').set(bearer(h.fx.globalAdmin.token));
  const adminPut = (body: any) =>
    h.ctx.http().put('/copilot-settings').set(bearer(h.fx.globalAdmin.token)).send(body);

  it('is ADMIN-only', async () => {
    expect((await h.ctx.http().get('/copilot-settings')).status).toBe(401);
    expect((await h.ctx.http().get('/copilot-settings').set(bearer(h.fx.scopedHr.token))).status).toBe(403);
    expect((await adminGet()).status).toBe(200);
  });

  it('returns a masked config (never the raw key)', async () => {
    const res = await adminGet();
    const d = res.body.data;
    expect(d).toHaveProperty('mcpEnabled');
    expect(d).toHaveProperty('models');
    expect(d).not.toHaveProperty('llmApiKey');
    expect(d).toHaveProperty('llmApiKeyConfigured');
  });

  it('persists an update and encrypts the API key at rest', async () => {
    const res = await adminPut({
      llmApiKey: 'sk-test-secret-9999',
      models: ['alpha/model:free', 'beta/model'],
      mcpMaxItems: 25,
      maxIterations: 5,
      modelOverride: 'openai/gpt-4o-mini',
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.llmApiKeyConfigured).toBe(true);
    expect(d.llmApiKeyMasked).toBe('••••9999');
    expect(d.models).toEqual(['alpha/model:free', 'beta/model']);
    expect(d.mcpMaxItems).toBe(25);
    expect(JSON.stringify(d)).not.toContain('sk-test-secret-9999');

    // stored value is ciphertext, not plaintext
    const row = await h.prisma.systemSetting.findUnique({ where: { key: 'copilot.llmApiKeyEnc' } });
    expect(row?.value).toMatch(/^v1:/);
    expect(row?.value).not.toContain('sk-test-secret-9999');

    // survives a re-read
    const again = (await adminGet()).body.data;
    expect(again.models).toEqual(['alpha/model:free', 'beta/model']);
    expect(again.modelOverride).toBe('openai/gpt-4o-mini');
    expect(again.maxIterations).toBe(5);
  });

  it('keeps the key on omit and removes it on clearApiKey', async () => {
    // omit → unchanged
    await adminPut({ mcpAuditReads: false });
    expect((await adminGet()).body.data.llmApiKeyConfigured).toBe(true);

    // clear → the stored encrypted row is gone
    const res = await adminPut({ clearApiKey: true });
    expect(res.status).toBe(200);
    const row = await h.prisma.systemSetting.findUnique({ where: { key: 'copilot.llmApiKeyEnc' } });
    expect(row).toBeNull();
  });

  it('available-models responds (live or fallback), honoring overrides', async () => {
    const res = await h.ctx
      .http()
      .post('/copilot-settings/available-models')
      .set(bearer(h.fx.globalAdmin.token))
      .send({ baseUrl: 'https://invalid.invalid.example/v1', apiKey: 'sk-bogus' });
    expect(res.status).toBe(201);
    expect(['live', 'fallback']).toContain(res.body.data.source);
    expect(Array.isArray(res.body.data.models)).toBe(true);
    // unreachable override → fallback with a reason
    expect(res.body.data.source).toBe('fallback');
    expect(typeof res.body.data.message).toBe('string');
  });

  it('test-connection is ADMIN-only and reports failure for an unreachable endpoint', async () => {
    expect((await h.ctx.http().post('/copilot-settings/test-connection').set(bearer(h.fx.scopedHr.token)).send({})).status).toBe(403);

    const res = await h.ctx
      .http()
      .post('/copilot-settings/test-connection')
      .set(bearer(h.fx.globalAdmin.token))
      .send({ baseUrl: 'https://invalid.invalid.example/v1', apiKey: 'sk-bogus', model: 'x/y' });
    expect(res.status).toBe(201);
    expect(res.body.data.ok).toBe(false);
    expect(typeof res.body.data.message).toBe('string');
  });

  it('the MCP enabled flag is live — disabling it 404s /mcp, re-enabling restores it', async () => {
    await adminPut({ mcpEnabled: false });
    // settings cache TTL is 30s; wait it out so the controller sees the change.
    await new Promise((r) => setTimeout(r, 31_000));
    const disabled = await h.ctx
      .http()
      .post('/mcp')
      .set(bearer(h.fx.globalAdmin.token))
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(disabled.status).toBe(404);

    await adminPut({ mcpEnabled: true });
    await new Promise((r) => setTimeout(r, 31_000));
    const enabled = await h.ctx
      .http()
      .post('/mcp')
      .set(bearer(h.fx.globalAdmin.token))
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(enabled.status).toBe(200);
  }, 90000);
});
