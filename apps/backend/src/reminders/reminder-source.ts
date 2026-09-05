/**
 * One thing that expires and should be reminded about.
 *
 * Before this, every expiring entity grew its own cron: visa and contract were
 * two near-identical copies, each with a single nullable `expiryAlertSentAt`
 * stamp that allowed exactly one alert per record, ever. Asset warranty and
 * training certificate would have been copies three and four.
 *
 * A source contributes only what is genuinely per-entity — the query, who to
 * tell, and what to say. Tier selection, dedupe, branch bypass and delivery are
 * the engine's job.
 */
export interface ReminderCandidate {
  /** Primary key of the source row; half of the dedupe key. */
  id: string;
  expiryDate: Date;
  /** Short noun for the subject line, e.g. "Visa", "Employment contract". */
  entityLabel: string;
  /** Who the reminder is about, for admin-facing copy. */
  subjectName: string;
  /** Deep link into the app. */
  link: string;
  /** Rendered as a definition list in the email + notification body. */
  fields: Array<{ label: string; value: string }>;
  /** User id of the person the record belongs to, when they have an account. */
  ownerUserId?: string | null;
  ownerEmail?: string | null;
}

export interface ReminderRecipient {
  userId: string;
  email: string;
  name: string;
  /** Owner copy is phrased in the second person; admin copy in the third. */
  isOwner: boolean;
}

export interface ReminderSource {
  /** Stable identifier; half of the dedupe key. Never rename without a migration. */
  readonly key: string;
  /**
   * System-setting key holding a comma-separated day list, e.g. "90,60,30,7".
   * Absent/blank falls back to `defaultThresholds`.
   */
  readonly thresholdSettingKey: string;
  readonly defaultThresholds: number[];
  /** `NotificationType` value for the in-app record. */
  readonly notificationType: string;

  /**
   * Rows expiring within [from, to]. MUST exclude records that are already
   * expired, superseded, or otherwise not worth chasing.
   */
  findExpiring(from: Date, to: Date): Promise<ReminderCandidate[]>;

  /** Everyone to notify about this candidate, owner included when they have an account. */
  recipients(candidate: ReminderCandidate): Promise<ReminderRecipient[]>;
}

/** DI token collecting every registered source (mirrors MCP_TOOL_PROVIDERS). */
export const REMINDER_SOURCES = Symbol('REMINDER_SOURCES');
