import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramApiClient } from './api/telegram-api.client';
import { TelegramSettingsService } from './telegram-settings.service';
import { chunkTelegram, toTelegramHtml } from './render/telegram-format';
import {
  WHATSAPP_TEMPLATES,
  WHATSAPP_TEMPLATES_BY_TYPE,
} from '../whatsapp/templates/whatsapp-template.registry';
import { WhatsAppTemplate } from '../whatsapp/templates/whatsapp-template.types';
import { TelegramResolvedConfig } from './telegram.types';
import {
  NotificationChannelSink,
  NotificationSinkInput,
} from '../notifications/notification-channel.sink';

const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 14_400_000];

/**
 * Outbound ESS notifications over Telegram, plus the ops-group alert path.
 *
 * Reuses the WhatsApp template registry wholesale, for the reason
 * DiscordOutboxService already gives: the wording, the allowlist and the
 * per-update admin switches are channel-agnostic decisions, and a second copy
 * would mean an admin who turns off payslip alerts turns them off on only one
 * channel. The only Telegram-specific step is the HTML conversion.
 *
 * `enqueueToChat` is the one thing neither other channel has. A login alert is
 * addressed to a CHAT, not to a person: there is no template, no audience and
 * frequently no ESS user at all (a failed login with an unknown email). It
 * still goes through the queue, because that is what gives it the retries, the
 * test-mode redirect and the retention sweep.
 */
