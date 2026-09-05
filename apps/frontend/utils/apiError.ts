/**
 * Read the server's own explanation out of a rejected request.
 *
 * Why this exists: `lib/axios.ts` rejects with a FLAT object
 * (`{ success, statusCode, message, errors, details, … }`), not an AxiosError. So
 * the natural-looking `err.response?.data?.message` reads `undefined`, the caller's
 * fallback string wins, and a precise backend message — "A wage file for this
 * payroll already exists (version 1, GENERATED)" — surfaces to the user as
 * "Generation failed". The two shapes were being read inconsistently across the
 * codebase, so this handles both and is the one thing to call.
 *
 * Field-level errors (e.g. `{ iban: 'IBAN check digits are invalid' }`) are folded
 * into the message, because for validation failures those ARE the explanation.
 */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (!err) return fallback;
  if (typeof err === 'string') return err;

  const e = err as Record<string, any>;

  // Flat shape from our interceptor, then the raw AxiosError shape, then a plain
  // Error. Anything that bypasses the interceptor still gets a real message.
  const body = e.details ?? e.response?.data ?? null;
  const base: string | undefined =
    firstString(e.message) ??
    firstString(body?.message) ??
    firstString(e.error) ??
    undefined;

  const fieldErrors = body?.errors ?? e.errors ?? null;
  const details = formatFieldErrors(fieldErrors);

  if (base && details) return `${base} — ${details}`;
  if (base) return base;
  if (details) return details;
  return fallback;
}

/** The HTTP status, when the caller wants to branch on it (409 vs 400). */
export function apiErrorStatus(err: unknown): number | undefined {
  const e = err as Record<string, any> | null;
  return e?.statusCode ?? e?.response?.status ?? undefined;
}

/**
 * The untouched response body, for endpoints that attach structured extras —
 * some routes return a full pre-flight report alongside their message so the
 * screen can refresh without a second round trip.
 */
export function apiErrorBody<T = any>(err: unknown): T | null {
  const e = err as Record<string, any> | null;
  return (e?.details ?? e?.response?.data ?? null) as T | null;
}

/**
 * The server's PER-FIELD validation errors, e.g. `{ iban: 'checksum failed' }`.
 *
 * Separate from `apiErrorBody` because the two shapes disagree about where they
 * live: the interceptor's flat rejection carries `errors` at the TOP level,
 * while a raw AxiosError carries it under `response.data`. Reading only one of
 * them is the same class of mistake as reading `err.response.data.message` — it
 * works in a test and returns undefined in the app.
 */
export function apiFieldErrors(err: unknown): Record<string, string> | null {
  const e = err as Record<string, any> | null;
  const body = e?.details ?? e?.response?.data ?? null;
  const errors = body?.errors ?? e?.errors ?? null;
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) return null;
  const entries = Object.entries(errors as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => [k, String(v).trim()] as const);
  return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * Nest sometimes sends `message` as an array (class-validator does this when several
 * constraints fail), so take the first usable string rather than rendering "[object
 * Object]" or a comma-mashed blob.
 */
function firstString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v)) {
    const found = v.find((x) => typeof x === 'string' && x.trim());
    if (found) return String(found).trim();
  }
  return undefined;
}

function formatFieldErrors(errors: unknown): string | undefined {
  if (!errors) return undefined;
  if (typeof errors === 'string') return errors.trim() || undefined;
  if (Array.isArray(errors)) {
    const parts = errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
    return parts.length ? parts.join('; ') : undefined;
  }
  if (typeof errors === 'object') {
    const parts = Object.entries(errors as Record<string, unknown>)
      .map(([field, msg]) => {
        const text = firstString(msg) ?? (msg == null ? '' : String(msg));
        return text ? `${field}: ${text}` : '';
      })
      .filter(Boolean);
    return parts.length ? parts.join('; ') : undefined;
  }
  return undefined;
}
