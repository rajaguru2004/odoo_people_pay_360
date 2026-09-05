import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TelegramApiClient } from './api/telegram-api.client';
import { TelegramSettingsService } from './telegram-settings.service';
import { TelegramIdentityService } from './identity/telegram-identity.service';
import { TelegramOutboxService } from './telegram-outbox.service';
import { UpdateTelegramSettingsDto } from './dto/update-telegram-settings.dto';
import { TelegramResolvedConfig } from './telegram.types';

/**
 * Telegram channel administration.
 *
 * ADMIN only, and outside the generic /system-settings surface for the same
 * reason as WhatsApp and Discord: `getSettingsList()` is a hardcoded catalogue,
 * so keeping every `telegram.*` key out of it means GET /system-settings never
 * carries the bot token for any role. The read projection is typed as
 * TelegramPublicConfig, which structurally has no `botToken` field.
 */
@ApiTags('telegram')
@ApiBearerAuth('JWT-auth')
@Controller('telegram')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class TelegramController {
  constructor(
    private readonly settings: TelegramSettingsService,
    private readonly identities: TelegramIdentityService,
    private readonly outbox: TelegramOutboxService,
    private readonly api: TelegramApiClient,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Telegram channel settings (bot token masked, never returned)' })
  async getSettings() {
    return { success: true, data: await this.settings.getPublic() };
  }

  @Put('settings')
  @ApiOperation({ summary: 'Update Telegram channel settings' })
  async updateSettings(@Body() dto: UpdateTelegramSettingsDto) {
    return { success: true, data: await this.settings.update(dto) };
  }

  @Get('identities/stats')
  @ApiOperation({ summary: 'How many Telegram accounts are linked' })
  async stats() {
    return { success: true, data: await this.identities.stats() };
  }

  @Get('diagnostics')
  @ApiOperation({
    summary: 'Ask Telegram who the bot is, whether the webhook delivers, and whether the alert chat is reachable.',
    description:
      'Ignores the `enabled` switch: an admin has to be able to verify the credentials ' +
      'before turning delivery on. The chat check is the one that matters in practice — ' +
      '"chat not found" is the same message whether the id is wrong, the bot was never ' +
      'added to the group, or the group was upgraded to a supergroup and changed id.',
  })
  async diagnostics() {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) throw new BadRequestException('No Telegram bot token is configured.');
    const [bot, webhook, chat] = await Promise.all([
      this.api.getMe(cfg),
      this.api.getWebhookInfo(cfg),
      this.resolveAlertChat(cfg),
    ]);
    return { success: true, data: { bot, webhook, chat } };
  }

  /**
   * What the alert chat id actually resolves to.
   *
   * Returned as data rather than thrown, because every outcome here is
   * something the admin needs to SEE: the stored id (so a wrong one is obvious
   * at a glance), the group's real title (so a right one is confirmed), or
   * Telegram's own refusal.
   */
  private async resolveAlertChat(cfg: TelegramResolvedConfig) {
    const chatId = cfg.alertChatId;
    if (!chatId) return { chatId: '', ok: false as const, error: 'No alert chat id is set.' };

    const res = await this.api.getChat(cfg, chatId);
    if (!res.ok) return { chatId, ok: false as const, error: res.error };
    return { chatId, ok: true as const, title: res.title, type: res.type, resolvedId: res.id };
  }

  @Post('webhook/register')
  @ApiOperation({
    summary: 'Point Telegram at this deployment’s webhook.',
    description:
      'Generates a secret token if none is stored, then calls setWebhook. The URL is ' +
      'derived from BACKEND_PUBLIC_URL, so a deployment cannot be pointed at somebody ' +
      'else’s host from a request body.',
  })
  async registerWebhook() {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) throw new BadRequestException('No Telegram bot token is configured.');

    const base = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!base) {
      throw new BadRequestException(
        'BACKEND_PUBLIC_URL is not set, so there is no public URL to give Telegram.',
      );
    }
    if (!base.startsWith('https://')) {
      // Telegram refuses plain HTTP outright; saying so here beats a bare
      // "Bad Request: bad webhook" bubbling up from the API.
      throw new BadRequestException('Telegram only accepts an HTTPS webhook URL.');
    }

    const secret = await this.settings.ensureWebhookSecret();
    // Re-resolve: ensureWebhookSecret may have just minted and stored one.
    const fresh = (await this.settings.ensureCredentials())!;
    const res = await this.api.setWebhook(fresh, `${base}/telegram/webhook`, secret);
    if (!res.ok) throw new BadRequestException(res.error ?? 'Telegram refused the webhook.');
    return { success: true, data: { url: `${base}/telegram/webhook` } };
  }

  @Post('webhook/unregister')
  @ApiOperation({ summary: 'Stop Telegram delivering updates here.' })
  async unregisterWebhook() {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) throw new BadRequestException('No Telegram bot token is configured.');
    const res = await this.api.deleteWebhook(cfg);
    if (!res.ok) throw new BadRequestException(res.error ?? 'Telegram refused the request.');
    return { success: true, data: { removed: true } };
  }

  @Post('outbox/drain')
  @ApiOperation({ summary: 'Run the sender immediately' })
  async drain() {
    return { success: true, data: await this.outbox.drain() };
  }

  @Post('test-message')
  @ApiOperation({
    summary: 'Send a message to the configured alert chat, to prove the wiring.',
    description:
      'Sends SYNCHRONOUSLY and reports what Telegram said. Queuing it would answer ' +
      '"queued" and then fail in the drainer minutes later with nothing on screen — ' +
      'which is exactly how a broken chat id survived a deployment.',
  })
  async testMessage() {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) throw new BadRequestException('No Telegram bot token is configured.');

    const chatId = cfg.redirectAllTo || cfg.alertChatId;
    if (!chatId) throw new BadRequestException('No alert chat id is configured.');

    const res = await this.api.sendMessage(
      cfg,
      chatId,
      '<b>ESS</b>\nTelegram channel test message.',
    );
    if (!res.ok) throw new BadRequestException(this.explainSendFailure(chatId, res.error));

    return { success: true, data: { sent: true, chatId, messageId: res.messageId ?? null } };
  }

  /**
   * Turn Telegram's one-size-fits-all refusal into the thing to go and do.
   *
   * `Bad Request: chat not found` has four distinct causes and the API does not
   * say which. Listing them beats a bare echo, which sends people to re-copy an
   * id that was already correct.
   */
  private explainSendFailure(chatId: string, error?: string): string {
    const base = `Telegram refused to post to ${chatId}: ${error ?? 'send failed'}`;
    if (!/chat not found/i.test(error ?? '')) return base;
    return (
      `${base}. Either that id is not a chat, the bot was never added to that group, ` +
      'it has been removed from it, or the group was upgraded to a supergroup and its ' +
      'id changed (a supergroup id starts with -100). Use "Check chat" to see what the ' +
      'stored id resolves to.'
    );
  }
}

