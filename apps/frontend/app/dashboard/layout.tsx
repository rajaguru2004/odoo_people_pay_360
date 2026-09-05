'use client';

import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import Breadcrumbs from '@/components/layout/Breadcrumbs';
import Sidebar from '@/components/layout/Sidebar';
import Topbar from '@/components/layout/Topbar';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { usePathname } from 'next/navigation';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { isReady } = useRequireAuth();
  const pathname = usePathname();

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
     */
    <div className="flex h-dvh overflow-hidden bg-surface-page">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar />
        {/* The trail sits INSIDE the content area, above the page, rather
            than in the header bar: it describes the page, not the frame. */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Breadcrumbs />
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            {children}
          </motion.div>
        </main>
      </div>
    </div>
  );
}
