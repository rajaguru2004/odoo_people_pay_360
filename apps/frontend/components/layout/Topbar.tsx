'use client';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { fullName, initials } from '@/utils/formatters';
import { Button } from '@/components/ui/Button';

export default function Topbar() {
  const router = useRouter();
  const { user, logout } = useAuthStore();

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <header className="flex h-16 items-center justify-between border-b border-header-border bg-header-bg px-4 md:px-6">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-header-text">
          {fullName(user?.employee) !== '—' ? fullName(user?.employee) : user?.email}
        </p>
        <p className="truncate text-xs text-text-muted">
          {user?.employee?.position ?? user?.role?.replace(/_/g, ' ')}
        </p>
      </div>

      <div className="flex items-center gap-3">
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
