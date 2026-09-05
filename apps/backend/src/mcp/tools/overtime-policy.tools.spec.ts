import { OvertimePolicyTools } from './overtime-policy.tools';
import { McpToolDef } from '../tool.types';

describe('OvertimePolicyTools — MCP tool definitions', () => {
  let policies: any;
  let tools: Record<string, McpToolDef>;

  beforeEach(() => {
    policies = {
      list: jest.fn().mockResolvedValue({ success: true, data: [] }),
      get: jest.fn().mockResolvedValue({ success: true }),
      resolveForEmployee: jest.fn().mockResolvedValue({ success: true }),
      create: jest.fn().mockResolvedValue({ success: true }),
      update: jest.fn().mockResolvedValue({ success: true }),
      setDefault: jest.fn().mockResolvedValue({ success: true }),
      assign: jest.fn().mockResolvedValue({ success: true }),
      remove: jest.fn().mockResolvedValue({ success: true }),
    };
    const provider = new OvertimePolicyTools(policies);
    tools = Object.fromEntries(provider.getTools().map((t) => [t.name, t]));
  });

  it('exposes the full CRUD + resolve tool set with snake_case names', () => {
    expect(Object.keys(tools).sort()).toEqual(
      [
        'overtime_policy_assign',
        'overtime_policy_create',
        'overtime_policy_delete',
        'overtime_policy_get',
        'overtime_policy_list',
        'overtime_policy_resolve',
        'overtime_policy_set_default',
        'overtime_policy_update',
      ].sort(),
    );
  });

  it('classifies reads vs writes vs destructive correctly (drives the confirm gate)', () => {
    expect(tools.overtime_policy_list.kind).toBe('read');
    expect(tools.overtime_policy_get.kind).toBe('read');
    expect(tools.overtime_policy_resolve.kind).toBe('read');
    expect(tools.overtime_policy_create.kind).toBe('write');
    expect(tools.overtime_policy_update.kind).toBe('write');
    expect(tools.overtime_policy_set_default.kind).toBe('write');
    expect(tools.overtime_policy_assign.kind).toBe('write');
    expect(tools.overtime_policy_delete.kind).toBe('destructive');
  });

  it('gates writes to ADMIN (assign also HR_MANAGER); reads open to HR', () => {
    expect(tools.overtime_policy_create.roles).toEqual(['ADMIN']);
    expect(tools.overtime_policy_delete.roles).toEqual(['ADMIN']);
    expect(tools.overtime_policy_assign.roles).toEqual(['ADMIN', 'HR_MANAGER']);
    expect(tools.overtime_policy_list.roles).toContain('HR_MANAGER');
  });

  it('every write/destructive tool ships a preview (confirm-first card)', () => {
    for (const t of Object.values(tools)) {
      if (t.kind !== 'read') expect(typeof t.preview).toBe('function');
    }
  });

  it('all tools audit under the OvertimePolicy resource type', () => {
    for (const t of Object.values(tools)) {
      expect(t.auditResourceType).toBe('OvertimePolicy');
    }
  });

  it('employmentType is a free string (library label), not a fixed enum', () => {
    // A daily-wage label must be accepted by the create schema.
    const schema: any = tools.overtime_policy_create.inputSchema.employmentType;
    expect(schema.safeParse('Daily Wage').success).toBe(true);
    expect(schema.safeParse('Anything Custom').success).toBe(true);
  });

  const user = { id: 'u1', role: 'ADMIN' } as any;

  it('create delegates to the service with the actor id', async () => {
    await tools.overtime_policy_create.execute(
      { name: 'Daily Wage OT', rules: { holidayBehavior: 'IGNORE' } },
      user,
    );
    expect(policies.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Daily Wage OT' }),
      'u1',
    );
  });

  it('update strips id from the dto and passes it separately', async () => {
    await tools.overtime_policy_update.execute({ id: 'p1', name: 'New' }, user);
    expect(policies.update).toHaveBeenCalledWith('p1', { name: 'New' }, 'u1');
  });

  it('assign / set_default / delete / resolve delegate to the right methods', async () => {
    await tools.overtime_policy_assign.execute(
      { employeeId: 'e1', employmentType: 'Daily Wage' },
      user,
    );
    expect(policies.assign).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'e1' }),
      'u1',
    );

    await tools.overtime_policy_set_default.execute({ id: 'p1' }, user);
    expect(policies.setDefault).toHaveBeenCalledWith('p1', 'u1');

    await tools.overtime_policy_delete.execute({ id: 'p1' }, user);
    expect(policies.remove).toHaveBeenCalledWith('p1', 'u1');

    await tools.overtime_policy_resolve.execute({ employeeId: 'e9' }, user);
    expect(policies.resolveForEmployee).toHaveBeenCalledWith('e9');
  });
});
