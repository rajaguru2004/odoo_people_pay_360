import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { CopilotModule } from '../src/copilot/copilot.module';
import { OpenRouterToolsClient, OrMessage } from '../src/copilot/llm/openrouter-tools.client';
import { COPILOT_TOOL_TRANSPORT } from '../src/copilot/mcp/tool-transport';
import { PrismaService } from '../src/prisma/prisma.service';
import { E2EContext } from './utils/e2e-app';
import { Fixtures, setupFixtures, bearer } from './utils/fixtures';
import { assertDevDb } from './utils/mcp-harness';
import { TestAppModule } from './utils/test-app.module';

/**
 * Copilot e2e with a scripted fake LLM and an in-memory tool transport —
 * exercises the full HTTP -> guard -> agent loop -> pending-action state
 * machine against the real DB without OpenRouter or the MCP endpoint.
 */

class FakeLLM {
  queue: Array<{ message: OrMessage; model: string }> = [];
  complete = jest.fn(async () => {
    const next = this.queue.shift();
    if (!next) throw new Error('FakeLLM queue empty');
    return next;
  });
  // The agent loop streams via completeStream; forward content to onText.
  completeStream = jest.fn(async (_opts: any, onText: (t: string) => void) => {
    const next = this.queue.shift();
    if (!next) throw new Error('FakeLLM queue empty');
    if (next.message.content) onText(next.message.content);
    return next;
  });
}

class FakeTransport {
  executedCalls: Array<{ name: string; args: any }> = [];
  listTools = jest.fn(async () => [
    { name: 'fake_read', description: 'read tool', inputSchema: { type: 'object', properties: {} } },
    { name: 'fake_write', description: 'write tool', inputSchema: { type: 'object', properties: {} } },
  ]);
  callTool = jest.fn(async (_auth: any, name: string, args: any) => {
    if (name === 'fake_write' && args.confirm !== true) {
      return {
        requiresConfirmation: true,
        action: 'fake_write',
        description: 'Fake write action',
        destructive: false,
        preview: { will: 'change things', target: args.target },
      };
    }
    this.executedCalls.push({ name, args });
    return name === 'fake_read' ? { data: [{ id: 'row1' }] } : { done: true, target: args.target };
  });
}

