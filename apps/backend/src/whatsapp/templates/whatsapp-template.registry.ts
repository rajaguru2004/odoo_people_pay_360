import { WhatsAppTemplate, WhatsAppTemplateContext } from './whatsapp-template.types';
import { bold, deepLink, escapeWa, fmtDate, kv, lines } from './format';
// fmtDate is used both directly (expiry_reminder) and via detail()'s DATE_KEYS.

/**
 * The WhatsApp allowlist.
 *
 * This file IS the blast radius. `NotificationsService` tees every notification
 * into the outbox, but the outbox drops anything that does not resolve to a
 * template here. So enabling the channel cannot start messaging people about
 * tasks, timesheets, grievances or the other ~40 chatty call sites — and adding
 * a domain is one entry here plus one `waTemplate:` line at the trigger site.
 *
 * Every `render` is pure and synchronous. A template must never throw: it runs
 * inside the notification tee, and although the tee swallows errors, a throwing
 * template would silently drop a message that looked deliverable.
 */

/** Common tail: deep link, then how to stop. */
function footer(ctx: WhatsAppTemplateContext): string {
  const url = deepLink(ctx.appBaseUrl, ctx.link);
  // Phase 1 has no inbound webhook, so we must not advertise "reply STOP" —
  // nothing would receive it. Point at the page that actually works.
  const manage = `_Manage WhatsApp updates: ${ctx.appBaseUrl}/dashboard/profile#notifications_`;
  return lines(url ? `${bold('View:')} ${url}` : '', manage);
}

function header(ctx: WhatsAppTemplateContext, title?: string): string {
  return bold(escapeWa(title ?? ctx.title));
}

