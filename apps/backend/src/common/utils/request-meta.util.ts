import type { Request } from 'express';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Read the caller's IP and User-Agent.
 *
 * Behind a reverse proxy `req.ip` is the proxy, so `x-forwarded-for` wins when
 * present — its FIRST entry, which is the original client; the rest are the
 * proxies it traversed.
 */
export function extractRequestMeta(req: Request): RequestMeta {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0];
  return {
    ipAddress: first?.trim() || req.ip,
    userAgent: req.headers['user-agent'],
  };
}