const toolCall = (id: string, name: string, args: any) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe('Copilot (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ctx: E2EContext;
  let fx: Fixtures;
  let llm: FakeLLM;
  let transport: FakeTransport;

  beforeAll(async () => {
    // Refuse to run against anything but a known dev DB (shared allowlist with
    // the MCP e2e harness — prod 192.168.0.141:8068 is never allowed).
    assertDevDb();

    llm = new FakeLLM();
    transport = new FakeTransport();

    const moduleRef = await Test.createTestingModule({
      imports: [TestAppModule, CopilotModule],
    })
      .overrideProvider(OpenRouterToolsClient)
      .useValue(llm)
      .overrideProvider(COPILOT_TOOL_TRANSPORT)
      .useValue(transport)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    ctx = { app, prisma, http: () => request(app.getHttpServer()) };
    fx = await setupFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) {
      await prisma.copilotConversation.deleteMany({
        where: { userId: { in: [fx.globalAdmin.userId, fx.scopedHr.userId, fx.plainEmployee.userId] } },
      });
      await fx.cleanup();
    }
    await app?.close();
  }, 120000);

  beforeEach(() => {
    llm.queue = [];
    llm.complete.mockClear();
    transport.executedCalls = [];
    transport.callTool.mockClear();
  });

  it('rejects EMPLOYEE role with 403', async () => {
    const res = await ctx
      .http()
      .post('/copilot/chat')
      .set(bearer(fx.plainEmployee.token))
      .send({ message: 'hi' });
    expect(res.status).toBe(403);
  });

  it('answers a read-only turn and persists the transcript', async () => {
    llm.queue.push(
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'fake_read', {})] },
        model: 'fake-model',
      },
      { message: { role: 'assistant', content: 'Found **1** row.' }, model: 'fake-model' },
    );

    const res = await ctx
      .http()
      .post('/copilot/chat')
      .set(bearer(fx.globalAdmin.token))
      .send({ message: 'how many rows?' });

    expect(res.status).toBe(201);
    const turn = res.body.data;
    expect(turn.type).toBe('final');
    expect(turn.message).toBe('Found **1** row.');
    expect(turn.toolActivity).toEqual([
      expect.objectContaining({ tool: 'fake_read', status: 'ok' }),
    ]);

    const messages = await prisma.copilotMessage.findMany({
      where: { conversationId: turn.conversationId },
      orderBy: { createdAt: 'asc' },
    });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('streams a turn over SSE (status → tool → token deltas → final)', async () => {
    llm.queue.push(
      {
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'fake_read', {})] },
        model: 'fake-model',
      },
      { message: { role: 'assistant', content: 'Found 1 row.' }, model: 'fake-model' },
      // Consumed by the (new-conversation) title generation call.
      { message: { role: 'assistant', content: 'Row Count Check' }, model: 'fake-model' },
    );
    const res = await ctx
      .http()
      .post('/copilot/chat/stream')
      .set(bearer(fx.globalAdmin.token))
      .send({ message: 'how many rows (stream)?' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"type":"status"');
    expect(res.text).toContain('"type":"tool_call"');
    expect(res.text).toContain('"type":"delta"');
    expect(res.text).toContain('Found 1 row.');
    expect(res.text).toContain('"type":"final"');
    // Live title event for the new conversation (sidebar updates without reload).
    expect(res.text).toContain('"type":"title"');
    expect(res.text).toContain('Row Count Check');
  });

  it('grounds the model on the exact tool result (anti-hallucination plumbing)', async () => {
    const orig = transport.callTool;
    transport.callTool = jest.fn(async () => ({ data: { workingNow: 3, lateToday: 0, pendingApprovals: 2 } })) as any;
    try {
      llm.queue.push(
        {
          message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'fake_read', {})] },
          model: 'fake-model',
        },
        { message: { role: 'assistant', content: '3 working, 0 late.' }, model: 'fake-model' },
      );
      const res = await ctx
        .http()
        .post('/copilot/chat')
        .set(bearer(fx.globalAdmin.token))
        .send({ message: "today's status?" });
      expect(res.status).toBe(201);

      // The follow-up LLM call must contain the tool result VERBATIM, so the model
      // is answering from real data — never from invented numbers.
      const lastCallMessages = (llm.completeStream.mock.calls.at(-1) as any)[0].messages;
      const toolMsg = lastCallMessages.find((m: any) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg.content).toContain('"workingNow":3');
      expect(toolMsg.content).toContain('"lateToday":0');
      expect(toolMsg.content).toContain('"pendingApprovals":2');
    } finally {
      transport.callTool = orig;
    }
  });

  it('pauses a mutating turn into a pending action, then executes on confirm with server-stored args', async () => {
    llm.queue.push({
      message: {
        role: 'assistant',
        content: 'This needs your approval.',
        tool_calls: [toolCall('c1', 'fake_write', { target: 'employee-42' })],
      },
      model: 'fake-model',
    });

    const chatRes = await ctx
      .http()
      .post('/copilot/chat')
      .set(bearer(fx.globalAdmin.token))
      .send({ message: 'do the write' });

    expect(chatRes.status).toBe(201);
    const turn = chatRes.body.data;
    expect(turn.type).toBe('pending_actions');
    expect(turn.pendingActions).toHaveLength(1);
    const action = turn.pendingActions[0];
    expect(action.tool).toBe('fake_write');
    expect(transport.executedCalls).toHaveLength(0); // nothing executed yet

    // new chat in same conversation is blocked while pending
    const blocked = await ctx
      .http()
      .post('/copilot/chat')
      .set(bearer(fx.globalAdmin.token))
      .send({ message: 'ignore that', conversationId: turn.conversationId });
    expect(blocked.status).toBe(409);

    // confirm — client sends ONLY the actionId; args come from the DB row
    llm.queue.push({ message: { role: 'assistant', content: 'Done ✅' }, model: 'fake-model' });
    const confirmRes = await ctx
      .http()
      .post('/copilot/confirm')
      .set(bearer(fx.globalAdmin.token))
      .send({ actionId: action.actionId, approve: true });

    expect(confirmRes.status).toBe(201);
    expect(confirmRes.body.data.type).toBe('final');
    expect(transport.executedCalls).toEqual([
      { name: 'fake_write', args: { target: 'employee-42', confirm: true } },
    ]);

    const row = await prisma.copilotPendingAction.findUnique({ where: { id: action.actionId } });
    expect(row?.status).toBe('CONFIRMED');
    expect(row?.resultJson).toMatchObject({ done: true });

    // double-confirm → 409
    const again = await ctx
      .http()
      .post('/copilot/confirm')
      .set(bearer(fx.globalAdmin.token))
      .send({ actionId: action.actionId, approve: true });
    expect(again.status).toBe(409);

    // audit row for the human approval
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'COPILOT_ACTION_CONFIRMED', resourceId: action.actionId },
    });
    expect(audit).toBeTruthy();
  });

  it('reject path cancels without executing and resumes the loop', async () => {
    llm.queue.push({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('c1', 'fake_write', { target: 'x' })],
      },
      model: 'fake-model',
    });
    const chatRes = await ctx
      .http()
      .post('/copilot/chat')
      .set(bearer(fx.globalAdmin.token))
      .send({ message: 'write x' });
    const action = chatRes.body.data.pendingActions[0];

    llm.queue.push({ message: { role: 'assistant', content: 'Okay, cancelled.' }, model: 'fake-model' });
    const rejectRes = await ctx
      .http()
      .post('/copilot/confirm')
      .set(bearer(fx.globalAdmin.token))
      .send({ actionId: action.actionId, approve: false });

    expect(rejectRes.status).toBe(201);
    expect(rejectRes.body.data.message).toBe('Okay, cancelled.');
    expect(transport.executedCalls).toHaveLength(0);

    const row = await prisma.copilotPendingAction.findUnique({ where: { id: action.actionId } });
    expect(row?.status).toBe('REJECTED');
  });

  it('expires stale pending actions on confirm', async () => {
    llm.queue.push({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('c1', 'fake_write', { target: 'y' })],
      },
      model: 'fake-model',
    });
    const chatRes = await ctx
      .http()
      .post('/copilot/chat')
      .set(bearer(fx.globalAdmin.token))
      .send({ message: 'write y' });
    const action = chatRes.body.data.pendingActions[0];

    await prisma.copilotPendingAction.update({
      where: { id: action.actionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const confirmRes = await ctx
      .http()
      .post('/copilot/confirm')
      .set(bearer(fx.globalAdmin.token))
      .send({ actionId: action.actionId, approve: true });

    expect(confirmRes.status).toBe(409);
    const row = await prisma.copilotPendingAction.findUnique({ where: { id: action.actionId } });
    expect(row?.status).toBe('EXPIRED');
    expect(transport.executedCalls).toHaveLength(0);
  });

  it('another user cannot see or confirm my conversation/action', async () => {
    llm.queue.push({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('c1', 'fake_write', { target: 'z' })],
      },
      model: 'fake-model',
    });
    const chatRes = await ctx
      .http()
      .post('/copilot/chat')
      .set(bearer(fx.globalAdmin.token))
      .send({ message: 'write z' });
    const { conversationId, pendingActions } = chatRes.body.data;

    const otherGet = await ctx
      .http()
      .get(`/copilot/conversations/${conversationId}`)
      .set(bearer(fx.scopedHr.token));
    expect(otherGet.status).toBe(404);

    const otherConfirm = await ctx
      .http()
      .post('/copilot/confirm')
      .set(bearer(fx.scopedHr.token))
      .send({ actionId: pendingActions[0].actionId, approve: true });
    expect(otherConfirm.status).toBe(404);
  });

  it('lists and deletes conversations', async () => {
    const list = await ctx.http().get('/copilot/conversations').set(bearer(fx.globalAdmin.token));
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);

    const id = list.body.data[0].id;
    const del = await ctx
      .http()
      .delete(`/copilot/conversations/${id}`)
      .set(bearer(fx.globalAdmin.token));
    expect(del.status).toBe(200);
    expect(await prisma.copilotConversation.count({ where: { id } })).toBe(0);
  });
});
