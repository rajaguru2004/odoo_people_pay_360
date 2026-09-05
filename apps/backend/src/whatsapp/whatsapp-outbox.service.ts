import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { PrismaService } from '../prisma/prisma.service';
import { EvolutionClient } from './evolution/evolution.client';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import {
  GENERIC_TEMPLATE_KEY,
  WHATSAPP_TEMPLATES,
  WHATSAPP_TEMPLATES_BY_TYPE,
} from './templates/whatsapp-template.registry';
import { WhatsAppTemplate, WhatsAppTemplateContext } from './templates/whatsapp-template.types';
import { bold, chunk, escapeWa, rule } from './templates/format';
import { maskPhone } from './utils/phone.util';
import {
  NotificationChannelSink,
  NotificationDecision,
} from '../notifications/notification-channel.sink';
import { WhatsAppActionTokenService } from './approvals/whatsapp-action-token.service';
import { decisionActionsFor } from './approvals/decision-actions';
import { encodeCallback } from './router/callback-id';
import {
  IDENTITY_FAILURE_SUSPEND_AT,
  OUTBOX_STATUS,
  RETRY_BACKOFF_MS,
  SENDING_RECLAIM_MS,
  WhatsAppResolvedConfig,
} from './whatsapp.types';

/** One notification, normalised so `create()` and `createBulk()` share a path. */
export interface EnqueueNotificationInput {
  userId: string;
  title: string;
  message: string;
  type?: string;
  link?: string;
  /** Explicit template key. Wins over the `type` lookup. */
  waTemplate?: string;
  waData?: Record<string, unknown>;
  /** Caller-supplied idempotency key. Derived from content when omitted. */
  dedupeKey?: string;
  /**
   * What the recipient is being asked to decide. Carries no authority — this
   * channel mints its own single-use capability from it.
   */
  decision?: NotificationDecision;
}

/**
 * The durable WhatsApp outbox.
 *
 * A row is simultaneously the claim, the payload and the delivery record. That
 * is the whole queue: this repo has no redis/bullmq/event-emitter, and
 * introducing a broker to ship notifications is not proportionate. Postgres
 * gives durability; a conditional `updateMany` gives an atomic claim.
 *
 * Nothing here is allowed to throw into a caller. `enqueueFromNotifications` is
 * invoked from inside `NotificationsService.create()`, so an exception would
 * take down the in-app notification and, with it, the business transaction that
 * triggered it.
 */
@Injectable()
export class WhatsAppOutboxService implements NotificationChannelSink {
  readonly channelName = 'whatsapp';

