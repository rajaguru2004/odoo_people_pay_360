import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditService } from '../audit/audit.service';
import { HrmPrincipal } from '../mcp/tool.types';
import { PrismaService } from '../prisma/prisma.service';
import { AgentLoopService } from './agent/agent-loop.service';
import { AgentEvent, PendingActionPayload, ToolActivityEntry } from './agent/agent-events';
import { buildCopilotSystemPrompt } from './agent/prompts';
import { OpenRouterToolsClient, OrMessage } from './llm/openrouter-tools.client';
import { CopilotSettingsService } from '../copilot-settings/copilot-settings.service';
import { isConfirmationRequired, isLocalEndpoint, OrToolDef, toOpenAiTools } from './mcp/schema-mapper';
import { COPILOT_TOOL_TRANSPORT } from './mcp/tool-transport';
import type { AuthForwardContext, CopilotToolTransport } from './mcp/tool-transport';
import { CopilotChatDto } from './dto/copilot-chat.dto';
import { ConfirmActionDto } from './dto/confirm-action.dto';

export interface CopilotTurn {
  conversationId: string;
  type: 'final' | 'pending_actions';
  message: string;
  model?: string;
  toolActivity: ToolActivityEntry[];
  pendingActions: PendingActionPayload[];
}

const HISTORY_MESSAGE_LIMIT = 30;
const HISTORY_CHAR_CAP = 24_000;
const TOOL_LIST_CACHE_MS = 60_000;

