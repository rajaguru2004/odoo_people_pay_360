/**
 * Events emitted by the agent loop. v1 accumulates them into the JSON
 * response (`toolActivity`); a future SSE endpoint can stream the same
 * objects without touching the loop.
 */
export type AgentEvent =
  | { type: 'status'; iteration: number }
  | {
      type: 'tool_call';
      phase: 'started' | 'finished';
      toolCallId: string;
      tool: string;
      args?: Record<string, unknown>;
      ok?: boolean;
      durationMs?: number;
      resultSummary?: string;
    }
  | { type: 'pending_action'; action: PendingActionPayload }
  | { type: 'delta'; text: string }
  | { type: 'final'; message: string }
  | { type: 'error'; message: string };

export interface PendingActionPayload {
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
  preview: unknown;
  summary?: string;
  destructive?: boolean;
  expiresAt: string;
}

export interface ToolActivityEntry {
  toolCallId: string;
  tool: string;
  status: 'ok' | 'error' | 'pending_confirmation';
  durationMs?: number;
  resultSummary?: string;
}

export type AgentResultType = 'final' | 'pending_actions';

export interface AgentResult {
  type: AgentResultType;
  message: string;
  model?: string;
  pendingActions?: PendingActionPayload[];
}
