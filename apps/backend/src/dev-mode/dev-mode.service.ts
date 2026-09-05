import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { requireSecret } from '../common/config/require-secret';
import {
  DEFAULT_DEV_MODE_TTL_MINUTES,
  DEV_TOKEN_HEADER,
  ELEVATION_ELIGIBLE_ROLES,
} from './dev-mode.constants';

/**
 * Shape of a bcrypt hash: `$2a|2b|2y$<cost>$<22-char salt><31-char digest>`.
 * Used to tell "not configured" apart from "configured but arrived corrupted",
 * which are the same 401 to a caller but very different to whoever deployed it.
 */
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export interface DevTokenClaims {
  sub: string;
  dev: true;
  jti: string;
  exp: number;
}

export interface ElevationResult {
  devToken: string;
  expiresAt: string;
}

/**
 * Mints and validates developer-elevation tokens.
 *
 * Design notes, because each choice is load-bearing:
 *
 *  - The password lives ONLY as a bcrypt hash in `DEV_MODE_PASSWORD_HASH`. It is
 *    never in the database, so neither a DB dump nor an admin with settings
 *    write access can read or replace it.
 *  - The token is signed with `DEV_MODE_TOKEN_SECRET`, a DIFFERENT secret from
 *    `JWT_SECRET`. If the access-token secret ever leaks, the leak cannot be
 *    escalated into a forged elevation.
 *  - Live elevations are held in memory keyed by `jti`. That makes `revoke()`
 *    real (a stateless JWT could not be withdrawn) and means a backend restart
 *    drops every elevation, which is the behaviour we want. The backend runs as
 *    a single Node process today; if it is ever scaled horizontally this map
 *    must move to Redis or the elevation will not be seen by sibling instances.
 */
@Injectable()
export class DevModeService implements OnModuleInit {
  private readonly logger = new Logger(DevModeService.name);

  /** jti -> live elevation. Pruned lazily on every read and on each mint. */
  private readonly live = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Says so at boot when the hash is configured but unusable.
   *
   * Without this the only symptom is a flat 401 on every elevation attempt,
   * indistinguishable from a wrong password — which is exactly how a hash
   * mangled in transit burns an afternoon. The usual culprits are Docker
   * Compose keeping the surrounding quotes from an `env_file` line, and shell
   * or Compose variable substitution eating the `$` segments of the hash.
   */
  onModuleInit(): void {
    const raw = this.rawPasswordHash();
    if (!raw) return;

    if (!BCRYPT_HASH_RE.test(this.passwordHash())) {
      this.logger.error(
        'DEV_MODE_PASSWORD_HASH is set but is not a valid bcrypt hash, so every ' +
          'elevation attempt will fail with "Invalid credentials". It must look like ' +
          '$2b$12$<53 chars>. The usual cause is Docker Compose interpolating the ' +
          'value: it substitutes $name segments away, turning $2b$12$pSOAs0... into ' +
          '$2b$12... — look for "variable is not set" warnings from `docker compose`. ' +
          'Fix: write each $ as $$ in the .env (this service collapses $$ back to $, ' +
          'so the same line still works when running on the host). ' +
          `Received ${raw.length} chars starting "${raw.slice(0, 7)}".`,
      );
      return;
    }

    if (this.isEnforced()) {
      this.logger.log('Developer mode is ENFORCED — operator settings are hidden from admins.');
    }
  }

  /** A usable bcrypt hash must be configured before anyone can elevate. When it
   *  is absent — or present but malformed — developer mode simply does not
   *  exist: the header icon hides and every gated route refuses. */
  isAvailable(): boolean {
    return BCRYPT_HASH_RE.test(this.passwordHash());
  }

  /**
   * Whether the gates actually bite. Shipped `false` so the feature can be
   * deployed and exercised before it starts denying anyone — the same
   * kill-switch shape the rest of the app uses for risky behaviour changes.
   *
   * Deliberately an env var rather than a `system_settings` row: a DB flag
   * would be flippable by the very admins this feature gates.
   */
  isEnforced(): boolean {
    return (this.config.get<string>('DEV_MODE_ENFORCED') ?? '').toLowerCase() === 'true';
  }