@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name);
  private readonly toolCache = new Map<string, { at: number; tools: OrToolDef[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentLoop: AgentLoopService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly llm: OpenRouterToolsClient,
    private readonly settings: CopilotSettingsService,
    @Inject(COPILOT_TOOL_TRANSPORT) private readonly transport: CopilotToolTransport,
  ) {}

  // ---------------------------------------------------------------- chat

  async chat(user: HrmPrincipal, auth: AuthForwardContext, dto: CopilotChatDto) {
    const { conversation } = await this.beginTurn(user, dto);
    const { events, turn } = await this.runLoop(user, auth, conversation.id);
    return this.envelope(conversation.id, events, turn.type, turn.message, turn.model, turn.pendingActions);
  }

  /**
   * Streaming variant: runs the same agent turn but forwards live events
   * (status, tool activity, text deltas) to `emit`, then a terminal
   * final/pending_actions event. Used by the SSE endpoint.
   */
  async chatStream(
    user: HrmPrincipal,
    auth: AuthForwardContext,
    dto: CopilotChatDto,
    emit: (event: any) => void,
  ): Promise<void> {
    const { conversation, isNew } = await this.beginTurn(user, dto);
    emit({ type: 'status', phase: 'thinking' });

    // Forward live events, but suppress the loop's own terminal events — we send
    // an enriched terminal below (with conversationId + tool activity).
    const { events, turn } = await this.runLoop(user, auth, conversation.id, (e) => {
      if (e.type === 'final' || e.type === 'error' || e.type === 'pending_action') return;
      emit(e);
    });

    const toolActivity = this.toolActivityFrom(events, turn.pendingActions ?? []);
    if (turn.type === 'pending_actions') {
      emit({
        type: 'pending_actions',
        conversationId: conversation.id,
        message: turn.message,
        model: turn.model,
        toolActivity,
        pendingActions: turn.pendingActions ?? [],
      });
    } else {
      emit({
        type: 'final',
        conversationId: conversation.id,
        message: turn.message,
        model: turn.model,
        toolActivity,
        pendingActions: [],
      });
    }

    // Generate a concise title for a new conversation and push it live on the
    // same stream so the sidebar updates without a reload.
    if (isNew) {
      const title = await this.generateTitle(conversation.id, dto.message, turn.message);
      if (title) emit({ type: 'title', conversationId: conversation.id, title });
    }
  }

  /** Shared turn setup: resolve/create the conversation, block on pending, save the user message. */
  private async beginTurn(user: HrmPrincipal, dto: CopilotChatDto) {
    const { conversation, isNew } = await this.findOrCreateConversation(user, dto);

    await this.expireStaleActions(conversation.id);
    const unresolved = await this.prisma.copilotPendingAction.count({
      where: { conversationId: conversation.id, status: 'PENDING' },
    });
    if (unresolved > 0) {
      throw new ConflictException(
        'This conversation has an action waiting for confirmation. Confirm or reject it first.',
      );
    }

    await this.prisma.copilotMessage.create({
      data: { conversationId: conversation.id, role: 'user', content: dto.message },
    });
    await this.touchConversation(conversation.id);
    return { conversation, isNew };
  }

  // ------------------------------------------------------------- confirm

  async confirm(user: HrmPrincipal, auth: AuthForwardContext, dto: ConfirmActionDto) {
    const action = await this.prisma.copilotPendingAction.findUnique({
      where: { id: dto.actionId },
      include: { conversation: true },
    });
    if (!action || action.conversation.userId !== user.id) {
      throw new NotFoundException('Pending action not found');
    }
    if (action.createdById !== user.id) {
      throw new ForbiddenException('Only the requester can resolve this action');
    }
    if (action.status !== 'PENDING') {
      throw new ConflictException(`Action already resolved (${action.status})`);
    }
    if (action.expiresAt < new Date()) {
      await this.prisma.copilotPendingAction.update({
        where: { id: action.id },
        data: { status: 'EXPIRED', resolvedAt: new Date() },
      });
      throw new ConflictException('Action expired. Ask the copilot again.');
    }

    const nextStatus = dto.approve ? 'CONFIRMED' : 'REJECTED';
    // Atomic CAS: blocks double-confirm/replay races.
    const cas = await this.prisma.copilotPendingAction.updateMany({
      where: { id: action.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      data: { status: nextStatus, resolvedAt: new Date() },
    });
    if (cas.count === 0) {
      throw new ConflictException('Action already resolved or expired');
    }

    let toolPayload: any;
    if (dto.approve) {
      // Args come from the server-side row — a tampered client body changes nothing.
      const args = { ...(action.argsJson as Record<string, unknown>), confirm: true };
      try {
        toolPayload = await this.transport.callTool(auth, action.toolName, args);
        if (isConfirmationRequired(toolPayload)) {
          // The MCP layer refused to execute (should not happen with confirm:true).
          toolPayload = { error: 'Tool did not execute despite confirmation' };
        }
      } catch (e) {
        toolPayload = { error: (e as Error).message ?? 'Tool execution failed' };
      }
      const failed = Boolean(toolPayload?.error);
      await this.prisma.copilotPendingAction.update({
        where: { id: action.id },
        data: { resultJson: toolPayload ?? null, ...(failed ? { status: 'FAILED' } : {}) },
      });
    } else {
      toolPayload = { cancelled: true, reason: 'User rejected the action' };
    }

    await this.audit.log({
      userId: user.id,
      action: dto.approve ? 'COPILOT_ACTION_CONFIRMED' : 'COPILOT_ACTION_REJECTED',
      resourceType: 'CopilotAction',
      resourceId: action.id,
      newData: { tool: action.toolName, args: action.argsJson },
    });

    await this.prisma.copilotMessage.create({
      data: {
        conversationId: action.conversationId,
        role: 'tool',
        content: JSON.stringify(toolPayload).slice(0, 8000),
        toolCallId: action.toolCallId,
        toolName: action.toolName,
      },
    });
    await this.touchConversation(action.conversationId);

    // Other actions from the same paused turn still unresolved? Return them.
    const siblings = await this.prisma.copilotPendingAction.findMany({
      where: { conversationId: action.conversationId, status: 'PENDING' },
    });
    if (siblings.length > 0) {
      return this.envelope(
        action.conversationId,
        [],
        'pending_actions',
        'More actions are waiting for your confirmation.',
        undefined,
        siblings.map((s) => this.toPendingPayload(s)),
      );
    }

    // Resume the loop so the LLM narrates the outcome.
    const { events, turn } = await this.runLoop(user, auth, action.conversationId);
    return this.envelope(action.conversationId, events, turn.type, turn.message, turn.model, turn.pendingActions);
  }

  // ------------------------------------------------------- conversations

  async listConversations(user: HrmPrincipal) {
    const rows = await this.prisma.copilotConversation.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1, where: { role: { not: 'tool' } } },
      },
    });
    return {
      success: true,
      data: rows.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        lastMessagePreview: c.messages[0]?.content?.slice(0, 120) ?? null,
      })),
    };
  }

  async getConversation(user: HrmPrincipal, id: string) {
    const conversation = await this.prisma.copilotConversation.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        pendingActions: { where: { status: 'PENDING' } },
      },
    });
    if (!conversation || conversation.userId !== user.id) {
      throw new NotFoundException('Conversation not found');
    }
    await this.expireStaleActions(id);
    return {
      success: true,
      data: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        messages: conversation.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolName: m.toolName,
          toolCalls: m.toolCalls,
          createdAt: m.createdAt,
        })),
        pendingActions: conversation.pendingActions
          .filter((a) => a.expiresAt > new Date())
          .map((a) => this.toPendingPayload(a)),
      },
    };
  }

  async deleteConversation(user: HrmPrincipal, id: string) {
    const conversation = await this.prisma.copilotConversation.findUnique({ where: { id } });
    if (!conversation || conversation.userId !== user.id) {
      throw new NotFoundException('Conversation not found');
    }
    await this.prisma.copilotConversation.delete({ where: { id } }); // cascades
    return { success: true, data: { deleted: true } };
  }

  // ------------------------------------------------------------ internals

  private async runLoop(
    user: HrmPrincipal,
    auth: AuthForwardContext,
    conversationId: string,
    emit?: (e: AgentEvent) => void,
  ) {
    const events: AgentEvent[] = [];
    const toolDefs = await this.getToolDefs(user, auth);
    const history = await this.buildHistory(conversationId);
    const messages: OrMessage[] = [
      { role: 'system', content: buildCopilotSystemPrompt(user) },
      ...history,
    ];

    const turn = await this.agentLoop.run({
      auth,
      userId: user.id,
      conversationId,
      messages,
      toolDefs,
      onEvent: (e) => {
        events.push(e);
        emit?.(e);
      },
    });
    await this.touchConversation(conversationId);
    return { events, turn };
  }

  private toolActivityFrom(
    events: AgentEvent[],
    pendingActions: PendingActionPayload[],
  ): ToolActivityEntry[] {
    const toolActivity: ToolActivityEntry[] = events
      .filter((e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call')
      .filter((e) => e.phase === 'finished')
      .map((e) => ({
        toolCallId: e.toolCallId,
        tool: e.tool,
        status: e.ok ? 'ok' : 'error',
        durationMs: e.durationMs,
        resultSummary: e.resultSummary,
      }));
    for (const a of pendingActions) {
      const entry = toolActivity.find((t) => t.tool === a.tool && t.status === 'ok');
      if (entry) entry.status = 'pending_confirmation';
    }
    return toolActivity;
  }

  private envelope(
    conversationId: string,
    events: AgentEvent[],
    type: 'final' | 'pending_actions',
    message: string,
    model?: string,
    pendingActions: PendingActionPayload[] = [],
  ) {
    const toolActivity = this.toolActivityFrom(events, pendingActions);
    const turn: CopilotTurn = { conversationId, type, message, model, toolActivity, pendingActions };
    return { success: true, data: turn };
  }

  /**
   * Generate a short, human "essence" title for a new conversation (ChatGPT/
   * Claude style). Best-effort and fire-and-forget — the truncated first
   * message stays as the fallback if the model call fails.
   */
  private async generateTitle(
    conversationId: string,
    userMsg: string,
    assistantMsg: string,
  ): Promise<string | null> {
    try {
      const { message } = await this.llm.complete({
        tools: [],
        messages: [
          {
            role: 'system',
            content:
              'You write concise chat titles. Reply with ONLY a 3-6 word title (no quotes, no punctuation at the end) capturing the essence of the exchange.',
          },
          {
            role: 'user',
            content: `User: ${userMsg}\nAssistant: ${(assistantMsg || '').slice(0, 400)}\n\nTitle:`,
          },
        ],
      });
      const title = (message.content ?? '')
        .replace(/^["'\s]+|["'\s]+$/g, '')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 60)
        .trim();
      if (!title) return null;
      await this.prisma.copilotConversation.update({
        where: { id: conversationId },
        data: { title },
      });
      return title;
    } catch (e) {
      this.logger.warn(`title generation failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async findOrCreateConversation(user: HrmPrincipal, dto: CopilotChatDto) {
    if (dto.conversationId) {
      const existing = await this.prisma.copilotConversation.findUnique({
        where: { id: dto.conversationId },
      });
      if (!existing || existing.userId !== user.id) {
        throw new NotFoundException('Conversation not found');
      }
      return { conversation: existing, isNew: false };
    }
    const conversation = await this.prisma.copilotConversation.create({
      data: {
        userId: user.id,
        title: dto.message.slice(0, 60),
        branchId: user.homeBranchId ?? null,
      },
    });
    return { conversation, isNew: true };
  }

  private async getToolDefs(user: HrmPrincipal, auth: AuthForwardContext): Promise<OrToolDef[]> {
    // Grammar-safe schemas only for local/self-hosted servers; API providers keep
    // the richer (original) schema for accuracy and speed.
    const strict = isLocalEndpoint((await this.settings.get()).llmBaseUrl);
    const cacheKey = `${user.role}:${strict}`;
    const cached = this.toolCache.get(cacheKey);
    if (cached && Date.now() - cached.at < TOOL_LIST_CACHE_MS) return cached.tools;
    const tools = toOpenAiTools(await this.transport.listTools(auth), strict);
    if (!tools.length) throw new BadRequestException('No copilot tools are available for your role');
    this.toolCache.set(cacheKey, { at: Date.now(), tools });
    return tools;
  }

  /** Last N rows -> OpenAI messages; drops leading orphan tool rows; caps size. */
  private async buildHistory(conversationId: string): Promise<OrMessage[]> {
    const rows = await this.prisma.copilotMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_MESSAGE_LIMIT,
    });
    rows.reverse();

    while (rows.length && rows[0].role !== 'user') rows.shift();

    let total = 0;
    const messages: OrMessage[] = [];
    for (const row of rows) {
      total += row.content?.length ?? 0;
      if (row.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: row.content,
          ...(row.toolCalls ? { tool_calls: row.toolCalls as any } : {}),
        });
      } else if (row.role === 'tool') {
        messages.push({
          role: 'tool',
          content: row.content ?? '{}',
          tool_call_id: row.toolCallId ?? undefined,
        });
      } else {
        messages.push({ role: 'user', content: row.content ?? '' });
      }
    }

    while (total > HISTORY_CHAR_CAP && messages.length > 2) {
      const dropped = messages.shift()!;
      total -= dropped.content?.length ?? 0;
      while (messages.length && messages[0].role !== 'user') {
        total -= messages[0].content?.length ?? 0;
        messages.shift();
      }
    }
    return messages;
  }

  private toPendingPayload(a: any): PendingActionPayload {
    const preview = a.previewJson as any;
    return {
      actionId: a.id,
      tool: a.toolName,
      args: (a.argsJson as Record<string, unknown>) ?? {},
      preview: preview?.preview ?? preview,
      summary: typeof preview?.description === 'string' ? preview.description : undefined,
      destructive: preview?.destructive === true,
      expiresAt: a.expiresAt.toISOString(),
    };
  }

  private async touchConversation(id: string) {
    await this.prisma.copilotConversation
      .update({ where: { id }, data: { updatedAt: new Date() } })
      .catch(() => undefined);
  }

  private async expireStaleActions(conversationId?: string) {
    await this.prisma.copilotPendingAction.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: new Date() },
        ...(conversationId ? { conversationId } : {}),
      },
      data: { status: 'EXPIRED', resolvedAt: new Date() },
    });
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireStaleActionsCron() {
    try {
      await this.expireStaleActions();
    } catch (e) {
      this.logger.warn(`pending-action expiry sweep failed: ${(e as Error).message}`);
    }
  }
}
