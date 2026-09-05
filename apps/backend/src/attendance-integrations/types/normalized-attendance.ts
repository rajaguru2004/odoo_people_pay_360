/**
 * The canonical shape every provider must produce. The sync engine only ever
 * sees this — it has no knowledge of any vendor's payload.
 */
export interface NormalizedAttendanceRecord {
  /** Opaque employee id as the provider knows it. Mapped to our Employee downstream. */
  externalEmployeeId: string;
  /** Display only — used in the dry-run table and in unmapped-employee lists. Never used for matching. */
  externalEmployeeName?: string;

  /**
   * The business day as the PROVIDER sees it (YYYY-MM-DD).
   *
   * Advisory only. Our own attendance date key is recomputed from `checkIn`
   * using the employee's timezone and the configurable `attendance_day_end_time`
   * boundary, because a provider's notion of "day" is its own (fusion-analytics,
   * for instance, is hardcoded to Asia/Kolkata for every branch worldwide).
   */
  businessDate: string;

  /** Absolute instants (UTC), already converted by the adapter. Null = no punch. */
  checkIn: Date | null;
  checkOut: Date | null;

  /** Optional intra-day punches, mapped into our `attendances.sessions` JSON. */
  sessions?: { checkIn: Date; checkOut: Date | null }[];

  /** Providers that report absentees explicitly set 'ABSENT'. Default 'PRESENT'. */
  status?: 'PRESENT' | 'ABSENT';

  /** Provider's own record id, stored on `attendances.external_ref` for traceability. */
  externalRef?: string;

  /** Raw payload, surfaced in dry runs and error details. Never persisted to attendances. */
  raw?: unknown;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
  /** Optional extra facts the provider chose to report (record counts, branch name, ...). */
  details?: Record<string, unknown>;
}
