/**
 * Saving a blob to the user's disk, in one place.
 *
 * There were EIGHT copies of this eight-line snippet in the codebase — the
 * canonical one in `services/exportService.ts`, one in `services/vaultService.ts`,
 * and six inline in pages and components. Six people wrote their own rather
 * than import a payroll export service to save a file, which is a fair reading
 * of the dependency direction: this is a UI primitive, so it belongs in `lib/`
 * beside `axios.ts`, `apiError.ts` and `toast.ts`.
 *
 * One behavioural difference from the copy it replaces: `saveBlob` THROWS on a
 * bad value instead of calling `console.error`. The Playwright `problems`
 * fixture fails a test on any console error, so the old behaviour turned a
 * handled edge case into a failing browser test — and it swallowed the failure
 * from the user, who saw nothing happen at all.
 */

export class FileDownloadError extends Error {}

/** Trigger a browser download for a blob. */
export function saveBlob(blob: unknown, filename: string): void {
  if (!(blob instanceof Blob)) {
    throw new FileDownloadError(
      'The download did not arrive as a file. Please try again.',
    );
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoked on a delay: revoking synchronously cancels the download in some
    // browsers before it has started.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/**
 * The filename the SERVER chose, from `Content-Disposition`.
 *
 * Worth the parsing: filenames invented on the client drift from what the
 * server actually stored, and they lose the serial number that makes a letter
 * identifiable. Handles both `filename="…"` and the RFC 5987
 * `filename*=UTF-8''…` form the backend emits for Arabic and em-dashed names.
 */
export function filenameFromResponse(res: unknown, fallback: string): string {
  const headers = (res as { headers?: Record<string, string> })?.headers;
  const disposition = headers?.['content-disposition'] ?? headers?.['Content-Disposition'];
  if (!disposition) return fallback;

  // RFC 5987 first: when both forms are present it is the encoded one that
  // carries the non-ASCII characters, and the plain one is the degraded copy.
  const extended = /filename\*=(?:UTF-8|utf-8)''([^;]+)/i.exec(disposition);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // A malformed encoding is not worth failing a download over.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  if (plain?.[1]) return plain[1].trim();
  return fallback;
}

/**
 * Unwrap an axios response that may or may not have been unwrapped already.
 *
 * `lib/axios.ts` returns the whole AxiosResponse for `responseType: 'blob'`
 * and `response.data` for everything else. Every blob call site has to know
 * that, and the ones that did not produced a Blob-shaped object that was not a
 * Blob — which is the failure `saveBlob` now throws on.
 */
export function unwrapBlob(res: unknown): Blob {
  return ((res as { data?: unknown })?.data ?? res) as Blob;
}
