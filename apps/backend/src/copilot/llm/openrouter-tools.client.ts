import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { CopilotSettingsService } from '../../copilot-settings/copilot-settings.service';
import { isLocalEndpoint, OrToolDef } from '../mcp/schema-mapper';

export interface OrToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OrMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OrToolCall[]; // assistant messages
  tool_call_id?: string; // tool messages
}

const DEFAULT_MODELS =
  'google/gemini-2.0-flash-exp:free,meta-llama/llama-3.3-70b-instruct:free';

/**
 * OpenRouter chat-completions client WITH tool calling — separate from the
 * legacy chatbot LLMService (which is prompt-only). Model list is env config
 * because free tool-capable model ids rotate on OpenRouter.
 */
@Injectable()
export class OpenRouterToolsClient {
  private readonly logger = new Logger(OpenRouterToolsClient.name);

  constructor(private readonly settings: CopilotSettingsService) {}

  /** Model fallback chain from settings — a single override wins when set. */
  async models(): Promise<string[]> {
    const cfg = await this.settings.get();
    if (cfg.modelOverride.trim()) return [cfg.modelOverride.trim()];
    return cfg.models.length ? cfg.models : DEFAULT_MODELS.split(',').map((s) => s.trim());
  }

  async complete(opts: {
    messages: OrMessage[];
    tools: OrToolDef[];
  }): Promise<{ message: OrMessage; model: string; usage?: any }> {
    const cfg = await this.settings.get();
    const baseURL = cfg.llmBaseUrl; // already normalized (no trailing slash) by the settings service
    const apiKey = cfg.llmApiKey;
    const models = cfg.modelOverride.trim() ? [cfg.modelOverride.trim()] : cfg.models;
    const local = isLocalEndpoint(baseURL);
    let lastErr: any;

    for (const model of models) {
      try {
        // OpenAI-compatible chat/completions: works with OpenRouter, OpenAI,
        // Azure OpenAI, Groq, Together, local vLLM/Ollama, etc.
        const res = await axios.post(
          `${baseURL}/chat/completions`,
          {
            model,
            messages: opts.messages,
            tools: opts.tools.length ? opts.tools : undefined,
            tool_choice: opts.tools.length ? 'auto' : undefined,
            // Parallel tool calls for API providers (fewer round-trips = faster);
            // omitted for local/strict servers that 400 on unknown params.
            ...(local ? {} : { parallel_tool_calls: true }),
            temperature: 0.2,
            max_tokens: 2000,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://ess-portal.company.com',
              'X-Title': 'Ess Portal HR Copilot',
            },
            timeout: 60_000,
          },
        );

        const msg = res.data?.choices?.[0]?.message;
        if (!msg || (msg.content == null && !msg.tool_calls?.length)) {
          throw new Error('Empty completion');
        }
        return { message: msg, model, usage: res.data.usage };
      } catch (e: any) {
        lastErr = e;
        this.logger.warn(
          `Copilot model ${model} failed: status=${e.response?.status ?? 'n/a'} ` +
            `msg=${e.response?.data?.error?.message ?? e.message} body=${safeBody(e.response?.data)}`,
        );
      }
    }

    throw new ServiceUnavailableException(
      `All copilot models failed: ${lastErr?.response?.data?.error?.message ?? lastErr?.message}`,
    );
  }

  /**
   * Streaming variant. Forwards assistant text deltas via `onText` as they
   * arrive and assembles the full message (content + tool_calls) to return.
   * Tries each model in turn; throws if none can stream (caller may fall back
   * to the non-streaming `complete`).
   */
  async completeStream(
    opts: { messages: OrMessage[]; tools: OrToolDef[] },
    onText: (text: string) => void,
  ): Promise<{ message: OrMessage; model: string }> {
    const cfg = await this.settings.get();
    const baseURL = cfg.llmBaseUrl;
    const apiKey = cfg.llmApiKey;
    const models = cfg.modelOverride.trim() ? [cfg.modelOverride.trim()] : cfg.models;
    const local = isLocalEndpoint(baseURL);
    let lastErr: any;

    for (const model of models) {
      try {
        const res = await axios.post(
          `${baseURL}/chat/completions`,
          {
            model,
            messages: opts.messages,
            tools: opts.tools.length ? opts.tools : undefined,
            tool_choice: opts.tools.length ? 'auto' : undefined,
            ...(local ? {} : { parallel_tool_calls: true }),
            temperature: 0.2,
            max_tokens: 2000,
            stream: true,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              'HTTP-Referer': 'https://ess-portal.company.com',
              'X-Title': 'Ess Portal HR Copilot',
            },
            timeout: 120_000,
            responseType: 'stream',
          },
        );
        const message = await consumeSseStream(res.data, onText);
        if (message.content == null && !message.tool_calls?.length) {
          throw new Error('Empty stream');
        }
        return { message, model };
      } catch (e: any) {
        lastErr = e;
        this.logger.warn(
          `Copilot stream model ${model} failed: ${e.response?.status ?? ''} ${e.message}`,
        );
      }
    }
    throw new ServiceUnavailableException(
      `All copilot models failed (stream): ${lastErr?.message}`,
    );
  }
}

function safeBody(d: any): string {
  if (d == null) return '';
  try {
    // A streaming error body is a Readable — don't try to serialize it.
    if (typeof d.pipe === 'function') return '<stream>';
    return (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400);
  } catch {
    return '<unserializable>';
  }
}

/** Parse an OpenAI-style SSE completion stream into a single assistant message. */
function consumeSseStream(
  stream: NodeJS.ReadableStream,
  onText: (text: string) => void,
): Promise<OrMessage> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let content = '';
    const toolMap = new Map<number, { id: string; name: string; args: string }>();

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            onText(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              const cur = toolMap.get(i) ?? { id: '', name: '', args: '' };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              toolMap.set(i, cur);
            }
          }
        } catch {
          /* partial/non-JSON keepalive line — ignore */
        }
      }
    });
    stream.on('end', () => {
      const tool_calls = [...toolMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({
          id: v.id,
          type: 'function' as const,
          function: { name: v.name, arguments: v.args },
        }));
      resolve({
        role: 'assistant',
        content: content || null,
        ...(tool_calls.length ? { tool_calls } : {}),
      });
    });
    stream.on('error', reject);
  });
}
