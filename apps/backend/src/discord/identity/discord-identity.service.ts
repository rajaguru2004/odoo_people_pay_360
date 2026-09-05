import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { AuditService } from '../../audit/audit.service';
import { runWithBranchBypass } from '../../common/branch/branch-context';
import { PrismaService } from '../../prisma/prisma.service';

export interface MyDiscordStatus {
  linked: boolean;
  discordUserId: string | null;
  discordTag: string | null;
  status: string | null;
  linkedAt: Date | null;
  optedIn: boolean;
}

/**
 * Maps a Discord account to an ESS user.
 *
 * Same reasoning as the WhatsApp handset link, adapted to what Discord can
 * prove:
 *
 *   1. the employee is signed in on the web — proves the ACCOUNT;
 *   2. a one-time code is shown there;
 *   3. they run `/link <code>` from Discord — proves the DISCORD ACCOUNT.
 *
 * Discord has no phone number to send a code to, so the code is issued in the
 * browser and redeemed from Discord — the reverse direction to WhatsApp, but
 * the same property: neither side alone completes the link.
 */
@Injectable()
export class DiscordIdentityService {
  private readonly logger = new Logger(DiscordIdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Step 1, on the web: issue a code for the signed-in user. */
  async startLink(userId: string): Promise<{ code: string; expiresInMinutes: number }> {
    return runWithBranchBypass(async () => {
      const employee = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { employeeId: true, employee: { select: { branchId: true } } },
      });

      // Six digits, shown once in the browser and stored hashed, so a database
      // read cannot be replayed into a link.
      const code = String(randomInt(100000, 1000000));
      const codeHash = await bcrypt.hash(code, 10);
      const linkExpiresAt = new Date(Date.now() + 15 * 60_000);

      const existing = await this.prisma.discordIdentity.findFirst({ where: { userId } });
      if (existing) {
        await this.prisma.discordIdentity.update({
          where: { id: existing.id },
          data: { linkCodeHash: codeHash, linkExpiresAt },
        });
      } else {
        await this.prisma.discordIdentity.create({
          data: {
            userId,
            employeeId: employee?.employeeId ?? null,
            branchId: employee?.employee?.branchId ?? null,
            // Placeholder until /link runs. discord_user_id is unique, so it
            // has to be unique and obviously not a real snowflake.
            discordUserId: `pending:${userId.slice(0, 24)}`,
            status: 'PENDING',
            linkCodeHash: codeHash,
            linkExpiresAt,
          },
        });
      }

      return { code, expiresInMinutes: 15 };
    });
  }

  /** Step 2, from Discord: redeem the code. */
  async redeemLink(
    discordUserId: string,
    discordTag: string | null,
    code: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
    return runWithBranchBypass(async () => {
      const taken = await this.prisma.discordIdentity.findUnique({ where: { discordUserId } });
      if (taken && taken.status === 'ACTIVE') {
        return { ok: false as const, reason: 'That Discord account is already linked.' };
      }

      const digits = code.replace(/\D/g, '');
      if (digits.length !== 6) return { ok: false as const, reason: 'The code is six digits.' };

      const candidates = await this.prisma.discordIdentity.findMany({
        where: {
          status: 'PENDING',
          linkCodeHash: { not: null },
          linkExpiresAt: { gt: new Date() },
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      });

      for (const row of candidates) {
        if (!(await bcrypt.compare(digits, row.linkCodeHash!))) continue;

        // Clear any placeholder or revoked row already holding this snowflake,
        // or the unique index rejects the update.
        await this.prisma.discordIdentity.deleteMany({
          where: { discordUserId, NOT: { id: row.id } },
        });

        await this.prisma.discordIdentity.update({
          where: { id: row.id },
          data: {
            discordUserId,
            discordTag: discordTag?.slice(0, 64) ?? null,
            status: 'ACTIVE',
            linkCodeHash: null,
            linkExpiresAt: null,
            linkedAt: new Date(),
            optedIn: true,
            optedOutAt: null,
            revokedAt: null,
          },
        });

        void this.audit.log({
          userId: row.userId,
          action: 'DISCORD_LINKED',
          resourceType: 'DiscordIdentity',
          resourceId: row.id,
          newData: { discordUserId, discordTag },
        });

        return { ok: true as const, userId: row.userId };
      }

      return { ok: false as const, reason: 'That code is not valid or has expired.' };
    });
  }

  /** The identity behind a Discord snowflake, or null. ACTIVE only. */
  async findActive(discordUserId: string) {
    return runWithBranchBypass(() =>
      this.prisma.discordIdentity.findFirst({ where: { discordUserId, status: 'ACTIVE' } }),
    );
  }

  async touch(id: string, dmChannelId?: string | null): Promise<void> {
    await this.prisma.discordIdentity
      .update({
        where: { id },
        data: { lastSeenAt: new Date(), ...(dmChannelId ? { dmChannelId } : {}) },
      })
      .catch(() => undefined);
  }

  async getMine(userId: string): Promise<MyDiscordStatus> {
    return runWithBranchBypass(async () => {
      const row = await this.prisma.discordIdentity.findFirst({ where: { userId } });
      const linked = row?.status === 'ACTIVE';
      return {
        linked,
        discordUserId: linked ? row!.discordUserId : null,
        discordTag: row?.discordTag ?? null,
        status: row?.status ?? null,
        linkedAt: row?.linkedAt ?? null,
        optedIn: row?.optedIn ?? false,
      };
    });
  }

  /** Unlink. The row stays — link history is a compliance artifact. */
  async revoke(userId: string, actorUserId?: string): Promise<{ ok: true }> {
    await runWithBranchBypass(() =>
      this.prisma.discordIdentity.updateMany({
        where: { userId },
        data: { status: 'REVOKED', optedIn: false, revokedAt: new Date(), linkCodeHash: null },
      }),
    );
    void this.audit.log({
      userId: actorUserId ?? userId,
      action: 'DISCORD_REVOKED',
      resourceType: 'DiscordIdentity',
      newData: { targetUserId: userId },
    });
    return { ok: true as const };
  }

  async stats(): Promise<{ total: number; active: number; pending: number }> {
    return runWithBranchBypass(async () => {
      const [total, active, pending] = await Promise.all([
        this.prisma.discordIdentity.count(),
        this.prisma.discordIdentity.count({ where: { status: 'ACTIVE' } }),
        this.prisma.discordIdentity.count({ where: { status: 'PENDING' } }),
      ]);
      return { total, active, pending };
    });
  }
}
