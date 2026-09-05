import { NotFoundException } from '@nestjs/common';
import { runWithBranchStore, setBranchContext } from '../common/branch/branch-context';
import { ToolExecutorService } from './tool-executor.service';
import { HrmPrincipal, McpToolDef } from './tool.types';

describe('ToolExecutorService', () => {
  let executor: ToolExecutorService;
  let auditLog: jest.Mock;

  const admin: HrmPrincipal = {
    id: 'user-admin',
    email: 'admin@test.local',
    role: 'ADMIN',
    employeeId: 'emp-admin',
    departmentId: null,
    homeBranchId: null,
    accessibleBranchIds: 'ALL',
    isGlobalBranchAccess: true,
  };

  const employee: HrmPrincipal = {
    ...admin,
    id: 'user-emp',
    role: 'EMPLOYEE',
    employeeId: 'emp-self',
    accessibleBranchIds: ['branch-a'],
    isGlobalBranchAccess: false,
  };

  const makeDef = (over: Partial<McpToolDef> = {}): McpToolDef => ({
    name: 'test_tool',
    description: 'test',
    kind: 'read',
    roles: ['ADMIN'],
    inputSchema: {},
    auditResourceType: 'Test',
    execute: jest.fn().mockResolvedValue({ ok: true }),
    ...over,
  });

  const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

  beforeEach(() => {
    auditLog = jest.fn().mockResolvedValue(undefined);
    const settings = { get: jest.fn().mockResolvedValue({ mcpMaxItems: 50 }) };
    const enricher = { enrich: jest.fn(async (p: unknown) => p) };
    executor = new ToolExecutorService({ log: auditLog } as any, settings as any, enricher as any);
  });

  it('denies a role not in the tool roles list', async () => {
    const def = makeDef({ roles: ['ADMIN'] });
    const res = await executor.run(def, {}, employee);
    expect(res.isError).toBe(true);
    expect(parse(res).error.status).toBe(403);
    expect(def.execute).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(def, {}, employee, 'DENIED', expect.any(Number), undefined);
  });

  it('forces self-scope param for restricted roles', async () => {
    const def = makeDef({
      roles: ['ADMIN', 'EMPLOYEE'],
      selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE'] },
    });
    await runWithBranchStore(async () => {
      setBranchContext({
        effectiveBranchId: 'branch-a',
        accessibleBranchIds: ['branch-a'],
        isAllBranches: false,
        isGlobal: false,
      });
      await executor.run(def, { employeeId: 'someone-else' }, employee);
    });
    expect(def.execute).toHaveBeenCalledWith({ employeeId: 'emp-self' }, employee);
  });

  it('rejects self-scoped calls when the account has no employee profile', async () => {
    const def = makeDef({
      roles: ['EMPLOYEE'],
      selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE'] },
    });
    const res = await executor.run(def, {}, { ...employee, employeeId: null });
    expect(res.isError).toBe(true);
    expect(parse(res).error.status).toBe(400);
  });

  it('fails closed when a branch-scoped principal has no branch context', async () => {
    const def = makeDef({ roles: ['EMPLOYEE'] });
    const res = await executor.run(def, {}, employee); // no ALS store here
    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe('BranchContextMissing');
    expect(def.execute).not.toHaveBeenCalled();
  });

  it('returns a preview envelope for writes without confirm', async () => {
    const def = makeDef({ kind: 'write', roles: ['ADMIN'] });
    const res = await executor.run(def, { name: 'x' }, admin);
    const body = parse(res);
    expect(res.isError).toBeUndefined();
    expect(body.requiresConfirmation).toBe(true);
    expect(body.action).toBe('test_tool');
    expect(body.preview).toEqual({ arguments: { name: 'x' } });
    expect(def.execute).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(def, { name: 'x' }, admin, 'PREVIEW', expect.any(Number), undefined);
  });

  it('uses the custom preview function when provided', async () => {
    const def = makeDef({
      kind: 'destructive',
      roles: ['ADMIN'],
      preview: jest.fn().mockResolvedValue({ action: 'Custom', target: 't1' }),
    });
    const res = await executor.run(def, { id: 't1' }, admin);
    const body = parse(res);
    expect(body.destructive).toBe(true);
    expect(body.preview).toEqual({ action: 'Custom', target: 't1' });
  });

  it('executes writes with confirm:true and strips the confirm flag', async () => {
    const def = makeDef({ kind: 'write', roles: ['ADMIN'] });
    const res = await executor.run(def, { name: 'x', confirm: true }, admin);
    expect(res.isError).toBeUndefined();
    expect(def.execute).toHaveBeenCalledWith({ name: 'x' }, admin);
    expect(auditLog).toHaveBeenCalledWith(
      def,
      { name: 'x', confirm: true },
      admin,
      'SUCCESS',
      expect.any(Number),
      undefined,
    );
  });

  it('maps HttpException to a tool error payload, not a throw', async () => {
    const def = makeDef({
      execute: jest.fn().mockRejectedValue(new NotFoundException('Employee not found')),
    });
    const res = await executor.run(def, {}, admin);
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.error.status).toBe(404);
    expect(body.error.message).toBe('Employee not found');
    expect(auditLog).toHaveBeenCalledWith(def, {}, admin, 'ERROR', expect.any(Number), expect.anything());
  });

  it('hides internals on unknown errors', async () => {
    const def = makeDef({ execute: jest.fn().mockRejectedValue(new Error('secret stack')) });
    const res = await executor.run(def, {}, admin);
    const body = parse(res);
    expect(body.error.status).toBe(500);
    expect(body.error.message).not.toContain('secret');
  });

  it('trims long arrays to the limit argument', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ i }));
    const def = makeDef({ execute: jest.fn().mockResolvedValue(rows) });
    const res = await executor.run(def, { limit: 10 }, admin);
    const body = parse(res);
    expect(body.data).toHaveLength(10);
    expect(body.meta).toMatchObject({ truncated: true, returned: 10, total: 40 });
  });

  it('unwraps the {success,data,meta} service envelope', async () => {
    const def = makeDef({
      execute: jest.fn().mockResolvedValue({
        success: true,
        data: [{ id: 1 }],
        meta: { total: 1 },
      }),
    });
    const res = await executor.run(def, {}, admin);
    const body = parse(res);
    expect(body.data).toEqual([{ id: 1 }]);
    expect(body.meta).toMatchObject({ total: 1 });
  });
});
