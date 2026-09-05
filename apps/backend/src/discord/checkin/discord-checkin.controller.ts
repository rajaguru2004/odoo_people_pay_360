import { Body, Controller, Get, Logger, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHash } from 'crypto';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { fmtTime } from '../../whatsapp/render/wa-format';
import { DiscordOutboxService } from '../discord-outbox.service';
import { ChannelPrincipalService } from '../../common/channel/channel-principal.service';
import { Public } from '../../common/decorators/public.decorator';
import { ToolCallerService } from '../../mcp/tool-caller.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TimezoneService } from '../../common/timezone/timezone.service';
import { DiscordCheckinTokenService } from './discord-checkin-token.service';

export class DiscordCheckinDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  longitude!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  accuracy?: number;
}

/**
 * The browser half of a Discord check-in.
 *
 * Public by necessity: the link is opened on a phone that has no HR session,
 * which is the entire reason this exists. What makes that acceptable is that
 * the token is the only credential AND the only instruction — the tool name and
 * its arguments come from the row, so this endpoint cannot be steered into
 * doing anything other than checking in the one employee it was minted for.
 */
@ApiExcludeController()
@Controller('discord/checkin')
export class DiscordCheckinController {
  private readonly logger = new Logger(DiscordCheckinController.name);

  constructor(
    private readonly tokens: DiscordCheckinTokenService,
    private readonly principals: ChannelPrincipalService,
    private readonly caller: ToolCallerService,
    private readonly prisma: PrismaService,
    private readonly outbox: DiscordOutboxService,
    private readonly tzSvc: TimezoneService,
  ) {}

  /** The employee's zone, so the DM does not quote a UTC clock. */
  private async timeZoneFor(user: { employeeId?: string | null }): Promise<string> {
    const employee = user.employeeId
      ? await this.prisma.employee
          .findUnique({ where: { id: user.employeeId }, select: { timezone: true } })
          .catch(() => null)
      : null;
    return this.tzSvc.getEffectiveTZ(employee?.timezone ?? null);
  }

  /**
   * Whether the page should ask for GPS at all.
   *
   * Deliberately returns nothing but a boolean. A token in a URL can leak
   * through a referrer or a screenshot, so this must not confirm WHO it belongs
   * to before it has been used.
   */
  @Public()
  @Get(':token')
  async peek(@Param('token') token: string) {
    return { success: true, data: await this.tokens.peek(token) };
  }

  @Public()
  @Post(':token')
  async checkIn(@Param('token') token: string, @Body() dto: DiscordCheckinDto) {
    const claim = await this.tokens.consume(token);

    if (!claim.ok) {
      const message =
        claim.reason === 'replay'
          ? 'This link has already been used. Run /attendance-checkin in Discord for a new one.'
          : claim.reason === 'expired'
            ? 'This link has expired. Run /attendance-checkin in Discord for a new one.'
            : 'This link is not valid. Run /attendance-checkin in Discord for a new one.';
      return { success: false, data: { ok: false, message } };
    }

    const identity = await this.prisma.discordIdentity.findUnique({
      where: { id: claim.identityId },
      select: { discordUserId: true, status: true, employeeId: true, branchId: true },
    });
    if (!identity || identity.status !== 'ACTIVE') {
      return {
        success: false,
        data: { ok: false, message: 'This Discord account is no longer linked to an HR profile.' },
      };
    }

    try {
      return await this.principals.runAs(
        'discord',
        identity.discordUserId,
        claim.userId,
        async (user) => {
          const payload = await this.caller.call(user, claim.toolName, {
            ...claim.args,
            latitude: dto.latitude,
            longitude: dto.longitude,
            confirm: true,
          });

          if (payload?.error) {
            // A geofence rejection lands here and is the one error worth
            // showing verbatim: it tells the employee they are in the wrong
            // place, which is the only thing they can act on.
            const err = payload.error ?? {};
            const status = Number(err.status ?? 0);
            const message =
              status === 400 || err.code === 'ValidationError'
                ? String(err.message || 'That check-in was not accepted.')
                : 'Something went wrong at our end.';
            if (!(status === 400 || err.code === 'ValidationError')) {
              this.logger.error(`Discord check-in tool error: ${status} ${err.code} ${err.message}`);
            }
            await this.tokens.release(token);
            return { success: false, data: { ok: false, message, retryable: true } };
          }

          const d = payload?.data ?? payload;
          const at = d?.checkIn ?? d?.attendance?.checkIn ?? null;

          // The employee started this in Discord and finished it in a browser,
          // so the confirmation belongs in both places — otherwise the chat
          // still shows nothing but the prompt that sent them away.
          void this.outbox
            .enqueueDirect({
              userId: claim.userId,
              discordUserId: identity.discordUserId,
              employeeId: identity.employeeId,
              branchId: identity.branchId,
              templateKey: 'attendance_checked_in',
              body: [
                '*✅ Checked in*',
                at ? `*Time:* ${fmtTime(at, await this.timeZoneFor(user))}` : '',
                d?.status ? `*Status:* ${d.status}` : '',
                '_Location confirmed._',
              ]
                .filter(Boolean)
                .join('\n'),
              // The token is single-use, so it is already the id of this
              // check-in: a retried POST cannot produce a second DM.
              dedupeKey: `checkin:${hashToken(token)}`,
            })
            .catch(() => undefined);

          return {
            success: true,
            data: {
              ok: true,
              message: 'Checked in.',
              checkIn: at,
              status: d?.status ?? null,
            },
          };
        },
      );
    } catch (e) {
      this.logger.error(`Discord check-in failed: ${(e as Error).message}`);
      await this.tokens.release(token);
      return {
        success: false,
        data: { ok: false, message: 'Something went wrong at our end.', retryable: true },
      };
    }
  }
}

/** Identifies the check-in in a dedupe key without putting the token in one. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}
