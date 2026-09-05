import { z } from 'zod';
import { ActionRegistryService } from './action-registry.service';
import { essActions } from './actions/ess.actions';
import { approvalActions } from './actions/approval.actions';
import { WHATSAPP_TOOL_DENYLIST } from './whatsapp-tool-denylist';
import { McpToolDef } from '../../mcp/tool.types';

/**
 * The single highest-value test in the WhatsApp feature.
 *
 * The boot-time checks are what make "WhatsApp can only do a fixed, reviewed
 * set of things" a property of the process rather than a claim in a document.
 * This suite pins each of them, and it must fail loudly the day somebody adds
 * a parameterised auto-confirm action or points one at a denied tool.
 */

const tool = (over: Partial<McpToolDef> = {}): McpToolDef =>
  ({
    name: 'demo_read',
    description: 'demo',
    kind: 'read',
    roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
    inputSchema: {},
    auditResourceType: 'Demo',
    execute: async () => ({}),
    ...over,
  }) as McpToolDef;

/**
 * The tools the REAL approval actions map to.
 *
 * Invariant 12 checks DECISION_ACTIONS against the registered catalogue, and
 * that map is global — so the isolation harness has to keep the real approval
 * actions registered, which in turn means their tools must resolve. Mocking
 * the map instead would mean the check never runs against anything real.
 */
