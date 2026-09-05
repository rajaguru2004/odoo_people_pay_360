import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { runWithBranchBypass } from '../branch/branch-context';
import { ActorChannelName, getActorChannel } from '../context/channel-context';
import { PrismaService } from '../../prisma/prisma.service';
import { VerificationPurpose } from './verification.types';

/**
 * How many verification LINKS may be live at once for one employee and purpose.
 *
 * Not one: a person who taps "Check in" twice would otherwise be left holding a
 * link that the second tap silently killed. Not unbounded either — each is a
 * single-use capability, and the point of the cap is that a chat full of old
 * links cannot accumulate into a pile of live ones.
 */
const MAX_LIVE_LINKS = 3;

export interface IssueVerificationArgs {
  channel: ActorChannelName;
  /** LINK hands out a url; CHAT keeps the token server-side as a challenge. */
  deliveryMode: 'LINK' | 'CHAT';
  identityId: string;
  userId: string;
  employeeId: string | null;
  purpose: VerificationPurpose;
  requireLocation: boolean;
  requireFace: boolean;
  actionKey: string;
  toolName: string;
  args?: Record<string, unknown>;
  ttlSeconds: number;
  maxAttempts?: number;
}

export interface VerificationRow {
  id: string;
  channel: string;
  deliveryMode: string;
  identityId: string;
  userId: string;
  employeeId: string | null;
  purpose: string;
  requireLocation: boolean;
  requireFace: boolean;
  actionKey: string;
  toolName: string;
  args: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  faceVerifiedAt: Date | null;
}

export type ConsumeVerificationResult =
  | { ok: true; row: VerificationRow }
  | { ok: false; reason: 'unknown' | 'expired' | 'replay' | 'exhausted' };

/**
 * Issues and burns the one-time capability a channel hands out when a punch
 * needs proof it cannot collect in the chat.
 *
 * A direct generalisation of DiscordCheckinTokenService: same sha256-only
 * storage, same atomic CAS on consumption, same one-live-row-per-employee rule,
 * same deliberate absence of an identity check AT CONSUME TIME for links — the
 * whole point is that the link opens in a browser with no channel session to
 * prove anything with. What compensates is unchanged and now stronger: the row
 * is single-use and short lived, it carries the tool name and arguments itself
 * so the holder can only add a position and a photo, and it can do exactly one
 * thing — complete the one action it was minted for, for its own owner.
 *
 * The face proof adds a second lifecycle on the same row. `spendFaceProof` is
 * where that lifecycle meets the tool layer, and it fail-closes on five
 * independent bindings, one of which is the actor channel from AsyncLocalStorage.
 */
