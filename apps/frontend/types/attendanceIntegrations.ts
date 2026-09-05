/** Mirrors apps/backend/src/attendance-integrations/types/provider-config-schema.ts */
export type ProviderConfigFieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'select'
  | 'boolean';

export interface ProviderConfigField {
  name: string;
  label: string;
  type: ProviderConfigFieldType;
  required: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  help?: string;
  placeholder?: string;
  secret?: boolean;
}

export interface ProviderDescriptor {
  key: string;
  displayName: string;
  description: string;
  /** The admin form is generated from this — a new vendor needs no UI work. */
  configSchema: ProviderConfigField[];
}

export interface ProviderCatalogue {
  providers: ProviderDescriptor[];
  conflictPolicies: { value: string; label: string }[];
}

export interface AttendanceIntegration {
  id: string;
  branchId: string;
  branch?: { id: string; code: string; name: string };
  provider: string;
  displayName: string;
  enabled: boolean;

  baseUrl: string;
  authScheme: string;
  authHeaderName: string | null;
  /** The real secret never reaches the browser. */
  authSecretConfigured: boolean;
  authSecretMasked: string;

  externalBranchId: string;
  externalTenantId: string | null;
  options: Record<string, unknown> | null;

  conflictPolicy: string;
  syncIntervalMinutes: number;
  lookbackDays: number;
  autoCreateAbsent: boolean;

  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface UpsertIntegrationInput {
  branchId?: string;
  provider?: string;
  displayName?: string;
  enabled?: boolean;
  baseUrl?: string;
  authScheme?: string;
  authHeaderName?: string;
  /** Write-only. Omit to keep the stored secret. */
  authSecret?: string;
  clearAuthSecret?: boolean;
  externalBranchId?: string;
  externalTenantId?: string;
  options?: Record<string, unknown>;
  conflictPolicy?: string;
  syncIntervalMinutes?: number;
  lookbackDays?: number;
  autoCreateAbsent?: boolean;
}

export interface TestIntegrationInput {
  baseUrl?: string;
  authHeaderName?: string;
  authSecret?: string;
  externalBranchId?: string;
  externalTenantId?: string;
}

export interface TestIntegrationResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
  details?: Record<string, unknown>;
}

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

export interface SyncRecordResult {
  externalEmployeeId: string;
  externalEmployeeName?: string;
  employeeId?: string;
  employeeCode?: string;
  employeeName?: string;
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
  records: SyncRecordResult[];
}

export interface SyncRunRow {
  id: string;
  integrationId: string;
  trigger: string;
  windowStart: string;
  windowEnd: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  fetched: number;
  matched: number;
  created: number;
  updated: number;
  skipped: number;
  unmapped: number;
  errorCount: number;
  detailCount: number;
  durationMs: number | null;
}

export interface UnmappedExternalEmployee {
  externalId: string;
  name?: string;
  lastSeen: string;
}

export interface MappedEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
  status: string;
  attendanceExternalId: string | null;
}

export interface CandidateEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
  position: string;
}

export interface MappingSuggestionCandidate {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  position: string;
  /** Name-overlap score in [0,1]. */
  score: number;
}

export interface MappingSuggestion {
  externalId: string;
  externalName: string | null;
  /** Top match is strong AND clearly ahead of the runner-up. */
  confident: boolean;
  suggestions: MappingSuggestionCandidate[];
}

export interface BulkMapResult {
  linked: number;
  failed: number;
  results: {
    externalId: string;
    employeeId: string;
    ok: boolean;
    message: string;
  }[];
}
