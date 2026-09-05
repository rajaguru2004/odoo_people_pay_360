'use client';

import { Loader2 } from 'lucide-react';
import Breadcrumbs from '@/components/layout/Breadcrumbs';
import Sidebar from '@/components/layout/Sidebar';
import Topbar from '@/components/layout/Topbar';
import { useRequireAuth } from '@/hooks/useRequireAuth';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { isReady } = useRequireAuth();

  // Render nothing decisive until the persisted session has been read. Showing
  // the shell first would flash it to a signed-out visitor on their way to
  // /login; showing /login first would flash it to a signed-in one on reload.
  if (!isReady) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-page">
        <Loader2 className="h-6 w-6 animate-spin text-brand-primary" aria-label="Loading" />
      </div>
    );
  }

  return (
    /**
     * The shell is exactly one viewport tall and does not scroll; `<main>` is
     * the only scroller in it.
     *
     * With `min-h-dvh` the document itself grew and took the rail and the
     * header with it, so on any page longer than the window the navigation
     * scrolled off the top and the way out of the page went with it. Pinning
     * the frame and scrolling only the content is what keeps them reachable.
     *
     * `data-app-shell` is not decoration: `globals.css` keys the rule that
     * stops the DOCUMENT scrolling off it. `body` carries `overflow-x: hidden`
     * for /login, which makes the viewport a vertical scroller too, and 100dvh
     * overshoots the space actually available by a fraction of a pixel on a
     * fractionally-scaled display — enough for the viewport to draw a second,
     * dead scrollbar beside the live one on `<main>`. The attribute is what
     * lets that rule apply here and not to the sign-in screen, which is
     * `min-h-dvh` and still has to scroll on a short window.
     */
    <div data-app-shell className="flex h-dvh overflow-hidden bg-surface-page">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar />
        {/* The trail sits INSIDE the content area, above the page, rather
            than in the header bar: it describes the page, not the frame. */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Breadcrumbs />
          {children}
        </main>
      </div>
    </div>
  );
}
