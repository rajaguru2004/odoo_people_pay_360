import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request = require('supertest');
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { McpModule } from '../../src/mcp/mcp.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { E2EContext } from './e2e-app';
import { Fixtures, setupFixtures } from './fixtures';
import { TestAppModule } from './test-app.module';

// Allowed non-production targets. 192.168.0.141:8069 is the dev instance on the
// prod host (PROD itself is 192.168.0.141:8068 — never allowed here).
// localhost:8068 is the throwaway stack from docker-compose.yml on a dev machine.
// localhost:8069 is the DISPOSABLE test stack from docker-compose.test.yml —
// the `ess_e2e` clone that `scripts/e2e-db.sh` drops and recreates on demand.
// It was missing from this list, which meant `.env.test` — the file the docs
// tell you to use — made 17 suites refuse to run rather than fail honestly.
// It is the safest target here by some distance: nothing else on this list is
// recreated from a template on every reset.
const DEV_DB_HOSTS = [
  '80.225.236.50:8068',
  '192.168.0.141:8069',
  'localhost:8068',
  '127.0.0.1:8068',
  'localhost:8069',
  '127.0.0.1:8069',
];

/** Refuse to run against anything but a dev DB — production is 192.168.0.141:8068. */
export function assertDevDb(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!DEV_DB_HOSTS.some((h) => url.includes(h))) {
    throw new Error(
      `MCP e2e must run against a dev DB (${DEV_DB_HOSTS.join(' or ')}). ` +
        'Override DATABASE_URL/DIRECT_URL — never run this suite against production.',
    );
  }
}

export interface ToolResult {
  isError: boolean;
  body: any;
  raw: any;
}

export interface McpHarness {
  app: INestApplication;
  prisma: PrismaService;
  ctx: E2EContext;
  fx: Fixtures;
  /** extra MANAGER user (home branch A) for RBAC coverage. */
  manager: { userId: string; employeeId: string; email: string; token: string };
  baseUrl: string;
  /** Open an MCP client for a token (optionally pinned to a branch). Tracked for teardown. */
  client(token: string, branchId?: string): Promise<Client>;
  /** Low-level call → {isError, body}. */
  call(client: Client, name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Assert success, return parsed payload. */
  callOk(client: Client, name: string, args?: Record<string, unknown>): Promise<any>;
  /** Assert tool error, return the {status,code,message} error object. */
  callErr(client: Client, name: string, args?: Record<string, unknown>): Promise<any>;
  /** Assert a confirm-first preview (requiresConfirmation), return the envelope. */
  preview(client: Client, name: string, args?: Record<string, unknown>): Promise<any>;
  teardown(): Promise<void>;
}

export async function bootMcpHarness(): Promise<McpHarness> {
  assertDevDb();

  const moduleRef = await Test.createTestingModule({
    imports: [TestAppModule, McpModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0);

  const url = await app.getUrl();
  const baseUrl = url.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');

  const prisma = app.get(PrismaService);
  const ctx: E2EContext = { app, prisma, http: () => request(app.getHttpServer()) };
  const fx = await setupFixtures(ctx);
  const manager = await createManager(ctx, fx);

  const openClients: Client[] = [];

  const client = async (token: string, branchId?: string): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(branchId ? { 'X-Branch-Id': branchId } : {}),
        },
      },
    });
    const c = new Client({ name: 'mcp-e2e', version: '1.0.0' });
    await c.connect(transport);
    openClients.push(c);
    return c;
  };

  const call = async (
    c: Client,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    const raw: any = await c.callTool({ name, arguments: args });
    const text = raw?.content?.find((x: any) => x?.type === 'text')?.text;
    let body: any;
    try {
      body = text !== undefined ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { isError: raw?.isError === true, body, raw };
  };

  const callOk = async (c: Client, name: string, args?: Record<string, unknown>) => {
    const res = await call(c, name, args);
    if (res.isError) {
      throw new Error(`${name} expected success but errored: ${JSON.stringify(res.body)}`);
    }
    return res.body;
  };

  const callErr = async (c: Client, name: string, args?: Record<string, unknown>) => {
    const res = await call(c, name, args);
    if (!res.isError) {
      throw new Error(`${name} expected an error but succeeded: ${JSON.stringify(res.body)}`);
    }
    return res.body?.error ?? res.body;
  };

  const preview = async (c: Client, name: string, args?: Record<string, unknown>) => {
    const res = await call(c, name, args);
    if (res.isError) {
      throw new Error(`${name} preview expected success but errored: ${JSON.stringify(res.body)}`);
    }
    if (res.body?.requiresConfirmation !== true) {
      throw new Error(`${name} expected a confirm-first preview, got: ${JSON.stringify(res.body)}`);
    }
    return res.body;
  };

  const teardown = async () => {
    for (const c of openClients) await c.close().catch(() => undefined);
    await fullCleanup(prisma, fx);
    await app.close();
  };

  return { app, prisma, ctx, fx, manager, baseUrl, client, call, callOk, callErr, preview, teardown };
}

