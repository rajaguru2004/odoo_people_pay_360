import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { HrmPrincipal } from '../../mcp/tool.types';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageComposerService } from '../render/message-composer.service';
import { bold, italic, lines } from '../render/wa-format';
import { SessionRow, WhatsAppSessionService } from '../session/whatsapp-session.service';
import { ActionRegistryService } from './action-registry.service';
import { RenderCtx, WhatsAppActionDef } from './action.types';
import { WhatsAppInboundService } from '../inbound/whatsapp-inbound.service';

/** Slot key used by the PIN step-up pseudo-flow. */
const PIN_FLOW = '__pin__';
const PIN_RESUME_SLOT = '__resumeAction';
const BASE_ARGS_SLOT = '__baseArgs';

/**
 * Multi-step argument collection.
 *
 * Slots live on the session row rather than in memory so a restart does not
 * lose a half-finished leave application. Each step owns its own parse and
 * error message, because "that is not a date" is far more useful than a
 * validation failure surfaced three steps later by the tool.
 */
@Injectable()
export class FlowEngineService {
  private readonly logger = new Logger(FlowEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: WhatsAppSessionService,
    private readonly registry: ActionRegistryService,
    private readonly composer: MessageComposerService,
    // Circular by nature: the processor starts flows, and a completed flow runs
    // an action back through the processor.
    @Inject(forwardRef(() => WhatsAppInboundService))
    private readonly inbound: WhatsAppInboundService,
  ) {}

  async start(
    session: SessionRow,
    action: WhatsAppActionDef,
    baseArgs: Record<string, unknown>,
    ctx: RenderCtx,
    cfg: any,
  ): Promise<void> {
    const flow = action.flow!;
    await this.sessions.startFlow(session, action.key, flow.ttlMinutes ?? cfg.flowTtlMinutes);
    await this.sessions.patch(session, {
      slotsJson: { [BASE_ARGS_SLOT]: baseArgs },
    });
    await this.promptStep(session, action, 0, ctx);
  }

  /** PIN step-up, modelled as a one-step flow that resumes the original action. */
  async startPin(session: SessionRow, action: WhatsAppActionDef, ctx: RenderCtx): Promise<void> {
    await this.sessions.patch(session, {
      flowKey: PIN_FLOW,
      flowStep: 0,
      flowErrors: 0,
      slotsJson: { [PIN_RESUME_SLOT]: action.key },
      flowExpiresAt: new Date(Date.now() + 5 * 60_000),
    });
    await this.composer.send(session, {
      plain: lines(
        bold('🔒 PIN required'),
        'Reply with your 6-digit WhatsApp PIN to view this.',
        italic('Reply CANCEL to stop.'),
      ),
    });
  }

  /** Handle a message that is an answer to the current step. */
  async feed(
    session: SessionRow,
    row: { body: string | null; callbackId: string | null; inputKind: string; location?: any },
    user: HrmPrincipal,
    ctx: RenderCtx,
    cfg: any,
  ): Promise<void> {
    if (session.flowKey === PIN_FLOW) {
      await this.feedPin(session, row, user, ctx, cfg);
      return;
    }

    const action = this.registry.getByKey(session.flowKey!);
    if (!action?.flow) {
      await this.sessions.clearFlow(session);
      await this.composer.send(session, { plain: 'That request expired. Reply MENU to start again.' });
      return;
    }

    const flow = action.flow;
    const stepIndex = session.flowStep ?? 0;
    const step = flow.steps[stepIndex];
    if (!step) {
      await this.sessions.clearFlow(session);
      return;
    }

    const slots = (session.slotsJson ?? {}) as Record<string, unknown>;
    const parsed = step.parse(
      {
        kind: row.inputKind as any,
        text: row.body,
        callbackId: row.callbackId,
        location: row.location ?? null,
      },
      { slots, render: ctx },
    );

    if (!parsed.ok) {
      const errors = await this.sessions.noteFlowError(session);
      const max = flow.maxParseErrors ?? 3;
      if (errors >= max) {
        await this.sessions.clearFlow(session);
        await this.composer.send(session, {
          plain: lines(
            "Let's stop there for now.",
            italic('Reply MENU to start again, or use the HR portal.'),
          ),
        });
        return;
      }
      await this.composer.send(session, { plain: parsed.error });
      return;
    }

    slots[step.slot] = parsed.value;

    // Advance past any steps this answer makes irrelevant.
    let next = stepIndex + 1;
    while (next < flow.steps.length && flow.steps[next].skipIf?.(slots)) next++;

    await this.sessions.advanceFlow(session, next, slots, flow.ttlMinutes ?? cfg.flowTtlMinutes);

    if (next < flow.steps.length) {
      await this.promptStep(session, action, next, ctx);
      return;
    }

    // Collected. Hand back to the processor, which applies the confirm policy.
    const baseArgs = (slots[BASE_ARGS_SLOT] ?? {}) as Record<string, unknown>;
    const args = { ...baseArgs, ...flow.buildArgs(slots) };
    await this.sessions.clearFlow(session);
    await this.inbound.execute(action, args, session, user, cfg, ctx);
  }

