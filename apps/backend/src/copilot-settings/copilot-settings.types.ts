/** Fully-resolved MCP + Copilot configuration (internal use — includes the decrypted key). */
export interface CopilotResolvedConfig {
  // MCP server
  mcpEnabled: boolean;
  mcpAuditReads: boolean;
  mcpMaxItems: number;
  mcpLoopbackUrl: string; // '' → derive from PORT
  // Copilot
  copilotEnabled: boolean;
  llmBaseUrl: string;
  llmApiKey: string; // decrypted; '' if unset
  models: string[];
  modelOverride: string; // '' if unset
  maxIterations: number;
  pendingTtlMinutes: number;
  rateLimit: number;
  rateWindowMs: number;
}

/** Safe projection returned to the admin UI — never exposes the raw key. */
export interface CopilotPublicConfig
  extends Omit<CopilotResolvedConfig, 'llmApiKey' | 'models'> {
  models: string[];
  llmApiKeyConfigured: boolean;
  llmApiKeyMasked: string;
}

/** system_settings keys (key-value store — no new table needed). */
export const SETTING_KEYS = {
  mcpEnabled: 'mcp.enabled',
  mcpAuditReads: 'mcp.auditReads',
  mcpMaxItems: 'mcp.maxItems',
  mcpLoopbackUrl: 'mcp.loopbackUrl',
  copilotEnabled: 'copilot.enabled',
  llmBaseUrl: 'copilot.llmBaseUrl',
  llmApiKeyEnc: 'copilot.llmApiKeyEnc',
  models: 'copilot.models',
  modelOverride: 'copilot.modelOverride',
  maxIterations: 'copilot.maxIterations',
  pendingTtlMinutes: 'copilot.pendingTtlMinutes',
  rateLimit: 'copilot.rateLimit',
  rateWindowMs: 'copilot.rateWindowMs',
} as const;

export const DEFAULT_MODELS =
  'google/gemini-2.0-flash-exp:free,meta-llama/llama-3.3-70b-instruct:free';

export interface AvailableModelsResult {
  source: 'live' | 'fallback';
  models: string[];
  message?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  model?: string;
  toolCalling?: boolean;
  latencyMs?: number;
  message: string;
}

/** Curated fallback shown if the live /models lookup fails. */
export const FALLBACK_MODEL_OPTIONS = [
  'google/gemini-2.0-flash-exp:free',
  'google/gemini-2.5-flash-lite',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3.5-sonnet',
  'deepseek/deepseek-chat',
];
