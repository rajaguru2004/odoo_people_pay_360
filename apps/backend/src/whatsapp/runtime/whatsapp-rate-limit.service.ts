import { Injectable } from '@nestjs/common';

interface Window {
  hits: number[];
}

/**
 * Sliding-window limits for the inbound channel.
 *
 * Shape copied from CopilotRateLimitGuard, but a service rather than a guard:
 * there is no `req.user` off the HTTP path. In-memory is adequate for the
 * current single-process deployment; the persisted daily counter on
 * whatsapp_identities is what stops a restart resetting an identified abuser.
 */
@Injectable()
export class WhatsAppRateLimitService {
  private windows = new Map<string, Window>();

  /**
   * True when the call is allowed.
   *
   * A limit of 0 (or less) means UNLIMITED, not "block everything". These
   * ceilings exist to stop a runaway client, never to ration an employee's own
   * HR services — so an admin who wants a limit gone must be able to remove it,
   * and the setting that removes it must not be the one that locks everyone
   * out. Absent this, "0" read as "zero allowed" and silenced the channel.
   */
  allow(key: string, limit: number, windowMs: number): boolean {
    if (!Number.isFinite(limit) || limit <= 0) return true;
    const now = Date.now();
    const w = this.windows.get(key) ?? { hits: [] };
    w.hits = w.hits.filter((t) => now - t < windowMs);
    if (w.hits.length >= limit) {
      this.windows.set(key, w);
      return false;
    }
    w.hits.push(now);
    this.windows.set(key, w);
    return true;
  }

  /**
   * Anti-enumeration: an unknown number gets ONE reply per hour, and that reply
   * is identical whether the number is unknown, revoked, blocked or belongs to
   * a deactivated user. Never confirm whether a number is known to the system.
   */
  allowUnknownReply(phoneE164: string): boolean {
    return this.allow(`unknown:${phoneE164}`, 1, 60 * 60_000);
  }

  /** Periodic cleanup so a long-running process does not accumulate keys. */
  prune(): void {
    const now = Date.now();
    for (const [k, w] of this.windows) {
      if (w.hits.every((t) => now - t > 60 * 60_000)) this.windows.delete(k);
    }
  }
}