  /** Re-ask the previous question. */
  async stepBack(session: SessionRow, ctx: RenderCtx): Promise<void> {
    if (!session.flowKey || session.flowKey === PIN_FLOW) {
      await this.composer.send(session, { plain: 'There is nothing to go back to.' });
      return;
    }
    const action = this.registry.getByKey(session.flowKey);
    if (!action?.flow) return;

    const prev = Math.max(0, (session.flowStep ?? 0) - 1);
    const slots = (session.slotsJson ?? {}) as Record<string, unknown>;
    delete slots[action.flow.steps[prev].slot];
    await this.sessions.patch(session, { flowStep: prev, slotsJson: slots, flowErrors: 0 });
    await this.promptStep(session, action, prev, ctx);
  }

  // ------------------------------------------------------------------- pin

  private async feedPin(
    session: SessionRow,
    row: { body: string | null },
    user: HrmPrincipal,
    ctx: RenderCtx,
    cfg: any,
  ): Promise<void> {
    const identity = session.identityId
      ? await this.prisma.whatsAppIdentity.findUnique({ where: { id: session.identityId } })
      : null;
    if (!identity?.pinHash) {
      await this.sessions.clearFlow(session);
      await this.composer.send(session, { plain: 'Set a PIN in the HR portal first.' });
      return;
    }

    if (identity.lockedUntil && identity.lockedUntil.getTime() > Date.now()) {
      await this.composer.send(session, {
        plain: 'Too many incorrect PINs. Try again later.',
      });
      return;
    }

    const candidate = (row.body ?? '').replace(/\D/g, '');
    const ok = candidate.length >= 4 && (await bcrypt.compare(candidate, identity.pinHash));

    if (!ok) {
      const failed = identity.failedPinCount + 1;
      const lock = failed >= 5;
      await this.prisma.whatsAppIdentity.update({
        where: { id: identity.id },
        data: {
          failedPinCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + 30 * 60_000) : null,
        },
      });
      if (lock) {
        await this.sessions.clearFlow(session);
        // Out-of-band alert: if the handset is compromised, the in-app
        // notification reaches a channel the attacker may not control.
        await this.prisma.notification
          .create({
            data: {
              userId: identity.userId,
              title: 'WhatsApp PIN locked',
              message:
                'Too many incorrect PIN attempts on your linked WhatsApp number. If this was not you, unlink it from your profile.',
              type: 'WARNING',
              link: '/dashboard/profile#notifications',
            },
          })
          .catch(() => undefined);
        await this.composer.send(session, {
          plain: 'Too many incorrect PINs. This is locked for 30 minutes.',
        });
        return;
      }
      await this.composer.send(session, { plain: `Incorrect PIN. ${5 - failed} attempts left.` });
      return;
    }

    await this.prisma.whatsAppIdentity
      .update({ where: { id: identity.id }, data: { failedPinCount: 0, lockedUntil: null } })
      .catch(() => undefined);

    const slots = (session.slotsJson ?? {}) as Record<string, unknown>;
    const resumeKey = String(slots[PIN_RESUME_SLOT] ?? '');
    await this.sessions.clearFlow(session);
    await this.sessions.markPinVerified(session);

    const action = this.registry.getByKey(resumeKey);
    if (!action) {
      await this.composer.send(session, { plain: 'Verified. Reply MENU for options.' });
      return;
    }
    // staticArgs only, on purpose: execute() applies the server-derived
    // dynamicArgs itself, so a PIN-gated action with a derived year gets it on
    // this path exactly as it does on the direct one.
    await this.inbound.execute(action, { ...(action.tool?.staticArgs ?? {}) }, session, user, cfg, ctx);
  }

  private async promptStep(
    session: SessionRow,
    action: WhatsAppActionDef,
    index: number,
    ctx: RenderCtx,
  ): Promise<void> {
    const step = action.flow!.steps[index];
    const slots = (session.slotsJson ?? {}) as Record<string, unknown>;
    const out = step.prompt({ slots, render: ctx });
    await this.composer.send(session, {
      ...out,
      plain: lines(out.plain, '', italic('Reply CANCEL to stop.')),
    });
  }
}
