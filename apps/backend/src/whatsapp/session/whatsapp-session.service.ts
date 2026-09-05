import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface MenuOption {
  n: number;
  label: string;
  actionKey: string;
  params?: Record<string, string>;
}

export interface SessionRow {
  id: string;
  instance: string;
  remoteJid: string;
  identityId: string | null;
  userId: string | null;
  flowKey: string | null;
  flowStep: number | null;
  slotsJson: any;
  flowExpiresAt: Date | null;
  flowErrors: number;
  lastMenuJson: any;
  lastMenuAt: Date | null;
  pinVerifiedAt: Date | null;
  unknownStreak: number;
  version: number;
}

/**
 * Conversation state for one chat, plus the ordering guarantee around it.
 *
 * State is a row rather than an in-memory map because it is read and written
 * exactly once per message anyway, and because losing a half-finished leave
 * application on a deploy is a worse experience than one extra query.
 */
@Injectable()
export class WhatsAppSessionService {
  private readonly logger = new Logger(WhatsAppSessionService.name);

  /**
   * Serialises processing per chat. Two messages arriving together must not
   * interleave halfway through a flow — the user would see the second prompt
   * answered by the first reply. Correct for the current single-process
   * deployment; the version CAS below is the backstop if that ever changes.
   */
  private chains = new Map<string, Promise<unknown>>();

  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(instance: string, remoteJid: string): Promise<SessionRow> {
    const existing = await this.prisma.whatsAppSession.findUnique({
      where: { instance_remoteJid: { instance, remoteJid } },
    });
    if (existing) return existing as SessionRow;

    try {
      return (await this.prisma.whatsAppSession.create({
        data: { instance, remoteJid },
      })) as SessionRow;
    } catch {
      // Lost a create race with a concurrent message from the same chat.
      return (await this.prisma.whatsAppSession.findUnique({
        where: { instance_remoteJid: { instance, remoteJid } },
      })) as SessionRow;
    }
  }

  /**
   * Count a message we could not route, and report the run length.
   *
   * A run, not a total: somebody who mistypes once a month should keep getting
   * the friendly guesses, while somebody stuck in a loop should be handed a
   * link to a human.
   */
  async noteUnknown(session: SessionRow): Promise<number> {
    const row = await this.prisma.whatsAppSession
      .update({
        where: { id: session.id },
        data: { unknownStreak: { increment: 1 } },
        select: { unknownStreak: true },
      })
      .catch(() => null);
    return row?.unknownStreak ?? 0;
  }

  /** Anything we understood clears the run. */
  async clearUnknownStreak(session: SessionRow): Promise<void> {
    if (!session.unknownStreak) return;
    await this.prisma.whatsAppSession
      .update({ where: { id: session.id }, data: { unknownStreak: 0 } })
      .catch(() => undefined);
  }

