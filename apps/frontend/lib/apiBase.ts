/**
 * Where the API lives, resolved once for every caller.
 *
 * ONE resolver, used everywhere. The alternative — each module answering the
 * question itself — is how a checkout ends up with axios pointing at one port,
 * a streaming client at another, and a public page at the empty string, all
 * three "working" locally and only one of them working in a split deployment.
 */

/** Trailing slashes are stripped so callers can always write `${API_BASE}/path`. */
function resolve(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  // Unset: fall back to same-origin, which is correct for a single-host
  // deployment and for the catch-all rewrite in next.config.ts. Deliberately
  // NOT a guess at a sibling hostname such as `api.<host>` — bearer tokens
  // travel on these requests, and sending one to a host nobody configured is a
  // worse failure than a visible 404.
  return '';
}

export const API_BASE = resolve();

/** True when requests go to this same origin and rely on the Next.js proxy. */
export const API_IS_SAME_ORIGIN = API_BASE === '';
