import { AgentLoopService, AgentContext } from './agent-loop.service';
import { AgentEvent } from './agent-events';
import { OrMessage } from '../llm/openrouter-tools.client';

const toolCall = (id: string, name: string, args: any) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe('AgentLoopService', () => {
  let llmQueue: Array<{ message: OrMessage; model: string }>;
  let llm: { complete: jest.Mock; completeStream: jest.Mock };
  let transport: { callTool: jest.Mock; listTools: jest.Mock };
  let prisma: { copilotMessage: { create: jest.Mock }; copilotPendingAction: { create: jest.Mock } };
  let config: { maxIterations: number; pendingTtlMinutes: number };
  let service: AgentLoopService;
  let events: AgentEvent[];
  let savedMessages: any[];
  let savedActions: any[];

  beforeEach(() => {
    llmQueue = [];
    events = [];
    savedMessages = [];
    savedActions = [];
    llm = {
      complete: jest.fn().mockImplementation(() => Promise.resolve(llmQueue.shift())),
      // The loop calls completeStream first; forward content to onText and return the message.
      completeStream: jest.fn().mockImplementation((_opts: any, onText: (t: string) => void) => {
        const next = llmQueue.shift();
        if (next?.message?.content) onText(next.message.content);
        return Promise.resolve(next);
      }),
    };
    transport = { callTool: jest.fn(), listTools: jest.fn() };
    prisma = {
      copilotMessage: {
        create: jest.fn().mockImplementation(({ data }) => {
          const row = { id: `msg-${savedMessages.length}`, ...data };
          savedMessages.push(row);
          return Promise.resolve(row);
        }),
      },
      copilotPendingAction: {
        create: jest.fn().mockImplementation(({ data }) => {
          const row = { id: `act-${savedActions.length}`, ...data };
          savedActions.push(row);
          return Promise.resolve(row);
        }),
      },
    };
    config = { maxIterations: 8, pendingTtlMinutes: 10 };
    const settings = { get: jest.fn().mockImplementation(async () => config) };
    service = new AgentLoopService(transport as any, llm as any, prisma as any, settings as any);
  });

  const baseCtx = (): AgentContext => ({
    auth: { authorization: 'Bearer t' },
    userId: 'user-1',
    conversationId: 'conv-1',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ],
    toolDefs: [{ type: 'function', function: { name: 'employee_list', parameters: {} } }],
    onEvent: (e) => events.push(e),
  });

  it('returns final answer directly when the LLM calls no tools', async () => {
    llmQueue.push({ message: { role: 'assistant', content: 'Hi there' }, model: 'm1' });
    const res = await service.run(baseCtx());
    expect(res).toMatchObject({ type: 'final', message: 'Hi there', model: 'm1' });
    expect(savedMessages).toHaveLength(1);
    expect(savedMessages[0]).toMatchObject({ role: 'assistant', content: 'Hi there' });
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it('executes tool calls, feeds results back, then finishes', async () => {
    llmQueue.push({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('c1', 'employee_list', { search: 'x' })],
      },
      model: 'm1',
    });
    llmQueue.push({ message: { role: 'assistant', content: '32 employees' }, model: 'm1' });
    transport.callTool.mockResolvedValue({ data: [{ id: 'e1' }] });

    const res = await service.run(baseCtx());

    expect(res.type).toBe('final');
    expect(transport.callTool).toHaveBeenCalledWith(
      { authorization: 'Bearer t' },
      'employee_list',
      { search: 'x' },
    );
    // second LLM call got assistant tool_calls + tool result appended
    const secondCallMessages = llm.completeStream.mock.calls[1][0].messages;
    expect(secondCallMessages.at(-2).tool_calls).toBeDefined();
    expect(secondCallMessages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    // persisted: assistant w/ toolCalls, tool result, final assistant
    expect(savedMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('handles parallel tool calls', async () => {
    llmQueue.push({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('c1', 'employee_list', {}),
          toolCall('c2', 'report_headcount', {}),
        ],
      },
      model: 'm1',
    });
    llmQueue.push({ message: { role: 'assistant', content: 'done' }, model: 'm1' });
    transport.callTool.mockResolvedValue({ data: [] });

    await service.run(baseCtx());
    expect(transport.callTool).toHaveBeenCalledTimes(2);
  });

  it('feeds transport errors back to the LLM instead of throwing', async () => {
    llmQueue.push({
      message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'employee_get', { id: 'x' })] },
      model: 'm1',
    });
    llmQueue.push({ message: { role: 'assistant', content: 'that failed' }, model: 'm1' });
    transport.callTool.mockRejectedValue(new Error('boom'));

    const res = await service.run(baseCtx());
    expect(res.type).toBe('final');
    const toolMsg = savedMessages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toContain('boom');
  });

  it('feeds malformed tool-call JSON back as an error result', async () => {
    llmQueue.push({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'employee_list', arguments: '{bad' } }],
      },
      model: 'm1',
    });
    llmQueue.push({ message: { role: 'assistant', content: 'sorry' }, model: 'm1' });

    await service.run(baseCtx());
    expect(transport.callTool).not.toHaveBeenCalled();
    const toolMsg = savedMessages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toContain('Invalid JSON');
  });

  it('pauses on requiresConfirmation and persists a pending action', async () => {
    llmQueue.push({
      message: {
        role: 'assistant',
        content: 'I will approve it',
        tool_calls: [toolCall('c1', 'leave_request_approve', { id: 'lr-1', confirm: false })],
      },
      model: 'm1',
    });
    transport.callTool.mockResolvedValue({
      requiresConfirmation: true,
      action: 'leave_request_approve',
      destructive: false,
      preview: { request: { id: 'lr-1' } },
    });

    const res = await service.run(baseCtx());

    expect(res.type).toBe('pending_actions');
    expect(res.pendingActions).toHaveLength(1);
    expect(res.pendingActions![0]).toMatchObject({
      actionId: 'act-0',
      tool: 'leave_request_approve',
      args: { id: 'lr-1' }, // confirm flag stripped
    });
    expect(savedActions[0]).toMatchObject({
      conversationId: 'conv-1',
      toolCallId: 'c1',
      toolName: 'leave_request_approve',
      argsJson: { id: 'lr-1' },
      createdById: 'user-1',
    });
    // loop stopped: only one LLM call
    expect(llm.completeStream).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'pending_action')).toBe(true);
  });

  it('bails out at the iteration limit', async () => {
    config.maxIterations = 2;
    const loopMsg = () => ({
      message: {
        role: 'assistant' as const,
        content: null,
        tool_calls: [toolCall('c', 'employee_list', {})],
      },
      model: 'm1',
    });
    llmQueue.push(loopMsg(), loopMsg(), loopMsg());
    transport.callTool.mockResolvedValue({ data: [] });

    const res = await service.run(baseCtx());
    expect(res.type).toBe('final');
    expect(res.message).toContain('step limit');
    expect(llm.completeStream).toHaveBeenCalledTimes(2);
  });
});
