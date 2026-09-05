'use client';

import { useEffect, useState } from 'react';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import {
  clarityShouldStart,
  clarityScriptSrc,
  identifyClarityUser,
  setClarityPage,
  setClarityTags,
} from '@/lib/analytics/clarity';
import { pseudonymousId } from '@/lib/analytics/params';
import { describeScreen } from '@/lib/analytics/routes';

/**
 * Mounts Microsoft Clarity and keeps its session labelled.
 *
 * Sits in the ROOT layout beside `AnalyticsProvider`, above the dashboard
 * shell, so the tag survives every navigation — including `/login` →
 * `/dashboard`, where a session actually starts.
 *
 * Clarity does its own work once loaded: it records the session, builds the
 * heatmaps and detects rage clicks and dead clicks without being told. This
 * component adds only what Clarity cannot know by itself, and nothing beyond
 * it:
 *
 *   1. load the tag (`afterInteractive`, so it never blocks first paint);
 *   2. name the current SCREEN on every client navigation, sanitised, so an
 *      SPA route is filterable and no record id reaches the recording list;
 *   3. label the session with the signed-in ROLE and a pseudonymous id, which
 *      is what turns "a session" into "an HR manager in payroll".
 *
 * No custom events are sent. GA4 already measures the journeys (see
 * `lib/analytics/events.ts`); duplicating them here would be tracking added
 * for its own sake.
 *
 * Two conditions have to hold before anything loads: a valid project id, and a
 * host worth recording. Without either it renders `null` and never touches the
 * network — see `clarityShouldStart()` in lib/analytics/clarity.ts.
 */
export default function ClarityProvider() {
  const pathname = usePathname();
  /**
   * Resolved after mount, never during render.
   *
   * The gate reads `window.location.hostname`, which the server does not have.
   * Deciding in an effect means the server and the first client render agree on
   * `null`, so there is no hydration mismatch — and an `afterInteractive` script
   * would not have loaded before hydration anyway, so nothing is lost by it.
   */
  const [recording, setRecording] = useState(false);
  useEffect(() => setRecording(clarityShouldStart()), []);
  const userId = useAuthStore((state) => state.user?.id);
  const userRole = useAuthStore((state) => state.user?.role);
  const globalBranchAccess = useAuthStore((state) => state.user?.isGlobalBranchAccess);
  const hasHydrated = useAuthStore((state) => state.hasHydrated);

  /**
   * One effect, not three.
   *
   * Clarity's identify call carries the page id as a positional argument, so
   * "who" and "where" have to be sent together or the page name is lost. The
   * effect therefore re-runs on either changing, and every send is idempotent:
   * re-tagging a session with the value it already has costs one queue entry
   * and changes nothing in the dashboard, which is why this needs none of the
   * de-duplication the GA4 page_view path requires.
   */
  useEffect(() => {
    if (!recording) return;
    if (!pathname) return;
    // `user: null` is not yet an answer while the store rehydrates — tagging
    // now would label the first screen of every reload as anonymous.
    if (!hasHydrated) return;

    const { path, module, screen } = describeScreen(pathname);

    const tags: Record<string, string> = { module, screen };
    if (userId && userRole) {
      // A job category shared by many people, so it describes a population
      // rather than a person — the same reasoning as the GA4 user property.
      tags.user_role = userRole;
      tags.branch_access = globalBranchAccess ? 'global' : 'scoped';
    }
    setClarityTags(tags);

    if (userId) {
      identifyClarityUser(pseudonymousId(userId), path);
    } else {
      // Nobody to identify; the screen still travels as a plain tag.
      setClarityPage(path);
    }
  }, [recording, pathname, hasHydrated, userId, userRole, globalBranchAccess]);

  if (!recording) return null;

  return (
    <Script
      id="clarity-loader"
      src={clarityScriptSrc()}
      strategy="afterInteractive"
    />
  );
}