  private readonly logger = new Logger(WhatsAppOutboxService.name);
  /** Guards against a slow drain run overlapping the next cron tick. */
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: WhatsAppSettingsService,
    private readonly evolution: EvolutionClient,
    private readonly tokens: WhatsAppActionTokenService,
    /**
     * @Optional so the many specs that construct this service with four
     * arguments keep working; auto-enrolment simply does not run without it.
     */
    @Optional()
    private readonly identities?: WhatsAppIdentityService,
  ) {}

  // =========================================================== enqueue

  /**
   * Tee entry point. Resolves a template, finds consented recipients, renders,
   * and inserts. Returns the number of rows created (0 is the normal case for
   * most notifications, and is not an error).
   */
  async enqueueFromNotifications(inputs: EnqueueNotificationInput[]): Promise<number> {
    if (!inputs.length) return 0;

    const cfg = await this.settings.get();
    // Note: we check `enabled` rather than ensureConfigured() so that a
    // half-configured install still logs "[DISABLED] Would send" instead of
    // silently doing nothing — the same tell MailService gives.
    if (!cfg.enabled) {
      for (const i of inputs) {
        const t = this.resolveTemplate(i, cfg);
        if (t) this.logger.debug(`[DISABLED] Would send WhatsApp ${t.key} to user ${i.userId}`);
      }
      return 0;
    }

    // Resolve templates first: most notifications have none, so this avoids a
    // recipient query for the ~40 chatty call sites we never message about.
    const targeted = inputs
      .map((input) => ({ input, template: this.resolveTemplate(input, cfg) }))
      .filter((x): x is { input: EnqueueNotificationInput; template: WhatsAppTemplate } =>
        Boolean(x.template),
      );
    if (!targeted.length) return 0;

    // The tee can fire from a cron (reminders) where there is no request branch
    // context, and identity rows are not branch-scoped by design.
    // Test mode: every message is re-addressed to one handset. Consent lookup is
    // skipped because it cannot protect anyone — no employee is reachable — and
    // requiring it would make the mode useless on a dev database where nobody
    // has opted in.
    const redirecting = Boolean(cfg.redirectAllTo);

    // The watcher copy. Off while redirecting: test mode already funnels every
    // message to one handset, so a copy would just send it there twice.
    const ccActive = cfg.carbonCopyEnabled && Boolean(cfg.carbonCopyTo) && !redirecting;

    return runWithBranchBypass(async () => {
      const userIds = [...new Set(targeted.map((t) => t.input.userId))];

      // This channel is switched on for the company by an admin, not subscribed
      // to by each employee — so make anyone with a number on their HR record
      // reachable before looking, rather than requiring a separate step nobody
      // knew existed. Only ever creates: an explicit opt-out is left alone.
      if (!redirecting && cfg.autoEnroll && this.identities) {
        await this.identities.autoEnrollUsers(userIds);
      }

      const identities = redirecting
        ? []
        : await this.prisma.whatsAppIdentity.findMany({
            where: {
              userId: { in: userIds },
              ...(cfg.requireOptIn ? { optedIn: true } : {}),
              ...(cfg.requireVerified ? { verified: true } : {}),
            },
            orderBy: { createdAt: 'asc' },
          });
      // With the copy on we carry on even when NOBODY is reachable — that case
      // is precisely what the operator is trying to see.
      if (!redirecting && !identities.length && !ccActive) return 0;

      // One user may have several numbers; Phase 1 delivers to the oldest.
      const byUser = new Map<string, (typeof identities)[number]>();
      for (const id of identities) if (!byUser.has(id.userId)) byUser.set(id.userId, id);

      const names = await this.resolveRecipientNames(
        redirecting || ccActive ? userIds : [...byUser.keys()],
      );
      const companyName = await this.settings.getCompanyName();

      const rows = targeted.flatMap(({ input, template }) => {
        const identity = byUser.get(input.userId);
        // Undeliverable AND no copy wanted: nothing to record.
        if (!identity && !redirecting && !ccActive) return [];

        const ctx: WhatsAppTemplateContext = {
          recipientName: names.get(input.userId) ?? '',
          companyName,
          appBaseUrl: cfg.appBaseUrl,
          title: input.title,
          message: input.message,
          link: input.link,
          data: input.waData ?? {},
        };

        let body: string;
        try {
          body = template.render(ctx);
        } catch (e) {
          // A broken template must not take the notification down with it.
          this.logger.error(
            `WhatsApp template '${template.key}' threw: ${(e as Error).message}`,
          );
          return [];
        }
        if (!body.trim()) return [];

        // In test mode, say plainly who the message was really for — otherwise
        // a tester cannot tell which employee's flow they just exercised.
        const intendedName = names.get(input.userId) || 'an employee';
        const intendedNumber = identity ? maskPhone(identity.phoneE164) : 'no number on file';
        const finalBody = redirecting
          ? `${bold('⚠️ TEST MODE')}\n_Intended for ${escapeWa(intendedName)} (${intendedNumber})_\n${rule()}\n${body}`
          : body;

        // Only worth minting when the recipient can actually tap, the channel
        // allows deciding, and the request type has a reviewed action pair.
        const pair =
          cfg.approvalsEnabled &&
          cfg.inboundEnabled &&
          cfg.interactiveMode !== 'text' &&
          identity &&
          !redirecting
            ? decisionActionsFor(input.decision?.requestType)
            : undefined;

        const baseKey = input.dedupeKey ?? this.autoDedupeKey(input, template.key);
        const common = {
          templateKey: template.key,
          notificationType: input.type ?? null,
          status: cfg.dryRun ? OUTBOX_STATUS.SKIPPED : OUTBOX_STATUS.QUEUED,
          lastError: cfg.dryRun ? 'dry-run' : null,
          maxAttempts: cfg.maxAttempts,
        };

        const out: any[] = [];

        // The employee's own copy. Absent when nobody could be addressed, which
        // is exactly when the watcher copy below is worth having.
        if (identity || redirecting) {
          out.push({
            ...common,
            __decision:
              pair && input.decision
                ? { pair, requestId: input.decision.requestId, identityId: identity!.id }
                : undefined,
            dedupeKey: baseKey,
            // The intended recipient is still recorded, so the delivery log
            // answers "whose notification was this?" even when redirected.
            userId: input.userId,
            employeeId: identity?.employeeId ?? null,
            branchId: identity?.branchId ?? null,
            toPhoneE164: redirecting ? cfg.redirectAllTo : identity!.phoneE164,
            body: finalBody,
          });
        }

        if (ccActive) {
          // Says who it was for and whether they actually got it. "Nothing
          // arrived" and "nothing was ever addressed" are different faults and
          // look identical from outside the system.
          const reach = identity
            ? `also sent to ${intendedNumber}`
            : 'NOT sent to them — no confirmed WhatsApp number on file';
          out.push({
            ...common,
            // Never tappable: the watcher is not the approver, and minting an
            // action token for them would let a debug copy decide a request.
            __decision: undefined,
            dedupeKey: `${baseKey}:cc`,
            userId: input.userId,
            // Left null on purpose: this row is not the employee's delivery, so
            // it must not feed their identity failure counter or branch scoping.
            employeeId: null,
            branchId: null,
            toPhoneE164: cfg.carbonCopyTo,
            body: `${bold('📋 COPY')}\n_For ${escapeWa(intendedName)} — ${reach}_\n${rule()}\n${body}`,
          });
        }

        return out;
      });

      if (!rows.length) return 0;

      // Rows that ask somebody to DECIDE get tappable buttons, which means
      // minting a single-use capability per row. Those are inserted one at a
      // time so a lost dedupe race is observable and the orphaned tokens can be
      // revoked; everything else keeps the untouched bulk path.
      const decisionRows = rows.filter((r) => r.__decision);
      const plainRows = rows.filter((r) => !r.__decision);

      let count = 0;
      if (plainRows.length) {
        // skipDuplicates on the unique dedupeKey is the idempotency guard: a
        // replayed cron inserts zero rows rather than double-messaging a human.
        const bulk = await this.prisma.whatsAppMessage.createMany({
          data: plainRows.map(strip),
          skipDuplicates: true,
        });
        count += bulk.count;
      }
      for (const row of decisionRows) {
        count += await this.insertDecisionRow(row, cfg);
      }

      const created = { count };

      if (created.count > 0 && !cfg.dryRun) {
        // Opportunistic immediate attempt for happy-path latency; the cron is
        // the durability backstop, and the claim makes the two safe to overlap.
        void this.drain().catch(() => undefined);
      }
      return created.count;
    }).catch((e) => {
      this.logger.error(`WhatsApp enqueue failed: ${(e as Error).message}`);
      return 0;
    });
  }

  /**
   * When this message may next be attempted, or null to send it now.
   *
   * The window is read in the RECIPIENT's zone — a 22:00 cutoff means 22:00
   * where they are, not where the server is. A window that crosses midnight
   * (22:00 to 07:00, the normal case) is handled by testing "after start OR
   * before end" rather than "between".
   */
  private async quietHoursHold(
    row: { employeeId: string | null; templateKey: string },
    cfg: WhatsAppResolvedConfig,
  ): Promise<Date | null> {
    const { quietHoursStart: start, quietHoursEnd: end } = cfg;
    if (!start || !end || start === end) return null;
    if (cfg.quietHoursOverrideTemplates.includes(row.templateKey)) return null;

    // One raw read rather than importing TimezoneModule: WhatsAppModule is
    // transitively imported by ~20 domain modules, and a new edge there is a
    // cycle waiting to happen.
    const tz =
      (row.employeeId
        ? await this.prisma.employee
            .findUnique({ where: { id: row.employeeId }, select: { timezone: true } })
            .then((e) => e?.timezone ?? null)
            .catch(() => null)
        : null) ?? 'UTC';

    const now = new Date();
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);

    const inWindow = start < end
      ? local >= start && local < end
      : local >= start || local < end;
    if (!inWindow) return null;

    // Next occurrence of `end`, in the recipient's zone, expressed as an
    // instant. Computed by walking forward in minutes rather than by date
    // arithmetic across a zone, which is where this kind of code usually breaks.
    const [eh, em] = end.split(':').map(Number);
    const [lh, lm] = local.split(':').map(Number);
    const minutesUntil = ((eh * 60 + em - (lh * 60 + lm)) + 1440) % 1440 || 1440;
    return new Date(now.getTime() + minutesUntil * 60_000);
  }

  /** Record a successful delivery, whichever surface carried it. */
  private async markSent(
    row: { id: string; toPhoneE164: string; templateKey?: string },
    result: { providerMessageId?: string },
    cfg: WhatsAppResolvedConfig,
  ): Promise<'sent'> {
    // The counterpart to the FAILED warning below. Without it the log only ever
    // showed failures, so a quiet channel and a working one looked the same.
    this.logger.log(
      `[WA OUT] sent ${row.templateKey ?? 'message'} to ${maskPhone(row.toPhoneE164)}` +
        (result.providerMessageId ? ` (provider id ${result.providerMessageId})` : ''),
    );
    await this.prisma.whatsAppMessage.update({
      where: { id: row.id },
      data: {
        status: OUTBOX_STATUS.SENT,
        sentAt: new Date(),
        providerMessageId: result.providerMessageId ?? null,
        lastError: null,
        lockedAt: null,
      },
    });
    // Skip identity bookkeeping while redirecting: the row's number is the
    // test handset, so any success/failure says nothing about the employee it
    // was meant for — and could otherwise suspend whoever owns the catcher.
    if (!cfg.redirectAllTo) await this.resetIdentityFailures(row.toPhoneE164);
    return 'sent';
  }

  /**
   * Insert one decision-bearing row, minting its capabilities first.
   *
   * `create` rather than `createMany` deliberately: the unique dedupeKey has to
   * be observable. A replayed enqueue that silently skipped the row would leave
   * two live approve/reject capabilities attached to a message nobody received,
   * which is why the P2002 branch revokes them.
   *
   * The tokens are minted BEFORE the insert because the ids have to go into the
   * row's `interactiveJson`. Failing that way round leaves revocable garbage;
   * the other way round would leave a message with dead buttons.
   */
  private async insertDecisionRow(row: any, cfg: WhatsAppResolvedConfig): Promise<number> {
    const { __decision: decision, ...data } = row;
    const common = {
      identityId: decision.identityId,
      userId: data.userId as string,
      resourceType: decision.pair.resourceType,
      resourceId: decision.requestId,
      args: { id: decision.requestId },
      ttlMinutes: cfg.approvalTokenTtlMinutes,
    };

    let approve: { token: string; id: string } | undefined;
    let reject: { token: string; id: string } | undefined;
    try {
      approve = await this.tokens.issue({ ...common, ...decision.pair.approve });
      reject = await this.tokens.issue({ ...common, ...decision.pair.reject });

      const created = await this.prisma.whatsAppMessage.create({
        data: {
          ...data,
          interactiveJson: {
            kind: 'buttons',
            title: 'Approval requested',
            description: firstLines(data.body as string, 2),
            items: [
              {
                label: 'Approve',
                callbackId: encodeCallback(decision.pair.approve.actionKey, { t: approve.token }),
              },
              {
                label: 'Reject',
                callbackId: encodeCallback(decision.pair.reject.actionKey, { t: reject.token }),
              },
            ],
          } as any,
        },
        select: { id: true },
      });
      return created ? 1 : 0;
    } catch (e) {
      // P2002: somebody else already enqueued this exact notification. Our
      // capabilities were never delivered, so they must not stay live.
      await this.tokens.revoke([approve?.id, reject?.id].filter(Boolean) as string[]);
      if ((e as any)?.code !== 'P2002') {
        this.logger.error(`Decision enqueue failed: ${(e as Error).message}`);
      }
      return 0;
    }
  }

  /**
   * Direct send: a number is supplied instead of being resolved from a consented
   * identity. Still goes through the outbox, so it is throttled, retried and
   * logged like everything else.
   *
   * Two callers, and they are not equivalent:
   *  - the admin test-send, messaging a number the admin typed themselves;
   *  - login credentials, messaging the employee's own HR phone.
   *
   * The second DOES reach an employee and deliberately skips the opt-in gate:
   * a person being handed their account cannot have opted in yet, and the
   * message is the one they are waiting for. That is the only consent bypass in
   * the channel, and it is why the admin's per-update switch is enforced below —
   * without it, "Login credentials: off" would be a switch that does nothing.
   *
   * Gated on credentials rather than the `enabled` kill switch: proving the
   * channel works is precisely what you do before switching it on.
   */
  async enqueueDirect(args: {
    toE164: string;
    templateKey: string;
    body: string;
    userId?: string;
    dedupeKey?: string;
  }): Promise<{
    queued: boolean;
    id?: string;
    reason?: string;
    deliveredTo?: string;
    redirected?: boolean;
  }> {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) {
      return {
        queued: false,
        reason: 'Set the base URL, instance name and API key, then save.',
      };
    }

    // The admin's per-update switch. Test sends carry a 'test:' prefix and so
    // can never match a registry key — an admin proving the channel works is
    // not the same act as messaging staff, and must not be blocked by it.
    if (cfg.disabledTemplates.includes(args.templateKey)) {
      this.logger.debug(`WhatsApp update '${args.templateKey}' is switched off — skipping.`);
      return { queued: false, reason: `The '${args.templateKey}' update is switched off.` };
    }

    // Test mode captures the admin test too. "Only this number receives
    // messages" has to hold without exception, or it is not a safety net — but
    // the real destination is returned so the UI never claims otherwise.
    const redirecting = Boolean(cfg.redirectAllTo);
    const destination = redirecting ? cfg.redirectAllTo : args.toE164;
    const body = redirecting
      ? `${bold('⚠️ TEST MODE')}\n_Intended for ${maskPhone(args.toE164)}_\n${rule()}\n${args.body}`
      : args.body;

    return runWithBranchBypass(async () => {
      const dedupeKey =
        args.dedupeKey ?? `direct:${destination}:${Date.now()}:${randomSuffix()}`;
      const row = await this.prisma.whatsAppMessage.create({
        data: {
          dedupeKey,
          userId: args.userId ?? null,
          toPhoneE164: destination,
          templateKey: args.templateKey,
          body,
          status: cfg.dryRun ? OUTBOX_STATUS.SKIPPED : OUTBOX_STATUS.QUEUED,
          lastError: cfg.dryRun ? 'dry-run' : null,
          maxAttempts: cfg.maxAttempts,
        },
      });
      if (!cfg.dryRun) void this.deliverOne(row.id, cfg).catch(() => undefined);
      return { queued: true, id: row.id, deliveredTo: destination, redirected: redirecting };
    });
  }

  // ============================================================= drain

  /**
   * Claim and deliver due rows, serially. Safe to call concurrently.
   *
   * `force` is for the admin "run now" / retry path only: it drains on
   * credentials alone so a failed test message can be retried before the
   * channel is switched on. The cron never passes it, so the kill switch still
   * governs all automatic delivery to employees.
   */
  async drain(opts: { force?: boolean } = {}): Promise<{ processed: number; sent: number; failed: number }> {
    if (this.draining) return { processed: 0, sent: 0, failed: 0 };
    this.draining = true;
    try {
      const cfg = opts.force
        ? await this.settings.ensureCredentials()
        : await this.settings.ensureConfigured();
      if (!cfg) return { processed: 0, sent: 0, failed: 0 };
      this.evolution.setPacing(cfg.minGapMs, cfg.maxPerMinute);

      return await runWithBranchBypass(async () => {
        await this.reclaimStuck();
        await this.expireStale(cfg);

        const due = await this.prisma.whatsAppMessage.findMany({
          where: { status: OUTBOX_STATUS.QUEUED, nextAttemptAt: { lte: new Date() } },
          orderBy: { nextAttemptAt: 'asc' },
          take: cfg.drainBatchSize,
          select: { id: true },
        });

        let sent = 0;
        let failed = 0;
        // Serial, never Promise.all. The deliberate inverse of the reminders
        // email fan-out: hundreds of WhatsApp messages in one second from one
        // Baileys session is how a number gets banned.
        for (const { id } of due) {
          const outcome = await this.deliverOne(id, cfg);
          if (outcome === 'sent') sent++;
          else if (outcome === 'failed') failed++;
        }
        return { processed: due.length, sent, failed };
      });
    } catch (e) {
      this.logger.error(`WhatsApp drain failed: ${(e as Error).message}`);
      return { processed: 0, sent: 0, failed: 0 };
    } finally {
      this.draining = false;
    }
  }

  /**
   * Claim one row and attempt delivery.
   * Returns 'skipped' when another worker (or the inline attempt) won the claim.
   */
  private async deliverOne(
    id: string,
    cfg: WhatsAppResolvedConfig,
  ): Promise<'sent' | 'failed' | 'retry' | 'skipped'> {
    // The conditional updateMany IS the lock. count===1 means we own the row;
    // count===0 means the drainer and the inline attempt raced and the other won.
    // attempts increments here, not at outcome, so a process that dies mid-send
    // burns one attempt rather than looping on the same row forever.
    const claimed = await this.prisma.whatsAppMessage.updateMany({
      where: { id, status: OUTBOX_STATUS.QUEUED },
      data: {
        status: OUTBOX_STATUS.SENDING,
        lockedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return 'skipped';

    const row = await this.prisma.whatsAppMessage.findUnique({ where: { id } });
    if (!row) return 'skipped';

    // Quiet hours: HELD, never dropped. The row goes back to QUEUED with its
    // next attempt at the end of the window, so nobody loses a payslip notice
    // because it was generated at 23:00 — they just get it at 07:00.
    //
    // Outbound only. A reply to somebody who just messaged us is never held:
    // answering a question is not the same as starting a conversation at night.
    const holdUntil = await this.quietHoursHold(row, cfg);
    if (holdUntil) {
      await this.prisma.whatsAppMessage.update({
        where: { id },
        data: {
          status: OUTBOX_STATUS.QUEUED,
          nextAttemptAt: holdUntil,
          lockedAt: null,
          // Not a failure: undo the attempt the claim charged for.
          attempts: { decrement: 1 },
        },
      });
      return 'skipped';
    }

    const parts = chunk(row.body);

    // An approval notice goes out as a bubble with Approve / Reject on it when
    // one was minted at enqueue time. On failure it falls straight through to
    // the text below, which still carries the portal link — so the fallback is
    // honest rather than a dead end.
    const interactive = row.interactiveJson as any;
    if (interactive?.kind === 'buttons' && Array.isArray(interactive.items)) {
      const res = await this.evolution.sendButtons(cfg, {
        toE164: row.toPhoneE164,
        title: String(interactive.title ?? 'Action needed'),
        description: String(interactive.description ?? row.body).slice(0, 900),
        footer: interactive.footer ? String(interactive.footer) : undefined,
        buttons: interactive.items.map((i: any) => ({
          type: 'reply' as const,
          displayText: String(i.label),
          id: String(i.callbackId),
        })),
      });
      if (res.ok) return this.markSent(row, res, cfg);
      this.logger.warn(`Interactive approval send failed, falling back to text: ${res.error}`);
    }

    let result = await this.evolution.sendText(cfg, {
      toE164: row.toPhoneE164,
      text: parts[0],
    });
    // Continuation chunks are best-effort: the first part carrying the headline
    // is what determines success, and re-queuing the whole message because part
    // 3 of 3 failed would re-send parts 1 and 2.
    if (result.ok && parts.length > 1) {
      for (const part of parts.slice(1)) {
        await this.evolution.sendText(cfg, { toE164: row.toPhoneE164, text: part, delay: 600 });
      }
    }

    if (result.ok) return this.markSent(row, result, cfg);

    const terminal = !result.retryable || row.attempts >= row.maxAttempts;
    if (terminal) {
      await this.prisma.whatsAppMessage.update({
        where: { id },
        data: { status: OUTBOX_STATUS.FAILED, lastError: result.error ?? 'send failed', lockedAt: null },
      });
      // Only a hard rejection says anything about the number itself; a run of
      // 5xx from a down gateway must not suspend everybody's identity. And in
      // test mode the number is the catcher, not the employee.
      if (!result.retryable && !cfg.redirectAllTo) {
        await this.noteIdentityFailure(row.toPhoneE164, result.error);
      }
      this.logger.warn(
        `WhatsApp send FAILED (${row.templateKey} -> ${maskPhone(row.toPhoneE164)}): ${result.error}`,
      );
      return 'failed';
    }

    await this.prisma.whatsAppMessage.update({
      where: { id },
      data: {
        status: OUTBOX_STATUS.QUEUED,
        nextAttemptAt: this.nextAttemptAt(row.attempts),
        lastError: result.error ?? 'send failed',
        lockedAt: null,
      },
    });
    return 'retry';
  }

  // ========================================================= maintenance

  /** Delete old terminal rows. FAILED is kept — it is the evidence. */
  async sweep(): Promise<number> {
    const cfg = await this.settings.get();
    const cutoff = new Date(Date.now() - cfg.retentionDays * 86_400_000);
    return runWithBranchBypass(async () => {
      const res = await this.prisma.whatsAppMessage.deleteMany({
        where: {
          status: { in: [OUTBOX_STATUS.SENT, OUTBOX_STATUS.SKIPPED] },
          createdAt: { lt: cutoff },
        },
      });
      if (res.count) this.logger.log(`WhatsApp outbox sweep removed ${res.count} rows`);
      return res.count;
    }).catch(() => 0);
  }

  /** Manual dead-letter retry from the admin outbox view. */
  async retry(id: string): Promise<boolean> {
    return runWithBranchBypass(async () => {
      const res = await this.prisma.whatsAppMessage.updateMany({
        where: { id, status: { in: [OUTBOX_STATUS.FAILED, OUTBOX_STATUS.SKIPPED] } },
        data: {
          status: OUTBOX_STATUS.QUEUED,
          attempts: 0,
          nextAttemptAt: new Date(),
          lastError: null,
          lockedAt: null,
        },
      });
      return res.count > 0;
    }).catch(() => false);
  }

  /** A process that died mid-send leaves SENDING rows; give them back. */
  private async reclaimStuck(): Promise<void> {
    await this.prisma.whatsAppMessage
      .updateMany({
        where: {
          status: OUTBOX_STATUS.SENDING,
          lockedAt: { lt: new Date(Date.now() - SENDING_RECLAIM_MS) },
        },
        data: { status: OUTBOX_STATUS.QUEUED, lockedAt: null },
      })
      .catch(() => undefined);
  }

  /**
   * Drop rows that have sat queued too long — typically because the channel was
   * disabled for a while. A two-day-old "your leave was approved" is worse than
   * no message at all.
   */
  private async expireStale(cfg: WhatsAppResolvedConfig): Promise<void> {
    const cutoff = new Date(Date.now() - cfg.staleHours * 3_600_000);
    await this.prisma.whatsAppMessage
      .updateMany({
        where: { status: OUTBOX_STATUS.QUEUED, createdAt: { lt: cutoff } },
        data: { status: OUTBOX_STATUS.SKIPPED, lastError: 'stale' },
      })
      .catch(() => undefined);
  }

  // ============================================================= helpers

  /**
   * Template resolution — the gate that keeps the channel quiet.
   * No template means no WhatsApp, silently.
   *
   * Two layers, and both must pass: the registry decides what the system is
   * *capable* of sending, and the admin's disabled list decides what it
   * *should* send. Resolution happens first so that switching an update off
   * reads the same in the log as it does in the UI.
   */
  private resolveTemplate(
    input: EnqueueNotificationInput,
    cfg: WhatsAppResolvedConfig,
  ): WhatsAppTemplate | null {
    const resolved = this.resolveFromRegistry(input, cfg);
    if (!resolved) return null;

    if (cfg.disabledTemplates.includes(resolved.key)) {
      this.logger.debug(`WhatsApp update '${resolved.key}' is switched off by the admin — skipping.`);
      return null;
    }
    return resolved;
  }

  private resolveFromRegistry(
    input: EnqueueNotificationInput,
    cfg: WhatsAppResolvedConfig,
  ): WhatsAppTemplate | null {
    if (input.waTemplate) {
      const explicit = WHATSAPP_TEMPLATES.get(input.waTemplate);
      if (!explicit) {
        this.logger.warn(`Unknown WhatsApp template key '${input.waTemplate}' — skipping.`);
        return null;
      }
      return explicit;
    }
    if (input.type) {
      const byType = WHATSAPP_TEMPLATES_BY_TYPE.get(input.type);
      if (byType) return byType;
    }
    if (cfg.allowGenericFallback) return WHATSAPP_TEMPLATES.get(GENERIC_TEMPLATE_KEY) ?? null;
    return null;
  }

  /**
   * Content hash plus an hour bucket. Tight enough that a double-fire inside the
   * same hour collapses to one message, loose enough that a genuinely repeated
   * event tomorrow still sends. Callers with real identity (reminders) pass
   * their own key instead.
   */
  private autoDedupeKey(input: EnqueueNotificationInput, templateKey: string): string {
    const bucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const hash = createHash('sha1')
      .update([input.userId, templateKey, input.title, input.message, input.link ?? ''].join('|'))
      .digest('hex')
      .slice(0, 32);
    return `auto:${hash}:${bucket}`;
  }

  private nextAttemptAt(attempts: number): Date {
    const base = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1];
    // Jitter so a gateway outage does not produce a synchronised herd on recovery.
    const jitter = base * 0.1 * (Math.random() * 2 - 1);
    return new Date(Date.now() + base + jitter);
  }

  private async resolveRecipientNames(userIds: string[]): Promise<Map<string, string>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, employee: { select: { fullName: true } } },
    });
    return new Map(users.map((u) => [u.id, u.employee?.fullName || u.email || '']));
  }

  private async resetIdentityFailures(phoneE164: string): Promise<void> {
    await this.prisma.whatsAppIdentity
      .updateMany({
        where: { phoneE164, failureCount: { gt: 0 } },
        data: { failureCount: 0, lastError: null },
      })
      .catch(() => undefined);
  }

  /**
   * Count consecutive hard failures and auto-suspend a dead number so it stops
   * consuming attempts forever and shows up in the admin UI as needing
   * re-verification.
   */
  private async noteIdentityFailure(phoneE164: string, error?: string): Promise<void> {
    try {
      const identity = await this.prisma.whatsAppIdentity.findUnique({ where: { phoneE164 } });
      if (!identity) return;
      const failureCount = identity.failureCount + 1;
      await this.prisma.whatsAppIdentity.update({
        where: { id: identity.id },
        data: {
          failureCount,
          lastError: error ?? null,
          ...(failureCount >= IDENTITY_FAILURE_SUSPEND_AT ? { verified: false } : {}),
        },
      });
      if (failureCount >= IDENTITY_FAILURE_SUSPEND_AT) {
        this.logger.warn(
          `WhatsApp identity ${maskPhone(phoneE164)} suspended after ${failureCount} hard failures.`,
        );
      }
    } catch {
      /* delivery bookkeeping must never surface */
    }
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Drop the transient marker before the row reaches Prisma. */
function strip(row: any): any {
  const { __decision, ...rest } = row;
  return rest;
}

/** The opening lines of a rendered body, for a button bubble's description. */
function firstLines(body: string, n: number): string {
  return body
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, n)
    .join('\n')
    .slice(0, 300);
}
