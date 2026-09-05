import { API_BASE } from '@/lib/apiBase';

/**
 * Turn a server-relative upload path into something an `<img>` can load.
 *
 * The API stores `/uploads/...`, which is correct only when the portal and the
 * API share an origin. In a split deployment that path resolves against the
 * PORTAL and 404s, so it is joined to {@link API_BASE} — the same one resolver
 * axios uses, rather than a second guess at where the API lives.
 *
 * An absolute URL is returned untouched: it already names its own host.
 */
export function resolveFileUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) return url;
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}
