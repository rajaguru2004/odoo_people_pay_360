import { Injectable, Logger } from '@nestjs/common';
import { runWithBranchBypass } from '../../common/branch/branch-context';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramApiClient } from '../api/telegram-api.client';
import { TelegramIdentityService } from '../identity/telegram-identity.service';
import { TelegramSettingsService } from '../telegram-settings.service';
import { b, escapeTelegramHtml } from '../render/telegram-format';
import { TelegramUpdate } from '../telegram.types';

/**
 * The commands the bot answers in a private chat.
 *
 * Account linking ONLY. The ESS action router (check in, apply for leave,
 * approve) is deliberately not wired here: those actions carry a verification
 * contract — `ChannelVerificationToken`, face proof, the per-channel attendance
 * mode — and half-implementing that would give Telegram a weaker path to the
 * same operations than the two channels that enforce it. Adding it later is
 * additive and reuses EssActionsModule the way DiscordInboundModule does.
 *
 * Replies are sent DIRECTLY rather than queued: this is a synchronous
 * conversation, and a reply that arrives two minutes later via the drainer
 * reads as a broken bot. The queue is for notifications nobody is waiting on.
 */
@Injectable()
export class TelegramInboundService {
  private readonly logger = new Logger(TelegramInboundService.name);

  constructor(
    private readonly settings: TelegramSettingsService,
    private readonly identities: TelegramIdentityService,
    private readonly api: TelegramApiClient,
    private readonly prisma: PrismaService,
  ) {}

  async handle(update: TelegramUpdate): Promise<void> {
    const msg = update?.message;
    if (!msg) return;
    const chatId = msg.chat?.id;
    const text = (msg.text ?? '').trim();
    if (chatId === undefined || chatId === null || !text) return;

    // Groups are for alerts only. Answering commands there would let anyone in
    // the group drive another person's link flow.
    if (msg.chat?.type && msg.chat.type !== 'private') return;
    if (msg.from?.is_bot) return;

    const chat = String(chatId);
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) return;

    // "/link@MyBot 123456" — Telegram appends the bot name in some clients.
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();

    switch (command) {
      case '/start':
      case '/help':
        return this.reply(chat, this.helpText());

      case '/link':
        return this.handleLink(chat, msg, args[0] ?? '');

      case '/whoami':
        return this.handleWhoami(chat);

      case '/unlink':
        return this.handleUnlink(chat);

      default:
        return this.reply(
          chat,
          `I did not understand that.\n\n${this.helpText()}`,
        );
    }
  }

  // --------------------------------------------------------------- commands

  private async handleLink(
    chat: string,
    msg: NonNullable<TelegramUpdate['message']>,
    code: string,
  ): Promise<void> {
    const cfg = await this.settings.get();
    if (!cfg.linkingEnabled) {
      return this.reply(chat, 'Telegram linking is switched off for this company.');
    }
    if (!code) {
      return this.reply(
        chat,
        `Send ${b('/link 123456')} using the six-digit code from the portal ` +
          '(Profile → Telegram).',
      );
    }

    const res = await this.identities.redeemLink(
      chat,
      msg.from?.id === undefined ? null : String(msg.from.id),
      msg.from?.username ?? null,
      code,
    );
    if (!res.ok) return this.reply(chat, escapeTelegramHtml(res.reason));

    const name = await this.displayName(res.userId);
    return this.reply(
      chat,
      `✅ Linked${name ? ` to ${b(name)}` : ''}. You will get your ESS updates here.\n` +
        `Send ${b('/unlink')} at any time to stop.`,
    );
  }

  private async handleWhoami(chat: string): Promise<void> {
    const identity = await this.identities.findActive(chat);
    if (!identity) {
      return this.reply(chat, `This chat is not linked. Send ${b('/link <code>')} to link it.`);
    }
    await this.identities.touch(identity.id);
    const name = await this.displayName(identity.userId);
    return this.reply(chat, `You are linked as ${b(name || identity.userId)}.`);
  }

  private async handleUnlink(chat: string): Promise<void> {
    const identity = await this.identities.findActive(chat);
    if (!identity) return this.reply(chat, 'This chat is not linked.');
    await this.identities.revoke(identity.userId);
    return this.reply(chat, 'Unlinked. You will no longer get ESS updates here.');
  }

  // --------------------------------------------------------------- helpers

  private helpText(): string {
    return [
      `${b('ESS bot')}`,
      '',
      `${b('/link <code>')} — link this chat to your ESS account`,
      `${b('/whoami')} — who this chat is linked to`,
      `${b('/unlink')} — stop receiving updates here`,
      '',
      'Get your code from the portal: Profile → Telegram.',
    ].join('\n');
  }

  private async displayName(userId: string): Promise<string> {
    const user = await runWithBranchBypass(() =>
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, employee: { select: { fullName: true } } },
      }),
    ).catch(() => null);
    return user?.employee?.fullName || user?.email || '';
  }

  private async reply(chat: string, html: string): Promise<void> {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) return;
    await this.api.sendMessage(cfg, chat, html).catch(() => undefined);
  }
}