/** Fall back to the notification's own message when no structured data was passed. */
function bodyOr(ctx: WhatsAppTemplateContext, built: string): string {
  return built.trim() ? built : escapeWa(ctx.message);
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Keys whose values are dates and should read as "01 Sep 2026", not raw ISO. */
const DATE_KEYS = new Set([
  'startDate',
  'endDate',
  'date',
  'expiryDate',
  'assignedAt',
  'sessionDate',
]);

function detail(ctx: WhatsAppTemplateContext, keys: Array<[string, string]>): string {
  return keys
    .map(([label, key]) => {
      const raw = ctx.data[key];
      if (raw === undefined || raw === null || raw === '') return '';
      return kv(label, DATE_KEYS.has(key) ? fmtDate(raw) : raw);
    })
    .filter(Boolean)
    .join('\n');
}

const TEMPLATES: WhatsAppTemplate[] = [
  // ------------------------------------------------------------------ expiry
  {
    key: 'expiry_reminder',
    group: 'Documents',
    label: 'Document expiry reminders',
    // Selected explicitly by RemindersService: two of the four sources emit the
    // generic WARNING type, so type-based selection would be wrong here.
    render: (ctx) => {
      const d = ctx.data;
      const fields = Array.isArray(d.fields)
        ? (d.fields as Array<{ label?: string; value?: unknown }>)
            .filter((f) => f && f.label)
            .map((f) => kv(String(f.label), f.value))
            .join('\n')
        : '';
      const days = Number(d.daysRemaining);
      const when = Number.isFinite(days)
        ? days <= 0
          ? 'has expired'
          : `expires in ${days} day${days === 1 ? '' : 's'}`
        : 'is expiring';

      return lines(
        header(ctx, `⏰ ${str(d.entityLabel) || 'Document'} ${when}`),
        '',
        d.subjectName ? kv('Record', d.subjectName) : '',
        d.expiryDate ? kv('Expiry', fmtDate(d.expiryDate)) : '',
        fields,
        '',
        bodyOr(ctx, ''),
        '',
        footer(ctx),
      );
    },
  },

  // --------------------------------------------------------------- approvals
  {
    key: 'approval_requested',
    group: 'Approvals',
    label: 'Approval needed from you',
    notificationTypes: ['APPROVAL_REQUESTED'],
    render: (ctx) =>
      lines(
        header(ctx, '📝 Approval requested'),
        '',
        escapeWa(ctx.message),
        detail(ctx, [
          ['Type', 'requestType'],
          ['Requested by', 'requesterName'],
          ['Step', 'stepOrder'],
        ]),
        '',
        footer(ctx),
      ),
  },
  {
    key: 'approval_step_approved',
    group: 'Approvals',
    label: 'Request moved forward',
    notificationTypes: ['APPROVAL_STEP_APPROVED'],
    render: (ctx) =>
      lines(header(ctx, '✅ Approval progressed'), '', escapeWa(ctx.message), '', footer(ctx)),
  },
  {
    key: 'approval_rejected',
    group: 'Approvals',
    label: 'Request declined',
    notificationTypes: ['APPROVAL_REJECTED'],
    render: (ctx) =>
      lines(header(ctx, '❌ Request rejected'), '', escapeWa(ctx.message), '', footer(ctx)),
  },

  // ------------------------------------------------------------------- leave
  {
    key: 'leave_applied',
    group: 'Leave',
    label: 'Leave request submitted',
    notificationTypes: ['LEAVE_APPLIED'],
    render: (ctx) =>
      lines(
        header(ctx, '📄 Leave request submitted'),
        '',
        detail(ctx, [
          ['Employee', 'employeeName'],
          ['Type', 'leaveType'],
          ['From', 'startDate'],
          ['To', 'endDate'],
          ['Days', 'totalDays'],
        ]),
        bodyOr(ctx, ''),
        '',
        footer(ctx),
      ),
  },
  {
    key: 'leave_approved',
    group: 'Leave',
    label: 'Leave approved',
    notificationTypes: ['LEAVE_APPROVED'],
    render: (ctx) =>
      lines(
        header(ctx, '✅ Leave approved'),
        '',
        detail(ctx, [
          ['Type', 'leaveType'],
          ['From', 'startDate'],
          ['To', 'endDate'],
          ['Days', 'totalDays'],
        ]),
        escapeWa(ctx.message),
        '',
        footer(ctx),
      ),
  },
  {
    key: 'leave_rejected',
    group: 'Leave',
    label: 'Leave declined',
    notificationTypes: ['LEAVE_REJECTED'],
    render: (ctx) =>
      lines(
        header(ctx, '❌ Leave rejected'),
        '',
        detail(ctx, [
          ['Type', 'leaveType'],
          ['From', 'startDate'],
          ['To', 'endDate'],
          ['Reason', 'rejectionReason'],
        ]),
        escapeWa(ctx.message),
        '',
        footer(ctx),
      ),
  },

  // ---------------------------------------------------------------- overtime
  {
    key: 'overtime_approved',
    group: 'Overtime',
    label: 'Overtime approved',
    notificationTypes: ['OVERTIME_APPROVED'],
    render: (ctx) =>
      lines(
        header(ctx, '✅ Overtime approved'),
        '',
        detail(ctx, [
          ['Date', 'date'],
          ['Hours', 'hours'],
        ]),
        escapeWa(ctx.message),
        '',
        footer(ctx),
      ),
  },
  {
    key: 'overtime_rejected',
    group: 'Overtime',
    label: 'Overtime declined',
    notificationTypes: ['OVERTIME_REJECTED'],
    render: (ctx) =>
      lines(
        header(ctx, '❌ Overtime rejected'),
        '',
        detail(ctx, [
          ['Date', 'date'],
          ['Hours', 'hours'],
          ['Reason', 'rejectionReason'],
        ]),
        escapeWa(ctx.message),
        '',
        footer(ctx),
      ),
  },

  {
    key: 'training_nomination',
    group: 'Travel & training',
    label: 'Training decision',
    render: (ctx) =>
      lines(
        header(ctx),
        '',
        detail(ctx, [
          ['Course', 'courseName'],
          ['Session', 'sessionDate'],
        ]),
        escapeWa(ctx.message),
        '',
        footer(ctx),
      ),
  },

  // ------------------------------------------------------------------ assets
  {
    key: 'asset_assigned',
    group: 'Assets',
    label: 'Company item assigned',
    render: (ctx) =>
      lines(
        header(ctx, '📦 Asset assigned to you'),
        '',
        detail(ctx, [
          ['Asset', 'assetName'],
          ['Tag', 'assetTag'],
          ['Assigned', 'assignedAt'],
        ]),
        escapeWa(ctx.message),
        '',
        footer(ctx),
      ),
  },

  // ------------------------------------------------------------- attendance
  {
    key: 'attendance_correction_decision',
    group: 'Attendance',
    label: 'Attendance correction approved / declined',
    notificationTypes: ['ATTENDANCE_CORRECTION_APPROVED', 'ATTENDANCE_CORRECTION_REJECTED'],
    render: (ctx) =>
      lines(
        header(ctx),
        '',
        detail(ctx, [
          ['Date', 'date'],
          ['Status', 'status'],
          ['Reason', 'rejectionReason'],
        ]),
        escapeWa(ctx.message),
        '',
        footer(ctx),
      ),
  },
  {
    key: 'shift_reminder',
    group: 'Attendance',
    label: 'Shift start reminders',
    // Selected explicitly by ShiftNotificationScheduler. It emits a plain 'INFO'
    // for both the before-shift nudge and the missed-punch alert, so there is no
    // notification type to select on — and without this key the reminders only
    // reached WhatsApp when the admin had switched the catch-all `generic`
    // fallback on, which is not something a shift reminder should depend on.
    render: (ctx) => {
      const d = ctx.data;
      const started = str(d.phase) === 'post';
      const mins = Number(d.offsetMins);
      const when = Number.isFinite(mins)
        ? started
          ? `started ${mins} minute${mins === 1 ? '' : 's'} ago`
          : `starts in ${mins} minute${mins === 1 ? '' : 's'}`
        : started
          ? 'has already started'
          : 'is starting soon';

      return lines(
        header(ctx, started ? `⚠️ Your shift ${when}` : `⏰ Your shift ${when}`),
        '',
        detail(ctx, [
          ['Shift', 'shiftType'],
          ['Starts', 'startTime'],
          ['Ends', 'endTime'],
        ]),
        // The missed-punch alert is the one that needs a call to action; the
        // pre-shift nudge is purely informational and says nothing extra.
        started ? '\nPlease check in as soon as you can.' : '',
        '',
        footer(ctx),
      );
    },
  },


  // ------------------------------------------------------------------- work
  {
    key: 'task_assigned',
    group: 'Work',
    label: 'Task assigned to you',
    notificationTypes: ['TASK_ASSIGNED'],
    render: (ctx) =>
      lines(
        header(ctx, '📋 A task was assigned to you'),
        '',
        detail(ctx, [
          ['Task', 'taskTitle'],
          ['Project', 'projectName'],
          ['Due', 'dueDate'],
          ['Priority', 'priority'],
        ]),
        bodyOr(ctx, ''),
        '',
        footer(ctx),
      ),
  },
  {
    key: 'project_member_added',
    group: 'Work',
    label: 'Added to a project',
    notificationTypes: ['PROJECT_MEMBER_ADDED'],
    render: (ctx) =>
      lines(
        header(ctx, '👥 You were added to a project'),
        '',
        detail(ctx, [
          ['Project', 'projectName'],
          ['Role', 'role'],
        ]),
        bodyOr(ctx, ''),
        '',
        footer(ctx),
      ),
  },

  // ----------------------------------------------------------------- payroll
  {
    key: 'payroll_status',
    group: 'Pay',
    label: 'Payroll approval updates',
    render: (ctx) =>
      lines(
        header(ctx),
        '',
        detail(ctx, [
          ['Period', 'period'],
          ['Status', 'status'],
          ['Employees', 'employeeCount'],
        ]),
        escapeWa(ctx.message),
        '',
        footer(ctx),
      ),
  },
  {
    key: 'payslip_ready',
    group: 'Pay',
    label: 'Payslip ready',
    render: (ctx) =>
      // Deliberately no amounts. Salary figures over WhatsApp are a Phase 2
      // decision gated behind a PIN; Phase 1 only points at the portal.
      lines(
        header(ctx, '💰 Your payslip is ready'),
        '',
        detail(ctx, [['Period', 'period']]),
        escapeWa(ctx.message),
        '',
        footer(ctx),
      ),
  },

  // --------------------------------------------------- credentials (resend)
  {
    key: 'welcome_credentials',
    group: 'Onboarding',
    label: 'Login credentials (welcome / resend)',
    render: (ctx) =>
      lines(
        header(ctx, '🔑 Your HR Portal Credentials'),
        '',
        escapeWa(ctx.message),
        '',
        detail(ctx, [
          ['Name', 'employeeName'],
          ['Employee ID', 'employeeCode'],
          ['Email', 'email'],
          ['Temporary Password', 'temporaryPassword'],
        ]),
        '',
        `_Please log in and change your password immediately._`,
        '',
        footer(ctx),
      ),
  },

  // ----------------------------------------------------------------- generic
  {
    key: 'generic',
    group: 'Other',
    label: 'Everything else (not recommended)',
    render: (ctx) => lines(header(ctx), '', escapeWa(ctx.message), '', footer(ctx)),
  },
];

function italicNote(s: string): string {
  return `_${s}_`;
}

/** key -> template */
export const WHATSAPP_TEMPLATES: ReadonlyMap<string, WhatsAppTemplate> = new Map(
  TEMPLATES.map((t) => [t.key, t]),
);

/**
 * Notification `type` -> template, for sites that pass a semantic type and
 * therefore need no code change at all.
 *
 * Built eagerly so a duplicate claim is a startup crash rather than a silent
 * last-one-wins.
 */
export const WHATSAPP_TEMPLATES_BY_TYPE: ReadonlyMap<string, WhatsAppTemplate> = (() => {
  const map = new Map<string, WhatsAppTemplate>();
  for (const t of TEMPLATES) {
    for (const type of t.notificationTypes ?? []) {
      const existing = map.get(type);
      if (existing) {
        throw new Error(
          `WhatsApp template registry: notification type '${type}' is claimed by both ` +
            `'${existing.key}' and '${t.key}'.`,
        );
      }
      map.set(type, t);
    }
  }
  return map;
})();

/** The generic passthrough is opt-in via settings, so it is excluded here. */
export const GENERIC_TEMPLATE_KEY = 'generic';

export function listTemplates(): Array<{
  key: string;
  label: string;
  group: string;
  notificationTypes: string[];
}> {
  return TEMPLATES.map((t) => ({
    key: t.key,
    label: t.label,
    group: t.group,
    notificationTypes: t.notificationTypes ?? [],
  }));
}

/** Every registered key, for validating an admin-supplied disabled list. */
export function allTemplateKeys(): string[] {
  return TEMPLATES.map((t) => t.key);
}
