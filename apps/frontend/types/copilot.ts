export interface ToolActivityEntry {
  toolCallId: string;
  tool: string;
  status: 'ok' | 'error' | 'pending_confirmation';
  durationMs?: number;
  resultSummary?: string;
}

export interface PendingAction {
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
  preview: unknown;
  summary?: string;
  destructive?: boolean;
  expiresAt: string;
}

export interface CopilotTurn {
  conversationId: string;
  type: 'final' | 'pending_actions';
  message: string;
  model?: string;
  toolActivity: ToolActivityEntry[];
  pendingActions: PendingAction[];
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
  lastMessagePreview: string | null;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  toolName?: string | null;
  toolCalls?: unknown;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  title: string | null;
  createdAt: string;
  messages: ConversationMessage[];
  pendingActions: PendingAction[];
}

/** One rendered chat bubble (client-side state). */
export interface ChatItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolActivity?: ToolActivityEntry[];
  pendingActions?: PendingAction[];
  error?: boolean;
  /** Live streaming state. */
  streaming?: boolean;
  status?: string;
}

export interface CopilotStreamEvent {
  type: 'status' | 'tool_call' | 'delta' | 'pending_actions' | 'final' | 'error' | 'title';
  phase?: 'started' | 'finished' | 'thinking';
  tool?: string;
  text?: string;
  message?: string;
  title?: string;
  conversationId?: string;
  model?: string;
  toolActivity?: ToolActivityEntry[];
  pendingActions?: PendingAction[];
}
