/** Why a record was skipped, or what would have happened in a dry run. */
export type SyncOutcome =
  | 'CREATED'
  | 'UPDATED'
  | 'WOULD_CREATE'
  | 'WOULD_UPDATE'
  | 'UNCHANGED'
  | 'UNMAPPED'
  | 'SKIP_LEAVE'
  | 'SKIP_MANUAL'
  | 'SKIP_CORRECTED'
  | 'SKIP_BEFORE_START_DATE'
  | 'SKIP_NO_PUNCH'
  | 'SKIP_INACTIVE_EMPLOYEE'
  | 'ERROR';

/** Human-readable reason per outcome, surfaced in the dry-run table and run details. */
export const SYNC_OUTCOME_REASON: Record<SyncOutcome, string> = {
  CREATED: 'New attendance row created',
  UPDATED: 'Existing row updated from provider',
  WOULD_CREATE: 'Would create a new attendance row',
  WOULD_UPDATE: 'Would update the existing row',
  UNCHANGED: 'Provider data matches what we already hold',
  UNMAPPED: 'No employee is linked to this external id',
  SKIP_LEAVE: 'Day is an approved leave — left untouched',
  SKIP_MANUAL: 'Row was entered manually by an admin — left untouched',
  SKIP_CORRECTED: 'Row has an approved attendance correction — left untouched',
  SKIP_BEFORE_START_DATE: "Date precedes the employee's onboarding date",
  SKIP_NO_PUNCH: 'Provider reported no check-in for this day',
  SKIP_INACTIVE_EMPLOYEE: 'Employee is not ACTIVE',
  ERROR: 'Failed to apply — see error',
};

export interface SyncRecordResult {
  externalEmployeeId: string;
  externalEmployeeName?: string;
  employeeId?: string;
  employeeCode?: string;
  employeeName?: string;
  /** Our attendance date key (YYYY-MM-DD), after timezone + day-boundary resolution. */
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  outcome: SyncOutcome;
  reason: string;
  error?: string;
}

export interface SyncRunSummary {
  runId: string | null;
  integrationId: string;
  trigger: 'CRON' | 'MANUAL' | 'DRY_RUN';
  windowStart: string;
  windowEnd: string;
  status: 'OK' | 'PARTIAL' | 'ERROR';
  fetched: number;
  matched: number;
  created: number;
  updated: number;
  skipped: number;
  unmapped: number;
  errorCount: number;
  durationMs: number;
  message?: string;
  /** Capped. Dry runs return every record; real runs keep only the noteworthy ones. */
  records: SyncRecordResult[];
}

/** How much of `details` we are willing to persist / return, so one bad day cannot bloat a row. */
export const MAX_DETAIL_RECORDS = 500;

export const CONFLICT_POLICIES = ['PROVIDER_WINS_SAFE', 'PROVIDER_WINS_ALL', 'FILL_GAPS_ONLY'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export const CONFLICT_POLICY_LABELS: Record<ConflictPolicy, string> = {
  PROVIDER_WINS_SAFE:
    'Provider wins, except approved leave, approved corrections and manual admin entries',
  PROVIDER_WINS_ALL: 'Provider always wins — overwrites every existing row for the day',
  FILL_GAPS_ONLY: 'Only create rows where none exists — never update',
};
