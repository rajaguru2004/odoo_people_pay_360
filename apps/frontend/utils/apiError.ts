/**
 * Pull the readable message out of whatever the caller caught.
 *
 * Two shapes reach a catch block: the FLAT `ApiError` the axios interceptor
 * rejects with (`err.message`), and a raw AxiosError from any call that bypassed
 * the instance (`err.response.data.message`). Reading only the second is how a
 * precise backend message ends up displayed as a generic fallback.
 */
export function apiErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (!error) return fallback;

  if (typeof error === 'string') return error;

  const e = error as {
    message?: string;
    response?: { data?: { message?: string } };
    errors?: unknown;
  };

  const nested = e.response?.data?.message;
  if (nested) return nested;

  if (e.message) return e.message;

  return fallback;
}

/** Field-level validation errors, when the backend sent any. */
export function apiFieldErrors(error: unknown): string[] {
  const errors = (error as { errors?: unknown })?.errors;
  if (Array.isArray(errors)) return errors.filter((e): e is string => typeof e === 'string');
  return [];
}
