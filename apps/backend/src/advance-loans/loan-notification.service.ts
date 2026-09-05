import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Where the notice went. Today only in-app; the column exists for the rest. */
export type LoanNotificationChannel = 'IN_APP' | 'EMAIL' | 'SMS' | 'WHATSAPP';

export interface LoanNotifyArgs {
  requestId: string;
  /** What happened — `LOAN_APPROVED`, `EMI_DEDUCTED`, … */
  event: string;
  recipientUserId: string;
  title: string;
  message: string;
  /**
   * What makes this notice unique WITHIN its event.
   *
   * `'2026-08'` for anything that recurs per payroll cycle, the mutation id for
   * a one-shot, and `''` for something that can only ever happen once in a
   * loan's life. It is the difference between "tell them again next month" and
   * "we already told them".
   */
  periodKey?: string;
  channel?: LoanNotificationChannel;
  link?: string;
  type?: string;
  meta?: Record<string, unknown>;
}

/**
 * Loan notifications, with a record of what was actually sent.
 *
 * `AdvanceLoanNotificationLog` was created with a purpose-built dedupe index —
 * `@@unique([requestId, event, periodKey, recipientUserId, channel])` — and the
 * only reference to it in the entire backend was the branch-scope map. Nothing
 * wrote a row. The consequences were all invisible-by-construction:
 *
 *  - **Duplicates.** Re-running a payroll re-notified everyone, and nothing
 *    could tell a second notice from a first.
 *  - **Failures vanished.** Every send site is wrapped in try/catch and
 *    swallows — correct, because a notification must never roll back money, but
 *    it meant a broken channel was silent.
 *  - **No retry.** Nothing recorded what to retry.
 *
 * The order here is deliberate: **claim first, then send**. The unique index is
 * what makes the claim atomic, so two payroll runs racing on the same cycle
 * produce one notice, not two. A send that fails leaves the row as `FAILED`
 * with the error on it, which is what `retryFailed()` walks.
 */
@Injectable()
export class LoanNotificationService {
  private readonly logger = new Logger(LoanNotificationService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Send once. Returns whether this call was the one that sent it.
   *
   * Never throws: a notification failure must not roll back the money that
   * caused it.
   */
  async notifyOnce(args: LoanNotifyArgs): Promise<boolean> {
    const periodKey = args.periodKey ?? '';
    const channel = args.channel ?? 'IN_APP';

    let logId: string;
    try {
      // The claim. A duplicate loses on the unique index and stops here, which
      // is the whole dedupe mechanism — no read-then-write race to lose.
      const row = await this.prisma.advanceLoanNotificationLog.create({
        data: {
          requestId: args.requestId,
          event: args.event,
          periodKey,
          recipientUserId: args.recipientUserId,
          channel,
          status: 'PENDING',
        },
        select: { id: true },
      });
      logId = row.id;
    } catch (err) {
      // P2002 — already claimed, so somebody has already told them.
      if ((err as { code?: string })?.code === 'P2002') return false;
      // Anything else (the table missing on an unmigrated database, say) must
      // not cost the user their notification, so fall through and send blind.
      this.logger.warn(
        `Could not record notification ${args.event} for loan ${args.requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await this.send(args).catch(() => undefined);
      return true;
    }

    try {
      await this.send(args);
      await this.prisma.advanceLoanNotificationLog.update({
        where: { id: logId },
        data: { status: 'SENT', attempts: { increment: 1 }, sentAt: new Date() },
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.advanceLoanNotificationLog
        .update({
          where: { id: logId },
          data: {
            status: 'FAILED',
            attempts: { increment: 1 },
            lastError: message.slice(0, 1000),
          },
        })
        .catch(() => undefined);
      this.logger.warn(
        `Notification ${args.event} for loan ${args.requestId} failed: ${message}`,
      );
      return false;
    }
  }

  private async send(args: LoanNotifyArgs): Promise<void> {
    // `meta` is omitted rather than passed as undefined: it carries the
    // WhatsApp template for a decision, and a notice that has none should call
    // the notifier the same way it always did.
    const rest = args.meta === undefined ? [] : [args.meta as any];
    await (this.notifications.notifyUser as any)(
      args.recipientUserId,
      args.title,
      args.message,
      (args.type ?? 'INFO') as any,
      args.link,
      ...rest,
    );
  }

  /**
   * Re-send what failed.
   *
   * Bounded by `maxAttempts` so a permanently broken address is retried a few
   * times and then left alone with its error, rather than re-tried forever on
   * every sweep. The rows are kept either way — a failure nobody can see is the
   * thing this whole service exists to fix.
   */
  async retryFailed(opts: { maxAttempts?: number; limit?: number } = {}) {
    const maxAttempts = opts.maxAttempts ?? 3;
    const rows = await this.prisma.advanceLoanNotificationLog.findMany({
      where: { status: 'FAILED', attempts: { lt: maxAttempts } },
      orderBy: { createdAt: 'asc' },
      take: opts.limit ?? 100,
      include: {
        request: { select: { id: true, type: true, referenceNo: true } },
      },
    });

    let sent = 0;
    for (const row of rows) {
      if (!row.recipientUserId) continue;
      try {
        await this.send({
          requestId: row.requestId,
          event: row.event,
          recipientUserId: row.recipientUserId,
          // The original wording is not stored — only what it was ABOUT — so a
          // retry restates the event rather than inventing a new message.
          title: `Update on your ${row.request.type === 'LOAN' ? 'loan' : 'salary advance'}`,
          message: `${row.event} on ${row.request.referenceNo ?? row.requestId}`,
          link: `/dashboard/advance-loans/${row.requestId}`,
        });
        await this.prisma.advanceLoanNotificationLog.update({
          where: { id: row.id },
          data: { status: 'SENT', attempts: { increment: 1 }, sentAt: new Date() },
        });
        sent += 1;
      } catch (err) {
        await this.prisma.advanceLoanNotificationLog
          .update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
            },
          })
          .catch(() => undefined);
      }
    }
    return { considered: rows.length, sent };
  }

  /** What was sent about one loan, newest first. */
  async history(requestId: string) {
    return this.prisma.advanceLoanNotificationLog.findMany({
      where: { requestId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
