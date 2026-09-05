import { Injectable } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationType } from './dto/create-notification.dto';

export interface DispatchEvent {
  /**
   * The stable name of the business event. Explicit rather than inferred from
   * `type`, because most call sites pass a generic INFO/SUCCESS/WARNING that
   * cannot discriminate between domains.
   */
  event: string;
  userIds: string[];
  title: string;
  message: string;
  link?: string;
  type?: NotificationType | string;
  /** Structured context for the delivery channels. */
  data?: Record<string, unknown>;
  /** Stable per-event idempotency key; suffixed per recipient downstream. */
  dedupeKey?: string;
  channels?: { inApp?: boolean };
}

/**
 * The forward-looking notification API: one call, one business event, many channels.
 *
 * Introduced deliberately without migrating the ~60 existing `notifyUser` /
 * `notifications.create` call sites. Moving all of them in the same change that
 * introduces an external gateway would maximise blast radius for no benefit —
 * the tee in NotificationsService already reaches every registered channel.
 * New notifications (payroll, which has none today) use this instead, so the
 * right seam exists in the codebase from day one and domains migrate
 * opportunistically when they are being touched anyway.
 */
@Injectable()
export class NotificationDispatcher {
  constructor(private readonly notifications: NotificationsService) {}

  async dispatch(evt: DispatchEvent): Promise<void> {
    const userIds = [...new Set(evt.userIds.filter(Boolean))];
    if (!userIds.length) return;

    const inApp = evt.channels?.inApp ?? true;

    if (!inApp) {
      // In-app is the only channel, so an in-app-suppressed event would deliver
      // nowhere at all. Fail loudly rather than silently dropping it.
      throw new Error('NotificationDispatcher: inApp:false is not supported.');
    }

    await this.notifications
      .notifyUsers(userIds, evt.title, evt.message, (evt.type as string) ?? 'INFO', evt.link)
      .catch(() => undefined);
  }
}
