import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { HrmPrincipal } from '../../mcp/tool.types';
import { ToolCallerService } from '../../mcp/tool-caller.service';
import {
  ChannelVerificationTokenService,
  imageFingerprint,
} from '../../common/verification/channel-verification-token.service';
import { ChannelFaceVerificationService } from '../../common/verification/channel-face-verification.service';
import { EvolutionClient } from '../evolution/evolution.client';
import { WhatsAppSettingsService } from '../whatsapp-settings.service';
import { SessionRow } from '../session/whatsapp-session.service';
import { WaOutbound } from '../router/action.types';
import { bold, italic, lines } from '../render/wa-format';

export interface FaceProofOutcome {
  /** Reply to send. Always set — silence would look like a lost photo. */
  out: WaOutbound;
  /** The action to render on success, so the caller can run its renderer. */
  completed?: { actionKey: string; payload: any };
}

/**
 * Handles a photo sent into the chat as an answer to a face challenge.
 *
 * The meaning of an inbound photo comes entirely from a server-side challenge
 * row: it names the action and the tool that will run, exactly as the browser
 * link does. Without an open challenge the photo is refused rather than guessed
 * at — a bot that acts on any picture it receives is a bot that checks people
 * in when they send a photo of their lunch.
 *
 * ## What this can and cannot prove
 *
 * A saved photo and a live capture are indistinguishable here. This proves
 * possession of the enrolled handset plus possession of a photo matching the
 * employee; it does not prove presence. The checks that DO exist are upstream
 * and in ChannelFaceVerificationService: a bounded challenge window, one live
 * challenge per employee, a per-day cap, an attempt cap, exact-bytes replay
 * detection, and an admin-visible image on every accepted proof.
 */
@Injectable()
export class WhatsAppFaceProofService {
  private readonly logger = new Logger(WhatsAppFaceProofService.name);

  constructor(
    private readonly settings: WhatsAppSettingsService,
    private readonly evolution: EvolutionClient,
    private readonly tokens: ChannelVerificationTokenService,
    private readonly faces: ChannelFaceVerificationService,
    private readonly caller: ToolCallerService,
    private readonly audit: AuditService,
  ) {}

  async handle(
    session: SessionRow,
    user: HrmPrincipal,
    waMessageId: string,
  ): Promise<FaceProofOutcome> {
    if (!session.identityId) return { out: { plain: NOT_EXPECTED } };

    const challenge = await this.tokens.findOpenChallenge('whatsapp', session.identityId);
    if (!challenge) return { out: { plain: NOT_EXPECTED } };

    const cfg = await this.settings.ensureCredentials();
    if (!cfg) return { out: { plain: 'Photo verification is not available right now.' } };

    // Claim BEFORE fetching the bytes: two photos arriving together must not
    // both be treated as the answer.
    const claim = await this.tokens.consumeById(challenge.id);
    if (!claim.ok) {
      return {
        out: {
          plain:
            claim.reason === 'exhausted'
              ? 'Too many attempts. Reply CHECK IN to start again.'
              : 'That request has already been answered. Reply CHECK IN to start again.',
        },
      };
    }
    const row = claim.row;

    const media = await this.evolution.getBase64FromMediaMessage(cfg, { waMessageId });
    if (!media.ok) {
      // Not the employee's fault, and retryable — hand the challenge back.
      await this.tokens.releaseById(row.id);
      this.logger.warn(`Could not fetch inbound media ${waMessageId}: ${media.error}`);
      return {
        out: {
          plain: lines(
            bold('I could not open that photo'),
            'Please send it again — a normal photo works better than a forwarded one.',
          ),
        },
      };
    }

    const image = media.base64.startsWith('data:')
      ? media.base64
      : `data:${media.mimetype ?? 'image/jpeg'};base64,${media.base64}`;

    const verified = await this.faces.verifyAndRecord(row, image, imageFingerprint(image));
    if (!verified.ok) {
      const attempts = await this.tokens.bumpAttempts(row.id);
      const left = row.maxAttempts - attempts;
      if (left > 0) await this.tokens.releaseById(row.id);
      return {
        out: {
          plain: lines(
            verified.message,
            left > 0
              ? italic(`You can try ${left} more time(s).`)
              : italic('Reply CHECK IN to start again.'),
          ),
        },
      };
    }

    const payload = await this.caller.call(user, row.toolName, {
      ...row.args,
      faceProofId: row.id,
      confirm: true,
    });

    if (payload?.error) {
      // The proof was good; the punch was not accepted. Release so the employee
      // does not have to retake a photo for something they can fix — the
      // face match itself is preserved on the row.
      await this.tokens.releaseById(row.id);
      const err = payload.error ?? {};
      const actionable = Number(err.status) === 400 || err.code === 'ValidationError';
      if (!actionable) {
        this.logger.error(`Face-proof tool error: ${err.status} ${err.code} ${err.message}`);
      }
      return {
        out: {
          plain: actionable
            ? String(err.message || 'That was not accepted.')
            : 'Something went wrong at our end.',
        },
      };
    }

    void this.audit.log({
      userId: user.id,
      action: 'ATTENDANCE_SELFIE_VERIFIED',
      resourceType: 'Attendance',
      resourceId: row.employeeId ?? undefined,
      newData: { purpose: row.purpose, actionKey: row.actionKey, channel: 'whatsapp' },
    });

    return { out: { plain: '' }, completed: { actionKey: row.actionKey, payload } };
  }
}

/**
 * The single reply for a photo nobody asked for.
 *
 * Deliberately does not say whether a challenge exists, is expired, or was
 * never issued — the same non-enumerating discipline the rest of the channel
 * uses.
 */
const NOT_EXPECTED =
  'I was not expecting a photo. Reply CHECK IN (or MENU) first, and I will ask for one if it is needed.';
