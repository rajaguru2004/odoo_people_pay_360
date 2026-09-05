import { Body, Controller, Headers, Logger, Post, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { Public } from '../../common/decorators/public.decorator';
import { TelegramSettingsService } from '../telegram-settings.service';
import { TelegramInboundService } from './telegram-inbound.service';
import { TELEGRAM_WEBHOOK_HEADER, TelegramUpdate } from '../telegram.types';

/**
 * Telegram's callback endpoint.
 *
 * Three things about this controller are load-bearing, all learned on the
 * WhatsApp one:
 *
 *  1. The body is `Record<string, any>`, NOT a class DTO. main.ts sets
 *     `forbidNonWhitelisted: true` globally, and a Telegram Update has a dozen
 *     top-level keys — a DTO would 400 every single update.
 *  2. It always answers 200 (except on a genuine auth failure). Telegram RETRIES
 *     an update it did not get a 200 for, and it retries the whole backlog in
 *     order, so a slow handler that times out turns one message into a stuck
 *     queue. Ack first, work after.
 *  3. Processing is detached, and the detached task opens its own
 *     AsyncLocalStorage store — the request's store ends with the response.
 *
 * Auth is the `secret_token` given to setWebhook, which Telegram echoes in
 * X-Telegram-Bot-Api-Secret-Token. The endpoint URL is public, so without this
 * anybody who guesses it could feed the bot fabricated `/link` attempts.
 */
@ApiExcludeController()
@Controller('telegram/webhook')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);
  private authFailures = 0;

  constructor(
    private readonly settings: TelegramSettingsService,
    private readonly inbound: TelegramInboundService,
  ) {}

  @Public()
  @Post()
  async receive(
    @Body() body: Record<string, any>,
    @Headers(TELEGRAM_WEBHOOK_HEADER) token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const cfg = await this.settings.get();

    // 401 rather than a silent 200: a misconfigured secret that answers OK
    // would look healthy forever while every update vanished. And unlike a
    // silent drop, a 401 makes Telegram retry, so a secret fixed five minutes
    // later still delivers the backlog.
    if (!cfg.webhookSecret || !safeEqual(token ?? '', cfg.webhookSecret)) {
      this.authFailures++;
      this.logger.warn(
        cfg.webhookSecret
          ? `Telegram webhook rejected: secret token mismatch (${this.authFailures} so far). ` +
              'Either the stored secret was rotated without re-running ' +
              'POST /telegram/webhook/register, or something other than Telegram is posting here.'
          : 'Telegram webhook rejected: no secret is stored. Run POST /telegram/webhook/register.',
      );
      throw new UnauthorizedException('Invalid webhook token');
    }

    if (!cfg.inboundEnabled) {
      // 200, not 403: inbound being off is a deliberate configuration, and
      // making Telegram retry a message we are never going to process just
      // builds a backlog that arrives all at once when it is switched on.
      res.status(200).json({ ok: true, ignored: 'inbound disabled' });
      return;
    }

    res.status(200).json({ ok: true });

    void this.inbound
      .handle(body as TelegramUpdate)
      .catch((e) => this.logger.error(`Telegram update failed: ${(e as Error).message}`));
  }
}

/**
 * Constant-time compare that does not leak length through an early return.
 * Both sides are hashed to a fixed width by `Buffer.from`+length guard, so a
 * mismatched length is a plain false rather than a throw from timingSafeEqual.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
