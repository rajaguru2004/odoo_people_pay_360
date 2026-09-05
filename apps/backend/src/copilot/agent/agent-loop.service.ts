import { Inject, Injectable, Logger } from '@nestjs/common';
import { CopilotSettingsService } from '../../copilot-settings/copilot-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenRouterToolsClient, OrMessage, OrToolCall } from '../llm/openrouter-tools.client';
import { isConfirmationRequired, OrToolDef } from '../mcp/schema-mapper';
import { COPILOT_TOOL_TRANSPORT } from '../mcp/tool-transport';
import type { AuthForwardContext, CopilotToolTransport } from '../mcp/tool-transport';
import { AgentEvent, AgentResult, PendingActionPayload } from './agent-events';

export interface AgentContext {
  auth: AuthForwardContext;
  userId: string;
  conversationId: string;
  /** system + trimmed history + the new user message. */
  messages: OrMessage[];
  toolDefs: OrToolDef[];
  onEvent: (e: AgentEvent) => void;
}

const TOOL_RESULT_CHAR_CAP = 8_000;
const LOOP_DEADLINE_MS = 120_000;

@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);

  constructor(
    @Inject(COPILOT_TOOL_TRANSPORT) private readonly transport: CopilotToolTransport,
    private readonly llm: OpenRouterToolsClient,
    private readonly prisma: PrismaService,
    private readonly settings: CopilotSettingsService,
  ) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    const maxIter = (await this.settings.get()).maxIterations;
    const deadline = Date.now() + LOOP_DEADLINE_MS;
    let model: string | undefined;

    for (let i = 0; i < maxIter && Date.now() < deadline; i++) {
      ctx.onEvent({ type: 'status', iteration: i + 1 });

      // Stream assistant text deltas for a live typing effect; fall back to a
      // non-streaming completion if the endpoint can't stream. The final event
      // carries the authoritative text, so a partial/failed stream is harmless.
      let completion: { message: OrMessage; model: string };
      try {
        completion = await this.llm.completeStream(
          { messages: ctx.messages, tools: ctx.toolDefs },
          (text) => ctx.onEvent({ type: 'delta', text }),
        );
      } catch {
        completion = await this.llm.complete({ messages: ctx.messages, tools: ctx.toolDefs });
      }
      model = completion.model;
      const message = completion.message;

      if (!message.tool_calls?.length) {
        const text = message.content ?? '';
        await this.saveMessage(ctx.conversationId, { role: 'assistant', content: text });
        ctx.onEvent({ type: 'final', message: text });
        return { type: 'final', message: text, model };
      }

      const assistantRow = await this.saveMessage(ctx.conversationId, {
        role: 'assistant',
        content: message.content,
        toolCalls: message.tool_calls as any,
      });

      const settled = await Promise.allSettled(
        message.tool_calls.map((tc) => this.executeToolCall(ctx, tc)),
      );

      const pendingDrafts: Array<{ tc: OrToolCall; args: Record<string, unknown>; preview: any }> = [];
      const toolMsgs: OrMessage[] = [];

      for (let k = 0; k < settled.length; k++) {
        const tc = message.tool_calls[k];
        const s = settled[k];

        if (s.status === 'fulfilled' && isConfirmationRequired(s.value.result)) {
          pendingDrafts.push({ tc, args: s.value.args, preview: s.value.result });
          continue;
        }

        const payload =
          s.status === 'fulfilled'
            ? s.value.result
            : { error: (s.reason as Error)?.message ?? 'Tool execution failed' };
        const content = JSON.stringify(payload).slice(0, TOOL_RESULT_CHAR_CAP);
        toolMsgs.push({ role: 'tool', tool_call_id: tc.id, content });
        await this.saveMessage(ctx.conversationId, {
          role: 'tool',
          content,
          toolCallId: tc.id,
          toolName: tc.function.name,
        });
      }

      if (pendingDrafts.length) {
        const actions = await this.createPendingActions(ctx, assistantRow.id, pendingDrafts);
        actions.forEach((a) => ctx.onEvent({ type: 'pending_action', action: a }));
        return {
          type: 'pending_actions',
          message: message.content ?? '',
          model,
          pendingActions: actions,
        };
      }

      ctx.messages = [...ctx.messages, message, ...toolMsgs];
    }

    const bail =
      'I hit the step limit for a single request. Here is what I have so far — ask me to continue if you need more.';
    await this.saveMessage(ctx.conversationId, { role: 'assistant', content: bail });
    ctx.onEvent({ type: 'final', message: bail });
    return { type: 'final', message: bail, model };
  }

  private async executeToolCall(
    ctx: AgentContext,
    tc: OrToolCall,
  ): Promise<{ args: Record<string, unknown>; result: any }> {
    const parsed = safeJsonParse(tc.function.arguments);
    ctx.onEvent({
      type: 'tool_call',
      phase: 'started',
      toolCallId: tc.id,
      tool: tc.function.name,
      args: parsed.ok ? parsed.value : undefined,
    });

    const started = Date.now();
    let result: any;
    if (!parsed.ok) {
      result = { error: `Invalid JSON in tool arguments: ${parsed.error}` };
    } else {
      try {
        result = await this.transport.callTool(ctx.auth, tc.function.name, parsed.value);
      } catch (e) {
        this.logger.warn(`tool ${tc.function.name} transport error: ${(e as Error).message}`);
        result = { error: (e as Error).message ?? 'Tool call failed' };
      }
    }

    ctx.onEvent({
      type: 'tool_call',
      phase: 'finished',
      toolCallId: tc.id,
      tool: tc.function.name,
      ok: !result?.error,
      durationMs: Date.now() - started,
      resultSummary: summarize(result),
    });

    return { args: parsed.ok ? parsed.value : {}, result };
  }

  private async createPendingActions(
    ctx: AgentContext,
    messageId: string,
    drafts: Array<{ tc: OrToolCall; args: Record<string, unknown>; preview: any }>,
  ): Promise<PendingActionPayload[]> {
    const ttlMinutes = (await this.settings.get()).pendingTtlMinutes;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    const out: PendingActionPayload[] = [];
    for (const { tc, args, preview } of drafts) {
      const { confirm: _c, ...cleanArgs } = args as Record<string, unknown>;
      const row = await this.prisma.copilotPendingAction.create({
        data: {
          conversationId: ctx.conversationId,
          messageId,
          toolCallId: tc.id,
          toolName: tc.function.name,
          argsJson: cleanArgs as any,
          previewJson: preview ?? null,
          expiresAt,
          createdById: ctx.userId,
        },
      });
      out.push({
        actionId: row.id,
        tool: tc.function.name,
        args: cleanArgs,
        preview: preview?.preview ?? preview,
        summary: typeof preview?.description === 'string' ? preview.description : undefined,
        destructive: preview?.destructive === true,
        expiresAt: expiresAt.toISOString(),
      });
    }
    return out;
  }

  private saveMessage(
    conversationId: string,
    data: {
      role: 'user' | 'assistant' | 'tool';
      content?: string | null;
      toolCalls?: any;
      toolCallId?: string;
      toolName?: string;
    },
  ) {
    return this.prisma.copilotMessage.create({
      data: {
        conversationId,
        role: data.role,
        content: data.content ?? null,
        toolCalls: data.toolCalls ?? undefined,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
      },
    });
  }
}

function safeJsonParse(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || !raw.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
    return { ok: false, error: 'arguments must be a JSON object' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function summarize(result: any): string {
  if (result == null) return 'no output';
  if (result.error) return `error: ${String(result.error).slice(0, 120)}`;
  if (result.requiresConfirmation) return 'awaiting user confirmation';
  const data = Array.isArray(result) ? result : result.data;
  if (Array.isArray(data)) return `${data.length} rows`;
  const json = JSON.stringify(result);
  return json.length > 120 ? `${json.slice(0, 117)}...` : json;
}
