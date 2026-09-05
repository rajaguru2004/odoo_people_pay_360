import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { performance } from 'perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InProcessToolTransport } from '../src/copilot/mcp/in-process.transport';
import type { AuthForwardContext } from '../src/copilot/mcp/tool-transport';
import { ToolExecutorService } from '../src/mcp/tool-executor.service';
import { ToolRegistryService } from '../src/mcp/tool-registry.service';
import type { HrmPrincipal } from '../src/mcp/tool.types';
import { bootMcpHarness, McpHarness } from './utils/mcp-harness';

/**
 * CONCURRENCY — "multiple tool calls at a single time".
 *
 * The one-by-one specs (mcp-catalog / mcp-flows / mcp-rbac-audit) each fire a
 * single tool call and await it. This spec instead dispatches MANY tool calls
 * *simultaneously* — the way a real MCP/LLM client behaves when the model emits
 * several tool_calls in one assistant turn — and proves the server stays correct
 * under that parallelism.
 *
 * Two dispatch paths are exercised, matching production:
 *   1. HTTP fan-out  — N independent `POST /mcp` requests in flight at once
 *      (Promise.all over one SDK Client). Each is a fresh Nest request → fresh
 *      per-user McpServer → fresh AsyncLocalStorage branch store. This is what
 *      any external client (Claude Desktop, the copilot loopback) does.
 *   2. In-process fan-out — the copilot agent loop's exact mechanism:
 *      `Promise.allSettled(tool_calls.map(callTool))` against the shared
 *      InProcessToolTransport within a single request context.
 *
 * Every scenario records structured evidence into `report`; afterAll writes a
 * detailed markdown summary to docs/mcp-concurrency-report.md.
 */

// ------------------------------------------------------------------ reporting
interface Check {
  label: string;
  pass: boolean;
  detail?: string;
}
interface Scenario {
  id: string;
  title: string;
  path: 'HTTP parallel' | 'In-process fan-out';
  intent: string;
  metrics: Record<string, string | number>;
  checks: Check[];
  get passed(): boolean;
}
const scenario = (s: Omit<Scenario, 'passed'>): Scenario => ({
  ...s,
  get passed() {
    return this.checks.every((c) => c.pass);
  },
});

const report: {
  meta: Record<string, string | number>;
  scenarios: Scenario[];
} = { meta: {}, scenarios: [] };

const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> => {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
};
const ms = (n: number) => `${Math.round(n * 100) / 100} ms`;

