/**
 * Google Analytics 4 configuration, resolved once for every caller.
 *
 * Everything here is read from `NEXT_PUBLIC_*`, which Next inlines at BUILD
 * time — the same contract `NEXT_PUBLIC_API_URL` already has (see the ARG in
 * apps/frontend/Dockerfile). A measurement id set only at container runtime
 * will NOT reach the browser bundle; it has to be passed as a build arg.
 *
 * The whole integration is opt-in: with no measurement id configured, nothing
 * is injected, no script is fetched, and every tracking call is a no-op. That
 * is what keeps local development, the test suites and CI free of GA traffic
 * without anyone having to remember a flag.
 */

/** e.g. `G-XXXXXXXXXX`. Empty string = analytics off. */
export const GA_MEASUREMENT_ID = (process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? '').trim();

/**
 * Sends events with `debug_mode`, which makes them show up in GA4's DebugView
 * within seconds instead of the usual 24h reporting delay. Verification aid
 * only — leave it unset in production.
 */
export const GA_DEBUG = (process.env.NEXT_PUBLIC_GA_DEBUG ?? '').trim() === 'true';

/**
 * A measurement id is only honoured when it LOOKS like one.
 *
 * A typo'd or half-substituted value (`G-`, `${GA_ID}`, `changeme`) would
 * otherwise make the app fetch a 404 script on every page load for nothing.
 */
export function isAnalyticsEnabled(): boolean {
  return /^G-[A-Z0-9]{4,}$/i.test(GA_MEASUREMENT_ID);
}

/**
 * ─── Microsoft Clarity ───────────────────────────────────────────────────────
 *
 * Session replay, heatmaps and engagement insight. Same contract as the GA4 id
 * above and for the same reason: `NEXT_PUBLIC_*` is inlined by `next build`, so
 * this is a BUILD-time value that a running container cannot change.
 *
 * Kept in this file rather than one of its own so there is exactly ONE place
 * where the analytics environment is read, and one place to look when asking
 * "is anything measuring this build".
 */

/** e.g. `y9zmq4qs0j`. Empty string = Clarity off. */
export const CLARITY_PROJECT_ID = (process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID ?? '').trim();

/**
 * A project id is only honoured when it LOOKS like one.
 *
 * Clarity ids are lowercase base-36, ten characters in practice, and always mix
 * letters with digits. Requiring both classes is what rejects the values that
 * actually show up by accident — `changeme`, `yourprojectid`, a half-expanded
 * `${CLARITY_ID}` — each of which would otherwise make every page load fetch a
 * 404 from clarity.ms. A GA measurement id pasted into the wrong variable
 * (`G-KDF29Q2V54`) fails too: it is uppercase and hyphenated.
 */
export function isClarityEnabled(): boolean {
  return /^(?=.*[a-z])(?=.*\d)[a-z0-9]{8,12}$/.test(CLARITY_PROJECT_ID);
}

/**
 * Let a build served from localhost record anyway.
 *
 * Off by default, and that default is the point: unlike a GA hit, a Clarity
 * session is a REPLAY of the screen. Without the host rule in `clarity.ts`,
 * `npm run dev` and the Playwright suite — which read this same `.env.local`,
 * and which run against seeded employees, salaries and payroll runs — would
 * upload recordings of all of it into the production project. Clarity accepts
 * localhost traffic perfectly happily; nothing else stops this.
 *
 * Set to `true` only to verify the integration itself, the way
 * `NEXT_PUBLIC_GA_DEBUG` is used for GA4. See docs/ANALYTICS-CLARITY.md.
 */
export const CLARITY_ALLOW_LOCALHOST =
  (process.env.NEXT_PUBLIC_CLARITY_ALLOW_LOCALHOST ?? '').trim() === 'true';
