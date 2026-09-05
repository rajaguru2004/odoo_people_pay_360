import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { runWithBranchBypass } from '../common/branch/branch-context';
import {
  REMINDER_SOURCES,
  type ReminderCandidate,
  type ReminderSource,
} from './reminder-source';

export interface ReminderRunResult {
  /** Per-source count of reminders actually delivered this run. */
  sent: Record<string, number>;
  total: number;
}

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly settings: SystemSettingsService,
    @Inject(REMINDER_SOURCES) private readonly sources: ReminderSource[],
  ) {}

  /** Registered source keys — used by tests and the admin settings screen. */
  listSources(): Array<{ key: string; thresholdSettingKey: string }> {
    return this.sources.map((s) => ({
      key: s.key,
      thresholdSettingKey: s.thresholdSettingKey,
    }));
  }

  /** Configured tiers for a source, descending, de-duplicated, positives only. */
  async thresholdsFor(source: ReminderSource): Promise<number[]> {
    const raw = await this.settings.getSetting(
      source.thresholdSettingKey,
      source.defaultThresholds.join(','),
    );
    const parsed = String(raw ?? '')
      .split(',')
      .map((t) => parseInt(t.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    const list = parsed.length > 0 ? parsed : source.defaultThresholds;
    return [...new Set(list)].sort((a, b) => b - a);
  }

  /**
   * Run every registered source. Branch bypass is applied once for the whole
   * run — a cron has no request branch context, and every source query would
   * otherwise be scoped to nothing.
   */
  async runAll(): Promise<ReminderRunResult> {
    return runWithBranchBypass(async () => {
      const sent: Record<string, number> = {};
      let total = 0;
      for (const source of this.sources) {
        try {
          const count = await this.runSource(source);
          sent[source.key] = count;
          total += count;
        } catch (err) {
          // One broken source must not stop the others.
          sent[source.key] = 0;
          this.logger.error(
            `Reminder source "${source.key}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (total > 0) this.logger.log(`Sent ${total} expiry reminder(s)`);
      return { sent, total };
    });
  }

  async runSource(source: ReminderSource): Promise<number> {
    const thresholds = await this.thresholdsFor(source);
    if (thresholds.length === 0) return 0;

    const today = startOfDay(new Date());
    const horizon = addDays(today, thresholds[0]); // widest tier
    const candidates = await source.findExpiring(today, horizon);
    if (candidates.length === 0) return 0;

    // One query for every dispatch already recorded against this batch.
    const existing = await this.prisma.reminderDispatch.findMany({
      where: { sourceKey: source.key, entityId: { in: candidates.map((c) => c.id) } },
      select: { entityId: true, threshold: true, expiryDate: true },
    });
    const alreadySent = new Set(
      existing.map((d) => dispatchKey(d.entityId, d.threshold, d.expiryDate)),
    );

    let sent = 0;
    for (const candidate of candidates) {
      try {
        if (await this.processCandidate(source, candidate, thresholds, alreadySent)) {
          sent++;
        }
      } catch (err) {
        this.logger.error(
          `Reminder for ${source.key}/${candidate.id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return sent;
  }

  /**
   * Fire at most one tier per record per run: the tightest tier the record has
   * already crossed.
   *
   * With tiers 90/60/30/7 and 45 days remaining, tiers 90 and 60 are both
   * crossed; 60 is the one that describes the record's actual urgency, so it is
   * the one sent. 90 is recorded as dispatched too — it is moot and must never
   * fire later, which is also what stops a record entered late in its life from
   * emitting four reminders at once.
   */
  private async processCandidate(
    source: ReminderSource,
    candidate: ReminderCandidate,
    thresholds: number[],
    alreadySent: Set<string>,
  ): Promise<boolean> {
    const expiry = new Date(candidate.expiryDate);
    const daysRemaining = daysUntil(expiry);
    if (daysRemaining < 0) return false; // already expired; not our job

    const crossed = thresholds.filter((t) => daysRemaining <= t);
    if (crossed.length === 0) return false;

    const tier = Math.min(...crossed);
    const moot = crossed.filter((t) => t !== tier);

    if (alreadySent.has(dispatchKey(candidate.id, tier, expiry))) {
      return false;
    }

    // Claim the tier BEFORE delivering. A crash mid-send loses one reminder;
    // claiming afterwards would let a retry re-notify everyone.
    const claimed = await this.claim(source.key, candidate.id, tier, expiry);
    if (!claimed) return false; // a concurrent run won the race

    // Wider tiers are moot once a tighter one has fired; burn them so a record
    // entered late in its life never emits four reminders on consecutive runs.
    if (moot.length > 0) {
      await this.burn(source.key, candidate.id, moot, expiry);
    }

    const recipients = await source.recipients(candidate);
    if (recipients.length === 0) {
      this.logger.warn(
        `No recipients for ${source.key}/${candidate.id}; tier ${tier} consumed`,
      );
      return false;
    }

    const expiryStr = expiry.toLocaleDateString('en-US');

    // Fan out across recipients rather than awaiting each in turn. An SMTP round
    // trip is seconds, so a serial loop makes the nightly cron scale with
    // (records x recipients) — hundreds of expiring visas would take hours.
    // Email and in-app are independent: a mail failure must not cost the in-app
    // notification, and neither may abort the run.
    await Promise.all(
      recipients.flatMap((recipient) => {
        const title = recipient.isOwner
          ? `Your ${candidate.entityLabel} is expiring soon`
          : `${candidate.entityLabel} expiring soon: ${candidate.subjectName}`;
        const message = recipient.isOwner
          ? `Your ${candidate.entityLabel.toLowerCase()} expires in ${daysRemaining} day(s) on ${expiryStr}.`
          : `${candidate.subjectName}'s ${candidate.entityLabel.toLowerCase()} expires in ${daysRemaining} day(s) on ${expiryStr}.`;

        return [
          this.mail
            .sendExpiryReminder(recipient.email, {
              recipientName: recipient.name,
              isOwner: recipient.isOwner,
              entityLabel: candidate.entityLabel,
              subjectName: candidate.subjectName,
              expiryDate: expiryStr,
              daysRemaining,
              fields: candidate.fields,
            })
            .catch((e) =>
              this.logger.error(
                `reminder mail to ${recipient.email} failed: ${e.message}`,
              ),
            ),
          this.notifications
            .create({
              userId: recipient.userId,
              title,
              message,
              type: source.notificationType as any,
              link: candidate.link,
            })
            .catch((e) =>
              this.logger.error(`reminder notification failed: ${e.message}`),
            ),
        ];
      }),
    );

    return true;
  }

  /**
   * Claim exactly the tier we are about to send. The unique index is the
   * concurrency guard: `count === 0` means another run already took it, so two
   * overlapping runs can never both notify.
   *
   * Claimed one tier at a time on purpose — a multi-row `createMany` returns the
   * total inserted, which cannot distinguish "took the tier" from "took only a
   * moot sibling".
   */
  private async claim(
    sourceKey: string,
    entityId: string,
    threshold: number,
    expiryDate: Date,
  ): Promise<boolean> {
    const result = await this.prisma.reminderDispatch.createMany({
      data: [{ sourceKey, entityId, threshold, expiryDate }],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  /** Mark tiers as consumed without sending anything. */
  private async burn(
    sourceKey: string,
    entityId: string,
    thresholds: number[],
    expiryDate: Date,
  ): Promise<void> {
    await this.prisma.reminderDispatch.createMany({
      data: thresholds.map((threshold) => ({
        sourceKey,
        entityId,
        threshold,
        expiryDate,
      })),
      skipDuplicates: true,
    });
  }
}

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/**
 * Days until expiry, negative once past. Mirrors `LegalDocumentsService.daysUntil`
 * exactly so a reminder never disagrees with the figure the UI is showing.
 */
function daysUntil(expiryDate: Date): number {
  const today = startOfDay(new Date());
  return Math.ceil((new Date(expiryDate).getTime() - today.getTime()) / 86_400_000);
}

/**
 * Dedupe identity. Keyed on the UTC calendar date rather than a normalized
 * `Date`, so the key cannot shift a day under a server timezone change — and
 * because a renewal moves the expiry, which legitimately re-arms every tier.
 */
function dispatchKey(entityId: string, threshold: number, expiryDate: Date): string {
  const day = new Date(expiryDate).toISOString().slice(0, 10);
  return `${entityId}|${threshold}|${day}`;
}
