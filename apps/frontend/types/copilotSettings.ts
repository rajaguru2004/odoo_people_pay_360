export interface CopilotSettings {
  // MCP server
  mcpEnabled: boolean;
  mcpAuditReads: boolean;
  mcpMaxItems: number;
  mcpLoopbackUrl: string;
  // Copilot
  copilotEnabled: boolean;
  llmBaseUrl: string;
  models: string[];
  modelOverride: string;
  maxIterations: number;
  pendingTtlMinutes: number;
  rateLimit: number;
  rateWindowMs: number;
  // API key (never returned in full)
  llmApiKeyConfigured: boolean;
  llmApiKeyMasked: string;
}

export interface UpdateCopilotSettings {
  mcpEnabled?: boolean;
  mcpAuditReads?: boolean;
  mcpMaxItems?: number;
  mcpLoopbackUrl?: string;
  copilotEnabled?: boolean;
  llmBaseUrl?: string;
  llmApiKey?: string; // new plaintext key; omit to keep
  clearApiKey?: boolean; // remove stored key
  models?: string[];
  modelOverride?: string;
  maxIterations?: number;
  pendingTtlMinutes?: number;
  rateLimit?: number;
  rateWindowMs?: number;
}

export interface AvailableModels {
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

export interface TestConnectionInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}
