import { Body, Controller, Get, Logger, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Public } from '../decorators/public.decorator';
import { ChannelPrincipalService } from '../channel/channel-principal.service';
import { ToolCallerService } from '../../mcp/tool-caller.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ActorChannelName } from '../context/channel-context';
import {
  ChannelVerificationTokenService,
  VerificationRow,
  imageFingerprint,
} from './channel-verification-token.service';
import { ChannelFaceVerificationService } from './channel-face-verification.service';
import { TimezoneService } from '../timezone/timezone.service';
import { latestPunchAt } from '../../attendances/attendance-punch.util';

export class ChannelVerifyDto {
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  longitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  accuracy?: number;

  /** data:image/jpeg;base64,… — capped well under the 1 MB body limit. */
  @IsOptional()
  @IsString()
  @MaxLength(1_400_000)
  image?: string;
}

/**
 * The browser half of a verified punch, for any channel.
 *
 * Public by necessity: the link opens on a phone that has no HR session, which
 * is the entire reason it exists. What makes that acceptable is that the token
 * is the only credential AND the only instruction. The tool name and its
 * arguments come from the row, so this endpoint cannot be steered into doing
 * anything other than completing the one action it was minted for, for the one
 * employee it belongs to.
 */
@ApiExcludeController()
@Controller('channel/verify')
export class ChannelVerificationController {
  private readonly logger = new Logger(ChannelVerificationController.name);

  constructor(
    private readonly tokens: ChannelVerificationTokenService,
    private readonly faces: ChannelFaceVerificationService,
    private readonly principals: ChannelPrincipalService,
    private readonly caller: ToolCallerService,
    private readonly prisma: PrismaService,
    private readonly tzSvc: TimezoneService,
  ) {}

  /**
   * What the page should ask for.
   *
   * Deliberately returns nothing identifying. A token in a url leaks through
   * referrers and screenshots, so this must not confirm WHO it belongs to
   * before it has been used.
   */
  @Public()
  @Get(':token')
  async peek(@Param('token') token: string) {
    return { success: true, data: await this.tokens.peek(token) };
  }


  @Public()
  @Post(':token')
  async verify(@Param('token') token: string, @Body() dto: ChannelVerifyDto) {
    const claim = await this.tokens.consume(token);
    if (!claim.ok) {
      return { success: false, data: { ok: false, message: claimMessage(claim.reason) } };
    }
    const row = claim.row;

    // Proofs first, in one submit, because the capability is single-use: two
    // round trips would need two of them, and the second could be answered by
    // somebody standing somewhere else.
    if (row.requireFace) {
      const proof = await this.collectFaceProof(row, dto.image);
      if (!proof.ok) {
        const attempts = await this.tokens.bumpAttempts(row.id);
        const retryable = attempts < row.maxAttempts;
        if (retryable) await this.tokens.release(token);
        return {
          success: false,
          data: { ok: false, message: proof.message, retryable },
        };
      }
    }

    if (row.requireLocation && (dto.latitude === undefined || dto.longitude === undefined)) {
      await this.tokens.release(token);
      return {
        success: false,
        data: {
          ok: false,
          message: 'Location is required to complete this. Allow location access and try again.',
          retryable: true,
        },
      };
    }

    try {
      return await this.principals.runAs(
        row.channel as ActorChannelName,
        row.identityId,
        row.userId,
        async (user) => {
          const payload = await this.caller.call(user, row.toolName, {
            ...row.args,
            ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
            ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
            // The receipt, not an assertion: spendFaceProof re-checks the
            // channel against AsyncLocalStorage before it counts for anything.
            ...(row.requireFace ? { faceProofId: row.id } : {}),
            confirm: true,
          });

          if (payload?.error) {
            // The rejection worth showing VERBATIM: 400 is our own domain text
            // and 403 is the geofence denial ("out of office range, 240m away")
            // — in both cases the message is the only thing the employee can
            // act on. Anything else stays generic.
            const err = payload.error ?? {};
            const status = Number(err.status ?? 0);
            const actionable =
              status === 400 || status === 403 || err.code === 'ValidationError';
            if (!actionable) {
              this.logger.error(
                `Channel verification tool error: ${status} ${err.code} ${err.message}`,
              );
            }
            await this.tokens.release(token);
            const message = actionable
              ? String(err.message || 'That was not accepted.')
              : 'Something went wrong at our end.';
            return {
              success: false,
              data: { ok: false, message, retryable: true },
            };
          }

          // The LATEST punch, not the day-opening one: `attendance.checkIn`
          // never moves, so a second check-in was being confirmed with the
          // morning's time.
          const d = payload?.data ?? payload;
          const at = latestPunchAt(payload, row.purpose === 'CHECKOUT' ? 'out' : 'in');
          const label = await this.punchTimeLabel(row, at);

          return {
            success: true,
            data: {
              ok: true,
              message: 'Done.',
              // ONE authoritative field, formatted server-side in the
              // employee's zone. The page used to pick between checkIn and
              // checkOut itself and got a check-out confirmed with the day's
              // first check-in; and formatting in the BROWSER's zone would
              // disagree with the chat message for anyone travelling.
              at,
              atLabel: label,
              status: d?.status ?? null,
            },
          };
        },
      );
    } catch (e) {
      this.logger.error(`Channel verification failed: ${(e as Error).message}`);
      await this.tokens.release(token);
      return {
        success: false,
        data: { ok: false, message: 'Something went wrong at our end.', retryable: true },
      };
    }
  }

  // ----------------------------------------------------------------- internal

  private async collectFaceProof(
    row: VerificationRow,
    image: string | undefined,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!image) return { ok: false, message: 'A photo is required to complete this.' };
    if (!row.employeeId) {
      return { ok: false, message: 'This account is not linked to an employee record.' };
    }
    return this.faces.verifyAndRecord(row, image, imageFingerprint(image));
  }

  /** "14:32" in the employee's own zone, or '' when unknowable. */
  private async punchTimeLabel(row: VerificationRow, iso: string | null): Promise<string> {
    if (!iso) return '';
    const employeeTz = row.employeeId
      ? await this.prisma.employee
          .findUnique({ where: { id: row.employeeId }, select: { timezone: true } })
          .then((e) => e?.timezone ?? null)
          .catch(() => null)
      : null;
    // The SAME resolver every chat render uses: employee -> company -> default.
    // A hand-rolled fallback to UTC here is exactly how this message once told
    // somebody who checked in at 14:24 that they checked in at 08:54 — most
    // employees have no personal timezone set, and the company zone is the
    // answer for all of them.
    const tz = await this.tzSvc.getEffectiveTZ(employeeTz).catch(() => 'UTC');
    try {
      const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso));
      return time;
    } catch {
      return '';
    }
  }
}

function claimMessage(reason: 'unknown' | 'expired' | 'replay' | 'exhausted'): string {
  switch (reason) {
    case 'replay':
      return 'This link has already been used. Ask for a new one from the chat.';
    case 'expired':
      return 'This link has expired. Ask for a new one from the chat.';
    case 'exhausted':
      return 'Too many attempts. Ask for a new link from the chat.';
    default:
      return 'This link is not valid. Ask for a new one from the chat.';
  }
}