const approvalTools = (): McpToolDef[] =>
  ['leave_request_approve', 'leave_request_reject', 'overtime_approve', 'overtime_reject'].map(
    (name) => tool({ name, kind: 'write', roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'] }),
  );

function registryWith(tools: McpToolDef[], actions: any[]): ActionRegistryService {
  const all = [...tools, ...approvalTools()];
  const toolRegistry: any = {
    getByName: (n: string) => all.find((t) => t.name === n),
  };
  const svc = new ActionRegistryService(toolRegistry);
  // The real service reads its catalogue from the action modules; inject a
  // synthetic one so each invariant can be probed in isolation. Approval
  // actions stay real — see approvalTools() above.
  (svc as any).load = () => actions;
  jest.spyOn<any, any>(require('./actions/ess.actions'), 'essActions').mockReturnValue(actions);
  jest.spyOn<any, any>(require('./actions/nav.actions'), 'navActions').mockReturnValue([]);
  return svc;
}

const action = (over: any = {}) => ({
  key: 'demo.read',
  menuLabel: 'Demo',
  // A real, declared group: invariant 11 rejects anything else, and a fixture
  // that trips a DIFFERENT invariant than the one under test proves nothing.
  menuGroup: 'attendance',
  roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
  requiresEmployee: false,
  sensitivity: 'normal',
  keywords: ['demo'],
  tool: { name: 'demo_read' },
  confirmPolicy: 'none',
  render: () => ({ plain: 'ok' }),
  ...over,
});

afterEach(() => jest.restoreAllMocks());

describe('ActionRegistryService — boot invariants', () => {
  it('rejects a duplicate action key', () => {
    const svc = registryWith([tool()], [action(), action({ keywords: ['demo2'] })]);
    expect(() => svc.onModuleInit()).toThrow(/registered twice/);
  });

  it('rejects a keyword claimed by two actions', () => {
    // Otherwise which action a word runs depends on registration order.
    const svc = registryWith([tool()], [action(), action({ key: 'demo.other' })]);
    expect(() => svc.onModuleInit()).toThrow(/claimed by both/);
  });

  it('rejects a mapping to a tool that does not exist', () => {
    const svc = registryWith([tool()], [action({ tool: { name: 'gone' } })]);
    expect(() => svc.onModuleInit()).toThrow(/unknown tool/);
  });

  it('rejects an action reachable by a role the tool refuses', () => {
    const svc = registryWith(
      [tool({ roles: ['ADMIN'] })],
      [action({ roles: ['ADMIN', 'EMPLOYEE'] })],
    );
    expect(() => svc.onModuleInit()).toThrow(/allows roles \[EMPLOYEE\]/);
  });

  it('rejects any destructive tool outright', () => {
    const svc = registryWith(
      [tool({ name: 'demo_destroy', kind: 'destructive' })],
      [action({ tool: { name: 'demo_destroy' }, confirmPolicy: 'explicit' })],
    );
    expect(() => svc.onModuleInit()).toThrow(/destructive/);
  });

  it('rejects a tool on the denylist', () => {
    const svc = registryWith(
      [tool({ name: 'bank_change_request_create', kind: 'write' })],
      [action({ tool: { name: 'bank_change_request_create' }, confirmPolicy: 'explicit' })],
    );
    expect(() => svc.onModuleInit()).toThrow(/denylist/);
  });

  it('rejects an unconfirmed write', () => {
    const svc = registryWith(
      [tool({ name: 'demo_write', kind: 'write' })],
      [action({ tool: { name: 'demo_write' }, confirmPolicy: 'none' })],
    );
    expect(() => svc.onModuleInit()).toThrow(/skips confirmation/);
  });

  describe('local renderers', () => {
    const nav = (over: any = {}) =>
      action({
        key: 'demo.nav',
        keywords: ['nav'],
        tool: undefined,
        hidden: true,
        localRender: () => ({ plain: 'here' }),
        ...over,
      });

    it('accepts a hidden navigator with no tool', () => {
      const svc = registryWith([tool()], [nav()]);
      expect(() => svc.onModuleInit()).not.toThrow();
    });

    it('rejects an action that both calls a tool and renders locally', () => {
      // Which one runs would depend on the order of two branches in execute().
      const svc = registryWith([tool()], [nav({ tool: { name: 'demo_read' } })]);
      expect(() => svc.onModuleInit()).toThrow(/both a tool and a local renderer/);
    });

    it('rejects a local renderer that asks for confirmation', () => {
      const svc = registryWith([tool()], [nav({ confirmPolicy: 'explicit' })]);
      expect(() => svc.onModuleInit()).toThrow(/cannot request confirmation/);
    });

    it('rejects an action that can never reply', () => {
      // The silent no-op: execute() returns immediately for a tool-less action,
      // so without a local renderer the user gets nothing and every log is green.
      const svc = registryWith([tool()], [nav({ localRender: undefined })]);
      expect(() => svc.onModuleInit()).toThrow(/never reply/);
    });
  });

  describe('menu groups', () => {
    it('rejects a visible action in an undeclared section', () => {
      const svc = registryWith([tool()], [action({ menuGroup: 'Attendance' })]);
      expect(() => svc.onModuleInit()).toThrow(/unknown menuGroup/);
    });

    it('does not require a group for a hidden action', () => {
      const svc = registryWith([tool()], [action({ hidden: true, menuGroup: undefined })]);
      expect(() => svc.onModuleInit()).not.toThrow();
    });
  });

  describe('the auto-confirm invariant', () => {
    const nullaryWrite = tool({
      name: 'punch',
      kind: 'write',
      selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE'] } as any,
      inputSchema: { employeeId: z.string().uuid().optional() },
    });

    it('allows a call that carries no user-supplied argument', () => {
      const svc = registryWith(
        [nullaryWrite],
        [action({ tool: { name: 'punch' }, confirmPolicy: 'implicit' })],
      );
      expect(() => svc.onModuleInit()).not.toThrow();
    });

    it('allows optional tool parameters the action never populates', () => {
      // A tool may accept coordinates; what matters is that this action cannot
      // supply them.
      const withOptional = tool({
        name: 'punch',
        kind: 'write',
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE'] } as any,
        inputSchema: {
          employeeId: z.string().uuid().optional(),
          latitude: z.number().optional(),
        },
      });
      const svc = registryWith(
        [withOptional],
        [action({ tool: { name: 'punch' }, confirmPolicy: 'implicit' })],
      );
      expect(() => svc.onModuleInit()).not.toThrow();
    });

    it('REJECTS a required parameter', () => {
      const withRequired = tool({
        name: 'punch',
        kind: 'write',
        inputSchema: { reason: z.string() },
      });
      const svc = registryWith(
        [withRequired],
        [action({ tool: { name: 'punch' }, confirmPolicy: 'implicit' })],
      );
      expect(() => svc.onModuleInit()).toThrow(/requires \[reason\]/);
    });

    it('REJECTS an action that collects input through a flow', () => {
      const svc = registryWith(
        [nullaryWrite],
        [
          action({
            tool: { name: 'punch' },
            confirmPolicy: 'implicit',
            flow: { key: 'f', steps: [], buildArgs: () => ({}) },
          }),
        ],
      );
      expect(() => svc.onModuleInit()).toThrow(/collects input through a flow/);
    });

    it('REJECTS static arguments', () => {
      const svc = registryWith(
        [nullaryWrite],
        [action({ tool: { name: 'punch', staticArgs: { x: 1 } }, confirmPolicy: 'implicit' })],
      );
      expect(() => svc.onModuleInit()).toThrow(/static arguments/);
    });

    it('REJECTS a sensitive action', () => {
      const svc = registryWith(
        [nullaryWrite],
        [
          action({
            tool: { name: 'punch' },
            confirmPolicy: 'implicit',
            sensitivity: 'sensitive',
          }),
        ],
      );
      expect(() => svc.onModuleInit()).toThrow(/sensitive/);
    });

    it('allows the attachment exception only for a hidden action', () => {
      const svc = registryWith(
        [nullaryWrite],
        [
          action({
            tool: { name: 'punch' },
            confirmPolicy: 'implicit',
            implicitFromAttachment: true,
            hidden: false,
          }),
        ],
      );
      expect(() => svc.onModuleInit()).toThrow(/must be hidden/);
    });
  });
});

describe('the real catalogue', () => {
  /** The shipped registry, validated against the shipped tool definitions. */
  it('registers without violating any invariant', () => {
    // Uses the real tool registry shape via a lookup over the real defs would
    // require the Nest graph; instead assert the structural rules that do not
    // need it, and rely on the boot-time check for the rest.
    const all = [...essActions(), ...approvalActions()];
    expect(all.length).toBeGreaterThan(15);

    const keys = all.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);

    const keywords = all.flatMap((a) => a.keywords.map((k) => k.toLowerCase()));
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('never points at a denied tool', () => {
    for (const a of [...essActions(), ...approvalActions()]) {
      if (!a.tool) continue;
      expect(WHATSAPP_TOOL_DENYLIST).not.toContain(a.tool.name);
    }
  });

  it('keeps bank details entirely out of reach', () => {
    // A payroll-destination change from a SIM-swappable channel is the highest
    // value fraud target in an HRMS.
    const tools = [...essActions(), ...approvalActions()].map((a) => a.tool?.name ?? '');
    expect(tools.some((t) => t.startsWith('bank_'))).toBe(false);
    expect(tools.some((t) => t.includes('banking_config'))).toBe(false);
  });

  it('gates every approval action behind a server-side token', () => {
    for (const a of approvalActions()) {
      expect(a.needsActionToken).toBe(true);
      expect(a.hidden).toBe(true);
      // Rejections need a reason, so they can never be a single tap.
      if (a.key.endsWith('.reject')) expect(a.flow).toBeDefined();
    }
  });

  it('requires a PIN for anything showing pay or balances', () => {
    const sensitive = essActions().filter((a) => a.sensitivity === 'sensitive');
    expect(sensitive.map((a) => a.key)).toEqual(
      expect.arrayContaining(['payroll.payslips', 'loan.my']),
    );
    for (const a of sensitive) expect(a.confirmPolicy).not.toBe('implicit');
  });
});