@Injectable()
export class TelegramOutboxService implements NotificationChannelSink {
  private readonly logger = new Logger(TelegramOutboxService.name);
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: TelegramSettingsService,
    private readonly api: TelegramApiClient,
  ) {}

  readonly channelName = 'telegram';

  async enqueueFromNotifications(inputs: NotificationSinkInput[]): Promise<number> {
    if (!inputs.length) return 0;

    const cfg = await this.settings.get();
    if (!cfg.enabled || !cfg.notificationsEnabled) {
      for (const i of inputs) {
        const t = this.resolveTemplate(i);
        if (t) this.logger.debug(`[DISABLED] Would send ${t.key} to user ${i.userId}`);
      }
      return 0;
    }

    // Template resolution first: most notifications have none, so this avoids a
    // recipient query for the chatty call sites we never message about.
    const targeted = inputs
      .map((input) => ({ input, template: this.resolveTemplate(input) }))
      .filter((x): x is { input: NotificationSinkInput; template: WhatsAppTemplate } =>
        Boolean(x.template),
      );
    if (!targeted.length) return 0;

    return runWithBranchBypass(async () => {
      const userIds = [...new Set(targeted.map((t) => t.input.userId))];
      const identities = await this.prisma.telegramIdentity.findMany({
        where: { userId: { in: userIds }, status: 'ACTIVE', optedIn: true },
      });
      if (!identities.length) return 0;

      const byUser = new Map<string, (typeof identities)[number]>();
      for (const id of identities) if (!byUser.has(id.userId)) byUser.set(id.userId, id);

      const names = await this.resolveRecipientNames([...byUser.keys()]);
      const companyName = await this.companyName();

      const rows = targeted.flatMap(({ input, template }) => {
        const identity = byUser.get(input.userId);
        if (!identity) return [];

        let body: string;
        try {
          body = template.render({
            recipientName: names.get(input.userId) ?? '',
            companyName,
            appBaseUrl: appBaseUrl(),
            title: input.title,
            message: input.message,
            link: input.link,
            data: input.waData ?? {},
          });
        } catch (e) {
          this.logger.error(`Telegram template '${template.key}' threw: ${(e as Error).message}`);
          return [];
        }
        if (!body.trim()) return [];

        return [
          {
            dedupeKey: input.dedupeKey
              ? `telegram:${input.dedupeKey}`
              : this.autoDedupeKey(input, template.key),
            userId: input.userId,
            employeeId: identity.employeeId,
            branchId: identity.branchId,
            chatId: cfg.redirectAllTo || identity.telegramChatId,
            templateKey: template.key,
            notificationType: input.type ?? null,
            body: toTelegramHtml(body),
            maxAttempts: cfg.maxAttempts,
          },
        ];
      });

      if (!rows.length) return 0;

      const created = await this.prisma.telegramMessage.createMany({
        data: rows,
        skipDuplicates: true,
      });
      if (created.count > 0) void this.drain().catch(() => undefined);
      return created.count;
    }).catch((e) => {
      this.logger.error(`Telegram enqueue failed: ${(e as Error).message}`);
      return 0;
    });
  }

  /**
   * Queue one already-rendered message to a chat id.
   *
   * `body` is Telegram HTML and is NOT converted again — callers that start
   * from WhatsApp markup must run `toTelegramHtml` themselves. Converting here
   * would double-escape a body that was built with `escapeTelegramHtml`, which
   * is how the login alert is assembled.
   *
   * @returns whether a row was queued (false if disabled or a duplicate).
   */
  async enqueueToChat(input: {
    chatId: string;
    templateKey: string;
    body: string;
    dedupeKey: string;
    userId?: string | null;
    employeeId?: string | null;
    branchId?: string | null;
    notificationType?: string | null;
  }): Promise<boolean> {
    const cfg = await this.settings.get();
    if (!cfg.enabled) {
      this.logger.debug(`[DISABLED] Would send ${input.templateKey} to chat ${input.chatId}`);
      return false;
    }
    const chatId = cfg.redirectAllTo || input.chatId;
    if (!chatId) return false;

    return runWithBranchBypass(async () => {
      const created = await this.prisma.telegramMessage.createMany({
        data: [
          {
            dedupeKey: `telegram:${input.dedupeKey}`,
            userId: input.userId ?? null,
            employeeId: input.employeeId ?? null,
            branchId: input.branchId ?? null,
            chatId,
            templateKey: input.templateKey,
            notificationType: input.notificationType ?? null,
            body: input.body,
            maxAttempts: cfg.maxAttempts,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count > 0) void this.drain().catch(() => undefined);
      return created.count > 0;
    }).catch((e) => {
      this.logger.error(`Telegram chat enqueue failed: ${(e as Error).message}`);
      return false;
    });
  }

  /** Claim and deliver due rows. Safe to call concurrently. */
  async drain(): Promise<{ processed: number; sent: number; failed: number }> {
    if (this.draining) return { processed: 0, sent: 0, failed: 0 };
    this.draining = true;
    try {
      const cfg = await this.settings.ensureConfigured();
      if (!cfg) return { processed: 0, sent: 0, failed: 0 };

      return await runWithBranchBypass(async () => {
        await this.prisma.telegramMessage
          .updateMany({
            where: { status: 'SENDING', lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
            data: { status: 'QUEUED', lockedAt: null },
          })
          .catch(() => undefined);

        const due = await this.prisma.telegramMessage.findMany({
          where: { status: 'QUEUED', nextAttemptAt: { lte: new Date() } },
          orderBy: { nextAttemptAt: 'asc' },
          take: 50,
          select: { id: true },
        });

        let sent = 0;
        let failed = 0;
        for (const { id } of due) {
          const outcome = await this.deliverOne(id, cfg);
          if (outcome === 'sent') sent++;
          else if (outcome === 'failed') failed++;
        }
        return { processed: due.length, sent, failed };
      });
    } catch (e) {
      this.logger.error(`Telegram drain failed: ${(e as Error).message}`);
      return { processed: 0, sent: 0, failed: 0 };
    } finally {
      this.draining = false;
    }
  }

  private async deliverOne(
    id: string,
    cfg: TelegramResolvedConfig,
  ): Promise<'sent' | 'failed' | 'retry' | 'skipped'> {
    // The conditional updateMany IS the lock; attempts increments at claim so a
    // process that dies mid-send burns one attempt rather than looping.
    const claimed = await this.prisma.telegramMessage.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'SENDING', lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return 'skipped';

    const row = await this.prisma.telegramMessage.findUnique({ where: { id } });
    if (!row) return 'skipped';

    const parts = chunkTelegram(row.body);
    const res = await this.api.sendMessage(cfg, row.chatId, parts[0]);

    if (res.ok) {
      for (const part of parts.slice(1)) {
        await this.api.sendMessage(cfg, row.chatId, part);
      }
      await this.prisma.telegramMessage.update({
        where: { id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: res.messageId ?? null,
          lastError: null,
          lockedAt: null,
        },
      });
      return 'sent';
    }

    const terminal = !res.retryable || row.attempts >= row.maxAttempts;
    if (terminal) {
      await this.prisma.telegramMessage.update({
        where: { id },
        data: { status: 'FAILED', lastError: res.error ?? 'send failed', lockedAt: null },
      });
      // The chat id is named because it is the ONLY thing that distinguishes
      // the four causes of "chat not found" — and a log line that omitted it
      // once cost a deployment's worth of silent alerts. It is not a secret;
      // the token, which is, is never logged anywhere in this file.
      this.logger.warn(
        `Telegram send FAILED (${row.templateKey}) to chat ${row.chatId}: ${res.error}` +
          (/chat not found/i.test(res.error ?? '')
            ? ' — check Settings -> Messages -> Check chat: either that id is wrong or ' +
              'the bot is not a member of that group.'
            : ''),
      );
      return 'failed';
    }

    // Telegram, unlike Discord, says how long to wait on a flood limit. Obeying
    // it is the difference between backing off and being rate-limited harder.
    const base =
      res.retryAfterSeconds !== undefined
        ? res.retryAfterSeconds * 1000
        : RETRY_BACKOFF_MS[Math.min(row.attempts, RETRY_BACKOFF_MS.length) - 1];
    const jitter = base * 0.1 * (Math.random() * 2 - 1);
    await this.prisma.telegramMessage.update({
      where: { id },
      data: {
        status: 'QUEUED',
        nextAttemptAt: new Date(Date.now() + base + jitter),
        lastError: res.error ?? 'send failed',
        lockedAt: null,
      },
    });
    return 'retry';
  }

  async sweep(): Promise<number> {
    const cfg = await this.settings.get();
    const cutoff = new Date(Date.now() - cfg.retentionDays * 86_400_000);
    return runWithBranchBypass(async () => {
      const res = await this.prisma.telegramMessage.deleteMany({
        where: { status: 'SENT', createdAt: { lt: cutoff } },
      });
      return res.count;
    }).catch(() => 0);
  }

  // ----------------------------------------------------------------- helpers

  private resolveTemplate(input: NotificationSinkInput) {
    if (input.waTemplate) return WHATSAPP_TEMPLATES.get(input.waTemplate) ?? null;
    if (input.type) {
      const byType = WHATSAPP_TEMPLATES_BY_TYPE.get(input.type);
      if (byType) return byType;
    }
    return null;
  }

  private autoDedupeKey(input: NotificationSinkInput, templateKey: string): string {
    const bucket = new Date().toISOString().slice(0, 13);
    const hash = createHash('sha1')
      .update([input.userId, templateKey, input.title, input.message, input.link ?? ''].join('|'))
      .digest('hex')
      .slice(0, 32);
    return `telegram:auto:${hash}:${bucket}`;
  }

  private async resolveRecipientNames(userIds: string[]): Promise<Map<string, string>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, employee: { select: { fullName: true } } },
    });
    return new Map(users.map((u) => [u.id, u.employee?.fullName || u.email || '']));
  }

  private async companyName(): Promise<string> {
    const row = await this.prisma.systemSetting
      .findUnique({ where: { key: 'company_name' } })
      .catch(() => null);
    return row?.value?.trim() || 'HR';
  }
}

/** Portal base for deep links inside message bodies. */
function appBaseUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
