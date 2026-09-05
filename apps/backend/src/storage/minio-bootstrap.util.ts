/**
 * Boot-time helpers for the MinIO clients.
 *
 * Verifying a bucket during Nest bootstrap is the worst possible moment to
 * measure the network: the embedding model and the face-api models load in the
 * same window and starve the event loop, so a 3s deadline was timing out
 * against a MinIO that was perfectly healthy. The answer is a generous
 * deadline, retries with backoff, and never treating one failed probe as
 * "storage is gone".
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Race `op` against a deadline. Unlike a bare `Promise.race` with an inline
 * `setTimeout`, the timer is always cleared — a leaked 3s timer per probe kept
 * the process awake and fired long after the operation had already answered.
 */
export async function withDeadline<T>(
  op: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Delays between bucket-verification attempts. ~1m50s of total patience. */
export const BUCKET_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Run `task` until it succeeds, waiting `delaysMs[n]` between attempts.
 * Attempts = `delaysMs.length + 1`. Rethrows the last error when all fail.
 */
export async function retryWithBackoff<T>(
  task: (attempt: number) => Promise<T>,
  delaysMs: readonly number[] = BUCKET_RETRY_DELAYS_MS,
  onRetry?: (attempt: number, err: Error, waitMs: number) => void,
): Promise<T> {
  let lastErr: Error = new Error('retryWithBackoff: no attempt ran');

  for (let attempt = 1; attempt <= delaysMs.length + 1; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const waitMs = delaysMs[attempt - 1];
      if (waitMs === undefined) break;
      onRetry?.(attempt, lastErr, waitMs);
      await sleep(waitMs);
    }
  }

  throw lastErr;
}
