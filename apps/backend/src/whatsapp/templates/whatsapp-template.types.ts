/**
 * Everything a template gets. Assembled by the outbox at enqueue time, so
 * `render` stays a pure synchronous function with no I/O and no AI.
 */
export interface WhatsAppTemplateContext {
  /** Employee full name, or the user's email when there is no employee record. */
  recipientName: string;
  companyName: string;
  /** Absolute base for deep links, e.g. https://ess.example.com */
  appBaseUrl: string;
  /** The in-app notification title, verbatim. */
  title: string;
  /** The in-app notification message, verbatim. */
  message: string;
  /** Frontend path from Notification.link, e.g. '/dashboard/leaves'. */
  link?: string;
  /** Whatever the trigger site passed as `waData`. Always an object. */
  data: Record<string, unknown>;
}

/** Grouping for the admin list. Purely presentational. */
export type WhatsAppTemplateGroup =
  | 'Leave'
  | 'Overtime'
  | 'Attendance'
  | 'Approvals'
  | 'Pay'
  | 'Money'
  | 'Travel & training'
  | 'Documents'
  | 'Assets'
  | 'Work'
  | 'Onboarding'
  | 'Other';

export interface WhatsAppTemplate {
  key: string;
  /** Human label for the admin "which updates go out" list. */
  label: string;
  group: WhatsAppTemplateGroup;
  /**
   * Notification `type` values that select this template when the trigger site
   * did not pass an explicit `waTemplate`.
   *
   * Most sites pass a generic 'INFO'/'SUCCESS'/'WARNING', so type-based
   * selection only works for the handful that carry a semantic type. Everything
   * else must opt in explicitly — that is what keeps the channel quiet.
   */
  notificationTypes?: string[];
  render(ctx: WhatsAppTemplateContext): string;
}