/**
 * Employee self-service. Scoped from @CurrentUser() with no id parameter, so
 * there is no shape in which one employee links another one's account.
 */
@ApiTags('telegram')
@ApiBearerAuth('JWT-auth')
@Controller('telegram/me')
@UseGuards(JwtAuthGuard)
export class TelegramMeController {
  constructor(
    private readonly identities: TelegramIdentityService,
    private readonly settings: TelegramSettingsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Is my Telegram account linked?' })
  async me(@CurrentUser() user: any) {
    const [status, cfg] = await Promise.all([
      this.identities.getMine(user.id),
      this.settings.get(),
    ]);
    return {
      success: true,
      data: {
        ...status,
        // Lets the profile screen hide the section entirely rather than offering
        // a link that would be refused at /link time.
        available: cfg.enabled && cfg.linkingEnabled && cfg.inboundEnabled,
      },
    };
  }

  @Post('link/start')
  @ApiOperation({
    summary: 'Get a one-time code to send as /link to the bot.',
    description:
      'Issued in the browser and redeemed from Telegram, so neither side alone completes ' +
      'the link.',
  })
  async startLink(@CurrentUser() user: any) {
    const cfg = await this.settings.get();
    // Without this the code issues fine and then fails at redemption, which
    // reads as a broken bot rather than a switched-off channel. `inboundEnabled`
    // is part of the check because the redemption arrives on the webhook: with
    // it off there is nothing to redeem against.
    if (!cfg.enabled || !cfg.linkingEnabled || !cfg.inboundEnabled) {
      throw new ForbiddenException('Telegram linking is not enabled.');
    }
    return { success: true, data: await this.identities.startLink(user.id) };
  }

  @Post('unlink')
  @ApiOperation({ summary: 'Unlink my Telegram account. Link history is kept.' })
  async unlink(@CurrentUser() user: any) {
    return { success: true, data: await this.identities.revoke(user.id) };
  }
}
