import { ApiError } from '@/types/api';

/**
 * Extracts a human-readable message from a rejected API call.
 *
 * The axios response interceptor (lib/axios.ts) rejects with a FLAT `ApiError`
 * object — `{ success, statusCode, message, ... }` — so the backend message
 * lives on `error.message`, NOT on `error.response.data.message`. NestJS's
 * ValidationPipe returns `message` as an ARRAY of strings (one per failed
 * field), which we join so the banner shows the real reason instead of a
 * generic fallback.
 */
export function getApiErrorMessage(
  error: unknown,
  fallback = 'Something went wrong',
): string {
  if (!error) return fallback;

  // Prefer our flat ApiError shape; fall back to a raw axios error or a bare string.
  const raw =
    (error as ApiError)?.message ??
    (error as any)?.response?.data?.message ??
    (typeof error === 'string' ? error : undefined);

  if (Array.isArray(raw)) {
    const joined = raw.filter(Boolean).join(' ').trim();
    return joined || fallback;
  }
  if (typeof raw === 'string' && raw.trim()) return raw.trim();

  return fallback;
}
