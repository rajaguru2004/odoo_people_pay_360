import { Body, Controller, Headers, Logger, Post, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { Public } from '../../common/decorators/public.decorator';
import { WhatsAppSettingsService } from '../whatsapp-settings.service';
import { WhatsAppPrincipalService } from '../runtime/whatsapp-principal.service';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { eventNameOf, parseInbound, redactEnvelope } from './inbound-parser';
import { maskPhone } from '../utils/phone.util';
import { WHATSAPP_WEBHOOK_HEADER } from '../whatsapp.types';

/**
 * Evolution's callback endpoint.
 *
 * Three things about this controller are load-bearing:
 *
 *  1. The body is `Record<string, any>`, NOT a class DTO. main.ts sets
 *     `forbidNonWhitelisted: true` globally, and an Evolution envelope has a
 *     dozen top-level keys — a DTO would 400 every single webhook.
 *  2. It always answers 200 (except on a genuine auth failure). Evolution has a
 *     short client timeout and no documented retry contract; a timeout would
 *     produce a redelivery that the claim row then suppresses, losing the
 *     message entirely. Ack first, work after.
 *  3. Processing is detached, and the detached task opens its OWN
 *     AsyncLocalStorage store — the request's store ends with the response.
 */
@ApiExcludeController()
@Controller('whatsapp/webhook')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);
  private authFailures = 0;

  constructor(
    private readonly settings: WhatsAppSettingsService,
    private readonly inbound: WhatsAppInboundService,
    private readonly principals: WhatsAppPrincipalService,
  ) {}

  @Public()
  @Post()
  async receive(
    @Body() body: Record<string, any>,
    @Headers('x-hrms-webhook-token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const cfg = await this.settings.get();

    // 401 rather than a silent 200: a misconfigured secret that answers OK
    // would look healthy forever while every message vanished.
    //
    // The three causes need telling apart. A log that only says "bad token"
    // sent a real investigation down the wrong path: a flood of these turned
    // out to be a SECOND, header-less sender (an Evolution *global* webhook
    // pointed at the same URL) while the real instance webhook was working
    // perfectly the whole time. Naming the cause is the difference between
    // "rotate the secret" and "turn off the global webhook".
    if (!cfg.webhookSecret || !safeEqual(token ?? '', cfg.webhookSecret)) {
      this.authFailures++;
      // The instance in the body is CLAIMED, not proven — the request failed
      // auth, so nothing in it is trusted. It is still the most useful hint
      // available, because the commonest cause of a token mismatch is not a
      // rotated secret at all: it is a second WhatsApp instance, belonging to
      // another tenant or deployment, whose webhook points at this same URL.
      // One backend holds one instance and one secret, so the other instance
      // can never authenticate here no matter how often the secret is rotated.
      // Leading with "rotated somewhere else" sent a real investigation
      // chasing a secret that was already correct.
      const claimed = typeof body?.instance === 'string' ? body.instance : '';
      const foreignInstance = Boolean(claimed && cfg.instanceName && claimed !== cfg.instanceName);

      const cause = !cfg.webhookSecret
        ? 'no webhook secret is configured on our side — press Connect in WhatsApp settings'
        : !token
          ? `the caller sent no ${WHATSAPP_WEBHOOK_HEADER} header at all — this is not the instance ` +
            'webhook (a global webhook or an unrelated caller posting to this URL)'
          : foreignInstance
            ? `it claims to be instance '${claimed}', but this system is configured for ` +
              `'${cfg.instanceName}'. Two instances are pointing their webhook at this one URL. ` +
              'Do NOT rotate the secret — that would break the instance that currently works. ' +
              `Point '${claimed}' at its own deployment's callback address instead, or change ` +
              'the account name in WhatsApp settings if this system is meant to serve it.'
            : 'the token does not match ours — the secret was rotated somewhere else, ' +
              'or another deployment re-registered this instance';
      this.logger.warn(
        `Rejected WhatsApp webhook (${this.authFailures} so far): ${cause} ` +
          `Event '${eventNameOf(body) || 'unknown'}', instance '${claimed || '—'}'.`,
      );
      throw new UnauthorizedException('Invalid webhook token');
    }

    // The token proves the caller, not the body. Nothing in the payload is
    // trusted for authority — the phone number is only an index into an
    // identity row, and every action re-derives the principal from the DB.
    if (cfg.instanceName && body?.instance && body.instance !== cfg.instanceName) {
      this.logger.log(
        `[WA IN] ignored: instance '${body.instance}' is not ours ('${cfg.instanceName}').`,
      );
      res.status(200).json({ received: true, ignored: 'instance-mismatch' });
      return;
    }

    let ackPayload: Record<string, unknown> = { received: true };

    try {
      const event = eventNameOf(body);
      if (event !== 'MESSAGES_UPSERT') {
        // Delivery receipts and connection changes are acknowledged; Phase 2
        // acts only on inbound user messages.
        this.logger.debug(`[WA IN] ${event || 'unknown-event'} acknowledged, not acted on.`);
        res.status(200).json({ received: true, ignored: event || 'unknown-event' });
        return;
      }

      const parsed = parseInbound(body);
      if (!parsed.ok) {
        // Previously invisible: a message that arrived, authenticated, and was
        // then dropped by the parser left no trace whatsoever.
        this.logger.warn(`[WA IN] MESSAGES_UPSERT could not be parsed: ${parsed.reason}.`);
        res.status(200).json({ received: true, ignored: parsed.reason });
        return;
      }

      // The one line that answers "did my message reach the system?". The
      // instance is named here as well as on the rejection path — without it,
      // a log full of rejections from one instance and successes from another
      // gives no way to see that two are in play at all.
      this.logger.log(
        `[WA IN] instance '${body?.instance ?? '—'}' from ${maskPhone(parsed.message.phoneE164)}` +
          ` kind=${parsed.message.kind ?? 'text'}` +
          (cfg.logMessageBodies
            ? ` text=${JSON.stringify((parsed.message.text ?? '').slice(0, 160))}`
            : ` textLength=${(parsed.message.text ?? '').length}`),
      );

      const inboundId = await this.principals.runUnauthenticated(parsed.message.phoneE164, () =>
        this.inbound.claim(parsed.message, redactEnvelope(body)),
      );

      if (!inboundId) {
        // Duplicate delivery: already claimed, already being handled.
        this.logger.log(
          `[WA IN] duplicate delivery from ${maskPhone(parsed.message.phoneE164)} — already claimed.`,
        );
        res.status(200).json({ received: true, duplicate: true });
        return;
      }

      ackPayload = { received: true, id: inboundId };

      // Detached. Its own ALS store, and it can never reject into the request.
      setImmediate(() => {
        void this.inbound
          .process(inboundId)
          .catch((e) =>
            // Stack included: this runs detached, so nothing else will ever
            // surface it and a bare message is not enough to locate the throw.
            this.logger.error(
              `[WA IN] processing failed for inbound ${inboundId}: ${e?.message}`,
              e?.stack,
            ),
          );
      });
    } catch (e) {
      // AllExceptionsFilter is global; swallowing here keeps the 200 contract.
      this.logger.error(
        `[WA IN] webhook handling error: ${(e as Error).message}`,
        (e as Error).stack,
      );
    }

    res.status(200).json(ackPayload);
  }
}

/** Constant-time compare, length-safe. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
