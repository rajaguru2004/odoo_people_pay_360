import { z } from 'zod';
import { McpToolDef, Role } from '../../mcp/tool.types';
import { AnalyticsTools } from '../../mcp/tools/analytics.tools';
import { ApprovalsTools } from '../../mcp/tools/approvals.tools';
import { AssetsTools } from '../../mcp/tools/assets.tools';
import { AttendanceTools } from '../../mcp/tools/attendance.tools';
import { DepartmentTools } from '../../mcp/tools/departments.tools';
import { EmployeeTools } from '../../mcp/tools/employees.tools';
import { HolidayTools } from '../../mcp/tools/holidays.tools';
import { LeaveTools } from '../../mcp/tools/leave.tools';
import { OvertimePolicyTools } from '../../mcp/tools/overtime-policy.tools';
import { OvertimeTools } from '../../mcp/tools/overtime.tools';
import { PayrollTools } from '../../mcp/tools/payroll.tools';
import { ProjectTools } from '../../mcp/tools/projects.tools';
import { ReportTools } from '../../mcp/tools/reports.tools';
import { ShiftTools } from '../../mcp/tools/shifts.tools';
import { SupervisorTools } from '../../mcp/tools/supervisor.tools';
import { TaskTools } from '../../mcp/tools/tasks.tools';
import { TrainingTools } from '../../mcp/tools/training.tools';
import { VisaTools } from '../../mcp/tools/visa.tools';
import { essActions } from './actions/ess.actions';
import { approvalActions } from './actions/approval.actions';
import { navActions } from './actions/nav.actions';
import { RenderCtx, WhatsAppActionDef } from './action.types';

/**
 * Every action must be able to CALL its tool.
 *
 * The bug this exists to make impossible: `calendar.my` mapped to
 * `employee_calendar_get`, which requires startDate and endDate, and the
 * channel supplied neither. Tapping "My schedule" answered with raw zod:
 *
 *   startDate: Invalid input: expected string, received undefined
 *
 * Nothing caught it, because the boot invariants check that the tool EXISTS
 * and that roles line up — never that the arguments the channel actually sends
 * satisfy the schema. So this file reconstructs the real call for every
 * action and validates it against the real zod shape, exactly as
 * ToolCallerService would.
 *
 * A missing argument is a user-facing failure in a chat, where there is no
 * form to correct and no field to highlight. It should fail here instead.
 */

/** The argument construction in whatsapp-inbound execute(), reproduced. */
function argsFor(action: WhatsAppActionDef, ctx: RenderCtx, flowSlots: Record<string, unknown>) {
  return {
    ...(action.tool?.staticArgs ?? {}),
    ...(action.tool?.dynamicArgs?.(ctx) ?? {}),
    ...(action.flow ? action.flow.buildArgs(flowSlots) : {}),
  };
}

/**
 * Plausible answers for every flow slot in the catalogue.
 *
 * Deliberately hand-written rather than generated: a flow's parse step decides
 * the SHAPE of what lands in the slot, and inventing values from the zod
 * schema instead would test the schema against itself.
 */
const FLOW_ANSWERS: Record<string, unknown> = {
  leaveType: 'ANNUAL',
  startDate: '2026-09-01',
  endDate: '2026-09-03',
  reason: 'Family function',
  search: 'raja',
  type: 'Travel',
  amount: 1250,
  expenseDate: '2026-08-01',
  description: 'Client visit cab fare',
  date: '2026-08-01',
  checkIn: '09:15',
  checkOut: '18:00',
  comment: 'Approved',
};

const ctx: RenderCtx = {
  recipientName: 'Raja Guru',
  employeeId: '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607',
  appBaseUrl: 'https://hr.example.com',
  currencySymbol: '₹',
  timeZone: 'Asia/Kolkata',
  args: {},
};

/** The id the executor injects for a self-scoped tool. */
const CALLER_EMPLOYEE = ctx.employeeId!;

/**
 * Every tool provider that ships, instantiated WITHOUT Nest.
 *
 * `inputSchema` is declared statically on each definition, so the injected
 * services are never touched by this test — and booting McpModule for real
 * drags in ConfigService, Prisma and a TensorFlow-backed module, which is a
 * lot of machinery to assert a zod shape.
 *
 * Listing the classes is deliberate: if a provider is added to McpModule and
 * not here, the coverage assertion at the bottom notices.
 */
const PROVIDERS = [
  AnalyticsTools,
  ApprovalsTools,
  AssetsTools,
  AttendanceTools,
  DepartmentTools,
  EmployeeTools,
  HolidayTools,
  LeaveTools,
  OvertimePolicyTools,
  OvertimeTools,
  PayrollTools,
  ProjectTools,
  ReportTools,
  ShiftTools,
  SupervisorTools,
  TaskTools,
  TrainingTools,
  VisaTools,
];

/** Answers any property access, so a constructor can never fail on a stub. */
const stub: any = new Proxy(() => stub, {
  get: () => stub,
  apply: () => stub,
});

function buildToolIndex(): Map<string, McpToolDef> {
  const index = new Map<string, McpToolDef>();
  for (const Cls of PROVIDERS) {
    const instance = new (Cls as any)(...Array(12).fill(stub));
    for (const def of instance.getTools() as McpToolDef[]) index.set(def.name, def);
  }
  return index;
}

describe('every action can call its tool', () => {
  const tools = buildToolIndex();

  const catalogue = [...essActions(), ...approvalActions(), ...navActions()].filter(
    (a) => a.tool,
  );

  it.each(catalogue.map((a) => [a.key, a] as const))(
    '%s satisfies its tool schema',
    (_key, action) => {
      const def = tools.get(action.tool!.name) as McpToolDef;
      expect(def).toBeDefined();

      const slots = Object.fromEntries(
        (action.flow?.steps ?? []).map((s) => [s.slot, FLOW_ANSWERS[s.slot]]),
      );
      // Every slot the catalogue uses must have a fixture, or this test would
      // pass by feeding `undefined` to an optional field and prove nothing.
      for (const step of action.flow?.steps ?? []) {
        expect(FLOW_ANSWERS).toHaveProperty(step.slot);
      }

      let args: Record<string, unknown> = argsFor(action, ctx, slots);

      // Self-scope injection, as ToolExecutorService does it for the roles the
      // action is reachable by.
      if (def.selfScope && action.roles.some((r) => def.selfScope!.forRoles.includes(r as Role))) {
        args = { ...args, [def.selfScope.param]: CALLER_EMPLOYEE };
      }

      // The approval actions get their resource id from a server-side token
      // row, never from the wire — so supply what the token would carry.
      if (action.needsActionToken) {
        args = { ...args, id: '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b' };
      }

      // Writes carry confirm:true by the time they reach the schema.
      if (action.confirmPolicy !== 'none') args = { ...args, confirm: true };

      const shape = z.object(def.inputSchema as any).passthrough();
      const result = shape.safeParse(args);

      if (!result.success) {
        // Name the missing fields — "invalid" alone sends the reader hunting.
        const detail = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new Error(
          `${action.key} -> ${action.tool!.name} cannot be called with what the channel sends.\n` +
            `  sent : ${JSON.stringify(args)}\n` +
            `  fails: ${detail}`,
        );
      }
    },
  );

  it('covers every action that maps to a tool', () => {
    // Guards against the catalogue or the provider list silently shrinking.
    expect(catalogue.length).toBeGreaterThanOrEqual(20);
    expect(tools.size).toBeGreaterThanOrEqual(120);
  });
});
