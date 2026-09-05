/**
 * Who the request came from, at the network level.
 *
 * Lifted verbatim out of `AuditInterceptor`, which had the only copy. A second
 * consumer arrived (login alerts) and the choice was between duplicating four
 * subtle normalisation rules or naming them once — and they are subtle: an
 * IPv4-mapped IPv6 address and its plain form are the same client, but they
 * hash and compare differently, so a per-IP rate limit built on the un-normalised
 * value can be bypassed by nothing more than a protocol difference.
 */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * `x-forwarded-for` is trusted here because every deployment of this app sits
 * behind a reverse proxy that sets it. It is a client-controllable header: an
 * attacker can put anything in it, so the value is fine for a "where did this
 * come from" alert and must never become an authorisation input.
 */
export function extractRequestMeta(request: any): RequestMeta {
  const rawIp =
    (request?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    request?.ip ||
    request?.connection?.remoteAddress ||
    null;

  return {
    ip: normalizeIp(rawIp),
    userAgent: (request?.headers?.['user-agent'] as string) ?? null,
  };
}

/** Normalise IPv6 loopback and IPv4-mapped IPv6 to plain IPv4. */
export function normalizeIp(rawIp: string | null | undefined): string | null {
  if (!rawIp) return null;
  if (rawIp === '::1') return '127.0.0.1';
  if (rawIp.startsWith('::ffff:')) return rawIp.slice(7);
  return rawIp;
}