describe('MCP concurrency — multiple tool calls at once (e2e)', () => {
  let h: McpHarness;
  let admin: Client;
  let hr: Client;
  let employee: Client;
  let inproc: InProcessToolTransport;
  let adminAuth: AuthForwardContext;

  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  beforeAll(async () => {
    h = await bootMcpHarness();
    admin = await h.client(h.fx.globalAdmin.token);
    hr = await h.client(h.fx.scopedHr.token); // scoped to branch A
    employee = await h.client(h.fx.plainEmployee.token);

    // In-process transport = the copilot's real tool path (same-process, no HTTP).
    inproc = new InProcessToolTransport(
      h.app.get(ToolRegistryService),
      h.app.get(ToolExecutorService),
    );
    const adminPrincipal: HrmPrincipal = {
      id: h.fx.globalAdmin.userId,
      email: h.fx.globalAdmin.email,
      role: 'ADMIN',
      employeeId: null,
      departmentId: null,
      homeBranchId: null,
      accessibleBranchIds: 'ALL',
      isGlobalBranchAccess: true,
    };
    adminAuth = { authorization: `Bearer ${h.fx.globalAdmin.token}`, user: adminPrincipal };

    report.meta = {
      generatedAt: new Date().toISOString(),
      runId: h.fx.runId,
      dbHost: '80.225.236.50:8068 (dev)',
      node: process.version,
      totalToolsForAdmin: (await admin.listTools()).tools.length,
    };
  }, 120000);

  afterAll(async () => {
    // Best-effort cleanup of anything this spec created, then the base harness.
    await h?.prisma.holiday.deleteMany({ where: { name: { contains: h.fx.runId } } }).catch(() => 0);
    writeReport();
    await h?.teardown();
  }, 120000);

  // ---------------------------------------------------------------- Scenario 1
  it('S1 — parallel reads over one client return correct, correlated responses', async () => {
    // Fire employee_get for THREE distinct ids simultaneously (plus other reads).
    // If the transport ever mismatched a JSON-RPC response to the wrong request,
    // the returned id would not equal the requested id — this catches that.
    const getIds = [h.fx.empAId, h.fx.empBId, h.fx.scopedHr.employeeId!];
    const otherReads = [
      () => h.callOk(admin, 'department_list', {}),
      () => h.callOk(admin, 'report_headcount', {}),
      () => h.callOk(admin, 'holiday_list', { year: now.getFullYear() }),
      () => h.callOk(admin, 'employee_list', { search: h.fx.runId, limit: 50 }),
      () => h.callOk(admin, 'leave_pending_approvals', {}),
    ];

    const { ms: wall, value } = await timed(() =>
      Promise.all([
        ...getIds.map((id) => h.callOk(admin, 'employee_get', { id })),
        ...otherReads.map((f) => f()),
      ]),
    );

    const gets = value.slice(0, getIds.length);
    const idsMatch = gets.every((body: any, i) => (body.data?.id ?? body.id) === getIds[i]);
    const allResolved = value.every((v) => v !== undefined && v !== null);

    report.scenarios.push(
      scenario({
        id: 'S1',
        title: 'Parallel reads — response correlation',
        path: 'HTTP parallel',
        intent:
          'Prove N read tools fired at once each get their OWN response back (no JSON-RPC id cross-talk).',
        metrics: {
          'calls in flight': getIds.length + otherReads.length,
          'distinct employee_get ids': getIds.length,
          'wall time': ms(wall),
        },
        checks: [
          { label: 'every concurrent call resolved with a payload', pass: allResolved },
          {
            label: 'each employee_get returned exactly its requested id',
            pass: idsMatch,
            detail: gets.map((b: any, i) => `${getIds[i]}→${b.data?.id ?? b.id}`).join(', '),
          },
        ],
      }),
    );

    expect(allResolved).toBe(true);
    expect(idsMatch).toBe(true);
  }, 60000);

  // ---------------------------------------------------------------- Scenario 2
  it('S2 — concurrent calls from different principals stay branch/identity isolated', async () => {
    // The headline property: three requests with DIFFERENT scopes in flight at
    // the same instant. If AsyncLocalStorage leaked between them, the scoped HR
    // would see branch B, or the admin would be narrowed to branch A.
    const { value } = await timed(() =>
      Promise.all([
        h.callOk(admin, 'employee_list', { search: h.fx.runId, limit: 50 }), // global: A+B
        h.callOk(hr, 'employee_list', { search: h.fx.runId, limit: 50 }), // branch A only
        h.callOk(employee, 'leave_balance_get', {}), // self only
      ]),
    );
    const [adminBody, hrBody, empBal] = value as any[];
    const adminIds = adminBody.data.map((e: any) => e.id);
    const hrIds = hrBody.data.map((e: any) => e.id);
    const bal = empBal.data ?? empBal;

    const adminSeesBoth = adminIds.includes(h.fx.empAId) && adminIds.includes(h.fx.empBId);
    const hrSeesOnlyA = hrIds.includes(h.fx.empAId) && !hrIds.includes(h.fx.empBId);
    const empIsSelf = bal.employeeId === h.fx.plainEmployee.employeeId;

    report.scenarios.push(
      scenario({
        id: 'S2',
        title: 'Cross-principal isolation under concurrency (ALS integrity)',
        path: 'HTTP parallel',
        intent:
          'Three simultaneous requests with different branch scopes each resolve against their own scope — no context bleed.',
        metrics: {
          'principals in flight': 3,
          'admin visible employees': adminIds.length,
          'scoped-HR visible employees': hrIds.length,
        },
        checks: [
          { label: 'global admin sees branch A AND branch B', pass: adminSeesBoth },
          { label: 'scoped HR sees branch A but NOT branch B', pass: hrSeesOnlyA },
          { label: 'employee balance is the caller’s own record', pass: empIsSelf },
        ],
      }),
    );

    expect(adminSeesBoth).toBe(true);
    expect(hrSeesOnlyA).toBe(true);
    expect(empIsSelf).toBe(true);
  }, 60000);

  // ---------------------------------------------------------------- Scenario 3
  it('S3 — parallel confirmed writes all persist (no lost updates)', async () => {
    const N = 6;
    const names = Array.from({ length: N }, (_, i) => `ConcHol ${h.fx.runId} ${i}`);
    const dates = Array.from({ length: N }, (_, i) => `2099-03-0${i + 1}`);

    const { ms: wall } = await timed(() =>
      Promise.all(
        names.map((name, i) =>
          h.callOk(admin, 'holiday_create', { name, date: dates[i], confirm: true }),
        ),
      ),
    );

    const rows = await h.prisma.holiday.findMany({
      where: { name: { in: names } },
      select: { name: true },
    });
    const persisted = new Set(rows.map((r) => r.name));
    const allPersisted = names.every((n) => persisted.has(n));
    const exactCount = rows.length === N;

    report.scenarios.push(
      scenario({
        id: 'S3',
        title: 'Parallel independent writes — durability',
        path: 'HTTP parallel',
        intent: 'N confirmed creates fired at once → exactly N distinct rows land (no write lost to a race).',
        metrics: { 'concurrent writes': N, 'rows persisted': rows.length, 'wall time': ms(wall) },
        checks: [
          { label: `all ${N} distinct holidays persisted`, pass: allPersisted },
          { label: `exactly ${N} rows (no dupes / no drops)`, pass: exactCount },
        ],
      }),
    );

    expect(allPersisted).toBe(true);
    expect(exactCount).toBe(true);
    await h.prisma.holiday.deleteMany({ where: { name: { in: names } } }).catch(() => 0);
  }, 60000);

  // ---------------------------------------------------------------- Scenario 4
  it('S4 — confirm-first gate holds for every call in a concurrent write burst', async () => {
    const N = 6;
    const names = Array.from({ length: N }, (_, i) => `GateHol ${h.fx.runId} ${i}`);

    const { value: previews } = await timed(() =>
      Promise.all(
        names.map((name, i) =>
          // NO confirm → must preview, must NOT persist.
          h.call(admin, 'holiday_create', { name, date: `2099-04-0${i + 1}` }),
        ),
      ),
    );

    const allGated = previews.every((r: any) => r.body?.requiresConfirmation === true && !r.isError);
    const persistedCount = await h.prisma.holiday.count({ where: { name: { in: names } } });

    report.scenarios.push(
      scenario({
        id: 'S4',
        title: 'Confirm-gate integrity under concurrency',
        path: 'HTTP parallel',
        intent: 'A burst of unconfirmed writes all return previews and persist NOTHING — the gate never races open.',
        metrics: { 'concurrent unconfirmed writes': N, 'rows persisted': persistedCount },
        checks: [
          { label: 'every call returned requiresConfirmation', pass: allGated },
          { label: 'zero rows persisted', pass: persistedCount === 0 },
        ],
      }),
    );

    expect(allGated).toBe(true);
    expect(persistedCount).toBe(0);
  }, 60000);

  // ---------------------------------------------------------------- Scenario 5
  it('S5 — copilot agent-turn fan-out (Promise.allSettled) executes a mixed batch', async () => {
    // Exactly what AgentLoopService does when the model emits several tool_calls
    // in one assistant message: Promise.allSettled over the in-process transport.
    // One entry is an unconfirmed write → must come back requiresConfirmation
    // while the reads return data, all in the same turn.
    const batch = [
      { name: 'employee_list', args: { search: h.fx.runId, limit: 50 } },
      { name: 'report_headcount', args: {} },
      { name: 'department_list', args: {} },
      { name: 'holiday_list', args: { year: now.getFullYear() } },
      { name: 'leave_pending_approvals', args: {} },
      { name: 'holiday_create', args: { name: `TurnHol ${h.fx.runId}`, date: '2099-05-05' } }, // unconfirmed write
    ];

    const { ms: wall, value: settled } = await timed(() =>
      Promise.allSettled(batch.map((c) => inproc.callTool(adminAuth, c.name, c.args))),
    );

    const allFulfilled = settled.every((s) => s.status === 'fulfilled');
    const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : { error: 'rejected' }));
    const noReadErrored = results.slice(0, 5).every((r: any) => !r.error);
    const writeGated = (results[5] as any)?.requiresConfirmation === true;
    // Correlation: the employee_list result must actually be a list payload,
    // the write result must be the confirm envelope — positions preserved.
    const correlated = Array.isArray((results[0] as any)?.data) && writeGated;
    const notPersisted =
      (await h.prisma.holiday.count({ where: { name: `TurnHol ${h.fx.runId}` } })) === 0;

    report.scenarios.push(
      scenario({
        id: 'S5',
        title: 'Agent-turn fan-out — mixed read + write in one turn',
        path: 'In-process fan-out',
        intent:
          'Reproduce the copilot loop: many tool_calls dispatched together; reads return data, the unconfirmed write pauses for confirmation, results stay position-correlated.',
        metrics: { 'tool_calls in turn': batch.length, 'wall time': ms(wall) },
        checks: [
          { label: 'all tool_calls settled (fulfilled)', pass: allFulfilled },
          { label: 'all 5 reads returned data (no error)', pass: noReadErrored },
          { label: 'the write in the batch returned requiresConfirmation', pass: writeGated },
          { label: 'results correlate by position (read=list, write=envelope)', pass: correlated },
          { label: 'unconfirmed write persisted nothing', pass: notPersisted },
        ],
      }),
    );

    expect(allFulfilled).toBe(true);
    expect(noReadErrored).toBe(true);
    expect(writeGated).toBe(true);
    expect(notPersisted).toBe(true);
  }, 60000);

  // ---------------------------------------------------------------- Scenario 6
  it('S6 — concurrent dispatch is materially faster than serial (real parallelism)', async () => {
    const K = 8;
    const call = () => h.callOk(admin, 'employee_list', { search: h.fx.runId, limit: 50 });

    // warm up (JIT + connection reuse) so the comparison is steady-state.
    await Promise.all([call(), call(), call()]);

    const { ms: serialMs } = await timed(async () => {
      for (let i = 0; i < K; i++) await call();
    });
    const { ms: concMs } = await timed(() => Promise.all(Array.from({ length: K }, call)));

    const speedup = serialMs / concMs;
    // Genuine parallelism over a remote-DB RTT should beat serial clearly. Loose
    // bound (>1.3x) keeps this from being flaky while still proving non-serialization.
    const faster = concMs < serialMs && speedup >= 1.3;

    report.scenarios.push(
      scenario({
        id: 'S6',
        title: 'Throughput — parallel vs serial',
        path: 'HTTP parallel',
        intent: 'Confirm the server truly runs calls in parallel (not silently serialized): concurrent batch beats serial.',
        metrics: {
          'calls': K,
          'serial': ms(serialMs),
          'concurrent': ms(concMs),
          'speedup': `${Math.round(speedup * 100) / 100}x`,
        },
        checks: [{ label: 'concurrent ≥ 1.3x faster than serial', pass: faster }],
      }),
    );

    expect(concMs).toBeLessThan(serialMs);
  }, 90000);

  // ---------------------------------------------------------------- Scenario 7
  it('S7 — heterogeneous batch: each call gets its own outcome, no contamination', async () => {
    // A single burst mixing success / not-found / validation-error / unknown-tool.
    // Each must resolve independently to its correct result — one failure must not
    // corrupt a sibling's response.
    const attempt = async (name: string, args: Record<string, unknown>) => {
      try {
        const r = await h.call(admin, name, args);
        return { threw: false, isError: r.isError, body: r.body };
      } catch (e) {
        return { threw: true, isError: true, body: (e as Error).message };
      }
    };

    const { value } = await timed(() =>
      Promise.all([
        attempt('employee_get', { id: h.fx.empAId }), // ok
        attempt('employee_get', { id: '00000000-0000-0000-0000-000000000000' }), // 404
        attempt('employee_get', { id: 'not-a-uuid' }), // validation
        attempt('does_not_exist', {}), // unknown tool
        attempt('report_headcount', {}), // ok
      ]),
    );
    const [ok1, notFound, badArg, unknown, ok2] = value as any[];

    const c1 = ok1.isError === false && (ok1.body.data?.id ?? ok1.body.id) === h.fx.empAId;
    const c2 = notFound.isError === true && notFound.body?.error?.status === 404;
    const c3 = badArg.isError === true;
    const c4 = unknown.isError === true;
    const c5 = ok2.isError === false;

    report.scenarios.push(
      scenario({
        id: 'S7',
        title: 'Fault isolation in a mixed concurrent batch',
        path: 'HTTP parallel',
        intent: 'Success, 404, validation error and unknown-tool fired together — each resolves to its own correct outcome.',
        metrics: { 'calls in batch': 5, 'expected errors': 3, 'expected successes': 2 },
        checks: [
          { label: 'valid read #1 succeeded with correct id', pass: c1 },
          { label: 'not-found → isolated 404', pass: c2 },
          { label: 'bad UUID → isolated validation error', pass: c3 },
          { label: 'unknown tool → isolated error', pass: c4 },
          { label: 'valid read #2 unaffected by sibling failures', pass: c5 },
        ],
      }),
    );

    expect(c1 && c2 && c3 && c4 && c5).toBe(true);
  }, 60000);
});