@Injectable()
export class ChannelVerificationTokenService {
  private readonly logger = new Logger(ChannelVerificationTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @returns the raw token (unrecoverable afterwards) and the row id. A CHAT
   *          challenge never reveals the token; its caller uses the id.
   */
  async issue(args: IssueVerificationArgs): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString('base64url');

    const id = await runWithBranchBypass(async () => {
      // Only ONE open CHAT challenge may exist per employee per purpose: an
      // inbound photo has to bind to exactly one, and an old challenge must not
      // be answerable by a selfie sent much later. So a new issue of any kind
      // closes the open chat challenge.
      await this.prisma.channelVerificationToken.updateMany({
        where: {
          userId: args.userId,
          purpose: args.purpose,
          status: 'PENDING',
          deliveryMode: 'CHAT',
        },
        data: { status: 'EXPIRED' },
      });

      // LINK tokens are deliberately NOT invalidated here.
      //
      // They used to be, and that made every re-prompt kill the link already
      // sitting in the employee's chat — which is precisely what happens when
      // somebody taps "Check in" again because they are waiting for the link to
      // work. The link they were given then failed with "expired or already
      // used" while its own expiry was still ten minutes away. The invariant
      // that matters is bounded exposure, and TTL, single use, and the identity
      // and purpose bindings already provide it; replacing a live capability
      // added nothing except a broken link.
      //
      // A cap keeps the exposure bounded anyway: only the newest few stay live.
      if (args.deliveryMode === 'LINK') {
        const live = await this.prisma.channelVerificationToken.findMany({
          where: {
            userId: args.userId,
            purpose: args.purpose,
            status: 'PENDING',
            deliveryMode: 'LINK',
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
          skip: MAX_LIVE_LINKS - 1,
        });
        if (live.length) {
          await this.prisma.channelVerificationToken.updateMany({
            where: { id: { in: live.map((r) => r.id) } },
            data: { status: 'EXPIRED' },
          });
        }
      }

      const row = await this.prisma.channelVerificationToken.create({
        data: {
          tokenHash: hash(token),
          channel: args.channel,
          deliveryMode: args.deliveryMode,
          identityId: args.identityId,
          userId: args.userId,
          employeeId: args.employeeId,
          purpose: args.purpose,
          requireLocation: args.requireLocation,
          requireFace: args.requireFace,
          actionKey: args.actionKey,
          toolName: args.toolName,
          argsJson: (args.args ?? {}) as any,
          maxAttempts: args.maxAttempts ?? 5,
          expiresAt: new Date(Date.now() + args.ttlSeconds * 1000),
        },
        select: { id: true },
      });
      return row.id;
    });

    return { token, id };
  }

  /**
   * Non-destructive. Tells the page what to ask for, and nothing about WHO.
   *
   * A token in a url leaks through referrers, screenshots and shoulder
   * surfing, so this must not confirm whose it is before it has been used.
   */
  async peek(token: string): Promise<{
    valid: boolean;
    /**
     * Why it is not valid. 'unknown' covers both a token we have never seen and
     * a malformed one — the page must not become an oracle for guessed tokens.
     */
    reason: 'ok' | 'expired' | 'used' | 'replaced' | 'unknown';
    requires: { face: boolean; location: boolean };
    purposeLabel: string;
    expiresInSeconds: number;
  }> {
    const miss = (reason: 'expired' | 'used' | 'replaced' | 'unknown') => ({
      valid: false,
      reason,
      requires: { face: false, location: false },
      purposeLabel: '',
      expiresInSeconds: 0,
    });
    if (!token) return miss('unknown');

    return runWithBranchBypass(async () => {
      const row = await this.prisma.channelVerificationToken.findUnique({
        where: { tokenHash: hash(token) },
        select: {
          status: true,
          expiresAt: true,
          requireFace: true,
          requireLocation: true,
          purpose: true,
        },
      });
      if (!row) return miss('unknown');
      // Order matters: a row can be both used and past its expiry, and "you
      // already did this" is the more useful of the two to be told.
      if (row.status === 'USED') return miss('used');
      if (row.expiresAt.getTime() <= Date.now()) return miss('expired');
      // Still inside its own lifetime but closed by a newer request. Saying
      // "expired" here is what made this look broken: the employee is holding a
      // link that never got the chance to expire.
      if (row.status !== 'PENDING') return miss('replaced');

      return {
        valid: true,
        reason: 'ok' as const,
        requires: { face: row.requireFace, location: row.requireLocation },
        purposeLabel: PURPOSE_LABELS[row.purpose] ?? 'Continue',
        expiresInSeconds: Math.max(0, Math.round((row.expiresAt.getTime() - Date.now()) / 1000)),
      };
    });
  }

  /** Atomic claim by raw token (the LINK path). */
  async consume(token: string): Promise<ConsumeVerificationResult> {
    if (!token) return { ok: false, reason: 'unknown' };
    return this.claim({ tokenHash: hash(token) });
  }

  /** Atomic claim by row id (the CHAT path, where no token was ever revealed). */
  async consumeById(id: string): Promise<ConsumeVerificationResult> {
    if (!id) return { ok: false, reason: 'unknown' };
    return this.claim({ id });
  }

  /**
   * The open CHAT challenge for this identity, if any.
   *
   * This is what gives an inbound photo its meaning. Without a challenge a
   * photo is just a photo — it could be a check-in, a check-out or a cat — so
   * the row's own actionKey and toolName supply the instruction, exactly as
   * they do for a link.
   */
  async findOpenChallenge(
    channel: ActorChannelName,
    identityId: string,
  ): Promise<VerificationRow | null> {
    const row = await runWithBranchBypass(() =>
      this.prisma.channelVerificationToken.findFirst({
        where: {
          channel,
          identityId,
          deliveryMode: 'CHAT',
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return row ? toRow(row) : null;
  }

  /**
   * Hand a claimed capability back.
   *
   * The claim is taken BEFORE the punch runs, and the punch can still be
   * refused — standing outside the geofence is the likely one. Without this
   * the link would be burnt for something the employee fixes by walking fifty
   * metres.
   *
   * `proofSpentAt` is cleared too, so a retry does not demand a fresh selfie.
   * `faceVerifiedAt` is deliberately NOT cleared: the face genuinely matched,
   * and that fact does not stop being true because the geofence said no.
   */
  async release(token: string): Promise<void> {
    await this.unclaim({ tokenHash: hash(token) });
  }

  async releaseById(id: string): Promise<void> {
    await this.unclaim({ id });
  }

  /** @returns the new attempt count. The caller expires at maxAttempts. */
  async bumpAttempts(id: string): Promise<number> {
    const row = await runWithBranchBypass(() =>
      this.prisma.channelVerificationToken.update({
        where: { id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true, maxAttempts: true },
      }),
    ).catch(() => null);
    if (!row) return 0;

    if (row.attempts >= row.maxAttempts) {
      await runWithBranchBypass(() =>
        this.prisma.channelVerificationToken.updateMany({
          where: { id, status: { not: 'EXPIRED' } },
          data: { status: 'EXPIRED' },
        }),
      ).catch(() => undefined);
    }
    return row.attempts;
  }

  async recordFaceProof(
    id: string,
    p: { distance: number; quality: number; imageUrl: string | null; imageSha256: string },
  ): Promise<void> {
    await runWithBranchBypass(() =>
      this.prisma.channelVerificationToken.update({
        where: { id },
        data: {
          faceVerifiedAt: new Date(),
          faceDistance: p.distance,
          faceQuality: p.quality,
          faceImageUrl: p.imageUrl,
          imageSha256: p.imageSha256,
        },
      }),
    ).catch((e) => this.logger.warn(`Could not record face proof ${id}: ${(e as Error).message}`));
  }

  /**
   * Turn a proof id into `byFace`. Fail-closed on EVERY mismatch.
   *
   * Five independent bindings must all hold, and one of them is the actor
   * channel from AsyncLocalStorage — which is why the copilot, an MCP token or
   * a web request can pass a stolen uuid here and still get `false`.
   *
   * Never throws: this sits on the tool path, and an exception here would turn
   * a failed proof into a failed request.
   */
  async spendFaceProof(
    proofId: string | undefined | null,
    employeeId: string,
    purpose: VerificationPurpose,
  ): Promise<boolean> {
    if (!proofId || !UUID_RE.test(proofId)) return false;

    const channel = getActorChannel()?.channel;
    if (!channel) return false;

    try {
      return await runWithBranchBypass(async () => {
        const row = await this.prisma.channelVerificationToken.findUnique({
          where: { id: proofId },
          select: {
            channel: true,
            employeeId: true,
            purpose: true,
            faceVerifiedAt: true,
            expiresAt: true,
          },
        });

        if (!row) return false;
        if (row.channel !== channel) return false;
        if (row.employeeId !== employeeId) return false;
        if (row.purpose !== purpose) return false;
        if (!row.faceVerifiedAt) return false;
        if (row.expiresAt.getTime() <= Date.now()) return false;

        // A double tap spends once. The punch itself is not idempotent, so the
        // guard has to be in the claim rather than downstream.
        const spent = await this.prisma.channelVerificationToken.updateMany({
          where: { id: proofId, proofSpentAt: null },
          data: { proofSpentAt: new Date() },
        });
        return spent.count === 1;
      });
    } catch (e) {
      this.logger.warn(`spendFaceProof failed closed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Accepted selfie punches for this employee today, for the daily cap.
   * Counted from the receipts themselves, so it cannot drift from what was
   * actually allowed.
   */
  async acceptedFaceProofsToday(employeeId: string): Promise<number> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    return runWithBranchBypass(() =>
      this.prisma.channelVerificationToken.count({
        where: { employeeId, faceVerifiedAt: { gte: since } },
      }),
    ).catch(() => 0);
  }

  /**
   * Has this employee already sent these exact bytes?
   *
   * The single highest-value anti-replay check available: a saved photo and a
   * live capture are indistinguishable at the wire level, but re-sending the
   * SAME photo is both the most likely abuse and the cheapest to catch.
   */
  async imageAlreadyUsed(employeeId: string, imageSha256: string): Promise<boolean> {
    const n = await runWithBranchBypass(() =>
      this.prisma.channelVerificationToken.count({
        where: { employeeId, imageSha256 },
      }),
    ).catch(() => 0);
    return n > 0;
  }

  /** Housekeeping for capabilities nobody used. */
  async expireStale(): Promise<number> {
    const res = await runWithBranchBypass(() =>
      this.prisma.channelVerificationToken.updateMany({
        where: { status: 'PENDING', expiresAt: { lte: new Date() } },
        data: { status: 'EXPIRED' },
      }),
    );
    return res.count;
  }

  // ----------------------------------------------------------------- internal

  private async claim(where: { id?: string; tokenHash?: string }): Promise<ConsumeVerificationResult> {
    return runWithBranchBypass(async () => {
      const row = await this.prisma.channelVerificationToken.findUnique({
        where: where as any,
      });
      if (!row) return { ok: false as const, reason: 'unknown' as const };
      if (row.status === 'EXPIRED' && row.attempts >= row.maxAttempts) {
        return { ok: false as const, reason: 'exhausted' as const };
      }
      if (row.status !== 'PENDING') return { ok: false as const, reason: 'replay' as const };
      if (row.expiresAt.getTime() <= Date.now()) {
        return { ok: false as const, reason: 'expired' as const };
      }

      // Atomic CAS. Two taps race here and exactly one wins.
      const claimed = await this.prisma.channelVerificationToken.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'CONSUMED', consumedAt: new Date() },
      });
      if (claimed.count !== 1) return { ok: false as const, reason: 'replay' as const };

      return { ok: true as const, row: toRow(row) };
    });
  }

  private async unclaim(where: { id?: string; tokenHash?: string }): Promise<void> {
    await runWithBranchBypass(() =>
      this.prisma.channelVerificationToken.updateMany({
        // Only the holder of a live claim can release it, so this cannot
        // resurrect a token somebody else already spent.
        where: { ...where, status: 'CONSUMED', expiresAt: { gt: new Date() } } as any,
        data: { status: 'PENDING', consumedAt: null, proofSpentAt: null },
      }),
    ).catch(() => undefined);
  }
}

const PURPOSE_LABELS: Record<string, string> = {
  CHECKIN: 'Check in',
  CHECKOUT: 'Check out',
  LUNCH_IN: 'End lunch break',
  LUNCH_OUT: 'Start lunch break',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toRow(r: any): VerificationRow {
  return {
    id: r.id,
    channel: r.channel,
    deliveryMode: r.deliveryMode,
    identityId: r.identityId,
    userId: r.userId,
    employeeId: r.employeeId ?? null,
    purpose: r.purpose,
    requireLocation: r.requireLocation,
    requireFace: r.requireFace,
    actionKey: r.actionKey,
    toolName: r.toolName,
    args: (r.argsJson ?? {}) as Record<string, unknown>,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    expiresAt: r.expiresAt,
    faceVerifiedAt: r.faceVerifiedAt ?? null,
  };
}

/** SHA-256 of an image payload, for the replay check. */
export function imageFingerprint(base64: string): string {
  return createHash('sha256').update(base64).digest('hex');
}
