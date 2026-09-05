import { performance } from 'perf_hooks';
import { InProcessToolTransport } from '../src/copilot/mcp/in-process.transport';
import { McpHttpToolTransport } from '../src/copilot/mcp/mcp-http.transport';
import type { AuthForwardContext } from '../src/copilot/mcp/tool-transport';
import { ToolExecutorService } from '../src/mcp/tool-executor.service';
import { ToolRegistryService } from '../src/mcp/tool-registry.service';
import type { HrmPrincipal } from '../src/mcp/tool.types';
import { bootMcpHarness, McpHarness } from './utils/mcp-harness';

/**
 * Performance: the copilot's tool path, HTTP-loopback (current) vs in-process
 * (optimized). Prints a before/after table (median + p95) and asserts the
 * in-process transport is materially faster. Not a strict CI gate — timings are
 * environment-dependent — but the improvement factor is stable and large.
 */
describe('MCP tool transport performance (e2e)', () => {
  let h: McpHarness;
  let http: McpHttpToolTransport;
  let inproc: InProcessToolTransport;
  let httpAuth: AuthForwardContext;
  let inprocAuth: AuthForwardContext;

  const WARMUP = 3;
  const N = 12;
  const SEQ = 3; // tool calls per simulated agent turn

  beforeAll(async () => {
    h = await bootMcpHarness();

    // In-process transport: call the registry/executor directly.
    inproc = new InProcessToolTransport(
      h.app.get(ToolRegistryService),
      h.app.get(ToolExecutorService),
    );

    // HTTP transport pointed at this test app's real /mcp route.
    http = new McpHttpToolTransport({
      get: async () => ({ mcpLoopbackUrl: `${h.baseUrl}/mcp` }),
    } as any);

    httpAuth = { authorization: `Bearer ${h.fx.globalAdmin.token}` };
    const admin: HrmPrincipal = {
      id: h.fx.globalAdmin.userId,
      email: h.fx.globalAdmin.email,
      role: 'ADMIN',
      employeeId: null,
      departmentId: null,
      homeBranchId: null,
      accessibleBranchIds: 'ALL',
      isGlobalBranchAccess: true,
    };
    inprocAuth = { authorization: '', user: admin };
  }, 120000);

  afterAll(async () => {
    await h?.teardown();
  }, 120000);

  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  async function measure(label: string, fn: () => Promise<unknown>) {
    for (let i = 0; i < WARMUP; i++) await fn();
    const xs: number[] = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      await fn();
      xs.push(performance.now() - t);
    }
    return { label, p50: pct(xs, 50), p95: pct(xs, 95), mean: mean(xs) };
  }

  const round = (n: number) => Math.round(n * 100) / 100;

  it('compares HTTP-loopback vs in-process for the copilot tool path', async () => {
    const listArgs = { search: h.fx.runId, limit: 50 };

    const ops = [
      {
        op: 'callTool employee_list',
        http: () => http.callTool(httpAuth, 'employee_list', listArgs),
        inproc: () => inproc.callTool(inprocAuth, 'employee_list', listArgs),
      },
      {
        op: 'listTools',
        http: () => http.listTools(httpAuth),
        inproc: () => inproc.listTools(inprocAuth),
      },
      {
        op: `agent turn (${SEQ} sequential calls)`,
        http: async () => {
          for (let i = 0; i < SEQ; i++) await http.callTool(httpAuth, 'employee_list', listArgs);
        },
        inproc: async () => {
          for (let i = 0; i < SEQ; i++) await inproc.callTool(inprocAuth, 'employee_list', listArgs);
        },
      },
    ];

    const rows: any[] = [];
    for (const o of ops) {
      const hh = await measure(`http:${o.op}`, o.http);
      const ip = await measure(`inproc:${o.op}`, o.inproc);
      rows.push({
        op: o.op,
        'http p50 (ms)': round(hh.p50),
        'http p95 (ms)': round(hh.p95),
        'in-proc p50 (ms)': round(ip.p50),
        'in-proc p95 (ms)': round(ip.p95),
        'speedup (p50)': `${round(hh.p50 / ip.p50)}x`,
        'saved/call (ms)': round(hh.p50 - ip.p50),
      });
    }

    // eslint-disable-next-line no-console
    console.table(rows);

    // Sanity: verify both transports return real data (not empty/errored).
    const viaHttp = await http.callTool(httpAuth, 'employee_list', listArgs);
    const viaInproc = await inproc.callTool(inprocAuth, 'employee_list', listArgs);
    expect(Array.isArray(viaHttp.data)).toBe(true);
    expect(Array.isArray(viaInproc.data)).toBe(true);
    // in-process listTools exposes real input schemas (properties present)
    const tools = await inproc.listTools(inprocAuth);
    const del = tools.find((t) => t.name === 'employee_delete');
    expect((del?.inputSchema as any)?.properties?.id).toBeDefined();
    expect((del?.inputSchema as any)?.properties?.confirm).toBeDefined();

    // The whole point: in-process is materially faster on every op.
    for (const r of rows) {
      expect(r['in-proc p50 (ms)']).toBeLessThan(r['http p50 (ms)']);
    }
  }, 170000);
});
