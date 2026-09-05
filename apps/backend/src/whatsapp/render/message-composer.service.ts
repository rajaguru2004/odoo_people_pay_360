import { Injectable, Logger } from '@nestjs/common';
import { EvolutionClient } from '../evolution/evolution.client';
import { WhatsAppSettingsService } from '../whatsapp-settings.service';
import { SessionRow, WhatsAppSessionService } from '../session/whatsapp-session.service';
import { WaButton, WaOutbound } from '../router/action.types';
import { EvolutionButton } from '../evolution/evolution.types';
import { SendResult, WhatsAppResolvedConfig } from '../whatsapp.types';
import { chunk, escapeWa, bold, lines, italic } from './wa-format';
import { WA_POLL } from './wa-limits';
import { jidToE164, maskPhone } from '../utils/phone.util';

/** The render layer's button vocabulary, in the wire's. */
function toEvolutionButton(b: WaButton): EvolutionButton {
  switch (b.kind) {
    case 'reply':
      return { type: 'reply', displayText: b.label, id: b.callbackId };
    case 'url':
      return { type: 'url', displayText: b.label, url: b.url };
    case 'copy':
      return { type: 'copy', displayText: b.label, copyCode: b.copyCode };
    case 'call':
      return { type: 'call', displayText: b.label, phoneNumber: b.phoneE164 };
  }
}

/** The tappable surfaces, each latched independently. */
export type WaSurfaceKind = 'list' | 'poll' | 'buttons';

/**
 * Sends a reply to one chat.
 *
 * Interactive where it works, text everywhere else. Re-probed against this
 * Evolution build after the button service was fixed: `sendList` now renders a
 * real `listMessage`, `sendButtons` renders as a nativeFlow `quick_reply`, and
 * both come back through the webhook with an id we put there.
 *
 * Three rules the ladder below exists to keep:
 *
 *  1. **At most one tappable surface per outbound.** Two would double the cost
 *     of every menu against a 1200 ms minimum send gap, for one choice.
 *  2. **A poll is never the fallback for a failed list.** A poll vote carries
 *     only the option TEXT and resolves by matching labels; a list row carries
 *     the action key and its parameters. Quietly swapping one for the other is
 *     a different security posture, not a fallback.
 *  3. **Latches are per surface.** One broken surface must not disable the
 *     others, which is exactly what a single shared counter would do.
 *
 * Every outbound carries a complete `plain` rendering, so a failed interactive
 * send degrades to text rather than to silence — and the session still
 * remembers the numbering, because people type "2" whether or not it rendered.
 */
@Injectable()
export class MessageComposerService {
  private readonly logger = new Logger(MessageComposerService.name);

  constructor(
    private readonly settings: WhatsAppSettingsService,
    private readonly evolution: EvolutionClient,
    private readonly sessions: WhatsAppSessionService,
  ) {}

  /**
   * Render and deliver. Persisting the menu is not optional: it is what makes a
   * numeric reply resolvable, and users type "2" whether or not buttons rendered.
   */
  async send(session: SessionRow, out: WaOutbound): Promise<boolean> {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) return false;

    // Persisted even for interactive sends: users type "2" instead of tapping,
    // and this is what makes that resolvable.
    if (out.menu?.length) {
      await this.sessions.rememberMenu(session, out.menu);
    }

    const to = jidToE164(session.remoteJid);
    if (!to) {
      this.logger.warn(`Cannot reply: ${session.remoteJid} is not a phone JID.`);
      return false;
    }

    this.evolution.setPacing(cfg.minGapMs, cfg.maxPerMinute);

    this.warnIfLinkOnlyInButtons(out);

    // What we are about to say, before we try to say it — so a reply that never
    // arrives can be told apart from a reply that was never composed.
    this.logger.log(
      `[WA OUT] reply to ${maskPhone(to)}` +
        (cfg.logMessageBodies
          ? ` text=${JSON.stringify((out.plain ?? '').slice(0, 160))}`
          : ` textLength=${(out.plain ?? '').length}`) +
        (out.menu?.length ? ` menu=${out.menu.length}` : ''),
    );

