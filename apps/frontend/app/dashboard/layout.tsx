'use client';

import { Loader2 } from 'lucide-react';
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
    <div className="flex min-h-dvh bg-surface-page">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
