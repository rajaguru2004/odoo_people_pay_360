import type { FieldValues, UseFormSetError, Path } from 'react-hook-form';
import { ApiError } from '@/types/api';

/**
 * Maps a rejected API call's per-field errors onto react-hook-form fields.
 *
 * The backend sends a field-keyed map alongside the message:
 *
 *   throw new BadRequestException({
 *     message: 'Validation failed',
 *     errors: { phone: 'Invalid phone', 'customFields.grade': 'Grade is required' },
 *   });
 *
 * `AllExceptionsFilter` passes `errors` through to the wire body, and the axios
 * interceptor (lib/axios.ts) copies it onto the FLAT rejection object — there is
 * no `.response` to read, which is why every `e.response.data.errors` in this
 * codebase silently evaluates to undefined and the precise per-field reasons
 * collapse into one generic toast.
 *
 * Keys are RHF field paths, so nested names ('customFields.grade') land on the
 * right control without any extra mapping.
 *
 * Returns true when at least one error was attached, so the caller can skip the
 * banner and let the form show the reasons in place:
 *
 *   if (!applyServerErrors(err, setError)) toast.error(getApiErrorMessage(err));
 *
 * Returns false for NestJS ValidationPipe failures — those carry `message` as a
 * string array and no `errors` map, so there is nothing to attach to a field.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  options: { focus?: boolean } = {},
): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as ApiError & { details?: unknown };
  // `errors` is the intended channel; `details` holds the whole response body
  // and is the fallback for endpoints that nest the map one level down.
  const candidate =
    err.errors ?? (err.details as { errors?: unknown } | null)?.errors;

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }

  let attached = false;
  for (const [path, raw] of Object.entries(
    candidate as Record<string, unknown>,
  )) {
    // A field may carry several reasons; show them as one line rather than
    // dropping all but the first.
    const message = Array.isArray(raw)
      ? raw.filter(Boolean).join(' ')
      : typeof raw === 'string'
        ? raw
        : '';
    if (!message.trim()) continue;

    setError(
      path as Path<T>,
      { type: 'server', message: message.trim() },
      // Focus only the first, or the browser scrolls to the last field instead.
      { shouldFocus: (options.focus ?? true) && !attached },
    );
    attached = true;
  }

  return attached;
}