  /** Run `fn` with no other message for this chat in flight. */
  async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await run;
    } finally {
      // Only clear if nobody queued behind us, or we would drop their turn.
      if (this.chains.get(sessionId) === run) this.chains.delete(sessionId);
    }
  }

  /**
   * Optimistic write. Returns false when another writer moved the session on,
   * which the caller surfaces as "still handling your previous message" rather
   * than silently applying a stale step.
   */
  async patch(session: SessionRow, data: Record<string, any>): Promise<boolean> {
    const res = await this.prisma.whatsAppSession.updateMany({
      where: { id: session.id, version: session.version },
      data: { ...data, version: session.version + 1 },
    });
    if (res.count === 1) {
      session.version += 1;
      Object.assign(session, data);
      return true;
    }
    return false;
  }

  async bindIdentity(
    session: SessionRow,
    identityId: string | null,
    userId: string | null,
  ): Promise<void> {
    if (session.identityId === identityId && session.userId === userId) return;
    await this.patch(session, { identityId, userId });
  }

  async touch(session: SessionRow): Promise<void> {
    await this.prisma.whatsAppSession
      .update({ where: { id: session.id }, data: { lastMessageAt: new Date() } })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------- flow

  async startFlow(session: SessionRow, flowKey: string, ttlMinutes: number): Promise<boolean> {
    return this.patch(session, {
      flowKey,
      flowStep: 0,
      slotsJson: {},
      flowErrors: 0,
      flowExpiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    });
  }

  async advanceFlow(
    session: SessionRow,
    step: number,
    slots: Record<string, unknown>,
    ttlMinutes: number,
  ): Promise<boolean> {
    return this.patch(session, {
      flowStep: step,
      slotsJson: slots,
      flowErrors: 0,
      flowExpiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    });
  }

  async noteFlowError(session: SessionRow): Promise<number> {
    const next = (session.flowErrors ?? 0) + 1;
    await this.patch(session, { flowErrors: next });
    return next;
  }

  async clearFlow(session: SessionRow): Promise<void> {
    await this.patch(session, {
      flowKey: null,
      flowStep: null,
      slotsJson: null,
      flowErrors: 0,
      flowExpiresAt: null,
    });
  }

  /** True when a flow was active but has timed out (and is now cleared). */
  async expireFlowIfStale(session: SessionRow): Promise<boolean> {
    if (!session.flowKey || !session.flowExpiresAt) return false;
    if (session.flowExpiresAt.getTime() > Date.now()) return false;
    await this.clearFlow(session);
    return true;
  }

  // ------------------------------------------------------------------- menu

  async rememberMenu(session: SessionRow, options: MenuOption[]): Promise<void> {
    await this.patch(session, {
      lastMenuJson: options as any,
      lastMenuAt: new Date(),
    });
  }

  /**
   * Resolve a bare "3" against the menu we last rendered.
   *
   * Returns null when there is no recent menu — a numeric reply is then a
   * no-match, never a guess, because guessing here can fire a mutation.
   */
  resolveMenuChoice(session: SessionRow, n: number, withinMinutes = 10): MenuOption | null {
    if (!Array.isArray(session.lastMenuJson) || !session.lastMenuAt) return null;
    if (Date.now() - session.lastMenuAt.getTime() > withinMinutes * 60_000) return null;
    return (session.lastMenuJson as MenuOption[]).find((o) => o.n === n) ?? null;
  }

  /**
   * Resolve a poll vote back to a menu option.
   *
   * A poll carries no ids — only the option text — so the label is matched
   * against the menu we last rendered. Exact match after normalisation: a
   * near-match here would run the wrong action, and the labels are ours, so
   * there is no reason for them not to match exactly.
   */
  resolveMenuLabel(session: SessionRow, label: string, withinMinutes = 10): MenuOption | null {
    if (!Array.isArray(session.lastMenuJson) || !session.lastMenuAt) return null;
    if (Date.now() - session.lastMenuAt.getTime() > withinMinutes * 60_000) return null;
    const want = label.trim().toLowerCase();
    return (
      (session.lastMenuJson as MenuOption[]).find((o) => o.label.trim().toLowerCase() === want) ??
      null
    );
  }

  // -------------------------------------------------------------------- pin

  isPinFresh(session: SessionRow, ttlMinutes: number): boolean {
    if (!session.pinVerifiedAt) return false;
    return Date.now() - session.pinVerifiedAt.getTime() < ttlMinutes * 60_000;
  }

  async markPinVerified(session: SessionRow): Promise<void> {
    await this.patch(session, { pinVerifiedAt: new Date() });
  }

  /** Idle expiry clears conversation state only — never the identity. */
  async clearIdle(olderThanMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    const res = await this.prisma.whatsAppSession.updateMany({
      where: { lastMessageAt: { lt: cutoff }, OR: [{ flowKey: { not: null } }, { pinVerifiedAt: { not: null } }] },
      data: {
        flowKey: null,
        flowStep: null,
        slotsJson: undefined,
        flowExpiresAt: null,
        flowErrors: 0,
        pinVerifiedAt: null,
        lastMenuJson: undefined,
        lastMenuAt: null,
      },
    });
    return res.count;
  }
}
