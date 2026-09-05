'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, LayoutDashboard, Settings, Users, Wallet } from 'lucide-react';
import { cn } from '@/utils/cn';
import { hasAnyPermission } from '@/utils/permissions';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, permissions: ['VIEW_DASHBOARD'] },
  { href: '/dashboard/employees', label: 'Employees', icon: Users, permissions: ['VIEW_EMPLOYEES'] },
  { href: '/dashboard/departments', label: 'Departments', icon: Building2, permissions: ['VIEW_DEPARTMENTS'] },
  { href: '/dashboard/payroll', label: 'Payroll', icon: Wallet, permissions: ['VIEW_ALL_PAYROLL', 'VIEW_OWN_PAYSLIP'] },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, permissions: ['VIEW_SYSTEM_SETTINGS'] },
];

export default function Sidebar() {
  const pathname = usePathname();
  const role = useAuthStore((s) => s.user?.role);
  const companyName = useBrandingStore((s) => s.branding.company_name);

  const items = NAV.filter((item) => hasAnyPermission(role, item.permissions));

  return (
    <aside className="hidden w-64 shrink-0 border-e border-sidebar-border bg-sidebar-bg md:flex md:flex-col">
      <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary text-sm font-bold text-text-on-brand">
          PP
        </span>
        <span className="truncate font-semibold text-text-heading">{companyName}</span>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {items.map(({ href, label, icon: Icon }) => {
          // Exact match for the index route, prefix match for the rest —
          // otherwise /dashboard stays highlighted on every child page.
          const active = href === '/dashboard' ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-button)] px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-sidebar-active-bg text-sidebar-active-text'
                  : 'text-sidebar-text hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
