import { Controller, Headers, Logger, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { DiscordSettingsService } from '../discord-settings.service';
import {
  BUTTON_STYLE,
  CALLBACK_TYPE,
  COMPONENT_TYPE,
  EPHEMERAL_FLAG,
  INTERACTION_TYPE,
} from '../discord.types';
import { verifyDiscordSignature } from './discord-verify';
import { DiscordInteractionService } from './discord-interaction.service';

/**
 * Discord's interactions endpoint.
 *
 * Four things here are load-bearing:
 *
 *  1. Signature verification over the RAW body. Discord signs the exact bytes
 *     it sent, so a re-serialised `JSON.stringify(req.body)` will not verify —
 *     main.ts is configured to retain `rawBody` for this route.
 *  2. A 401 on a bad signature, not a 200. Discord actively probes with invalid
 *     signatures when you save the URL and refuses an endpoint that accepts them.
 *  3. PING must answer PONG, or the URL cannot be saved at all.
 *  4. A reply within 3 seconds or Discord shows "the application did not
 *     respond". Everything downstream is a single MCP tool call, which is well
 *     inside that; if it ever is not, the fix is a deferred response.
 */
@ApiExcludeController()
@Controller('discord/interactions')
export class DiscordInteractionsController {
  private readonly logger = new Logger(DiscordInteractionsController.name);
  private signatureFailures = 0;

  constructor(
    private readonly settings: DiscordSettingsService,
    private readonly interactions: DiscordInteractionService,
  ) {}

  @Public()
  @Post()
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Headers('x-signature-ed25519') signature: string | undefined,
    @Headers('x-signature-timestamp') timestamp: string | undefined,
  ): Promise<void> {
    const cfg = await this.settings.get();

    if (!cfg.publicKey) {
      this.logger.error('Discord interaction received but no public key is configured.');
      res.status(401).send('unconfigured');
      return;
    }

    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const valid = verifyDiscordSignature({
      publicKeyHex: cfg.publicKey,
      signatureHex: signature ?? '',
      timestamp: timestamp ?? '',
      rawBody,
    });

    if (!valid) {
      this.signatureFailures++;
      this.logger.warn(`Rejected a Discord interaction with a bad signature (${this.signatureFailures}).`);
      res.status(401).send('invalid request signature');
      return;
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.status(400).send('bad json');
      return;
    }

    // The handshake Discord performs before it will save the endpoint URL.
    if (body?.type === INTERACTION_TYPE.PING) {
      res.status(200).json({ type: CALLBACK_TYPE.PONG });
      return;
    }

    if (body?.type !== INTERACTION_TYPE.APPLICATION_COMMAND) {
      // Components and modals are not used yet; acknowledge rather than error.
      res.status(200).json({ type: CALLBACK_TYPE.PONG });
      return;
    }

    try {
      // In a guild the user is under `member`; in a DM it is `user`.
      const user = body.member?.user ?? body.user ?? {};
      const options: Record<string, string> = {};
      for (const o of body.data?.options ?? []) {
        if (o?.name && o?.value !== undefined) options[o.name] = String(o.value);
      }

      const result = await this.interactions.handleCommand({
        commandName: String(body.data?.name ?? ''),
        options,
        discordUserId: String(user.id ?? ''),
        discordTag: user.username ? String(user.username) : null,
      });

      res.status(200).json({
        type: CALLBACK_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: result.content,
          ...(result.ephemeral ? { flags: EPHEMERAL_FLAG } : {}),
          // A LINK button carries no custom_id and produces no interaction, so
          // it needs no component handler — Discord just opens the URL.
          ...(result.linkButton
            ? {
                components: [
                  {
                    type: COMPONENT_TYPE.ACTION_ROW,
                    components: [
                      {
                        type: COMPONENT_TYPE.BUTTON,
                        style: BUTTON_STYLE.LINK,
                        label: result.linkButton.label.slice(0, 80),
                        url: result.linkButton.url,
                      },
                    ],
                  },
                ],
              }
            : {}),
        },
      });
    } catch (e) {
      this.logger.error(`Discord interaction failed: ${(e as Error).message}`);
      // Still a 200: a non-200 makes Discord show a generic failure, whereas a
      // message tells the user what happened.
      res.status(200).json({
        type: CALLBACK_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Something went wrong at our end.', flags: EPHEMERAL_FLAG },
      });
    }
  }
}
