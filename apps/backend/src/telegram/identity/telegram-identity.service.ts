import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { AuditService } from '../../audit/audit.service';
import { runWithBranchBypass } from '../../common/branch/branch-context';
import { PrismaService } from '../../prisma/prisma.service';

export interface MyTelegramStatus {
  linked: boolean;
  telegramChatId: string | null;
  username: string | null;
  status: string | null;
  linkedAt: Date | null;
  optedIn: boolean;
}

/**
 * Maps a Telegram chat to an ESS user.
 *
 * Identical ceremony to the Discord link, because Telegram can prove exactly
 * the same things:
 *
 *   1. the employee is signed in on the web — proves the ACCOUNT;
 *   2. a one-time code is shown there;
 *   3. they send `/link <code>` to the bot — proves the TELEGRAM CHAT.
 *
 * Neither side alone completes the link. The direction matters here for a
 * second reason as well: a Telegram bot cannot message a chat that has never
 * messaged it, so the redemption step is also what makes delivery possible at
 * all.
 */
@Injectable()
export class TelegramIdentityService {
  private readonly logger = new Logger(TelegramIdentityService.name);

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

      const existing = await this.prisma.telegramIdentity.findFirst({ where: { userId } });
      if (existing) {
        await this.prisma.telegramIdentity.update({
          where: { id: existing.id },
          data: { linkCodeHash: codeHash, linkExpiresAt },
        });
      } else {
        await this.prisma.telegramIdentity.create({
          data: {
            userId,
            employeeId: employee?.employeeId ?? null,
            branchId: employee?.employee?.branchId ?? null,
            // Placeholder until /link runs. telegram_chat_id is unique, so it
            // has to be unique and obviously not a real chat id.
            telegramChatId: `pending:${userId.slice(0, 24)}`,
            status: 'PENDING',
            linkCodeHash: codeHash,
            linkExpiresAt,
          },
        });
      }

      return { code, expiresInMinutes: 15 };
    });
  }

  /** Step 2, from Telegram: redeem the code. */
  async redeemLink(
    telegramChatId: string,
    telegramUserId: string | null,
    username: string | null,
    code: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
    return runWithBranchBypass(async () => {
      const taken = await this.prisma.telegramIdentity.findUnique({ where: { telegramChatId } });
      if (taken && taken.status === 'ACTIVE') {
        return { ok: false as const, reason: 'That Telegram account is already linked.' };
      }

      const digits = code.replace(/\D/g, '');
      if (digits.length !== 6) return { ok: false as const, reason: 'The code is six digits.' };

      const candidates = await this.prisma.telegramIdentity.findMany({
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

        // Clear any placeholder or revoked row already holding this chat id,
        // or the unique index rejects the update.
        await this.prisma.telegramIdentity.deleteMany({
          where: { telegramChatId, NOT: { id: row.id } },
        });

        await this.prisma.telegramIdentity.update({
          where: { id: row.id },
          data: {
            telegramChatId,
            telegramUserId: telegramUserId?.slice(0, 32) ?? null,
            username: username?.slice(0, 64) ?? null,
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
          action: 'TELEGRAM_LINKED',
          resourceType: 'TelegramIdentity',
          resourceId: row.id,
          newData: { telegramChatId, username },
        });

        return { ok: true as const, userId: row.userId };
      }

      return { ok: false as const, reason: 'That code is not valid or has expired.' };
    });
  }

  /** The identity behind a Telegram chat, or null. ACTIVE only. */
  async findActive(telegramChatId: string) {
    return runWithBranchBypass(() =>
      this.prisma.telegramIdentity.findFirst({ where: { telegramChatId, status: 'ACTIVE' } }),
    );
  }

  async touch(id: string): Promise<void> {
    await this.prisma.telegramIdentity
      .update({ where: { id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  async getMine(userId: string): Promise<MyTelegramStatus> {
    return runWithBranchBypass(async () => {
      const row = await this.prisma.telegramIdentity.findFirst({ where: { userId } });
      const linked = row?.status === 'ACTIVE';
      return {
        linked,
        telegramChatId: linked ? row!.telegramChatId : null,
        username: row?.username ?? null,
        status: row?.status ?? null,
        linkedAt: row?.linkedAt ?? null,
        optedIn: row?.optedIn ?? false,
      };
    });
  }

  /** Unlink. The row stays — link history is a compliance artifact. */
  async revoke(userId: string, actorUserId?: string): Promise<{ ok: true }> {
    await runWithBranchBypass(() =>
      this.prisma.telegramIdentity.updateMany({
        where: { userId },
        data: { status: 'REVOKED', optedIn: false, revokedAt: new Date(), linkCodeHash: null },
      }),
    );
    void this.audit.log({
      userId: actorUserId ?? userId,
      action: 'TELEGRAM_REVOKED',
      resourceType: 'TelegramIdentity',
      newData: { targetUserId: userId },
    });
    return { ok: true as const };
  }

  async stats(): Promise<{ total: number; active: number; pending: number }> {
    return runWithBranchBypass(async () => {
      const [total, active, pending] = await Promise.all([
        this.prisma.telegramIdentity.count(),
        this.prisma.telegramIdentity.count({ where: { status: 'ACTIVE' } }),
        this.prisma.telegramIdentity.count({ where: { status: 'PENDING' } }),
      ]);
      return { total, active, pending };
    });
  }
}
