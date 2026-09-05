import { CopilotTool } from './tool-transport';

export interface OrToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters: any };
}

/**
 * MCP tool list -> OpenAI-style function definitions.
 *
 * `strict` = grammar-safe mode for local/strict servers (llama.cpp, LM Studio):
 * it reduces schemas to a minimal subset those servers can compile into a GBNF
 * grammar. Remote API providers (OpenAI, OpenRouter, …) use the light path,
 * which preserves richer schema hints (format, ranges) for better accuracy and
 * is the original, unchanged behavior — so their performance is not affected.
 */
export function toOpenAiTools(tools: CopilotTool[], strict = false): OrToolDef[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: strict ? sanitizeGrammar(t.inputSchema) : sanitizeSchema(t.inputSchema),
    },
  }));
}

/**
 * Private/loopback endpoints are treated as local, self-hosted model servers
 * that need the grammar-safe request path. Public hostnames use performance mode.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'localhost' || host === '::1') return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a === 127 || a === 10) return true; // loopback + 10/8
      if (a === 192 && b === 168) return true; // 192.168/16
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    }
    return false;
  } catch {
    return false;
  }
}

// JSON-Schema keywords that grammar-based local servers (llama.cpp, LM Studio,
// some vLLM builds) cannot compile into a GBNF grammar and reject with
// "failed to parse grammar". They are validation-only hints — the MCP tool
// executor re-validates every argument with zod server-side — so dropping them
// costs nothing and makes the tool schemas portable across strict endpoints.
const STRIP_KEYS = new Set([
  '$schema',
  '$ref',
  '$defs',
  'definitions',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
  'examples',
  'const',
  'additionalProperties',
]);

/** Light (default, performance) sanitize — original behavior for API providers:
 *  drop $schema, ensure a top-level object schema, otherwise keep hints intact. */
function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const { $schema: _dollar, ...rest } = schema;
  if (!rest.type) rest.type = 'object';
  if (rest.type === 'object' && !rest.properties) rest.properties = {};
  return rest;
}

/** Strict (grammar-safe) sanitize for local/self-hosted servers: reduce to the
 *  subset a GBNF grammar builder accepts (type, enum, description, properties,
 *  required, items) and collapse nullable/union wrappers. */
function sanitizeGrammar(schema: any): any {
  const out = simplify(schema);
  // Top-level must be a plain object schema for the tool `parameters` field.
  if (!out || typeof out !== 'object' || Array.isArray(out)) {
    return { type: 'object', properties: {} };
  }
  if (!out.type) out.type = 'object';
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

function simplify(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;

  // Collapse anyOf/oneOf/allOf (from optional/nullable/union zod types) to a
  // single concrete branch — grammar builders commonly fail on unions.
  const union = schema.anyOf || schema.oneOf || schema.allOf;
  if (Array.isArray(union) && union.length) {
    const nonNull = union.find((s: any) => s && s.type !== 'null') ?? union[0];
    const merged = { ...schema, ...nonNull };
    delete merged.anyOf;
    delete merged.oneOf;
    delete merged.allOf;
    return simplify(merged);
  }

  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRIP_KEYS.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      // e.g. ["string","null"] -> "string"
      out.type = (value as any[]).find((t) => t !== 'null') ?? value[0];
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [p, ps] of Object.entries(value)) out.properties[p] = simplify(ps);
    } else if (key === 'items') {
      out.items = simplify(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Parse an MCP CallToolResult into a plain JSON payload. Prefers
 * structuredContent; falls back to the first text content item.
 */
export function parseMcpResult(res: any): any {
  if (res == null) return { error: 'Empty tool result' };
  if (res.structuredContent !== undefined) return res.structuredContent;

  const text = Array.isArray(res.content)
    ? res.content.find((c: any) => c?.type === 'text')?.text
    : undefined;

  if (text === undefined) {
    return res.isError ? { error: 'Tool failed with no output' } : {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return res.isError ? { error: String(text) } : { text: String(text) };
  }
}

export function isConfirmationRequired(parsed: any): boolean {
  return parsed != null && typeof parsed === 'object' && parsed.requiresConfirmation === true;
}
