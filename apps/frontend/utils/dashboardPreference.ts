export type DashboardVersion = 'v1' | 'v2';

/**
 * Dashboard layout is an org-wide setting persisted in the backend
 * (`system_settings.dashboard_layout`) and served via /system-settings/public
 * into the branding store. Only 'v1' means Classic; anything else → 'v2' (Modern).
 */
export function normalizeDashboardVersion(v?: string | null): DashboardVersion {
  return v === 'v1' ? 'v1' : 'v2';
}
