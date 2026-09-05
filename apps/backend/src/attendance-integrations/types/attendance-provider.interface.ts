import {
  NormalizedAttendanceRecord,
  ProviderTestResult,
} from './normalized-attendance';
import { ProviderConfigField } from './provider-config-schema';

/**
 * A connection's config, fully resolved and with the secret decrypted.
 * Built by AttendanceIntegrationsService; never leaves the backend.
 */
export interface ResolvedIntegrationConfig {
  id: string;
  provider: string;
  branchId: string;

  baseUrl: string;
  authScheme: string; // 'header' | 'bearer'
  authHeaderName: string | null;
  /** Decrypted. Empty string when unset. */
  authSecret: string;

  externalBranchId: string;
  externalTenantId: string | null;

  /** Provider-specific knobs. Read via `opt()` below rather than indexed directly. */
  options: Record<string, unknown>;

  autoCreateAbsent: boolean;
}

/** Typed read of an `options` value with a default. Providers use this instead of casts. */
export function opt<T extends string | number | boolean>(
  cfg: ResolvedIntegrationConfig,
  key: string,
  fallback: T,
): T {
  const v = cfg.options?.[key];
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof fallback === 'number') {
    const n = Number(v);
    return (Number.isFinite(n) ? n : fallback) as T;
  }
  if (typeof fallback === 'boolean') {
    return (v === true || v === 'true') as T;
  }
  return String(v) as T;
}

/**
 * The contract every attendance provider implements.
 *
 * Adding a vendor:
 *   1. implement this interface in `providers/<vendor>.provider.ts`
 *   2. register it in `providers/provider.registry.ts`
 * No schema change, no controller change, no frontend change — the settings
 * form is generated from `configSchema`.
 */
export interface AttendanceProvider {
  /** Stable registry key, persisted in `attendance_integrations.provider`. Never rename. */
  readonly key: string;
  readonly displayName: string;
  /** Short prose shown under the provider picker in Settings. */
  readonly description: string;

  /** Drives the admin form. See ProviderConfigField. */
  readonly configSchema: ProviderConfigField[];

  /** Cheapest authenticated call the vendor offers. Must not mutate anything. */
  testConnection(cfg: ResolvedIntegrationConfig): Promise<ProviderTestResult>;

  /**
   * Read attendance for an inclusive date range. `fromISO`/`toISO` are
   * YYYY-MM-DD. Implementations own their own pagination, retries and
   * rate-limiting, and must throw on auth failure rather than returning [].
   */
  fetchRange(
    cfg: ResolvedIntegrationConfig,
    fromISO: string,
    toISO: string,
  ): Promise<NormalizedAttendanceRecord[]>;
}
