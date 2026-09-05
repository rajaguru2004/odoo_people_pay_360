/**
 * Resolve a stored file URL for display/download.
 * - Absolute URLs (MinIO S3, e.g. https://s3.../bucket/...) are used as-is.
 * - Legacy relative paths (/uploads/...) are served by the backend.
 */
export function resolveFileUrl(url?: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002'}${url}`;
}
