'use client';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { usePageChrome } from '@/hooks/usePageChrome';
import { fullName, initials } from '@/utils/formatters';
import { Button } from '@/components/ui/Button';

/**
 * The fixed chrome: who you are signed in as, what page you are on, and the way
 * out.
 *
 * It owns the single `<h1>` for the whole shell — a page declares its text
 * through `usePageHeader` rather than painting a second heading of its own.
 *
 * The breadcrumb trail deliberately does NOT live here. It belongs to the page
 * rather than to the frame, and it is rendered at the top of the content area
 * instead; see `components/layout/Breadcrumbs.tsx`.
 */
export default function Topbar() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { title, subtitle } = usePageChrome();

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-header-border bg-header-bg px-4 md:px-6">
      <div className="min-w-0">
        {title && (
          <h1 className="truncate text-base font-semibold leading-tight text-header-text md:text-lg">
            {title}
          </h1>
        )}
        {subtitle && <p className="hidden truncate text-xs text-text-muted sm:block">{subtitle}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden min-w-0 text-end sm:block">
          <p className="truncate text-sm font-semibold text-header-text">
            {fullName(user?.employee) !== '—' ? fullName(user?.employee) : user?.email}
          </p>
          <p className="truncate text-xs text-text-muted">
            {user?.employee?.position ?? user?.role?.replace(/_/g, ' ')}
          </p>
        </div>
        <span
          aria-hidden
          className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-primary text-sm font-semibold text-text-on-brand"
        >
          {initials(user?.employee) !== '?' ? initials(user?.employee) : user?.email?.[0]?.toUpperCase()}
        </span>
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">Sign out</span>
        </Button>
      </div>
    </header>
  );
}
