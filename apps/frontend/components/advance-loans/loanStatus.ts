import { AdvanceLoanStatus, LoanScheduleStatus } from '@/types/advanceLoan';

/**
 * How every loan status is named and coloured, in one place.
 *
 * This exists because the list and the detail page each kept their own map, and
 * the list's covered five of the twelve statuses. Everything else — ACTIVE,
 * DISBURSED, ON_HOLD, WRITTEN_OFF, SETTLED, CLOSED, RECEIVABLE, DRAFT — fell
 * through to the CANCELLED style and rendered its raw enum name. So a loan whose
 * balance had been WRITTEN OFF was shown in the same muted grey as one that was
 * cancelled before any money moved, labelled `WRITTEN_OFF`. Those are opposite
 * facts about company money and they looked identical.
 *
 * A partial lookup keyed by an enum is the shape of that bug: adding a status
 * server-side silently degrades every screen that forgot to update. Keying the
 * record by `AdvanceLoanStatus` instead of `string` makes the compiler refuse a
 * missing case, so the next status cannot ship half-rendered.
 */

/** Semantic grouping — drives colour, and lets callers reason without a switch. */
export type LoanTone = 'neutral' | 'pending' | 'live' | 'paused' | 'done' | 'bad';

const TONE_CLASS: Record<LoanTone, string> = {
  neutral: 'bg-surface-page text-text-muted',
  pending: 'bg-status-warning-bg text-status-warning',
  live: 'bg-status-success-bg text-status-success',
  paused: 'bg-status-warning-bg text-status-warning',
  done: 'bg-status-info-bg text-status-info',
  bad: 'bg-status-error-bg text-status-error',
};

interface StatusMeta {
  /** What a human calls it. Never the raw enum. */
  label: string;
  tone: LoanTone;
  /** One line for a tooltip or an empty-state explanation. */
  hint: string;
}

/**
 * Exhaustive by construction: `Record<AdvanceLoanStatus, …>` fails to compile if
 * a status is added to the union and not described here.
 */
export const LOAN_STATUS: Record<AdvanceLoanStatus, StatusMeta> = {
  DRAFT: {
    label: 'Draft',
    tone: 'neutral',
    hint: 'Not submitted yet.',
  },
  PENDING: {
    label: 'Pending approval',
    tone: 'pending',
    hint: 'Waiting on an approver. No money has moved.',
  },
  APPROVED: {
    label: 'Approved',
    tone: 'live',
    hint: 'Approved and scheduled for payroll recovery.',
  },
  DISBURSED: {
    label: 'Disbursed',
    tone: 'live',
    hint: 'Paid out; recovery runs through payroll.',
  },
  ACTIVE: {
    label: 'Active',
    tone: 'live',
    hint: 'Being recovered through payroll.',
  },
  ON_HOLD: {
    label: 'On hold',
    tone: 'paused',
    hint: 'Payroll skips this loan until recovery is resumed.',
  },
  COMPLETED: {
    label: 'Fully repaid',
    tone: 'done',
    hint: 'Repaid in full.',
  },
  CLOSED: {
    label: 'Closed',
    tone: 'done',
    hint: 'Closed manually; nothing further is owed.',
  },
  SETTLED: {
    label: 'Settled on exit',
    tone: 'done',
    hint: 'Cleared as part of the employee’s final settlement.',
  },
  RECEIVABLE: {
    label: 'Receivable',
    tone: 'paused',
    hint: 'Being recovered outside payroll — no payroll operation remains.',
  },
  WRITTEN_OFF: {
    label: 'Written off',
    tone: 'bad',
    hint: 'The balance was forgiven. Reversible only via Reinstate.',
  },
  REJECTED: {
    label: 'Rejected',
    tone: 'bad',
    hint: 'Declined; no money ever moved.',
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'neutral',
    hint: 'Withdrawn before it took effect.',
  },
};

/**
 * Never throws on an unknown status.
 *
 * A server that gains a status before this bundle is redeployed must still
 * render something readable, so an unknown value is title-cased rather than
 * dropped or shown as `SOME_NEW_STATUS`.
 */
export function loanStatusMeta(status: string): StatusMeta {
  return (
    LOAN_STATUS[status as AdvanceLoanStatus] ?? {
      label: titleCase(status),
      tone: 'neutral' as LoanTone,
      hint: '',
    }
  );
}

export function loanStatusLabel(status: string): string {
  return loanStatusMeta(status).label;
}

/** Tailwind classes for the badge body. Pair with `LOAN_BADGE_BASE`. */
export function loanStatusClass(status: string): string {
  return TONE_CLASS[loanStatusMeta(status).tone];
}

export const LOAN_BADGE_BASE =
  'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium';

/** Statuses where money can still move — the ones a manager can operate on. */
export const LOAN_LIVE_STATUSES: AdvanceLoanStatus[] = [
  'APPROVED',
  'DISBURSED',
  'ACTIVE',
  'ON_HOLD',
];

/** Statuses where the request never became debt. */
export const LOAN_NEVER_DISBURSED: AdvanceLoanStatus[] = [
  'DRAFT',
  'PENDING',
  'REJECTED',
  'CANCELLED',
];

/**
 * Filter groups offered in the list toolbar.
 *
 * Grouped rather than one-per-status: "Active" meaning four separate enum values
 * is the question a user actually asks, and thirteen checkboxes is not a filter,
 * it is a second copy of the schema. The value is sent as the CSV that
 * `findAll`'s `status` param already accepts.
 */
export const LOAN_STATUS_FILTERS: { key: string; label: string; value: string }[] = [
  { key: 'all', label: 'All', value: '' },
  { key: 'pending', label: 'Pending', value: 'PENDING,DRAFT' },
  { key: 'live', label: 'Active', value: 'APPROVED,DISBURSED,ACTIVE' },
  { key: 'hold', label: 'On hold', value: 'ON_HOLD,RECEIVABLE' },
  { key: 'done', label: 'Settled', value: 'COMPLETED,CLOSED,SETTLED' },
  { key: 'bad', label: 'Rejected / written off', value: 'REJECTED,CANCELLED,WRITTEN_OFF' },
];

// ── schedule rows ───────────────────────────────────────────────────────────

const SCHEDULE_TONE: Record<LoanScheduleStatus, LoanTone> = {
  SCHEDULED: 'neutral',
  PARTIAL: 'pending',
  PAID: 'live',
  DEFERRED: 'paused',
  SKIPPED: 'paused',
  WAIVED: 'done',
  WRITTEN_OFF: 'bad',
  CLOSED_EARLY: 'done',
  CANCELLED: 'neutral',
};

const SCHEDULE_LABEL: Record<LoanScheduleStatus, string> = {
  SCHEDULED: 'Scheduled',
  PARTIAL: 'Part paid',
  PAID: 'Paid',
  DEFERRED: 'Deferred',
  SKIPPED: 'Skipped',
  WAIVED: 'Waived',
  WRITTEN_OFF: 'Written off',
  CLOSED_EARLY: 'Closed early',
  CANCELLED: 'Cancelled',
};

export function scheduleStatusLabel(status: string): string {
  return SCHEDULE_LABEL[status as LoanScheduleStatus] ?? titleCase(status);
}

export function scheduleStatusClass(status: string): string {
  return TONE_CLASS[SCHEDULE_TONE[status as LoanScheduleStatus] ?? 'neutral'];
}

function titleCase(raw: string): string {
  return String(raw)
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}
