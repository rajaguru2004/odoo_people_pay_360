/**
 * The transport. Everything that touches `window` lives here and nowhere else.
 *
 * Two guarantees this file exists to make:
 *
 *   • **Analytics can never break the portal.** Every entry point is wrapped in
 *     try/catch and returns void. An ad-blocker that removes `window.gtag`, a
 *     CSP that refuses the script, a browser with storage disabled — all of it
 *     ends as a silent no-op, never as an exception inside a React render or a
 *     form submit handler.
 *
 *   • **Order does not matter.** `dataLayer` is a plain array that the real
 *     gtag.js drains when it finishes loading, so a page_view queued before the
 *     script arrives is still delivered. Callers never have to wait for load.
 */

import { GA_DEBUG, GA_MEASUREMENT_ID, isAnalyticsEnabled } from './config';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: any[]) => void;
  }
}

/**
 * Ensure the queue and the shim exist.
 *
 * The shim pushes `arguments`, not an array — that is what Google's own snippet
 * does and what gtag.js expects to find in the queue.
 */
function ensureGtag(): Window['gtag'] | null {
  if (typeof window === 'undefined') return null;
  if (!window.dataLayer) window.dataLayer = [];
  if (!window.gtag) {
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    };
  }
  return window.gtag;
}

/** Low-level send. No-op when analytics is off or anything at all goes wrong. */
export function gtagSend(...args: any[]): void {
  if (!isAnalyticsEnabled()) return;
  try {
    const gtag = ensureGtag();
    if (!gtag) return;
    gtag(...args);
  } catch {
    // Deliberately silent: a failed measurement is not a user-visible problem.
  }
}

/**
 * Configure the stream. Called once, by AnalyticsProvider, after the tag loads.
 *
 * `send_page_view: false` because this app is a client-side SPA — gtag's own
 * automatic page_view only fires on the first hard load, so every in-app
 * navigation would be missing. AnalyticsProvider sends them all itself, which
 * also lets each one carry the sanitised path rather than the real URL.
 *
 * Nothing else belongs in this object. GA4 forwards any config key it does not
 * recognise to every hit as a custom event parameter — `anonymize_ip: true` was
 * set here and arrived on production traffic as `ep.anonymize_ip` on each
 * event, doing nothing: it is a Universal Analytics field, and GA4 truncates
 * the IP on collection whether it is sent or not.
 */
export function configureAnalytics(): void {
  if (!isAnalyticsEnabled()) return;
  gtagSend('js', new Date());
  gtagSend('config', GA_MEASUREMENT_ID, {
    send_page_view: false,
    ...(GA_DEBUG ? { debug_mode: true } : {}),
  });
}

/** URL of the gtag.js bundle for the configured stream. */
export function gtagScriptSrc(): string {
  return `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
}
