import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { HrmPrincipal } from '../../mcp/tool.types';
import { ToolCallerService } from '../../mcp/tool-caller.service';
import { TimezoneService } from '../../common/timezone/timezone.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppSettingsService } from '../whatsapp-settings.service';
import { WhatsAppPrincipalService } from '../runtime/whatsapp-principal.service';
import { WhatsAppRateLimitService } from '../runtime/whatsapp-rate-limit.service';
import { WhatsAppActionTokenService } from '../approvals/whatsapp-action-token.service';
import { MessageComposerService } from '../render/message-composer.service';
import { ActionRegistryService } from '../router/action-registry.service';
import { CommandRouterService } from '../router/command-router.service';
import { FlowEngineService } from '../router/flow-engine.service';
import { SessionRow, WhatsAppSessionService } from '../session/whatsapp-session.service';
import { WhatsAppActionDef, RenderCtx, WaOutbound, replyBtn } from '../router/action.types';
import { buildMainMenu } from '../render/menu-renderer';
import { withNextSteps } from '../router/next-steps';
import { ParsedInbound } from './inbound-parser';
import { INBOUND_STATUS, IDENTITY_STATUS, WhatsAppResolvedConfig } from '../whatsapp.types';
import { bold, escapeWa, italic, lines, outbound, renderMenu, rule } from '../render/wa-format';
import { firstRegion, maskPhone, toE164 } from '../utils/phone.util';
import { runWithBranchBypass } from '../../common/branch/branch-context';
import { IDENTITY_SOURCE } from '../whatsapp.types';
import { WHATSAPP_AI_PORT } from '../ai/whatsapp-ai.port';
import type { WhatsAppAiPort } from '../ai/whatsapp-ai.port';
import { APPROVAL_ACTION_KEYS } from '../router/actions/approval.actions';
import { decodeCallback, decodeControl, encodeCallback, encodeControl } from '../router/callback-id';
import { ChannelVerificationTokenService } from '../../common/verification/channel-verification-token.service';
import { WhatsAppFaceProofService } from './whatsapp-face-proof.service';
import {
  VERIFICATION_MODE,
  VerificationMode,
  VerificationPurpose,
  effectiveMode,
  resolveVerificationMode,
} from '../../common/verification/verification.types';

/**
 * Which punch an action performs.
 *
 * A map rather than a field on the action, because it exists to bind a
 * verification proof to one specific act — and that binding has to be decided
 * here, by the runtime, not declared by the catalogue entry it is checking.
 * An unmapped action gets CHECKIN, the strictest of the four to forge, and
 * only ever reaches a purpose check that will then fail.
 */
const ACTION_PURPOSES: Record<string, VerificationPurpose> = {
  'attendance.checkin': 'CHECKIN',
  'attendance.checkout': 'CHECKOUT',
  'attendance.lunch_start': 'LUNCH_OUT',
  'attendance.lunch_end': 'LUNCH_IN',
};

function purposeOf(actionKey: string): VerificationPurpose {
  return ACTION_PURPOSES[actionKey] ?? 'CHECKIN';
}

/**
 * Turns one inbound message into one reply.
 *
 * The order of the gates here is the security design: identify, rate-limit,
 * route, authorise, then act. Nothing calls a tool before a real principal and
 * a real branch context exist.
 */
@Injectable()
export class WhatsAppInboundService {
  private readonly logger = new Logger(WhatsAppInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: WhatsAppSettingsService,
    private readonly sessions: WhatsAppSessionService,
    private readonly router: CommandRouterService,
    private readonly registry: ActionRegistryService,
    private readonly flows: FlowEngineService,
    private readonly principals: WhatsAppPrincipalService,
    private readonly caller: ToolCallerService,
    private readonly composer: MessageComposerService,
    private readonly rates: WhatsAppRateLimitService,
    private readonly tokens: WhatsAppActionTokenService,
    private readonly audit: AuditService,
    private readonly tzSvc: TimezoneService,
    private readonly proofs: ChannelVerificationTokenService,
    private readonly faceProofs: WhatsAppFaceProofService,
    @Inject(WHATSAPP_AI_PORT) private readonly ai: WhatsAppAiPort,
  ) {}

  /**
   * Claim the message. The first write IS the duplicate-delivery guard: a
   * retried webhook loses the unique insert instead of re-running the action.
   *
   * @returns the row id, or null when this delivery is a duplicate.
   */
  async claim(parsed: ParsedInbound, rawJson: any): Promise<string | null> {
    const cfg = await this.settings.get();
    try {
      const row = await this.prisma.whatsAppInboundMessage.create({
        data: {
          instance: parsed.instance,
          waMessageId: parsed.waMessageId,
          remoteJid: parsed.remoteJid,
          phoneE164: parsed.phoneE164,
          pushName: parsed.pushName,
          inputKind: parsed.kind,
          body: cfg.logMessageBodies ? parsed.text : null,
          callbackId: parsed.callbackId,
          rawJson,
          status: INBOUND_STATUS.RECEIVED,
        },
        select: { id: true },
      });
      return row.id;
    } catch {
      // P2002 on (instance, waMessageId) — Evolution redelivered.
      return null;
    }
  }

