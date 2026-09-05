/**
 * Where the API lives, resolved once for every caller.
 *
 * There used to be three answers to this question in three files — axios said
 * `NEXT_PUBLIC_API_URL || 'http://localhost:3002'`, the stream services said the
 * same (against a backend that listens on 3001), and the /verify page said
 * `''`. The verify page's empty string meant "same origin", which only worked
 * because next.config has a catch-all rewrite to the backend. In a split
 * deployment — portal on hrm.example.com, API on api.hrm.example.com — that
 * rewrite's destination fell back to http://localhost:3001, and the host
 * refused to proxy to a private address:
 *
 *     GET https://hrm.skillhiveinnovations.com/channel/verify/<token>
 *     404  X-Vercel-Error: DNS_HOSTNAME_RESOLVED_PRIVATE
 *
 * So the verification link was dead on every deployment where the API is not
 * the portal, and healthy on every developer machine. One resolver, used
 * everywhere, is what stops that from being possible again.
 */

/** Trailing slashes are stripped so callers can always write `${API_BASE}/path`. */
function resolve(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  // Unset: fall back to same-origin, which is correct for a single-host
  // deployment and for the ngrok setup where next.config proxies everything to
  // the backend. Deliberately NOT a guess at a sibling hostname such as
  // `api.<host>` — a verification token travels in these URLs, and sending one
  // to a host nobody configured is a worse failure than a visible 404.
  return '';
}

export const API_BASE = resolve();

/** True when requests will go to this same origin and rely on the proxy. */
export const API_IS_SAME_ORIGIN = API_BASE === '';
