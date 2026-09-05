import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { runWithBranchBypass } from '../../common/branch/branch-context';
import { PrismaService } from '../../prisma/prisma.service';

export interface IssueCheckinTokenArgs {
  identityId: string;
  userId: string;
  actionKey: string;
  toolName: string;
  args?: Record<string, unknown>;
  ttlMinutes: number;
}

export type ConsumeCheckinResult =
  | {
      ok: true;
      identityId: string;
      userId: string;
      actionKey: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { ok: false; reason: 'unknown' | 'expired' | 'replay' };

/**
 * Issues and burns the one-time link the bot hands out for a geofenced check-in.
 *
 * Modelled on WhatsAppActionTokenService, with one deliberate difference: there
 * is no identity binding at consume time, because the whole point is that the
 * link opens in a browser that has no Discord session to prove anything with.
 * The binding is compensated for elsewhere — the token is single-use, short
 * lived, carries the tool name and arguments itself (the browser can only add
 * coordinates), and can do exactly one thing: check its own owner in.
 */
@Injectable()
export class DiscordCheckinTokenService {
  private readonly logger = new Logger(DiscordCheckinTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** @returns the raw token. It is not recoverable afterwards. */
  async issue(args: IssueCheckinTokenArgs): Promise<string> {
    const token = randomBytes(32).toString('base64url');

    await runWithBranchBypass(async () => {
      // One live link per employee: issuing a second invalidates the first, so
      // a stale link left in a chat cannot be used later.
      await this.prisma.discordActionToken.updateMany({
        where: { userId: args.userId, purpose: 'CHECKIN', status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });

      await this.prisma.discordActionToken.create({
        data: {
          tokenHash: hash(token),
          identityId: args.identityId,
          userId: args.userId,
          purpose: 'CHECKIN',
          actionKey: args.actionKey,
          toolName: args.toolName,
          argsJson: (args.args ?? {}) as any,
          expiresAt: new Date(Date.now() + args.ttlMinutes * 60_000),
        },
      });
    });

    return token;
  }

  /** Non-destructive: tells the page whether to bother asking for GPS. */
  async peek(token: string): Promise<{ valid: boolean }> {
    if (!token) return { valid: false };
    return runWithBranchBypass(async () => {
      const row = await this.prisma.discordActionToken.findUnique({
        where: { tokenHash: hash(token) },
        select: { status: true, expiresAt: true },
      });
      return {
        valid: Boolean(row && row.status === 'PENDING' && row.expiresAt.getTime() > Date.now()),
      };
    });
  }

  async consume(token: string): Promise<ConsumeCheckinResult> {
    if (!token) return { ok: false, reason: 'unknown' };

    return runWithBranchBypass(async () => {
      const row = await this.prisma.discordActionToken.findUnique({
        where: { tokenHash: hash(token) },
      });
      if (!row) return { ok: false, reason: 'unknown' as const };
      if (row.status !== 'PENDING') return { ok: false, reason: 'replay' as const };
      if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' as const };

      // Atomic CAS. Two taps race here, and exactly one wins — the check-in
      // itself is not idempotent, so the guard has to be in the claim.
      const claimed = await this.prisma.discordActionToken.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'CONSUMED', consumedAt: new Date() },
      });
      if (claimed.count !== 1) return { ok: false, reason: 'replay' as const };

      return {
        ok: true as const,
        identityId: row.identityId,
        userId: row.userId,
        actionKey: row.actionKey,
        toolName: row.toolName,
        args: (row.argsJson ?? {}) as Record<string, unknown>,
      };
    });
  }

  /**
   * Hand a claimed token back.
   *
   * The claim is taken before the check-in runs, so a rejection — standing
   * outside the geofence is the likely one — would otherwise burn the link and
   * force another slash command for something the employee fixes by walking
   * fifty metres. Only the holder of the claim can release it, so this cannot
   * resurrect a token someone else already spent.
   */
  async release(token: string): Promise<void> {
    await runWithBranchBypass(() =>
      this.prisma.discordActionToken.updateMany({
        where: { tokenHash: hash(token), status: 'CONSUMED', expiresAt: { gt: new Date() } },
        data: { status: 'PENDING', consumedAt: null },
      }),
    );
  }

  /** Housekeeping for links nobody opened. */
  async expireStale(): Promise<number> {
    const res = await runWithBranchBypass(() =>
      this.prisma.discordActionToken.updateMany({
        where: { status: 'PENDING', expiresAt: { lte: new Date() } },
        data: { status: 'EXPIRED' },
      }),
    );
    return res.count;
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