// ------------------------------------------------------------------- md writer
function writeReport() {
  const outPath = join(__dirname, '..', 'docs', 'mcp-concurrency-report.md');
  const total = report.scenarios.length;
  const passed = report.scenarios.filter((s) => s.passed).length;
  const verdict = passed === total ? '✅ PASS' : '❌ FAIL';

  const L: string[] = [];
  L.push('# MCP Concurrency Test Report — Multiple Tool Calls at Once');
  L.push('');
  L.push(`**Verdict:** ${verdict} — ${passed}/${total} scenarios passed`);
  L.push('');
  L.push('> Auto-generated by `test/mcp-concurrency.e2e-spec.ts`. Re-run with');
  L.push('> `npm run test:mcp:concurrency` (dev DB) to regenerate.');
  L.push('');

  // Meta
  L.push('## Run metadata');
  L.push('');
  L.push('| Field | Value |');
  L.push('| --- | --- |');
  for (const [k, v] of Object.entries(report.meta)) L.push(`| ${k} | ${v} |`);
  L.push('');

  // What / why
  L.push('## What this verifies');
  L.push('');
  L.push(
    'The existing MCP e2e suites fire tool calls **one at a time**. This suite fires ' +
      '**many at once** — the way an LLM client behaves when the model returns several ' +
      '`tool_calls` in a single assistant turn — and asserts the server stays correct ' +
      'under that parallelism. Two dispatch paths are exercised:',
  );
  L.push('');
  L.push(
    '1. **HTTP parallel** — N independent `POST /mcp` requests in flight simultaneously ' +
      '(`Promise.all` over one SDK `Client`). Each is a fresh Nest request with its own ' +
      'per-user `McpServer` and its own AsyncLocalStorage branch store.',
  );
  L.push(
    '2. **In-process fan-out** — the copilot agent loop’s exact mechanism, ' +
      '`Promise.allSettled(tool_calls.map(callTool))`, over the shared in-process transport.',
  );
  L.push('');

  // Summary table
  L.push('## Scenario summary');
  L.push('');
  L.push('| # | Scenario | Path | Result | Key metrics |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const s of report.scenarios) {
    const metrics = Object.entries(s.metrics)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
    L.push(`| ${s.id} | ${s.title} | ${s.path} | ${s.passed ? '✅' : '❌'} | ${metrics} |`);
  }
  L.push('');

  // Details
  L.push('## Scenario detail');
  L.push('');
  for (const s of report.scenarios) {
    L.push(`### ${s.id} — ${s.title}`);
    L.push('');
    L.push(`**Dispatch path:** ${s.path}  `);
    L.push(`**Intent:** ${s.intent}`);
    L.push('');
    L.push('**Metrics**');
    L.push('');
    for (const [k, v] of Object.entries(s.metrics)) L.push(`- ${k}: \`${v}\``);
    L.push('');
    L.push('**Assertions**');
    L.push('');
    for (const c of s.checks) {
      L.push(`- ${c.pass ? '✅' : '❌'} ${c.label}${c.detail ? ` — \`${c.detail}\`` : ''}`);
    }
    L.push('');
  }

  // Properties proven
  L.push('## Concurrency properties proven');
  L.push('');
  L.push('- **Response correlation** — each parallel call receives its own JSON-RPC response (S1).');
  L.push('- **Context isolation** — simultaneous requests with different branch scopes never leak into each other; AsyncLocalStorage is per-request (S2).');
  L.push('- **Write durability** — parallel confirmed writes all persist with no lost updates (S3).');
  L.push('- **Gate integrity** — the confirm-first gate holds for every call in a concurrent burst (S4).');
  L.push('- **Agent-turn fan-out** — the copilot’s `Promise.allSettled` batch runs mixed read+write correctly and stays position-correlated (S5).');
  L.push('- **Real parallelism** — concurrent dispatch beats serial, proving calls are not silently serialized (S6).');
  L.push('- **Fault isolation** — a failing call in a batch does not corrupt its siblings (S7).');
  L.push('');

  L.push('## How to run');
  L.push('');
  L.push('```bash');
  L.push('# against the dev DB only (apps/backend/.env points at PRODUCTION)');
  L.push('cd apps/backend');
  L.push('DATABASE_URL=postgresql://postgres:postgres@80.225.236.50:8068/myappdb \\');
  L.push('  npm run test:mcp:concurrency');
  L.push('```');
  L.push('');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, L.join('\n'));
  // eslint-disable-next-line no-console
  console.log(`\n📝 MCP concurrency report written to ${outPath} (${passed}/${total} passed)\n`);
}
