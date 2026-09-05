import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { PrismaService } from '../prisma/prisma.service';
import { DiscordApiClient } from './api/discord-api.client';
import { DiscordSettingsService } from './discord-settings.service';
import { toDiscordMarkdown, chunkDiscord, mention } from './render/discord-format';
import {
  GENERIC_TEMPLATE_KEY,
  WHATSAPP_TEMPLATES,
  WHATSAPP_TEMPLATES_BY_TYPE,
} from '../whatsapp/templates/whatsapp-template.registry';
import { WhatsAppTemplate } from '../whatsapp/templates/whatsapp-template.types';
import { DiscordResolvedConfig } from './discord.types';
import { NotificationChannelSink, NotificationSinkInput } from '../notifications/notification-channel.sink';

const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 14_400_000];

/**
 * Outbound ESS notifications over Discord.
 *
 * Reuses the WhatsApp template registry wholesale: the wording, the allowlist
 * and the per-update admin switches are channel-agnostic decisions, and having
 * a second copy would mean an admin who turns off payslip alerts turns them off
 * on only one channel. The only Discord-specific step is the markdown
 * conversion and the mention.
 *
 * Structure mirrors WhatsAppOutboxService — a row is the claim, the payload and
 * the delivery record — because this repo still has no queue infrastructure.
 */