    for (const surface of this.ladder(cfg, out)) {
      if (!this.surfaceAllowed(surface)) continue;
      const res = await this.attempt(surface, cfg, to, out);
      if (res.ok) {
        this.clearFailures(surface);
        this.logger.log(`[WA OUT] delivered to ${maskPhone(to)} as ${surface}.`);
        return true;
      }
      // Falling down the ladder is normal, but a surface that always fails is
      // a misconfiguration (buttons need a Business account), and that was only
      // ever visible in aggregate.
      this.logger.warn(`[WA OUT] ${surface} refused for ${maskPhone(to)}: ${res.error}`);
      this.noteSurfaceFailure(surface, res.error);
    }

    const parts = chunk(out.plain);
    let ok = true;
    for (const [i, part] of parts.entries()) {
      const res = await this.evolution.sendText(cfg, {
        toE164: to,
        text: part,
        // Sequential with a small delay so multi-part replies arrive in order.
        delay: i === 0 ? undefined : 600,
      });
      if (!res.ok) {
        ok = false;
        this.logger.error(
          `[WA OUT] reply FAILED to ${maskPhone(to)} (part ${i + 1}/${parts.length}): ${res.error}`,
        );
        break;
      }
    }
    if (ok) {
      this.logger.log(
        `[WA OUT] delivered to ${maskPhone(to)} as text${parts.length > 1 ? ` (${parts.length} parts)` : ''}.`,
      );
    }
    return ok;
  }

  /**
   * Which surfaces to try, in order, for this outbound under this mode.
   *
   * At most two entries in practice, and often none — a plain confirmation with
   * no menu and no buttons goes straight to text without a wasted round trip.
   */
  private ladder(
    cfg: { interactiveMode: string },
    out: WaOutbound,
  ): WaSurfaceKind[] {
    if (cfg.interactiveMode === 'text') return [];

    const order: WaSurfaceKind[] = [];

    if (out.menu?.length && cfg.interactiveMode === 'poll' && out.menu.length <= WA_POLL.maxOptions) {
      order.push('poll');
    } else if (out.list?.sections.length && cfg.interactiveMode === 'auto') {
      order.push('list');
    }

    if (out.buttons?.items.length) order.push('buttons');
    return order;
  }

  private attempt(
    surface: WaSurfaceKind,
    cfg: WhatsAppResolvedConfig,
    to: string,
    out: WaOutbound,
  ): Promise<SendResult> {
    switch (surface) {
      case 'poll':
        return this.evolution.sendPoll(cfg, {
          toE164: to,
          name: out.pollTitle ?? 'Tap an option',
          options: (out.menu ?? []).map((o) => o.label),
        });
      case 'list':
        return this.evolution.sendList(cfg, {
          toE164: to,
          title: out.list!.title,
          description: out.list!.description,
          buttonText: out.list!.buttonText,
          footerText: out.list!.footerText,
          sections: out.list!.sections,
        });
      case 'buttons':
        return this.evolution.sendButtons(cfg, {
          toE164: to,
          title: out.buttons!.title,
          description: out.buttons!.description,
          footer: out.buttons!.footer,
          buttons: out.buttons!.items.map(toEvolutionButton),
        });
    }
  }

  /**
   * Per-surface failure latch.
   *
   * Keyed by surface deliberately: a shared counter meant a run of list
   * failures would take confirmations down with it, and a single successful
   * button send would clear a latch it knows nothing about.
   *
   * Process-local, so replicas latch independently. That was already true and
   * is fine — the cost of a wrong guess is one extra round trip.
   */
  private failures = new Map<WaSurfaceKind, { count: number; disabledUntil: number }>();

  private noteSurfaceFailure(surface: WaSurfaceKind, error?: string): void {
    const state = this.failures.get(surface) ?? { count: 0, disabledUntil: 0 };
    state.count++;
    this.logger.warn(
      `WhatsApp ${surface} send failed (${state.count}), falling through: ${error}`,
    );
    if (state.count >= 3) {
      state.disabledUntil = Date.now() + 30 * 60_000;
      this.logger.warn(`WhatsApp ${surface} messages disabled for 30 minutes.`);
    }
    this.failures.set(surface, state);
  }

  private clearFailures(surface: WaSurfaceKind): void {
    this.failures.delete(surface);
  }

  private surfaceAllowed(surface: WaSurfaceKind): boolean {
    return Date.now() >= (this.failures.get(surface)?.disabledUntil ?? 0);
  }

  /**
   * A url button carries no callback, so whatever it points at has to survive
   * the fallback to text. Non-production only, and a warning rather than a
   * throw: a lint rule must never be the reason a message is not delivered.
   */
  private warnIfLinkOnlyInButtons(out: WaOutbound): void {
    if (process.env.NODE_ENV === 'production') return;
    for (const item of out.buttons?.items ?? []) {
      if (item.kind === 'url' && !out.plain.includes(item.url)) {
        this.logger.warn(
          `Outbound offers a url button ("${item.label}") whose target is absent from the text fallback.`,
        );
      }
    }
  }

  /** Acknowledge and show typing. Cheap, and it makes the bot feel alive. */
  async ack(session: SessionRow, waMessageId: string): Promise<void> {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) return;
    const to = jidToE164(session.remoteJid);
    if (!to) return;
    await Promise.all([
      this.evolution.markRead(cfg, session.remoteJid, waMessageId).catch(() => undefined),
      this.evolution.sendPresence(cfg, to, 'composing').catch(() => undefined),
    ]);
  }

  /**
   * Tool errors become human sentences. Never a stack trace, never Prisma text,
   * and never the raw validation internals — the user cannot act on any of it.
   */
  renderToolError(payload: any, correlationId: string): WaOutbound {
    const err = payload?.error ?? {};
    const code = String(err.code ?? '');
    const status = Number(err.status ?? 0);

    // Every branch ends with somewhere to go. A dead end in a chat is worse
    // than a dead end on a page: there is no back button and no navigation,
    // so a bare error leaves the person with nothing to type.
    const out = (...parts: Array<string | false>) => ({
      plain: lines(...parts, italic('Reply MENU for options.')),
    });

    if (status === 403 || code === 'Forbidden') {
      return out('You do not have access to that.');
    }
    if (status === 404 || code === 'NotFound' || code === 'UnknownTool') {
      return out('I could not find that.');
    }
    if (code === 'ValidationError' || status === 400) {
      // Our own zod / domain text, safe and actionable.
      return out(escapeWa(err.message || 'That request was not valid.'));
    }
    this.logger.error(
      `WhatsApp tool error (${correlationId}): ${status} ${code} ${err.message ?? ''}`,
    );
    return out(
      'Something went wrong at our end.',
      italic(`Reference: ${correlationId.slice(0, 8)}`),
    );
  }

  /** The single generic reply for unknown / revoked / blocked / inactive. */
  genericUnknownReply(appBaseUrl?: string): WaOutbound {
    return {
      plain: lines(
        bold('Not recognised'),
        'This number is not set up for HR updates. If you are an employee, link your ' +
          'number from your profile in the HR portal.',
        // The same string in all four cases (unknown, revoked, blocked,
        // inactive), so this is still not an oracle — but a real employee can
        // now self-serve instead of being stonewalled.
        appBaseUrl ? `${appBaseUrl}/dashboard/profile#notifications` : '',
      ),
      // Deliberately no buttons: a tappable affordance implies a session, which
      // is exactly the signal being withheld here.
    };
  }
}
