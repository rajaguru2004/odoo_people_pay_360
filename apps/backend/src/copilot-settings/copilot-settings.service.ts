import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { decryptSecret, encryptSecret, maskSecret } from '../common/crypto/secret-crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateCopilotSettingsDto } from './dto/update-copilot-settings.dto';
import {
  AvailableModelsResult,
  CopilotPublicConfig,
  CopilotResolvedConfig,
  DEFAULT_MODELS,
  FALLBACK_MODEL_OPTIONS,
  SETTING_KEYS,
  TestConnectionResult,
} from './copilot-settings.types';
import { TestConnectionDto } from './dto/test-connection.dto';

const PING_TOOL = {
  type: 'function',
  function: { name: 'ping', description: 'noop', parameters: { type: 'object', properties: {} } },
};

/** Pull the most useful message out of an axios error (OpenAI-style body, string, or message). */
function extractError(e: any): string {
  const d = e?.response?.data;
  return (
    d?.error?.message ||
    d?.error ||
    d?.message ||
    (typeof d === 'string' ? d : '') ||
    e?.message ||
    'Unknown error'
  )
    .toString()
    .slice(0, 300);
}

function safeBody(d: any): string {
  try {
    return (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500);
  } catch {
    return '<unserializable>';
  }
}

const CACHE_TTL_MS = 30_000;

/**
 * Single source of truth for MCP + Copilot runtime config. Values are stored as
 * key-value rows in `system_settings` (no dedicated table) and resolved as
 * DB value → environment variable → hardcoded default, so the system keeps
 * working before anything is saved and tests that set env vars still pass.
 *
 * The LLM API key is encrypted at rest (AES-256-GCM) and never returned to the UI.
 */
@Injectable()
export class CopilotSettingsService {
  private readonly logger = new Logger(CopilotSettingsService.name);
  private cache?: { at: number; cfg: CopilotResolvedConfig };

  constructor(private readonly prisma: PrismaService) {}

  /** Resolved config (cached ~30s). Includes the decrypted key for internal callers. */
  async get(): Promise<CopilotResolvedConfig> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.cfg;

    const rows = await runWithBranchBypass(() =>
      this.prisma.systemSetting.findMany({
        where: { key: { startsWith: 'mcp.' } },
      }),
    ).catch(() => [] as { key: string; value: string }[]);
    const copilotRows = await runWithBranchBypass(() =>
      this.prisma.systemSetting.findMany({
        where: { key: { startsWith: 'copilot.' } },
      }),
    ).catch(() => [] as { key: string; value: string }[]);

    const store = new Map<string, string>();
    for (const r of [...rows, ...copilotRows]) store.set(r.key, r.value);

    const cfg: CopilotResolvedConfig = {
      mcpEnabled: this.bool(store.get(SETTING_KEYS.mcpEnabled), ['MCP_ENABLED'], true),
      mcpAuditReads: this.bool(store.get(SETTING_KEYS.mcpAuditReads), ['MCP_AUDIT_READS'], true),
      mcpMaxItems: this.int(store.get(SETTING_KEYS.mcpMaxItems), ['MCP_MAX_ITEMS'], 50),
      mcpLoopbackUrl: this.str(store.get(SETTING_KEYS.mcpLoopbackUrl), ['MCP_LOOPBACK_URL'], ''),
      copilotEnabled: this.bool(store.get(SETTING_KEYS.copilotEnabled), ['COPILOT_ENABLED'], true),
      llmBaseUrl: this.str(
        store.get(SETTING_KEYS.llmBaseUrl),
        ['COPILOT_LLM_BASE_URL', 'OPENROUTER_BASE_URL'],
        'https://openrouter.ai/api/v1',
      ).replace(/\/+$/, ''),
      llmApiKey: this.resolveApiKey(store.get(SETTING_KEYS.llmApiKeyEnc)),
      models: this.str(store.get(SETTING_KEYS.models), ['COPILOT_MODELS'], DEFAULT_MODELS)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      modelOverride: this.str(store.get(SETTING_KEYS.modelOverride), ['COPILOT_MODEL_OVERRIDE'], ''),
      maxIterations: this.int(store.get(SETTING_KEYS.maxIterations), ['COPILOT_MAX_ITERATIONS'], 8),
      pendingTtlMinutes: this.int(
        store.get(SETTING_KEYS.pendingTtlMinutes),
        ['COPILOT_PENDING_ACTION_TTL_MINUTES'],
        10,
      ),
      rateLimit: this.int(store.get(SETTING_KEYS.rateLimit), ['COPILOT_RATE_LIMIT'], 30),
      rateWindowMs: this.int(store.get(SETTING_KEYS.rateWindowMs), ['COPILOT_RATE_WINDOW_MS'], 300_000),
    };