@Injectable()
export class DiscordOutboxService implements NotificationChannelSink {
  private readonly logger = new Logger(DiscordOutboxService.name);
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: DiscordSettingsService,
    private readonly api: DiscordApiClient,
  ) {}

  readonly channelName = 'discord';

  async enqueueFromNotifications(inputs: NotificationSinkInput[]): Promise<number> {
    if (!inputs.length) return 0;

    const cfg = await this.settings.get();
    if (!cfg.enabled || !cfg.notificationsEnabled) {
      for (const i of inputs) {
        const t = this.resolveTemplate(i, cfg);
        if (t) this.logger.debug(`[DISABLED] Would DM ${t.key} to user ${i.userId}`);
      }
      return 0;
    }

    // Template resolution first: most notifications have none, so this avoids a
    // recipient query for the chatty call sites we never message about.
    const targeted = inputs
      .map((input) => ({ input, template: this.resolveTemplate(input, cfg) }))
      .filter((x): x is { input: NotificationSinkInput; template: WhatsAppTemplate } =>
        Boolean(x.template),
      );
    if (!targeted.length) return 0;

    return runWithBranchBypass(async () => {
      const userIds = [...new Set(targeted.map((t) => t.input.userId))];
      const identities = await this.prisma.discordIdentity.findMany({
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
            appBaseUrl: cfg_appBaseUrl(),
            title: input.title,
            message: input.message,
            link: input.link,
            data: input.waData ?? {},
          });
        } catch (e) {
          this.logger.error(`Discord template '${template.key}' threw: ${(e as Error).message}`);
          return [];
        }
        if (!body.trim()) return [];

        return [
          {
            dedupeKey: input.dedupeKey
              ? `discord:${input.dedupeKey}`
              : this.autoDedupeKey(input, template.key),
            userId: input.userId,
            employeeId: identity.employeeId,
            branchId: identity.branchId,
            discordUserId: cfg.redirectAllTo || identity.discordUserId,
            templateKey: template.key,
            notificationType: input.type ?? null,
            body: toDiscordMarkdown(body),
            maxAttempts: cfg.maxAttempts,
          },
        ];
      });

      if (!rows.length) return 0;

      const created = await this.prisma.discordMessage.createMany({
        data: rows,
        skipDuplicates: true,
      });
      if (created.count > 0) void this.drain().catch(() => undefined);
      return created.count;
    }).catch((e) => {
      this.logger.error(`Discord enqueue failed: ${(e as Error).message}`);
      return 0;
    });
  }

  /**
   * Queue one already-rendered DM to a known Discord account.
   *
   * The notification path above starts from a template because it fans an
   * HR event out to whoever should hear it. This one is the reply to something
   * the employee just did in Discord, so there is no event, no audience and no
   * template — but it still belongs in the queue, which is what gives it the
   * retries, the test-mode redirect and the retention sweep.
   *
   * @returns whether a row was queued (false if disabled or a duplicate).
   */
  async enqueueDirect(input: {
    userId: string;
    discordUserId: string;
    employeeId?: string | null;
    branchId?: string | null;
    templateKey: string;
    body: string;
    dedupeKey: string;
  }): Promise<boolean> {
    const cfg = await this.settings.get();
    if (!cfg.enabled || !cfg.notificationsEnabled) {
      this.logger.debug(`[DISABLED] Would DM ${input.templateKey} to user ${input.userId}`);
      return false;
    }

    return runWithBranchBypass(async () => {
      const created = await this.prisma.discordMessage.createMany({
        data: [
          {
            dedupeKey: `discord:${input.dedupeKey}`,
            userId: input.userId,
            employeeId: input.employeeId ?? null,
            branchId: input.branchId ?? null,
            discordUserId: cfg.redirectAllTo || input.discordUserId,
            templateKey: input.templateKey,
            body: toDiscordMarkdown(input.body),
            maxAttempts: cfg.maxAttempts,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count > 0) void this.drain().catch(() => undefined);
      return created.count > 0;
    }).catch((e) => {
      this.logger.error(`Discord direct enqueue failed: ${(e as Error).message}`);
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
        await this.prisma.discordMessage
          .updateMany({
            where: { status: 'SENDING', lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
            data: { status: 'QUEUED', lockedAt: null },
          })
          .catch(() => undefined);

        const due = await this.prisma.discordMessage.findMany({
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
      this.logger.error(`Discord drain failed: ${(e as Error).message}`);
      return { processed: 0, sent: 0, failed: 0 };
    } finally {
      this.draining = false;
    }
  }

  private async deliverOne(
    id: string,
    cfg: DiscordResolvedConfig,
  ): Promise<'sent' | 'failed' | 'retry' | 'skipped'> {
    // The conditional updateMany IS the lock; attempts increments at claim so a
    // process that dies mid-send burns one attempt rather than looping.
    const claimed = await this.prisma.discordMessage.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'SENDING', lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return 'skipped';

    const row = await this.prisma.discordMessage.findUnique({ where: { id } });
    if (!row) return 'skipped';

    const identity = await this.prisma.discordIdentity.findUnique({
      where: { discordUserId: row.discordUserId },
    });

    const parts = chunkDiscord(row.body);
    const res = await this.api.dmUser(cfg, row.discordUserId, parts[0], identity?.dmChannelId);

    if (res.ok) {
      if (res.channelId && identity && identity.dmChannelId !== res.channelId) {
        await this.prisma.discordIdentity
          .update({ where: { id: identity.id }, data: { dmChannelId: res.channelId } })
          .catch(() => undefined);
      }
      for (const part of parts.slice(1)) {
        await this.api.dmUser(cfg, row.discordUserId, part, res.channelId);
      }
      await this.prisma.discordMessage.update({
        where: { id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: res.messageId ?? null,
          lastError: null,
          lockedAt: null,
        },
      });

      // Optional public mirror, mentioning the employee so they get a ping in
      // the team channel as well as the DM.
      if (cfg.announceChannelId && row.discordUserId) {
        await this.api
          .postMessage(
            cfg,
            cfg.announceChannelId,
            `${mention(row.discordUserId)} ${parts[0].split('\n')[0]}`,
          )
          .catch(() => undefined);
      }
      return 'sent';
    }

    const terminal = !res.retryable || row.attempts >= row.maxAttempts;
    if (terminal) {
      await this.prisma.discordMessage.update({
        where: { id },
        data: { status: 'FAILED', lastError: res.error ?? 'send failed', lockedAt: null },
      });
      this.logger.warn(`Discord DM FAILED (${row.templateKey}): ${res.error}`);
      return 'failed';
    }

    const base = RETRY_BACKOFF_MS[Math.min(row.attempts, RETRY_BACKOFF_MS.length) - 1];
    const jitter = base * 0.1 * (Math.random() * 2 - 1);
    await this.prisma.discordMessage.update({
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
      const res = await this.prisma.discordMessage.deleteMany({
        where: { status: 'SENT', createdAt: { lt: cutoff } },
      });
      return res.count;
    }).catch(() => 0);
  }

  // ----------------------------------------------------------------- helpers

  private resolveTemplate(input: NotificationSinkInput, cfg: DiscordResolvedConfig) {
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
    return `discord:auto:${hash}:${bucket}`;
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
function cfg_appBaseUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
