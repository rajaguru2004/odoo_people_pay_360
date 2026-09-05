/**
 * Serialization for MCP tool results: JSON-safe values, service-envelope
 * unwrapping, list trimming and a hard size cap so large domain payloads
 * never blow up an LLM context window.
 */

const HARD_CAP_BYTES = 48 * 1024;

/** Recursively convert Prisma Decimal / Date / BigInt into JSON-safe values. */
export function toJsonSafe(value: any): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  // Prisma Decimal (decimal.js) duck-typing: has toNumber() and the d/e/s fields.
  if (
    typeof value === 'object' &&
    typeof value.toNumber === 'function' &&
    'd' in value &&
    'e' in value &&
    's' in value
  ) {
    return value.toNumber();
  }
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v));
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

/**
 * Normalize a domain-service result for tool output:
 * - unwrap the common `{ success, data, meta }` envelope,
 * - trim arrays to `maxItems` with a `{ truncated, returned, total }` marker,
 * - convert Decimal/Date/BigInt,
 * - enforce a ~48KB hard cap on the serialized JSON.
 */
export function toToolJson(result: unknown, opts: { maxItems?: number } = {}): unknown {
  const maxItems = clampMaxItems(opts.maxItems);
  let payload: any = toJsonSafe(result);
  let meta: any = undefined;

  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.success === true && 'data' in payload) {
    meta = payload.meta;
    payload = payload.data;
  }

  const trim = (arr: any[]) => {
    if (arr.length <= maxItems) return { data: arr, trimMeta: undefined };
    return {
      data: arr.slice(0, maxItems),
      trimMeta: { truncated: true, returned: maxItems, total: arr.length },
    };
  };

  let out: any;
  if (Array.isArray(payload)) {
    const { data, trimMeta } = trim(payload);
    out = { data, meta: { ...(meta ?? {}), ...(trimMeta ?? {}) } };
    if (Object.keys(out.meta).length === 0) delete out.meta;
  } else if (payload && typeof payload === 'object' && Array.isArray(payload.data)) {
    const { data, trimMeta } = trim(payload.data);
    out = { ...payload, data, meta: { ...(meta ?? {}), ...(payload.meta ?? {}), ...(trimMeta ?? {}) } };
    if (Object.keys(out.meta).length === 0) delete out.meta;
  } else {
    out = meta !== undefined ? { data: payload, meta } : payload;
  }

  return enforceHardCap(out, maxItems);
}

function clampMaxItems(v: number | undefined): number {
  const def = Number(process.env.MCP_MAX_ITEMS ?? 50);
  const n = Number.isFinite(v as number) && (v as number) > 0 ? Math.floor(v as number) : def;
  return Math.min(Math.max(n, 1), 200);
}

function enforceHardCap(out: any, maxItems: number): any {
  let json = JSON.stringify(out);
  if (json.length <= HARD_CAP_BYTES) return out;

  // Halve any embedded data array until it fits.
  let items = maxItems;
  while (json.length > HARD_CAP_BYTES && out && typeof out === 'object' && Array.isArray(out.data) && items > 1) {
    items = Math.floor(items / 2);
    const total = out.meta?.total ?? out.data.length;
    out = {
      ...out,
      data: out.data.slice(0, items),
      meta: { ...(out.meta ?? {}), truncated: true, returned: items, total },
    };
    json = JSON.stringify(out);
  }
  if (json.length <= HARD_CAP_BYTES) return out;

  return {
    truncated: true,
    note: `Result exceeded ${Math.floor(HARD_CAP_BYTES / 1024)}KB and was cut off. Use pagination/filter arguments to narrow the query.`,
    partial: json.slice(0, HARD_CAP_BYTES),
  };
}
