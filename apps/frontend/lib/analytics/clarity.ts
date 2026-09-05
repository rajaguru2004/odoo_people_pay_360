/**
 * The Clarity transport. Everything that touches `window.clarity` is here.
 *
 * Twin of `gtag.ts`, and it makes the same two guarantees:
 *
 *   • **Clarity can never break the portal.** Every entry point is wrapped in
 *     try/catch and returns void. An ad-blocker that removes the queue, a
 *     corporate proxy that refuses clarity.ms, a browser with storage disabled
 *     — each ends as a silent no-op rather than an exception inside a React
 *     effect.
 *
 *   • **Order does not matter.** The shim below is Microsoft's own snippet: an
 *     array on `clarity.q` that the real tag drains when it finishes loading.
 *     A tag set before the script arrives is still delivered, so callers never
 *     wait for load.
 *
 * Nothing outside `lib/analytics/` imports this file — `ClarityProvider` is the
 * only caller, exactly as `AnalyticsProvider` is the only caller of gtag.ts.
 */

import { CLARITY_ALLOW_LOCALHOST, CLARITY_PROJECT_ID, isClarityEnabled } from './config';
import { scrubParams, type AnalyticsParams } from './params';

type ClarityFn = ((...args: any[]) => void) & { q?: unknown[] };

declare global {
  interface Window {
    clarity?: ClarityFn;
  }
}

/**
 * Ensure the queue and the shim exist.
 *
 * Identical in behaviour to the snippet Clarity hands out, minus the DOM
 * insertion — `next/script` owns loading the tag so it can be deferred past
 * first paint. The shim pushes `arguments`, not an array, because that is what
 * the real tag expects to find waiting for it.
 */
function ensureClarity(): ClarityFn | null {
  if (typeof window === 'undefined') return null;
  if (!window.clarity) {
    const shim: ClarityFn = function clarity() {
      // eslint-disable-next-line prefer-rest-params
      (shim.q = shim.q || []).push(arguments);
    };
    window.clarity = shim;
  }
  return window.clarity;
}

/** Low-level send. No-op when Clarity is off or anything at all goes wrong. */
export function clarityCall(...args: any[]): void {
  if (!isClarityEnabled()) return;
  try {
    const clarity = ensureClarity();
    if (!clarity) return;
    clarity(...args);
  } catch {
    // Deliberately silent: a failed measurement is not a user-visible problem.
  }
}

/** Hostnames a developer's machine serves the portal on. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * Whether a page served from this host may be recorded.
 *
 * A configured project id says recording is WANTED; this says it is wanted
 * HERE. Dev servers and the Playwright suite run against seeded HR data, and a
 * session recording of that is a recording of it — so localhost is refused
 * unless a build explicitly opts in.
 */
export function isRecordableHost(hostname: string | undefined | null): boolean {
  if (CLARITY_ALLOW_LOCALHOST) return true;
  if (!hostname) return false;
  if (LOCAL_HOSTS.has(hostname)) return false;
  // `*.local` is a Bonjour/LAN name; `*.localhost` is reserved for the loopback.
  return !hostname.endsWith('.local') && !hostname.endsWith('.localhost');
}

/**
 * The full gate: a valid project id AND a host worth recording.
 *
 * Browser-only — it reads `window.location`, so on the server it answers no and
 * the provider renders nothing until it is mounted.
 */
export function clarityShouldStart(): boolean {
  if (!isClarityEnabled()) return false;
  try {
    if (typeof window === 'undefined') return false;
    return isRecordableHost(window.location?.hostname);
  } catch {
    return false;
  }
}

/** URL of the tag bundle for the configured project. */
export function clarityScriptSrc(): string {
  return `https://www.clarity.ms/tag/${encodeURIComponent(CLARITY_PROJECT_ID)}`;
}

/**
 * Custom tags — the dimensions Clarity filters recordings and heatmaps by.
 *
 * Routed through the SAME scrub as GA4 events (`params.ts`), so the denylist
 * that stops `employeeId` or `netPay` reaching Google stops it reaching
 * Microsoft too. Clarity only accepts strings, so scalars are stringified
 * after the scrub has seen them in their real type.
 */
export function setClarityTags(params: AnalyticsParams | undefined): void {
  if (!isClarityEnabled()) return;
  for (const [key, value] of Object.entries(scrubParams(params))) {
    clarityCall('set', key, String(value));
  }
}

/**
 * Attach the signed-in user to the session.
 *
 * Clarity hashes `custom-id` in the browser before it is sent, but the value
 * passed here is ALREADY the FNV-1a pseudonym GA4 uses (`u_724d42b4`) — the
 * raw account id never enters the call, so the two products cannot be joined
 * back to a person even by whoever holds both dashboards.
 *
 * `custom-page-id` is the sanitised route, which is what makes an SPA readable
 * in Clarity: the docs ask for one identify call per page, and the portal's
 * pages are client transitions rather than documents. No `friendly-name` is
 * passed — that parameter is displayed in the dashboard in clear, and there is
 * nothing about an employee this integration is willing to show there.
 */
export function identifyClarityUser(pseudonymId: string, pageId: string): void {
  if (!pseudonymId) return;
  clarityCall('identify', pseudonymId, undefined, pageId);
}

/**
 * Tell Clarity which screen an anonymous visitor is on.
 *
 * The identify API is the only way to name a page, and it requires a user id —
 * so before sign-in the screen travels as a custom tag instead. Same value,
 * one less dimension to filter by, and no identifier invented for somebody who
 * has not authenticated.
 */
export function setClarityPage(sanitizedPath: string): void {
  clarityCall('set', 'page_path', sanitizedPath);
}
