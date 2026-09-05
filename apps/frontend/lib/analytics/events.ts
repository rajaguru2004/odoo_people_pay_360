/**
 * The one API the rest of the app calls.
 *
 * Nothing outside `lib/analytics/` should import `gtag.ts` or touch
 * `window.dataLayer`. Adding a new measurement is meant to be one line —
 * `trackEvent('shift_swapped', { module: 'schedules' })` — with the privacy
 * scrub, the enabled check and the never-throw guarantee already applied.
 */

import { scrubParams, pseudonymousId, type AnalyticsParams } from './params';
import { gtagSend } from './gtag';
import { describeScreen, moduleForEndpoint, namedActionFor, sanitizePath } from './routes';

/**
 * Event names that more than one place sends. One-off events can be passed as
 * plain strings; these are here so a rename shows up as a type error rather
 * than as a quietly empty report.
 */
export const AnalyticsEvent = {
  PAGE_VIEW: 'page_view',
  LOGIN: 'login',
  LOGIN_FAILED: 'login_failed',
  LOGOUT: 'logout',
  SESSION_RESTORED: 'session_restored',
  /** Generic write to the API — the catch-all under every named journey. */
  API_ACTION: 'api_action',
} as const;

/** Send any event. Params are scrubbed; unsafe keys are dropped, not thrown. */
export function trackEvent(name: string, params?: AnalyticsParams): void {
  if (!name) return;
  gtagSend('event', name, scrubParams(params));
}

/**
 * Page view for an in-app navigation.
 *
 * Repeats of the same path are swallowed. Next re-runs layout effects on
 * `searchParams` changes and on some re-mounts, and a doubled page_view turns
 * every "screens per session" number into fiction.
 */
let lastPagePath: string | null = null;

export function trackPageView(pathname: string, extra?: AnalyticsParams): void {
  const { path, module, screen } = describeScreen(pathname);
  if (path === lastPagePath) return;
  lastPagePath = path;

  trackEvent(AnalyticsEvent.PAGE_VIEW, {
    // GA4's own page dimensions, deliberately overridden with the sanitised
    // path so no record id can reach the reports through `location`.
    page_path: path,
    page_location: safeOrigin() + path,
    page_title: screen,
    module,
    screen,
    ...extra,
  });
}

/** Only the origin — never the live URL, which may still hold ids. */
function safeOrigin(): string {
  try {
    return typeof window === 'undefined' ? '' : window.location.origin;
  } catch {
    return '';
  }
}

/** Lets a sign-out re-send the same path as a fresh view after sign-in. */
export function resetPageViewDedupe(): void {
  lastPagePath = null;
}

export interface AnalyticsIdentity {
  /** Account id. Hashed before it leaves the browser — never sent raw. */
  id: string;
  role: string;
  /** Whether the account may switch branches. A capability, not a location. */
  globalBranchAccess?: boolean;
}

/**
 * Attach role and a pseudonymous id to everything sent from now on.
 *
 * Role is the dimension that makes module usage readable — "Payroll is 80%
 * HR_MANAGER" is the answer, "Payroll had 400 views" is not. It is a job
 * category shared by many people, so it identifies a population rather than a
 * person, unlike anything on the employee record.
 */
export function setAnalyticsUser(identity: AnalyticsIdentity | null | undefined): void {
  if (!identity?.id) return;
  gtagSend('set', { user_id: pseudonymousId(identity.id) });
  gtagSend('set', 'user_properties', {
    user_role: identity.role || 'UNKNOWN',
    branch_access: identity.globalBranchAccess ? 'global' : 'scoped',
  });
}

/** Detach the identity on sign-out so the next user is a separate GA user. */
export function clearAnalyticsUser(): void {
  gtagSend('set', { user_id: null });
  gtagSend('set', 'user_properties', { user_role: null, branch_access: null });
  resetPageViewDedupe();
}

export interface ApiActionInput {
  method: string;
  /** Raw request url as axios saw it, query string included. */
  url: string;
  status: number;
  ok: boolean;
}

/**
 * Every write the portal makes, recorded centrally from the axios interceptor.
 *
 * This is what makes the integration maintainable: a new screen that posts to
 * the API is measured the day it ships, with no analytics call in its code and
 * so no chance of a hand-written call leaking a payload. Only the METHOD, the
 * sanitised ENDPOINT and the STATUS travel — never the request or response body.
 *
 * GET is not tracked: reads are already covered by page_view, and every list
 * screen would otherwise bury the writes in noise.
 */
export function trackApiAction({ method, url, status, ok }: ApiActionInput): void {
  const verb = (method || '').toUpperCase();
  if (!verb || verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return;

  const endpoint = sanitizePath(stripBase(url));
  const named = namedActionFor(verb, endpoint);

  trackEvent(named ?? AnalyticsEvent.API_ACTION, {
    module: moduleForEndpoint(endpoint),
    endpoint,
    method: verb,
    status,
    outcome: ok ? 'success' : 'failure',
  });
}

/** axios urls may be absolute; keep only the path so endpoints group together. */
function stripBase(url: string): string {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
