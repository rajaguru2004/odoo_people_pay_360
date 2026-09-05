/**
 * A delivery channel that a notification can be teed into.
 *
 * Introduced when Discord became the second channel. With one channel a direct
 * optional injection was fine; with two, branching per channel inside
 * NotificationsService would mean every future channel edits the same method —
 * and that method runs inside business transactions all over the codebase, so
 * it is the last place that should keep changing.
 *
 * Channels register themselves under NOTIFICATION_CHANNELS. NotificationsService
 * fans out to whatever is registered and knows nothing about any of them.
 */
export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

/**
 * The decision a notification is asking somebody to make.
 *
 * Deliberately NOT a token: a plain (type, id) pair with no authority
 * whatsoever. Each channel mints its own single-use, identity-bound capability
 * from it, so a notification row is never itself a way to approve anything —
 * and the same notification reaching two channels produces two capabilities
 * that cannot be swapped for one another.
 */
export interface NotificationDecision {
  /** ApprovalRequestType, e.g. 'LEAVE' | 'OVERTIME'. */
  requestType: string;
  requestId: string;
}

/** One notification, normalised. Mirrors the transient fields on the DTO. */
export interface NotificationSinkInput {
  userId: string;
  title: string;
  message: string;
  type?: string;
  link?: string;
  /**
   * Explicit template key from the shared registry. Named `waTemplate` on the
   * DTO for historical reasons; the registry itself is channel-agnostic.
   */
  waTemplate?: string;
  waData?: Record<string, unknown>;
  /** Caller-supplied idempotency key; each channel namespaces it. */
  dedupeKey?: string;
  /** Present when the recipient is being asked to approve or reject. */
  decision?: NotificationDecision;
}

export interface NotificationChannelSink {
  /** For logs and diagnostics, e.g. 'whatsapp' | 'discord'. */
  readonly channelName: string;

  /**
   * Enqueue for delivery. MUST NOT throw: this is called from inside business
   * transactions, and a messaging failure must never break the in-app
   * notification, let alone the leave approval that triggered it.
   *
   * @returns rows created. Zero is the normal case for most notifications.
   */
  enqueueFromNotifications(inputs: NotificationSinkInput[]): Promise<number>;
}
