import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { runWithBranchBypass } from '../../common/branch/branch-context';
import { PrismaService } from '../../prisma/prisma.service';

export interface IssueTokenArgs {
  identityId: string;
  userId: string;
  actionKey: string;
  toolName: string;
  args: Record<string, unknown>;
  resourceType: string;
  resourceId: string;
  ttlMinutes: number;
}

export type ConsumeResult =
  | { ok: true; actionKey: string; toolName: string; args: Record<string, unknown> }
  | { ok: false; reason: 'unknown' | 'expired' | 'wrong-identity' | 'replay' };

/**
 * Single-use capability for an approve/reject tapped from a notification.
 *
 * Four properties, each closing a specific attack:
 *
 *  - only sha256(token) is stored, so the table cannot leak a usable token;
 *  - bound to the handset identity AND the approver, so forwarding the message
 *    to another enrolled colleague fails even with the token string intact;
 *  - single use via an atomic CAS, so a double tap decides once;
 *  - the arguments live here, so the inbound message never supplies a
 *    resource id — the most important property of the four.
 */
@Injectable()
export class WhatsAppActionTokenService {
  private readonly logger = new Logger(WhatsAppActionTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @returns the raw token — not recoverable afterwards — and the row id.
   *
   * The id exists so a caller that mints a token and then loses the message's
   * dedupe race can revoke what it created. Without it, a replayed enqueue
   * would leave live capabilities attached to a message nobody ever received.
   */
  async issue(args: IssueTokenArgs): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString('base64url');
    const row = await runWithBranchBypass(() =>
      this.prisma.whatsAppActionToken.create({
        data: {
          tokenHash: hash(token),
          identityId: args.identityId,
          userId: args.userId,
          actionKey: args.actionKey,
          toolName: args.toolName,
          argsJson: args.args as any,
          resourceType: args.resourceType,
          resourceId: args.resourceId,
          expiresAt: new Date(Date.now() + args.ttlMinutes * 60_000),
        },
        select: { id: true },
      }),
    );
    return { token, id: row.id };
  }

  /** Revoke tokens minted for a message that was then never enqueued. */
  async revoke(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const res = await runWithBranchBypass(() =>
      this.prisma.whatsAppActionToken.updateMany({
        where: { id: { in: ids }, status: 'PENDING' },
        data: { status: 'REVOKED' },
      }),
    ).catch(() => ({ count: 0 }));
    return res.count;
  }

  async consume(
    token: string,
    session: { identityId: string | null; userId: string | null },
    inboundMessageId: string,
  ): Promise<ConsumeResult> {
    return runWithBranchBypass(async () => {
      const row = await this.prisma.whatsAppActionToken.findUnique({
        where: { tokenHash: hash(token) },
      });
      if (!row) return { ok: false, reason: 'unknown' as const };

      // Identity binding is what defeats forwarding.
      if (row.identityId !== session.identityId || row.userId !== session.userId) {
        this.logger.warn(
          `WhatsApp action token presented by the wrong handset (token ${row.id}).`,
        );
        return { ok: false, reason: 'wrong-identity' as const };
      }

      if (row.status !== 'PENDING') return { ok: false, reason: 'replay' as const };
      if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' as const };

      // Atomic CAS: a double tap loses this update and is reported as a replay.
      const claimed = await this.prisma.whatsAppActionToken.updateMany({
        where: { id: row.id, status: 'PENDING', expiresAt: { gt: new Date() } },
        data: {
          status: 'CONSUMED',
          consumedAt: new Date(),
          consumedByMessageId: inboundMessageId,
        },
      });
      if (claimed.count === 0) return { ok: false, reason: 'replay' as const };

      return {
        ok: true as const,
        actionKey: row.actionKey,
        toolName: row.toolName,
        args: (row.argsJson ?? {}) as Record<string, unknown>,
      };
    });
  }

  /**
   * Hygiene only. Tokens for an already-decided request are deliberately NOT
   * revoked when the decision happens elsewhere: coupling the approval engine
   * to WhatsApp could desynchronise, whereas letting the tool fail naturally
   * ("No pending approval step for this request") is always honest.
   */
  async expireStale(): Promise<number> {
    const res = await runWithBranchBypass(() =>
      this.prisma.whatsAppActionToken.updateMany({
        where: { status: 'PENDING', expiresAt: { lt: new Date() } },
        data: { status: 'EXPIRED' },
      }),
    );
    return res.count;
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