async function createManager(ctx: E2EContext, fx: Fixtures) {
  const { prisma } = ctx;
  const hash = await bcrypt.hash('Passw0rd!', 10);
  const mgrEmp = await prisma.employee.create({
    data: {
      employeeCode: `EMP-${fx.runId}-MGR`,
      fullName: 'Mia Manager',
      dateOfBirth: new Date('1988-05-05'),
      idCard: `ID-${fx.runId}-MGR`,
      email: `mgr-${fx.runId}@test.local`,
      departmentId: fx.deptId,
      branchId: fx.branchA,
      position: 'Team Lead',
      startDate: new Date('2026-01-01'),
      baseSalary: 65000,
      status: 'ACTIVE',
    },
  });
  const mgrUser = await prisma.user.create({
    data: {
      email: `mgruser-${fx.runId}@test.local`,
      passwordHash: hash,
      role: 'MANAGER',
      isActive: true,
      isGlobalBranchAccess: false,
      employeeId: mgrEmp.id,
      branchAccess: { create: [{ branchId: fx.branchA }] },
    },
  });
  const res = await ctx.http().post('/auth/login').send({ email: mgrUser.email, password: 'Passw0rd!' });
  return {
    userId: mgrUser.id,
    employeeId: mgrEmp.id,
    email: mgrUser.email,
    token: res.body?.data?.accessToken,
  };
}

/**
 * FK-safe, runId-scoped teardown. Deletes every row any tool test could have
 * created — child rows first so employee/user deletes never hit a foreign-key
 * constraint — then the base fixtures. Every step is best-effort so one failure
 * can never orphan the rest (the bug this replaces: deleting a user before its
 * audit rows aborted the whole cleanup and leaked the fixture set).
 */
export async function fullCleanup(prisma: PrismaService, fx: Fixtures) {
  const tag = fx.runId;

  const users = await prisma.user
    .findMany({ where: { email: { contains: tag } }, select: { id: true } })
    .catch(() => [] as { id: string }[]);
  const userIds = users.map((u) => u.id);
  const emps = await prisma.employee
    .findMany({
      where: { OR: [{ employeeCode: { contains: tag } }, { email: { contains: tag } }] },
      select: { id: true },
    })
    .catch(() => [] as { id: string }[]);
  const empIds = emps.map((e) => e.id);

  const inEmp = { employeeId: { in: empIds } };
  const inUser = { userId: { in: userIds } };

  // 1. Tool-created domain rows (name-tagged).
  await safe(() => prisma.holiday.deleteMany({ where: { name: { contains: tag } } }));
  await safe(() => prisma.task.deleteMany({ where: { title: { contains: tag } } }));
  await safe(() => prisma.project.deleteMany({ where: { name: { contains: tag } } }));
  await safe(() => prisma.payrollItem.deleteMany({ where: inEmp }));

  // 2. Child rows that reference the test employees / users (FK blockers).
  await safe(() => prisma.workSchedule.deleteMany({ where: inEmp }));
  await safe(() => prisma.leaveApproval.deleteMany({ where: { leaveRequest: inEmp } as any }));
  await safe(() => prisma.leaveRequest.deleteMany({ where: inEmp }));
  await safe(() => prisma.leaveTypeBalance.deleteMany({ where: inEmp }));
  await safe(() => prisma.leaveBalance.deleteMany({ where: inEmp }));
  await safe(() => prisma.attendanceCorrection.deleteMany({ where: inEmp }));
  await safe(() => prisma.attendance.deleteMany({ where: inEmp }));
  await safe(() => prisma.projectMember.deleteMany({ where: inEmp }));
  await safe(() => prisma.employeeHistory.deleteMany({ where: inEmp }));
  await safe(() => prisma.employeeActivity.deleteMany({ where: inEmp }));
  await safe(() => prisma.contract.deleteMany({ where: inEmp }));
  await safe(() => prisma.notification.deleteMany({ where: inUser }));
  await safe(() => prisma.copilotConversation.deleteMany({ where: inUser }));
  await safe(() => prisma.auditLog.deleteMany({ where: inUser }));

  // 3. Test-created department (soft-deleted by department_delete) + base fixtures.
  await safe(() => prisma.department.deleteMany({ where: { code: { contains: `${tag}-X` } } }));
  await safe(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));
  await safe(() => prisma.employee.deleteMany({ where: { id: { in: empIds } } }));
  await safe(() => prisma.branch.deleteMany({ where: { code: { contains: tag } } }));
  await safe(() => prisma.department.deleteMany({ where: { code: { contains: tag } } }));
}

async function safe(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    /* best-effort cleanup */
  }
}