  ttlMinutes(): number {
    const raw = Number(this.config.get<string>('DEV_MODE_TTL_MINUTES'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEV_MODE_TTL_MINUTES;
  }

  async verifyPassword(plain: string): Promise<boolean> {
    const hash = this.passwordHash();
    if (!hash) return false;
    if (!plain) return false;
    try {
      return await bcrypt.compare(plain, hash);
    } catch (err) {
      // A malformed hash must fail closed, not throw a 500 that hints at config.
      this.logger.error(`DEV_MODE_PASSWORD_HASH is not a valid bcrypt hash: ${err}`);
      return false;
    }
  }

  /** Mints an elevation bound to this specific user. */
  elevate(userId: string): ElevationResult {
    this.prune();

    const jti = randomUUID();
    const ttlMs = this.ttlMinutes() * 60_000;
    const expiresAt = Date.now() + ttlMs;

    const devToken = this.jwt.sign(
      { sub: userId, dev: true, jti },
      { secret: this.tokenSecret(), expiresIn: `${this.ttlMinutes()}m` },
    );

    this.live.set(jti, { userId, expiresAt });

    return { devToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Drops one elevation. Returns the jti that was dropped, for the audit row. */
  revoke(token: string | undefined): string | null {
    const claims = this.decode(token);
    if (!claims) return null;
    this.live.delete(claims.jti);
    return claims.jti;
  }

  /** Every live elevation for a user — used to drop them all on explicit exit. */
  revokeAllForUser(userId: string): number {
    let dropped = 0;
    for (const [jti, entry] of this.live.entries()) {
      if (entry.userId === userId) {
        this.live.delete(jti);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * The non-throwing check, used both by `DevModeGuard` and by the partial
   * gating inside `SystemSettingsController` (where some keys in one payload are
   * developer-only and the rest are not).
   */
  isElevated(req: any): boolean {
    return this.elevationFor(req) !== null;
  }

  /** Remaining elevation for this request, or null. */
  elevationFor(req: any): { jti: string; expiresAt: string } | null {
    const user = req?.user;
    if (!user || !ELEVATION_ELIGIBLE_ROLES.includes(user.role)) return null;

    const claims = this.decode(this.tokenFrom(req));
    if (!claims) return null;

    // The elevation is bound to the session that earned it. Without this check a
    // dev token could be replayed on any other admin's session.
    if (claims.sub !== user.id) return null;

    const entry = this.live.get(claims.jti);
    if (!entry) return null;
    if (entry.userId !== user.id) return null;
    if (entry.expiresAt <= Date.now()) {
      this.live.delete(claims.jti);
      return null;
    }

    return { jti: claims.jti, expiresAt: new Date(entry.expiresAt).toISOString() };
  }

  tokenFrom(req: any): string | undefined {
    const raw = req?.headers?.[DEV_TOKEN_HEADER];
    return Array.isArray(raw) ? raw[0] : raw;
  }

  private decode(token: string | undefined): DevTokenClaims | null {
    if (!token) return null;
    try {
      const claims = this.jwt.verify<DevTokenClaims>(token, { secret: this.tokenSecret() });
      if (!claims?.dev || !claims.jti || !claims.sub) return null;
      return claims;
    } catch {
      // Expired or tampered — indistinguishable to the caller on purpose.
      return null;
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [jti, entry] of this.live.entries()) {
      if (entry.expiresAt <= now) this.live.delete(jti);
    }
  }

  private rawPasswordHash(): string {
    return (this.config.get<string>('DEV_MODE_PASSWORD_HASH') ?? '').trim();
  }

  /**
   * The configured hash, normalised for how it may have travelled to get here.
   *
   * A bcrypt hash is hostile to env plumbing — it is full of `$`, which is
   * exactly what config layers interpolate. Two things happen in practice:
   *
   *  1. Docker Compose interpolates `env_file` values, so `$2b$12$pSOAs0...`
   *     loses `$pSOAs0...` entirely (a valid identifier name) and arrives as
   *     `$2b$12.Bo31...`. `$2b` and `$12` survive only because a variable name
   *     cannot start with a digit. The written fix is to escape each `$` as
   *     `$$`, which Compose collapses back to one `$`.
   *  2. Running the SAME .env on the host (npm run dev, prisma, jest) goes
   *     through dotenv, which does no interpolation — so the escaped `$$` form
   *     arrives verbatim and is now the broken one.
   *
   * Collapsing `$$` -> `$` here makes one written value correct in both places.
   * It is unambiguous: a valid bcrypt hash never contains two adjacent `$`,
   * since the three `$` are separators around non-empty fields.
   *
   * Surrounding quotes are stripped for the same reason — some Compose versions
   * keep them as part of the value.
   */
  private passwordHash(): string {
    const raw = this.rawPasswordHash();
    const unquoted = raw.replace(/^(["'])([\s\S]*)\1$/, '$2');
    return unquoted.replace(/\$\$/g, '$').trim();
  }

  private tokenSecret(): string {
    return requireSecret('DEV_MODE_TOKEN_SECRET', this.config.get<string>('DEV_MODE_TOKEN_SECRET'));
  }
}
