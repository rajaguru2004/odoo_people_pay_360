'use client';

import { useEffect, useRef } from 'react';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { isAnalyticsEnabled } from '@/lib/analytics/config';
import { configureAnalytics, gtagScriptSrc } from '@/lib/analytics/gtag';
import {
  AnalyticsEvent,
  clearAnalyticsUser,
  setAnalyticsUser,
  trackEvent,
  trackPageView,
} from '@/lib/analytics/events';

/** Key for the once-per-session mark. Scoped to the tab, cleared on sign-out. */
const SESSION_MARK = 'ess.analytics.session';

/**
 * True the first time it is called in a browser session.
 *
 * Storage can throw outright (Safari private mode, "block all cookies"), so a
 * failure is treated as "first time" — measuring twice is a smaller problem
 * than an exception thrown from a layout effect.
 */
function markSessionStarted(): boolean {
  try {
    if (window.sessionStorage.getItem(SESSION_MARK)) return false;
    window.sessionStorage.setItem(SESSION_MARK, '1');
    return true;
  } catch {
    return true;
  }
}

function clearSessionMark(): void {
  try {
    window.sessionStorage.removeItem(SESSION_MARK);
  } catch {
    // Nothing to do — the mark is a de-duplication aid, not state.
  }
}

/**
 * Mounts Google Analytics 4 and keeps it in step with the session.
 *
 * Lives in the ROOT layout, above the dashboard shell, so it is mounted once
 * for the whole portal and survives every navigation — including the ones
 * between `/login` and `/dashboard`, which is where a session starts and where
 * a provider mounted inside the dashboard would miss the first screen.
 *
 * Three responsibilities and nothing else:
 *   1. load gtag.js (`afterInteractive`, so it never blocks first paint);
 *   2. send a page_view per client-side navigation;
 *   3. mirror the signed-in role onto the GA user, and drop it on sign-out.
 *
 * With no measurement id configured it renders `null` and never touches the
 * network — see lib/analytics/config.ts.
 */
export default function AnalyticsProvider() {
  const pathname = usePathname();
  const userId = useAuthStore((state) => state.user?.id);
  const userRole = useAuthStore((state) => state.user?.role);
  const globalBranchAccess = useAuthStore((state) => state.user?.isGlobalBranchAccess);
  const hasHydrated = useAuthStore((state) => state.hasHydrated);

  // `js` + `config` are queued on MOUNT, not on script load. gtag.js replays
  // dataLayer in order when it arrives, and an event that sits in front of the
  // config command is discarded — so configuring first is what makes the very
  // first page_view of a cold load countable.
  useEffect(() => {
    if (!isAnalyticsEnabled()) return;
    configureAnalytics();
  }, []);

  // Identity is attached BEFORE the first page_view of a session wherever
  // possible, so views are not split between an anonymous and a known user.
  const identified = useRef<string | null>(null);

  useEffect(() => {
    if (!isAnalyticsEnabled()) return;
    if (!hasHydrated) return; // `user: null` is not yet an answer — see authStore.

    if (userId && userRole) {
      if (identified.current !== userId) {
        identified.current = userId;
        setAnalyticsUser({ id: userId, role: userRole, globalBranchAccess });
        // Distinguishes "arrived with a live session" from a fresh sign-in,
        // which authStore reports as `login`. Once per browser session, not
        // once per page load: every full reload builds a new JS context, so
        // without the sessionStorage mark a user who refreshes ten times looks
        // like ten returning sessions.
        if (markSessionStarted()) {
          trackEvent(AnalyticsEvent.SESSION_RESTORED, { user_role: userRole });
        }
      }
      return;
    }

    if (identified.current) {
      identified.current = null;
      clearAnalyticsUser();
      clearSessionMark();
    }
  }, [hasHydrated, userId, userRole, globalBranchAccess]);

  useEffect(() => {
    if (!isAnalyticsEnabled()) return;
    if (!pathname) return;
    trackPageView(pathname);
  }, [pathname]);

  if (!isAnalyticsEnabled()) return null;

  return (
    <Script
      id="ga4-loader"
      src={gtagScriptSrc()}
      strategy="afterInteractive"
    />
  );
}