    this.cache = { at: Date.now(), cfg };
    return cfg;
  }

  /** Admin-facing projection — masks the key, never returns it. */
  async getPublic(): Promise<CopilotPublicConfig> {
    const cfg = await this.get();
    const { llmApiKey, ...rest } = cfg;
    return {
      ...rest,
      llmApiKeyConfigured: Boolean(llmApiKey),
      llmApiKeyMasked: maskSecret(llmApiKey),
    };
  }

  async update(dto: UpdateCopilotSettingsDto): Promise<CopilotPublicConfig> {
    const writes: Array<[string, string]> = [];
    const push = (k: string, v: unknown) => {
      if (v !== undefined) writes.push([k, String(v)]);
    };

    push(SETTING_KEYS.mcpEnabled, dto.mcpEnabled);
    push(SETTING_KEYS.mcpAuditReads, dto.mcpAuditReads);
    push(SETTING_KEYS.mcpMaxItems, dto.mcpMaxItems);
    push(SETTING_KEYS.mcpLoopbackUrl, dto.mcpLoopbackUrl);
    push(SETTING_KEYS.copilotEnabled, dto.copilotEnabled);
    push(SETTING_KEYS.llmBaseUrl, dto.llmBaseUrl);
    push(SETTING_KEYS.modelOverride, dto.modelOverride);
    push(SETTING_KEYS.maxIterations, dto.maxIterations);
    push(SETTING_KEYS.pendingTtlMinutes, dto.pendingTtlMinutes);
    push(SETTING_KEYS.rateLimit, dto.rateLimit);
    push(SETTING_KEYS.rateWindowMs, dto.rateWindowMs);
    if (dto.models !== undefined) {
      push(SETTING_KEYS.models, dto.models.map((s) => s.trim()).filter(Boolean).join(','));
    }

    await runWithBranchBypass(async () => {
      for (const [key, value] of writes) {
        await this.prisma.systemSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        });
      }

      // API key: encrypt-on-write, keep-on-omit, delete-on-clear.
      if (dto.clearApiKey) {
        await this.prisma.systemSetting
          .deleteMany({ where: { key: SETTING_KEYS.llmApiKeyEnc } })
          .catch(() => undefined);
      } else if (typeof dto.llmApiKey === 'string' && dto.llmApiKey.trim()) {
        const enc = encryptSecret(dto.llmApiKey.trim());
        await this.prisma.systemSetting.upsert({
          where: { key: SETTING_KEYS.llmApiKeyEnc },
          update: { value: enc },
          create: { key: SETTING_KEYS.llmApiKeyEnc, value: enc },
        });
      }
    });

    this.invalidate();
    return this.getPublic();
  }

  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * Best-effort live lookup of tool-capable models. Uses the given overrides
   * (unsaved Base URL / key) falling back to stored config, so the picker
   * reflects whatever endpoint the admin is currently typing.
   */
  async availableModels(overrides?: {
    baseUrl?: string;
    apiKey?: string;
  }): Promise<AvailableModelsResult> {
    const cfg = await this.get();
    const baseUrl = (overrides?.baseUrl?.trim() || cfg.llmBaseUrl).replace(/\/+$/, '');
    const apiKey = overrides?.apiKey?.trim() || cfg.llmApiKey;

    if (!apiKey) {
      this.logger.warn(`available-models: no API key for ${baseUrl} — returning fallback list`);
      return { source: 'fallback', models: FALLBACK_MODEL_OPTIONS, message: 'No API key — showing suggestions.' };
    }
    try {
      const res = await axios.get(`${baseUrl}/models`, {
        // supported_parameters is an OpenRouter filter; other endpoints ignore it.
        params: { supported_parameters: 'tools' },
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 12_000,
      });
      const ids: string[] = (res.data?.data ?? [])
        .map((m: any) => m?.id)
        .filter((x: any) => typeof x === 'string');
      if (!ids.length) {
        this.logger.warn(`available-models: ${baseUrl}/models returned no ids — fallback`);
        return { source: 'fallback', models: FALLBACK_MODEL_OPTIONS, message: 'Endpoint returned no models.' };
      }
      this.logger.log(`available-models: ${ids.length} models from ${baseUrl}`);
      return { source: 'live', models: ids.sort() };
    } catch (e: any) {
      const status = e.response?.status;
      const detail = extractError(e);
      this.logger.warn(
        `available-models lookup failed: baseUrl=${baseUrl} status=${status ?? 'n/a'} detail=${detail} body=${safeBody(e.response?.data)}`,
      );
      return {
        source: 'fallback',
        models: FALLBACK_MODEL_OPTIONS,
        message: status ? `Lookup failed (${status}: ${detail}).` : `Lookup failed (${detail}).`,
      };
    }
  }

  /**
   * Live connectivity test against the LLM endpoint. Uses the given overrides
   * (unsaved form values) falling back to stored config, so admins can validate
   * before saving. Probes tool-calling support and distinguishes it from a plain
   * connectivity failure.
   */
  async testConnection(dto: TestConnectionDto): Promise<TestConnectionResult> {
    const cfg = await this.get();
    const baseUrl = (dto.baseUrl?.trim() || cfg.llmBaseUrl).replace(/\/+$/, '');
    const apiKey = dto.apiKey?.trim() || cfg.llmApiKey;
    const model = dto.model?.trim() || cfg.modelOverride.trim() || cfg.models[0] || '';

    if (!apiKey) return { ok: false, message: 'No API key set — enter one above (or save it) to test.' };
    if (!model) return { ok: false, message: 'No model configured — select at least one fallback model.' };

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ess-portal.company.com',
      'X-Title': 'Ess Portal HR Copilot',
    };
    const body = (withTools: boolean) => ({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      max_tokens: 16,
      ...(withTools ? { tools: [PING_TOOL], tool_choice: 'auto' } : {}),
    });
    const started = Date.now();
    this.logger.log(`test-connection: probing ${baseUrl} model=${model} (with tools)`);

    try {
      await axios.post(`${baseUrl}/chat/completions`, body(true), { headers, timeout: 25_000 });
      this.logger.log(`test-connection OK (tools): model=${model}`);
      return {
        ok: true,
        model,
        toolCalling: true,
        latencyMs: Date.now() - started,
        message: `Connected — ${model} responded and supports tool calling.`,
      };
    } catch (e1: any) {
      this.logger.warn(
        `test-connection with-tools failed: model=${model} status=${e1.response?.status ?? 'n/a'} detail=${extractError(e1)} body=${safeBody(e1.response?.data)}`,
      );
      // Retry without tools to tell "no tool support" apart from "can't connect".
      try {
        await axios.post(`${baseUrl}/chat/completions`, body(false), { headers, timeout: 25_000 });
        this.logger.log(`test-connection OK (no tools): model=${model} — tool calling unsupported`);
        return {
          ok: true,
          model,
          toolCalling: false,
          latencyMs: Date.now() - started,
          message: `Connected, but ${model} may not support tool calling — the copilot needs a tool-capable model.`,
        };
      } catch (e2: any) {
        const status = e2.response?.status;
        const detail = extractError(e2);
        this.logger.error(
          `test-connection FAILED: baseUrl=${baseUrl} model=${model} status=${status ?? 'n/a'} detail=${detail} body=${safeBody(e2.response?.data)}`,
        );
        return {
          ok: false,
          model,
          latencyMs: Date.now() - started,
          message: status ? `${status}: ${detail}` : detail || 'Connection failed',
        };
      }
    }
  }

  // ------------------------------------------------------------------ helpers
  private resolveApiKey(encFromDb?: string): string {
    if (encFromDb) {
      try {
        return decryptSecret(encFromDb);
      } catch (e) {
        this.logger.error(`Failed to decrypt stored LLM API key: ${(e as Error).message}`);
      }
    }
    return (process.env.COPILOT_LLM_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
  }

  private str(dbVal: string | undefined, envNames: string[], def: string): string {
    if (dbVal !== undefined && dbVal !== null && dbVal.trim() !== '') return dbVal.trim();
    for (const n of envNames) {
      const v = process.env[n]?.trim();
      if (v) return v;
    }
    return def;
  }

  private int(dbVal: string | undefined, envNames: string[], def: number): number {
    const raw = this.str(dbVal, envNames, '');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  }

  private bool(dbVal: string | undefined, envNames: string[], def: boolean): boolean {
    const raw = this.str(dbVal, envNames, '').toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return def;
  }
}