  /** Process a claimed message. Always resolves; never throws at the caller. */
  async process(inboundId: string): Promise<void> {
    const row = await this.prisma.whatsAppInboundMessage.findUnique({ where: { id: inboundId } });
    if (!row) return;

    // Reclaim guard: only RECEIVED or a due retry may run.
    const claimed = await this.prisma.whatsAppInboundMessage.updateMany({
      where: { id: inboundId, status: { in: [INBOUND_STATUS.RECEIVED, INBOUND_STATUS.FAILED] } },
      data: { status: INBOUND_STATUS.PROCESSING, attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return;

    try {
      await this.handle(row as any);
      await this.finish(inboundId, INBOUND_STATUS.DONE);
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 500) ?? 'unknown';
      this.logger.error(`WhatsApp inbound ${inboundId} failed: ${msg}`);
      await this.prisma.whatsAppInboundMessage
        .update({
          where: { id: inboundId },
          data: {
            status: INBOUND_STATUS.FAILED,
            lastError: msg,
            // Backoff so a persistent failure does not spin.
            nextRetryAt: new Date(Date.now() + 2 * 60_000),
          },
        })
        .catch(() => undefined);
    }
  }

  // ============================================================== pipeline

  private async handle(row: {
    id: string;
    instance: string;
    remoteJid: string;
    phoneE164: string | null;
    inputKind: string;
    body: string | null;
    callbackId: string | null;
  }): Promise<void> {
    const cfg = await this.settings.get();

    if (!cfg.inboundEnabled) {
      await this.finish(row.id, INBOUND_STATUS.IGNORED, 'inbound disabled');
      return;
    }

    // An @lid-only sender cannot be identified. Stay silent rather than guess:
    // replying would confirm the number reached a real system.
    if (!row.phoneE164) {
      this.logger.warn(`Inbound from unresolvable JID ${row.remoteJid}; ignoring.`);
      await this.finish(row.id, INBOUND_STATUS.IGNORED, 'unresolvable-sender');
      return;
    }

    // Flood protection before any DB lookup keyed on the sender.
    if (!this.rates.allow(`phone:${row.phoneE164}`, cfg.ratePerPhone5Min, 5 * 60_000)) {
      await this.finish(row.id, INBOUND_STATUS.IGNORED, 'rate-limited');
      return;
    }

    const session = await this.sessions.getOrCreate(row.instance, row.remoteJid);

    await this.sessions.withLock(session.id, async () => {
      const identity = await this.prisma.whatsAppIdentity.findUnique({
        where: { phoneE164: row.phoneE164! },
      });

      // Unknown, revoked, blocked: ONE identical reply, at most hourly. Never
      // reveal which of those it is, or the endpoint becomes an oracle.
      if (!identity || identity.status !== IDENTITY_STATUS.ACTIVE) {
        await this.handleUnenrolled(session, row, identity, cfg);
        return;
      }

      // Stamp before anything else can fail: `lastSeenAt` is how we know
      // whether we have ever spoken to this person, and the column had no
      // writer at all until now.
      const firstEver = !identity.lastSeenAt;
      await this.prisma.whatsAppIdentity
        .update({ where: { id: identity.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);

      await this.sessions.bindIdentity(session, identity.id, identity.userId);
      await this.prisma.whatsAppInboundMessage.update({
        where: { id: row.id },
        data: { sessionId: session.id, identityId: identity.id, userId: identity.userId },
      });
      await this.composer.ack(session, (row as any).waMessageId ?? '');

      this.logger.log(
        `[WA IN] ${maskPhone(row.phoneE164)} recognised as user ${identity.userId} ` +
          `(identity ${identity.status}) — routing.`,
      );

      if (!this.rates.allow(`user:${identity.userId}`, cfg.ratePerUserHour, 60 * 60_000)) {
        // Named, because "rate limited" and "broken" look identical from the
        // handset and this reply is easy to mistake for a canned failure.
        this.logger.warn(
          `[WA IN] user ${identity.userId} is over the hourly message cap ` +
            `(${cfg.ratePerUserHour}/hour) — asked them to retry.`,
        );
        await this.composer.send(session, {
          plain: 'You have sent a lot of requests. Please try again shortly.',
        });
        return;
      }

      // The very first thing we ever say to somebody. Sent before their message
      // is answered, not instead of it — they asked for something, and being
      // introduced to a bot is not an answer.
      if (firstEver) {
        await this.composer.send(session, this.buildWelcome(cfg));
      }

      // The principal is rebuilt per message, so a deactivated account or a
      // revoked grant takes effect immediately.
      try {
        await this.principals.runAs(identity.userId, row.phoneE164, (user) =>
          this.route(cfg, session, row, user, identity),
        );
      } catch (e) {
        if ((e as any)?.status === 401 || /inactive|not found/i.test((e as Error).message ?? '')) {
          await this.prisma.whatsAppIdentity.update({
            where: { id: identity.id },
            data: { status: IDENTITY_STATUS.REVOKED, revokedAt: new Date() },
          });
          await this.composer.send(session, this.composer.genericUnknownReply(cfg.appBaseUrl));
          return;
        }
        throw e;
      }
    });
  }

  private async handleUnenrolled(
    session: SessionRow,
    row: { phoneE164: string | null; body: string | null; callbackId: string | null },
    identity: any,
    cfg: any,
  ): Promise<void> {
    // A PENDING identity replying START is the third leg of enrolment: it
    // proves the WhatsApp account itself is live and consenting.
    // Typed or tapped. The confirmation now carries a button, and a tap arrives
    // as a callback id rather than the word — accepting only the text would
    // make the button we just drew do nothing.
    const text = this.router.normalise(row.body);
    const tappedStart =
      decodeControl(decodeCallback(row.callbackId ?? '')?.actionKey ?? '') === 'start';
    if (
      identity?.status === IDENTITY_STATUS.PENDING &&
      (tappedStart || /^(start|begin|subscribe)$/.test(text))
    ) {
      await this.prisma.whatsAppIdentity.update({
        where: { id: identity.id },
        data: {
          status: IDENTITY_STATUS.ACTIVE,
          handsetOptInAt: new Date(),
          remoteJid: session.remoteJid,
          optedIn: true,
          optedInAt: new Date(),
        },
      });
      void this.audit.log({
        userId: identity.userId,
        action: 'WHATSAPP_ENROLLED',
        resourceType: 'WhatsAppIdentity',
        resourceId: identity.id,
        newData: { phone: maskPhone(identity.phoneE164) },
      });
      // Not the menu itself: building one needs a principal, and this path runs
      // before any identity was ACTIVE enough to have one. The next message
      // gets the full welcome anyway, because `lastSeenAt` is still null — so
      // this only has to carry the words that get somebody started.
      await this.composer.send(session, {
        plain: lines(
          bold('✅ You are all set'),
          'You can now use HR services here.',
          '',
          `Reply ${bold('MENU')} for everything, or ${bold('HELP')} for how this works.`,
        ),
      });
      return;
    }

    // Nobody has linked this number yet — but HR may already have it on the
    // employee record, which is what an admin means when they "add the number
    // to the account". Offer the link instead of stonewalling.
    if (!identity && cfg.enrollmentEnabled) {
      const match = await this.matchEmployeeByPhone(row.phoneE164!, cfg);
      if (match) {
        await this.offerSelfLink(session, row.phoneE164!, match, cfg);
        return;
      }
    }

    // The hourly cap exists so an unknown number cannot be used to pump
    // messages at a stranger. Its cost is that the SECOND message from an
    // unrecognised number gets no reply at all — which reads from the outside
    // as "the chatbot is down", and left no trace in the log to say otherwise.
    // That silence is now explicit.
    if (this.rates.allowUnknownReply(row.phoneE164!)) {
      this.logger.log(
        `[WA IN] ${maskPhone(row.phoneE164)} is not linked to any employee ` +
          `(identity ${identity?.status ?? 'none'}) — sending the "not recognised" reply.`,
      );
      await this.composer.send(session, this.composer.genericUnknownReply(cfg.appBaseUrl));
    } else {
      this.logger.log(
        `[WA IN] ${maskPhone(row.phoneE164)} is not linked to any employee ` +
          `(identity ${identity?.status ?? 'none'}) — reply SUPPRESSED, already answered ` +
          'this number within the last hour. This is the cap, not a failure. ' +
          'Linking a number requires opt-in from the portal; setting the phone ' +
          'field on the employee record does not create a WhatsApp identity.',
      );
    }
  }

  /**
   * Find the employee whose phone on file IS this number.
   *
   * Why this is not a plain `where: { phone }` lookup: `Employee.phone` is
   * free-text HR data — "+91-99529-82836", "9952982836", "0995 298 2836" are
   * all the same person and none of them equal the E.164 the webhook gives us.
   * So the query narrows on digits in SQL, and each candidate is then parsed
   * properly against its own region chain (the employee's phone country, then
   * their branch's, then the global default).
   *
   * Returns null unless EXACTLY ONE active employee with a live account
   * matches. Two employees sharing a number is a data-entry mistake, and
   * guessing between them would hand one person's HR record to the other.
   */
  private async matchEmployeeByPhone(
    phoneE164: string,
    cfg: WhatsAppResolvedConfig,
  ): Promise<{ userId: string; employeeId: string; fullName: string } | null> {
    // Last 8 digits: long enough to be selective, short enough to survive any
    // national-vs-international prefix the number was typed with.
    const digits = phoneE164.replace(/\D/g, '');
    const tail = digits.slice(-8);
    if (tail.length < 8) return null;

    type Candidate = {
      employeeId: string;
      fullName: string;
      phone: string | null;
      phoneCountryCode: string | null;
      branchCountry: string | null;
      userId: string | null;
    };

    const candidates: Candidate[] = await runWithBranchBypass(() =>
      // Raw because the comparison has to strip separators from the STORED
      // value; Prisma cannot express that. Parameterised, never interpolated.
      this.prisma.$queryRaw<Candidate[]>`
        SELECT e.id            AS "employeeId",
               e.full_name     AS "fullName",
               e.phone         AS "phone",
               e.phone_country_code AS "phoneCountryCode",
               b.country       AS "branchCountry",
               u.id            AS "userId"
        FROM employees e
        LEFT JOIN branches b ON b.id = e.branch_id
        LEFT JOIN users u ON u.employee_id = e.id AND u.is_active = true
        WHERE e.status = 'ACTIVE'
          AND e.phone IS NOT NULL
          AND regexp_replace(e.phone, '\\D', '', 'g') LIKE ${'%' + tail}
        LIMIT 25
      `,
    ).catch((e): Candidate[] => {
      this.logger.error(`Employee phone lookup failed: ${(e as Error).message}`);
      return [];
    });

    // The digit prefilter can over-match across country codes, so confirm each
    // candidate by parsing it the same way every other part of the system does.
    const exact = candidates.filter(
      (c) =>
        toE164(c.phone, firstRegion(c.phoneCountryCode, c.branchCountry, cfg.defaultRegion)) ===
        phoneE164,
    );

    if (exact.length > 1) {
      this.logger.warn(
        `[WA IN] ${maskPhone(phoneE164)} is on file for ${exact.length} employees ` +
          `(${exact.map((c) => c.employeeId).join(', ')}) — refusing to guess. ` +
          'Remove the duplicate phone number.',
      );
      return null;
    }

    const hit = exact[0];
    if (!hit) return null;
    if (!hit.userId) {
      this.logger.warn(
        `[WA IN] ${maskPhone(phoneE164)} matches employee ${hit.fullName} but they have no ` +
          'active portal account, so there is nothing to link to.',
      );
      return null;
    }
    return { userId: hit.userId, employeeId: hit.employeeId, fullName: hit.fullName };
  }

  /**
   * Create a PENDING identity and ask the handset to confirm it.
   *
   * PENDING, not ACTIVE: a number on an HR record is unverified data. It may be
   * a typo, or a number that has since been reassigned to a stranger — and the
   * reply to "who am I?" is somebody's leave balance and payslip. Requiring one
   * word back from the handset proves whoever holds it is the person asking,
   * which is the same bar the portal's own enrolment uses. The existing
   * PENDING + START path (above) completes the link.
   */
  private async offerSelfLink(
    session: SessionRow,
    phoneE164: string,
    match: { userId: string; employeeId: string; fullName: string },
    cfg: WhatsAppResolvedConfig,
  ): Promise<void> {
    try {
      await runWithBranchBypass(() =>
        this.prisma.whatsAppIdentity.create({
          data: {
            userId: match.userId,
            phoneE164,
            source: IDENTITY_SOURCE.EMPLOYEE_PHONE,
            status: IDENTITY_STATUS.PENDING,
            // Neither is true yet. START is what sets them.
            optedIn: false,
            verified: false,
            remoteJid: session.remoteJid,
          },
        }),
      );
    } catch (e) {
      // Unique on phoneE164: a racing message from the same handset already
      // created it. That is success for our purposes, so fall through to the
      // same prompt rather than going silent.
      this.logger.debug(`Pending identity already present for ${maskPhone(phoneE164)}.`);
    }

    void this.audit.log({
      userId: match.userId,
      action: 'WHATSAPP_LINK_OFFERED',
      resourceType: 'WhatsAppIdentity',
      newData: { phone: maskPhone(phoneE164), employeeId: match.employeeId },
    });

    this.logger.log(
      `[WA IN] ${maskPhone(phoneE164)} is on file for ${match.fullName} — created a PENDING ` +
        'identity and asked them to confirm with START.',
    );

    const firstName = match.fullName.trim().split(/\s+/)[0] || match.fullName;
    await this.composer.send(session, {
      plain: lines(
        bold(`👋 Hello ${escapeWa(firstName)}`),
        '',
        'This number is on your employee record, but it has not been linked for HR updates yet.',
        '',
        `Reply ${bold('START')} to link it and use HR services here.`,
        '',
        italic('If you are not expecting this, ignore this message and nothing will be linked.'),
      ),
      buttons: {
        title: 'Link this number?',
        description: 'Confirm that this handset belongs to you.',
        items: [replyBtn('START', encodeControl('start'))],
      },
    });
  }

  // ================================================================ routing

  private async route(
    cfg: any,
    session: SessionRow,
    row: any,
    user: HrmPrincipal,
    identity: any,
  ): Promise<void> {
    const renderCtx = await this.renderCtx(user, cfg);

    // A timed-out flow is cleared before routing, so the next message starts
    // fresh instead of being read as an answer to a forgotten question.
    if (await this.sessions.expireFlowIfStale(session)) {
      await this.composer.send(session, {
        plain: 'That took a while, so I cancelled the previous request. Reply MENU to start again.',
      });
      return;
    }

    let resolution = this.router.resolve(
      session,
      { kind: row.inputKind, text: row.body, callbackId: row.callbackId },
      Boolean(session.flowKey),
    );

    // A photo means "here is the proof you asked for" only while a challenge is
    // open. With none open, a CAPTIONED photo is just someone typing with a
    // picture attached — reading the caption is what makes "menu" written under
    // an image keep working, which is how images behaved before they had a kind
    // of their own. The lookup is here rather than in the router so that stays
    // pure and synchronous.
    if (resolution.type === 'face-proof' && row.body && !(await this.hasOpenChallenge(session))) {
      resolution = this.router.resolve(
        session,
        { kind: 'text', text: row.body, callbackId: null },
        false,
      );
    }

    // Anything we understood ends the run of confusion.
    if (resolution.type !== 'no-match') await this.sessions.clearUnknownStreak(session);

    switch (resolution.type) {
      case 'control':
        await this.handleControl(resolution.verb, session, user, identity, cfg, renderCtx);
        return;

      case 'flow-input':
        await this.flows.feed(session, row, user, renderCtx, cfg);
        return;

      case 'action':
        await this.startAction(
          resolution.action,
          resolution.params,
          session,
          row,
          user,
          identity,
          cfg,
          renderCtx,
        );
        return;

      case 'face-proof':
        await this.handleFaceProof(session, row, user, cfg, renderCtx);
        return;

      case 'location-attachment':
        // A shared pin used to check people in. It no longer does: a pin is
        // wherever the sender drops it, while the secure link's page takes a
        // real fix from the device. Old habits get a kind redirection, with
        // Check in one tap away.
        await this.composer.send(session, {
          plain: lines(
            bold('Shared locations are not used any more'),
            'Tap Check in (or Check out) and I will send you a secure link that ' +
              'confirms your location automatically.',
          ),
          buttons: {
            title: 'Use the secure link instead',
            description: 'Shared location pins are no longer accepted.',
            items: [
              replyBtn('Check in', encodeCallback('attendance.checkin')),
              replyBtn('Check out', encodeCallback('attendance.checkout')),
            ],
          },
        });
        return;

      case 'no-match':
      default:
        await this.handleNoMatch(session, row, user, cfg, renderCtx, resolution as any);
    }
  }

  /**
   * The one-time hello.
   *
   * Kept short and concrete: what this is, the three things people actually do,
   * and the two words that get them unstuck. A PIN nudge only when the channel
   * will actually ask for one, because telling somebody to set a PIN they will
   * never be prompted for is noise.
   */
  private buildWelcome(cfg: any): WaOutbound {
    return {
      plain: lines(
        bold('👋 Hello from HR'),
        'You can do a lot of your HR admin right here — check in, book leave, ' +
          'look up your payslips.',
        '',
        `Reply ${bold('MENU')} for everything, or ${bold('HELP')} for how this works.`,
        `Reply ${bold('STOP')} at any time to switch these messages off.`,
        cfg.requirePinForSensitive
          ? italic(`Pay details ask for a PIN. Set one at ${cfg.appBaseUrl}/dashboard/profile#notifications`)
          : '',
      ),
    };
  }

  /** Is a photo currently expected from this chat? */
  private async hasOpenChallenge(session: SessionRow): Promise<boolean> {
    if (!session.identityId) return false;
    return Boolean(await this.proofs.findOpenChallenge('whatsapp', session.identityId));
  }

  /**
   * A photo arrived to answer an open challenge.
   *
   * On success the action's own renderer runs, so a verified check-in reads
   * exactly like an unverified one — the verification is a gate, not a
   * different feature.
   */
  private async handleFaceProof(
    session: SessionRow,
    row: any,
    user: HrmPrincipal,
    cfg: any,
    ctx: RenderCtx,
  ): Promise<void> {
    const result = await this.faceProofs.handle(session, user, row.waMessageId ?? '');

    if (result.completed) {
      const action = this.registry.getByKey(result.completed.actionKey);
      if (action) {
        await this.sendRendered(session, action, result.completed.payload, ctx, user, cfg);
        return;
      }
    }

    if (result.out.plain) await this.composer.send(session, result.out);
  }

  private async handleControl(
    verb: string,
    session: SessionRow,
    user: HrmPrincipal,
    identity: any,
    cfg: any,
    ctx: RenderCtx,
  ): Promise<void> {
    switch (verb) {
      case 'cancel':
        await this.sessions.clearFlow(session);
        await this.expirePending(session.id);
        await this.composer.send(session, { plain: 'Cancelled. Reply MENU for options.' });
        return;

      case 'back':
        await this.flows.stepBack(session, ctx);
        return;

      case 'menu':
        await this.composer.send(session, this.buildMenu(user, cfg));
        return;

      case 'greeting': {
        // Say hello back, then show the menu — in ONE message, because a
        // greeting followed by a separate menu is two notifications for one
        // "hi", and the menu is the useful half.
        const menu = this.buildMenu(user, cfg);
        const name = ctx.recipientName?.split(' ')[0] ?? '';
        await this.composer.send(session, {
          ...menu,
          plain: lines(bold(`👋 Hello${name ? ` ${escapeWa(name)}` : ''}`), '', menu.plain),
        });
        return;
      }

      case 'menu_all':
        await this.composer.send(session, this.buildMenuText(user, cfg));
        return;

      case 'help':
        await this.composer.send(session, this.buildHelp(user, cfg));
        return;

      case 'stop':
        await this.prisma.whatsAppIdentity.update({
          where: { id: identity.id },
          data: { optedIn: false, optedOutAt: new Date(), status: IDENTITY_STATUS.REVOKED },
        });
        await this.composer.send(session, {
          plain: 'You will not receive further HR messages here. Re-link from the HR portal to resume.',
        });
        return;

      case 'start':
        // The menu itself, not an instruction to ask for it. One extra send,
        // and it removes the only step between "hello" and doing something.
        await this.composer.send(session, this.buildMenu(user, cfg));
        return;

      case 'yes':
        await this.confirmPending(session, user, ctx, cfg, true);
        return;

      case 'no':
        await this.confirmPending(session, user, ctx, cfg, false);
        return;
    }
  }

  private async handleNoMatch(
    session: SessionRow,
    row: any,
    user: HrmPrincipal,
    cfg: any,
    ctx: RenderCtx,
    resolution: { text: string },
  ): Promise<void> {
    // The one and only place the future AI layer is reachable. Never a retry
    // for a failed action, never inside a flow, never for a callback id.
    if (cfg.aiFallbackEnabled) {
      const handled = await this.ai
        .handle(
          {
            user,
            session: { id: session.id, remoteJid: session.remoteJid, identityId: session.identityId },
            text: resolution.text,
            correlationId: row.id,
          },
          (out) => this.composer.send(session, out).then(() => undefined),
          async () => undefined,
        )
        .catch(() => false);
      if (handled) return;
    }

    // Never echo the unrecognised text back: it is attacker-controlled and
    // would reflect straight into a chat and the log.
    const streak = await this.sessions.noteUnknown(session);
    await this.composer.send(session, this.buildUnknown(user, cfg, streak));
  }

  // ================================================================ actions

  private async startAction(
    action: WhatsAppActionDef,
    params: Record<string, string>,
    session: SessionRow,
    row: any,
    user: HrmPrincipal,
    identity: any,
    cfg: any,
    ctx: RenderCtx,
  ): Promise<void> {
    // Recorded before every gate, so the conversation log shows what the user
    // asked for even when a PIN prompt, a role check or a policy declines it —
    // "why did nothing happen?" is the question this column exists to answer.
    await this.prisma.whatsAppInboundMessage
      .update({ where: { id: row.id }, data: { resolvedActionKey: action.key } })
      .catch(() => undefined);

    // Hot kill switch, no deploy required.
    if (cfg.actionDenylist.includes(action.key)) {
      await this.composer.send(session, { plain: 'That is not available here right now.' });
      return;
    }

    if (APPROVAL_ACTION_KEYS.has(action.key) && !cfg.approvalsEnabled) {
      await this.composer.send(session, {
        plain: 'Approvals are handled in the HR portal.',
      });
      return;
    }

    if (!action.roles.includes(user.role as any)) {
      await this.composer.send(session, { plain: 'You do not have access to that.' });
      return;
    }
    if (action.requiresEmployee && !user.employeeId) {
      await this.composer.send(session, {
        plain: 'Your account is not linked to an employee record.',
      });
      return;
    }

    const isWrite = action.confirmPolicy !== 'none';
    if (isWrite && !cfg.mutationsEnabled) {
      await this.composer.send(session, {
        plain: 'Requests and updates are not available here yet — please use the HR portal.',
      });
      return;
    }
    if (
      isWrite &&
      !this.rates.allow(`mut:${user.id}`, cfg.rateMutations10Min, 10 * 60_000)
    ) {
      // Reaching this is now a sign the ceiling is set too low, not that the
      // employee did anything wrong — so it is logged for the admin as well as
      // answered on the handset.
      this.logger.warn(
        `[WA IN] user ${user.id} hit the change ceiling ` +
          `(${cfg.rateMutations10Min} per 10 minutes). Raise or clear it under ` +
          'WhatsApp settings if staff are hitting it in normal use.',
      );
      await this.composer.send(session, {
        plain: 'That is a lot of changes at once. Please try again in a few minutes.',
      });
      return;
    }

    // Step-up for anything showing pay or balances.
    if (
      action.sensitivity === 'sensitive' &&
      cfg.requirePinForSensitive &&
      !this.sessions.isPinFresh(session, cfg.pinTtlMinutes)
    ) {
      await this.requirePin(session, action, identity, ctx);
      return;
    }

    // A policy the channel cannot satisfy should read as guidance, not as a
    // domain exception surfaced verbatim.
    if (action.preflight) {
      const getSetting = (key: string, fallback = '') =>
        this.prisma.systemSetting
          .findUnique({ where: { key } })
          .then((r) => r?.value ?? fallback)
          .catch(() => fallback);

      const geofenceRequired = await this.geofenceRequired(user);
      // The SAME resolver AttendancesService reads through, so the preflight
      // cannot promise something the service then refuses. The actor channel
      // comes from AsyncLocalStorage, which runAs() has already set.
      const verificationMode = await resolveVerificationMode(
        getSetting,
        purposeOf(action.key),
      );

      // Set when a prompt mints a secure link, so the refusal message can
      // carry it as a tappable CTA button rather than a bare pasted URL.
      let verifyUrl: string | null = null;
      let verifyLabel = 'Verify & continue';

      const refusal = await action.preflight({
        getSetting,
        hasEmployee: Boolean(user.employeeId),
        geofenceRequired,
        verificationMode,
        faceProofPrompt: async () => {
          const minted = await this.mintVerificationPrompt(session, user, action, cfg, {
            requireFace: true,
            requireLocation: geofenceRequired,
            mode: effectiveMode(verificationMode, geofenceRequired),
          });
          if (minted.url) {
            verifyUrl = minted.url;
            verifyLabel = geofenceRequired ? 'Verify face & location' : 'Verify face';
          }
          return minted.text;
        },
        timeZone: await this.timeZoneFor(user),
        todayStatus: async () => {
          // Only shapes a message, so a failed read must not block the action.
          try {
            const payload = await this.caller.call(user, 'attendance_today_status', {});
            if (payload?.error) return null;
            return (payload?.data ?? payload) ?? null;
          } catch {
            return null;
          }
        },
        // A secure link, never a WhatsApp location attachment. The page asks
        // the browser for a real GPS fix — an attachment can be any pin the
        // sender chooses, including a place they are not.
        locationPrompt: async () => {
          const minted = await this.mintVerificationPrompt(session, user, action, cfg, {
            requireFace: false,
            requireLocation: true,
            mode: VERIFICATION_MODE.SECURE_LINK,
          });
          if (minted.url) {
            verifyUrl = minted.url;
            verifyLabel = purposeOf(action.key) === 'CHECKOUT' ? 'Check out here' : 'Check in here';
          }
          return minted.text;
        },
      });
      if (refusal) {
        await this.composer.send(
          session,
          verifyUrl
            ? {
                plain: refusal,
                // One url button, alone: Evolution refuses a message that
                // mixes reply and CTA buttons, and the link IS the action.
                // `plain` repeats the URL, so the text fallback stays whole.
                buttons: {
                  title: verifyLabel,
                  description: refusal.slice(0, 900),
                  items: [{ kind: 'url', label: verifyLabel, url: verifyUrl }],
                },
              }
            : { plain: refusal },
        );
        return;
      }
    }

    // Approvals get their arguments from a server-side token, never the wire.
    // Static args only. Server-derived ones (dynamicArgs) are applied inside
    // execute(), because execute is reached through three doors — a routed
    // message, a completed flow, and a PIN resume — and the PIN resume rebuilds
    // its arguments from staticArgs alone. One choke point, or a PIN-gated
    // action loses its derived year on exactly one of the three paths.
    let baseArgs: Record<string, unknown> = { ...(action.tool?.staticArgs ?? {}) };
    if (action.needsActionToken) {
      const token = params.t;
      if (!token) {
        await this.composer.send(session, { plain: 'That link is no longer valid.' });
        return;
      }
      const consumed = await this.tokens.consume(
        token,
        { identityId: session.identityId, userId: session.userId },
        row.id,
      );
      if (!consumed.ok) {
        if (consumed.reason === 'replay') {
          void this.audit.log({
            userId: user.id,
            action: 'WHATSAPP_ACTION_TOKEN_REUSE',
            resourceType: 'WhatsAppActionToken',
            newData: { actionKey: action.key },
          });
        }
        // Three of the four reasons get their own message; `unknown` and
        // `wrong-identity` deliberately share one, because telling those apart
        // would make this an oracle for whether a token exists and whose it is.
        //
        // `replay` is safe to name: only the bound identity reaches this branch
        // at all, so it is telling the approver about their own earlier tap.
        const plain =
          consumed.reason === 'expired'
            ? lines(
                'That approval link has expired.',
                `Open the portal to decide: ${cfg.appBaseUrl}/dashboard`,
              )
            : consumed.reason === 'replay'
              ? 'That was already decided.'
              : 'That link is no longer valid.';
        await this.composer.send(session, { plain });
        return;
      }
      baseArgs = { ...baseArgs, ...consumed.args };
    }

    // Multi-step actions collect their arguments first.
    if (action.flow) {
      await this.flows.start(session, action, baseArgs, ctx, cfg);
      return;
    }

    await this.execute(action, baseArgs, session, user, cfg, ctx, params);
  }

  /**
   * Run the tool, applying the confirm policy.
   *
   * `explicit` is the default and costs one extra round trip: the first call
   * returns the tool's own preview envelope, which means the user approves
   * exactly what will happen — and every domain validation (leave balance,
   * overlapping dates) has already run before they are asked.
   */
  async execute(
    action: WhatsAppActionDef,
    args: Record<string, unknown>,
    session: SessionRow,
    user: HrmPrincipal,
    // Typed, not `any`, and deliberately so: this signature once swapped cfg
    // and ctx, every caller kept the old order, and the compiler said nothing
    // because both slots accepted anything. With a real type here, a RenderCtx
    // passed as the config is a compile error instead of a phone mystery.
    cfg: WhatsAppResolvedConfig,
    ctx: RenderCtx,
    params: Record<string, string> = {},
  ): Promise<void> {
    // Navigation and other stateless surfaces answer from what the caller can
    // already see, without a tool call. The visible catalogue is passed in
    // rather than looked up inside the renderer, so a sub-menu is filtered by
    // exactly the same rules as the main one.
    if (action.localRender) {
      const out = action.localRender({
        ...ctx,
        args,
        params,
        visibleActions: this.visibleFor(user, cfg),
      });
      await this.composer.send(session, out);
      return;
    }

    if (!action.tool) return;

    // Server-derived arguments — the current year, the caller's own employee
    // id. Applied here so every path into execute gets them, including the PIN
    // resume that carries nothing but staticArgs. Explicit args win on
    // collision: derived values fill gaps, they never override.
    const fullArgs: Record<string, unknown> = {
      ...(action.tool.dynamicArgs?.(ctx) ?? {}),
      ...args,
    };

    const confirmNow = action.confirmPolicy !== 'explicit';
    const payload = await this.caller.call(user, action.tool.name, {
      ...fullArgs,
      ...(confirmNow && action.confirmPolicy === 'implicit' ? { confirm: true } : {}),
    });

    if (payload?.error) {
      await this.composer.send(session, this.composer.renderToolError(payload, session.id));
      return;
    }

    if (payload?.requiresConfirmation) {
      await this.pend(action, fullArgs, payload, session, user, cfg);
      return;
    }

    await this.sendRendered(session, action, payload, { ...ctx, args: fullArgs }, user, cfg);
  }

  /**
   * Render, then offer what usually comes next.
   *
   * Both places an action's result reaches the user go through here, so a
   * follow-up cannot exist on one path and not the other.
   */
  private async sendRendered(
    session: SessionRow,
    action: WhatsAppActionDef,
    payload: any,
    ctx: RenderCtx,
    user: HrmPrincipal,
    cfg: any,
  ): Promise<void> {
    const out = action.render(payload, ctx);
    const visible = new Set(this.visibleFor(user, cfg).map((a) => a.key));
    await this.composer.send(session, withNextSteps(out, action, payload, ctx, visible));
  }

  private async pend(
    action: WhatsAppActionDef,
    args: Record<string, unknown>,
    envelope: any,
    session: SessionRow,
    user: HrmPrincipal,
    cfg: any,
  ): Promise<void> {
    await this.expirePending(session.id);
    await this.prisma.whatsAppPendingAction.create({
      data: {
        sessionId: session.id,
        userId: user.id,
        identityId: session.identityId!,
        actionKey: action.key,
        toolName: action.tool!.name,
        argsJson: args as any,
        previewJson: envelope?.preview ?? null,
        expiresAt: new Date(Date.now() + cfg.pendingActionTtlMinutes * 60_000),
      },
    });

    const summary = summarise(envelope.preview);
    await this.composer.send(session, {
      plain: lines(
        bold(envelope.action ?? 'Please confirm'),
        envelope.description ? String(envelope.description) : '',
        rule(),
        summary,
        rule(),
        `Reply ${bold('YES')} to confirm or ${bold('NO')} to cancel.`,
      ),
      // The highest-value tap in the whole channel: two options, and getting it
      // wrong is expensive. `plain` above still works if buttons do not render.
      buttons: {
        title: String(envelope.action ?? 'Please confirm'),
        description: lines(summary, '', 'Confirm this?'),
        footer: 'HR portal',
        items: [
          replyBtn('Yes, confirm', encodeControl('yes')),
          replyBtn('Cancel', encodeControl('no')),
        ],
      },
    });
  }

  private async confirmPending(
    session: SessionRow,
    user: HrmPrincipal,
    ctx: RenderCtx,
    cfg: any,
    accept: boolean,
  ): Promise<void> {
    const pending = await this.prisma.whatsAppPendingAction.findFirst({
      where: { sessionId: session.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) {
      await this.composer.send(session, {
        plain: 'There is nothing waiting for confirmation. Reply MENU for options.',
      });
      return;
    }

    // Atomic CAS: a double "yes" executes exactly once.
    const claimed = await this.prisma.whatsAppPendingAction.updateMany({
      where: { id: pending.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      data: { status: accept ? 'CONFIRMED' : 'REJECTED', resolvedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.composer.send(session, { plain: 'That was already handled.' });
      return;
    }

    void this.audit.log({
      userId: user.id,
      action: accept ? 'WHATSAPP_ACTION_CONFIRMED' : 'WHATSAPP_ACTION_REJECTED',
      resourceType: 'WhatsAppAction',
      resourceId: pending.id,
      newData: { actionKey: pending.actionKey, tool: pending.toolName },
    });

    if (!accept) {
      await this.composer.send(session, { plain: 'Cancelled — nothing was changed.' });
      return;
    }

    const action = this.registry.getByKey(pending.actionKey);
    if (!action) {
      await this.composer.send(session, { plain: 'That action is no longer available.' });
      return;
    }

    // Re-call with the SERVER-SIDE arguments plus confirm. The reply text
    // supplies nothing but the word "yes".
    const args = (pending.argsJson ?? {}) as Record<string, unknown>;
    const payload = await this.caller.call(user, pending.toolName, { ...args, confirm: true });

    await this.prisma.whatsAppPendingAction
      .update({ where: { id: pending.id }, data: { resultJson: payload ?? undefined } })
      .catch(() => undefined);

    if (payload?.error) {
      await this.composer.send(session, this.composer.renderToolError(payload, session.id));
      return;
    }
    if (payload?.requiresConfirmation) {
      // Should not happen; surfacing it beats silently doing nothing.
      await this.composer.send(session, { plain: 'That could not be completed. Please use the portal.' });
      return;
    }
    await this.sendRendered(session, action, payload, { ...ctx, args }, user, cfg);
  }

  // ==================================================================== pin

  private async requirePin(
    session: SessionRow,
    action: WhatsAppActionDef,
    identity: any,
    ctx: RenderCtx,
  ): Promise<void> {
    if (!identity.pinHash) {
      // Never silently fall back to no-PIN: that would make the setting a lie.
      await this.composer.send(session, {
        plain: lines(
          bold('A PIN is needed'),
          'Set a WhatsApp PIN in the HR portal (Profile → WhatsApp) before viewing pay details here.',
        ),
      });
      return;
    }
    await this.flows.startPin(session, action, ctx);
  }

  // ================================================================= menus

  /**
   * The actions this caller may see, with every kill switch already applied.
   *
   * One definition, used by the menu, by locally-rendered sub-menus and by the
   * next-step filter — so a section or a follow-up button can never offer
   * something the main menu deliberately hides.
   */
  visibleFor(user: HrmPrincipal, cfg: WhatsAppResolvedConfig): WhatsAppActionDef[] {
    const disabled = new Set<string>(cfg.actionDenylist);
    if (!cfg.approvalsEnabled) for (const k of APPROVAL_ACTION_KEYS) disabled.add(k);
    if (!cfg.mutationsEnabled) {
      for (const a of this.registry.getAll()) {
        if (a.confirmPolicy !== 'none') disabled.add(a.key);
      }
    }
    return this.registry.visibleFor(user.role, Boolean(user.employeeId), disabled);
  }

  buildMenu(user: HrmPrincipal, cfg: any): WaOutbound {
    const actions = this.visibleFor(user, cfg);
    const built = buildMainMenu(actions, {
      title: 'HR services',
      description: 'Everything you can do here. Tap one, or reply with its number.',
      buttonText: 'Open menu',
      footerText: 'HR portal',
    });

    return { plain: built.plain, menu: built.menu, list: built.list };
  }

  /**
   * The full numbered list, with no tappable surface.
   *
   * Reached from the "Everything" row of the group picker, so it must NOT
   * offer a list of its own — that row exists precisely for someone who wants
   * the flat text.
   */
  private buildMenuText(user: HrmPrincipal, cfg: any): WaOutbound {
    const { list: _list, ...rest } = this.buildMenu(user, cfg);
    return rest;
  }

  /**
   * What this channel can do, and the words that steer it.
   *
   * Deliberately separate from `buildUnknown`. Both used to be this one method,
   * so typing HELP answered with "I did not understand that" — accusing someone
   * of a typo for asking a perfectly well-formed question.
   *
   * The vocabulary block is the part that actually earns its place: MENU,
   * CANCEL, BACK and STOP are undiscoverable otherwise.
   */
  private buildHelp(user: HrmPrincipal, cfg: any): WaOutbound {
    const menu = this.buildMenu(user, cfg);
    const vocabulary = lines(
      bold('Useful words'),
      `• ${bold('MENU')} — everything you can do`,
      `• ${bold('CANCEL')} — stop what we are in the middle of`,
      `• ${bold('BACK')} — go back one question`,
      `• ${bold('STOP')} — stop receiving messages here`,
      cfg.requirePinForSensitive
        ? `• Pay and loan details ask for your ${bold('PIN')} first. Set one in the HR portal.`
        : '',
    );

    return {
      plain: lines(
        bold('👋 Here is what I can do'),
        '',
        menu.plain,
        '',
        vocabulary,
      ),
      menu: menu.menu,
      list: menu.list,
    };
  }

  /**
   * The reply to something we could not route. Guesses, never certainty.
   */
  private buildUnknown(user: HrmPrincipal, cfg: any, streak = 0): WaOutbound {
    const menu = this.buildMenu(user, cfg);
    const top = (menu.menu ?? []).slice(0, 6);

    // Repeating the same three guesses at somebody who is clearly stuck is the
    // most irritating thing a bot can do, so a run of them escalates instead.
    const stuck = streak >= 3;
    const escalation = stuck
      ? lines(
          '',
          italic(
            cfg.supportContact
              ? `Still stuck? Contact ${escapeWa(cfg.supportContact)}.`
              : `Still stuck? Everything is also in the portal: ${cfg.appBaseUrl}/dashboard`,
          ),
        )
      : streak === 2
        ? lines('', italic(`Everything is also in the portal: ${cfg.appBaseUrl}/dashboard`))
        : '';

    const out = outbound(
      lines(
        bold('I did not understand that'),
        stuck ? '' : 'You can try:',
        stuck ? '' : renderMenu(top),
        '',
        italic('Reply MENU for everything, or HELP for how this works.'),
        escalation,
      ),
      stuck ? [] : top,
    );
    // Three taps for the most likely intents; the numbered list above still
    // covers the rest, and both resolve through the same session menu.
    return {
      ...out,
      buttons: top.length
        ? {
            title: 'I did not understand that',
            description: 'Did you mean one of these?',
            footer: 'Reply MENU for everything',
            items: top
              .slice(0, 3)
              .map((o) => replyBtn(o.label, encodeCallback(o.actionKey, o.params ?? {}))),
          }
        : undefined,
    };
  }

  // =============================================================== helpers

  private async renderCtx(user: HrmPrincipal, cfg: any): Promise<RenderCtx> {
    const employee = user.employeeId
      ? await this.prisma.employee.findUnique({
          where: { id: user.employeeId },
          select: { fullName: true, timezone: true },
        })
      : null;
    const symbol = await this.prisma.systemSetting
      .findUnique({ where: { key: 'payroll_currency_symbol' } })
      .then((r) => r?.value ?? '')
      .catch(() => '');
    return {
      recipientName: employee?.fullName ?? user.email ?? '',
      employeeId: user.employeeId ?? null,
      appBaseUrl: cfg.appBaseUrl,
      currencySymbol: symbol,
      timeZone: await this.tzSvc.getEffectiveTZ(employee?.timezone ?? null),
      args: {},
    };
  }

  /**
   * Mint the one-time capability for a punch that needs proof, and say how to
   * provide it.
   *
   * The default and preferred shape is a SECURE LINK: one page asks the browser
   * for the camera and a real GPS fix, collects both in a single submit, and
   * the punch completes server-side. A WhatsApp location attachment is never
   * requested any more — an attachment is any pin the sender chooses, including
   * a place they are not standing, while the page's fix comes from the device.
   *
   * The in-chat selfie challenge survives only for the SELFIE_IN_CHAT mode
   * with no geofence, where there is genuinely nothing for a page to add.
   */
  private async mintVerificationPrompt(
    session: SessionRow,
    user: HrmPrincipal,
    action: WhatsAppActionDef,
    cfg: WhatsAppResolvedConfig,
    opts: { requireFace: boolean; requireLocation: boolean; mode: VerificationMode },
  ): Promise<{ text: string; url: string | null }> {
    if (!user.employeeId || !session.identityId || !action.tool) {
      return { text: 'Attendance cannot be verified from here. Please use the HR app.', url: null };
    }

    const purpose = purposeOf(action.key);
    const doing = purpose === 'CHECKOUT' ? 'check out' : 'check in';
    const chatSelfie =
      opts.requireFace &&
      !opts.requireLocation &&
      opts.mode === VERIFICATION_MODE.SELFIE_IN_CHAT;

    // A cap on accepted selfies per day. Bounds the blast radius of the one
    // thing a photo cannot prove — that it was taken just now.
    if (opts.requireFace) {
      const used = await this.proofs.acceptedFaceProofsToday(user.employeeId);
      if (used >= cfg.selfieDailyCap) {
        return {
          text: lines(
            bold('Daily limit reached'),
            `You have verified by photo ${used} time(s) today. Please use the HR app.`,
          ),
          url: null,
        };
      }
    }

    const { token } = await this.proofs.issue({
      channel: 'whatsapp',
      deliveryMode: chatSelfie ? 'CHAT' : 'LINK',
      identityId: session.identityId,
      userId: user.id,
      employeeId: user.employeeId,
      purpose,
      requireLocation: opts.requireLocation,
      requireFace: opts.requireFace,
      actionKey: action.key,
      toolName: action.tool.name,
      ttlSeconds: chatSelfie ? cfg.selfieChallengeSeconds : cfg.verificationLinkTtlMinutes * 60,
    });

    if (chatSelfie) {
      return {
        text: lines(
          bold('📸 Send a selfie'),
          'Take a photo now and send it here to confirm it is you.',
          italic(`This request expires in ${Math.round(cfg.selfieChallengeSeconds / 60)} minute(s).`),
        ),
        url: null,
      };
    }

    // The API's own address, not the portal's: the page is served by the API so
    // that its calls are same-origin and need no configuration in the browser.
    // Falls back to the portal only when no API address has been set, which is
    // the pre-existing behaviour and still works for a single-host deployment.
    const verifyHost = (cfg.publicApiUrl || cfg.appBaseUrl).replace(/\/+$/, '');
    const url = `${verifyHost}/verify/${token}`;
    const asks =
      opts.requireFace && opts.requireLocation
        ? 'It will ask for your camera and your location, and then '
        : opts.requireFace
          ? 'It will ask for your camera, and then '
          : 'It will ask for your location, and then ';
    return {
      text: lines(
        bold(`🔐 One quick step to ${doing}`),
        `Tap the button below. ${asks}${doing.replace('check', 'check you')} automatically. ` +
          'You will get a confirmation here once it is done.',
        '',
        url,
        '',
        italic('The link works once and expires shortly.'),
      ),
      url,
    };
  }

  /**
   * The zone every date and time in a reply is rendered in.
   *
   * Attendance is stored as UTC instants, so without this a check-in at 20:26
   * in Chennai reads back as 14:56.
   */
  private async timeZoneFor(user: HrmPrincipal): Promise<string> {
    const employee = user.employeeId
      ? await this.prisma.employee
          .findUnique({ where: { id: user.employeeId }, select: { timezone: true } })
          .catch(() => null)
      : null;
    return this.tzSvc.getEffectiveTZ(employee?.timezone ?? null);
  }

  /**
   * Does this caller's branch enforce a check-in geofence?
   *
   * Read directly rather than through SystemSettingsModule: importing it here
   * would add an edge to a module graph that already had to be split once to
   * break a cycle. Same branch-column -> global -> default chain it uses.
   */
  private async geofenceRequired(user: HrmPrincipal): Promise<boolean> {
    if (!user.employeeId) return false;
    const employee = await this.prisma.employee.findUnique({
      where: { id: user.employeeId },
      select: { branch: { select: { geofencingEnabled: true, latitude: true, longitude: true } } },
    });
    const branch = employee?.branch;
    const enabled =
      branch?.geofencingEnabled != null
        ? branch.geofencingEnabled
        : (await this.prisma.systemSetting
            .findUnique({ where: { key: 'geofencing_enabled' } })
            .then((r) => r?.value === 'true')
            .catch(() => false));
    return Boolean(enabled);
  }

  private async expirePending(sessionId: string): Promise<void> {
    await this.prisma.whatsAppPendingAction
      .updateMany({
        where: { sessionId, status: 'PENDING' },
        data: { status: 'EXPIRED', resolvedAt: new Date() },
      })
      .catch(() => undefined);
  }

  private async finish(id: string, status: string, note?: string): Promise<void> {
    await this.prisma.whatsAppInboundMessage
      .update({
        where: { id },
        data: { status, processedAt: new Date(), lastError: note ?? null, nextRetryAt: null },
      })
      .catch(() => undefined);
  }
}

/** Pull coordinates back out of the stored (redacted) envelope. */
/** Flatten a preview envelope into a few readable lines. */
function summarise(preview: any): string {
  if (!preview || typeof preview !== 'object') return '';
  const out: string[] = [];
  for (const [k, v] of Object.entries(preview)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as any)) {
        if (v2 === null || v2 === undefined || v2 === '') continue;
        if (typeof v2 === 'object') continue;
        out.push(`${bold(`${humanise(k2)}:`)} ${String(v2)}`);
      }
      continue;
    }
    out.push(`${bold(`${humanise(k)}:`)} ${String(v)}`);
  }
  return out.slice(0, 12).join('\n');
}

function humanise(key: string): string {
  const s = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
