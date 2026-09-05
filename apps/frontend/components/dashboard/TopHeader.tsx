'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search, Bell, Settings, LogOut, User, ChevronDown, LayoutGrid, RefreshCw, Menu, Languages, Building2, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useGlobalSearchStore } from '@/store/globalSearchStore';
import { useBranchStore } from '@/store/branchStore';
import { usePageHeaderStore } from '@/store/pageHeaderStore';
import { useDebounce } from '@/hooks/useDebounce';
import employeeService from '@/services/employeeService';
import departmentService from '@/services/departmentService';
import { Employee } from '@/types/employee';
import { Department } from '@/types/department';
import NotificationBell from '@/components/notifications/NotificationBell';
import Avatar from '@/components/common/Avatar';
import BranchPicker from '@/components/common/BranchPicker';

const roleLabels: Record<string, string> = {
  ADMIN: 'Admin',
  HR_MANAGER: 'HR Manager',
  MANAGER: 'Department Head',
  EMPLOYEE: 'Employee',
};

const pageInfo: Record<string, { title: string; subtitle: string; icon?: any }> = {
  '/dashboard': {
    title: 'Dashboard',
    subtitle: 'Overview of human resource management system',
    icon: LayoutGrid
  },
  '/dashboard/employees': { title: 'Employee Directory', subtitle: 'Manage employee information' },
  '/dashboard/departments': { title: 'Department Management', subtitle: 'Management of organizational structure' },
  '/dashboard/branches': { title: 'Branch Management', subtitle: 'Manage office locations and settings' },
  '/dashboard/attendance': { title: 'Time & Attendance Management', subtitle: 'Manage employee timekeeping' },
  '/dashboard/leaves': { title: 'Leave Requests', subtitle: 'Manage leave applications' },
  '/dashboard/my-leaves': { title: 'My Leaves', subtitle: 'View and create leave applications' },
  '/dashboard/overtime': { title: 'Overtime Management', subtitle: 'Manage overtime requests' },
  '/dashboard/my-overtime': { title: 'My Overtime', subtitle: 'View and register for overtime' },
  '/dashboard/payroll': { title: 'Payroll Management', subtitle: 'Compensation and payroll runs' },
  '/dashboard/my-attendance': { title: 'My Attendance', subtitle: 'Timekeeping and viewing history' },
  '/dashboard/face-recognition': { title: 'Face Recognition', subtitle: 'Register and manage faces' },
  '/dashboard/my-calendar': { title: 'My Calendar', subtitle: 'View calendar and events' },
  '/dashboard/rewards': { title: 'Rewards', subtitle: 'Reward management' },
  '/dashboard/disciplines': { title: 'Disciplines', subtitle: 'Discipline management' },
  '/dashboard/settings': { title: 'Settings', subtitle: 'System configuration' },
  '/dashboard/profile': { title: 'My Profile', subtitle: 'Personal Information' },
  '/dashboard/audit-logs': { title: 'Audit Logs', subtitle: 'System event logs' },
  '/dashboard/appraisal': { title: 'AI Appraisal & Ranking', subtitle: 'Autonomous performance analysis by the HR Copilot' },
};

const getPageInfo = (pathname: string): { title: string; subtitle: string; icon?: any } => {
  if (pageInfo[pathname]) return pageInfo[pathname];

  // AI appraisal sub-routes (live runs, reports, employee results)
  if (pathname.startsWith('/dashboard/appraisal')) {
    return { title: 'AI Appraisal & Ranking', subtitle: 'Autonomous performance analysis by the HR Copilot' };
  }

  // Specific contracts check
  if (pathname.startsWith('/dashboard/contracts')) {
    if (pathname.endsWith('/new')) return { title: 'New Contract', subtitle: 'Create a new employee contract' };
    if (pathname.includes('/terminations')) return { title: 'Contract Terminations', subtitle: 'Manage terminated contracts' };
    return { title: 'Contract Management', subtitle: 'Manage employee labor contracts' };
  }

  // Specific employee sub-routes
  if (pathname.startsWith('/dashboard/employees')) {
    if (pathname.endsWith('/new')) return { title: 'Add Employee', subtitle: 'Register a new employee' };
    return { title: 'Employee Management', subtitle: 'Manage employee information' };
  }

  // Specific department sub-routes
  if (pathname.startsWith('/dashboard/departments')) {
    if (pathname.endsWith('/tree')) return { title: 'Organizational Chart', subtitle: 'View department hierarchy' };
    if (pathname.includes('/change-requests')) return { title: 'Change Requests', subtitle: 'Department change requests' };
    return { title: 'Department Management', subtitle: 'Management of organizational structure' };
  }

  // Specific branch sub-routes
  if (pathname.startsWith('/dashboard/branches')) {
    if (pathname.endsWith('/new')) return { title: 'New Branch', subtitle: 'Create a new office location' };
    if (pathname.endsWith('/edit')) return { title: 'Edit Branch', subtitle: 'Update branch details' };
    if (pathname === '/dashboard/branches') return { title: 'Branch Management', subtitle: 'Manage office locations and settings' };
    return { title: 'Branch Details', subtitle: 'View branch information' };
  }

  // Attendance sub-routes
  if (pathname.startsWith('/dashboard/attendance')) {
    if (pathname.endsWith('/history')) return { title: 'Attendance Logs', subtitle: 'View detailed attendance logs' };
    if (pathname.endsWith('/reports')) return { title: 'Attendance Reports', subtitle: 'View attendance analytical reports' };
    if (pathname.endsWith('/management')) return { title: 'Attendance Manager', subtitle: 'Manage and adjust attendance entries' };
    if (pathname.endsWith('/face-management')) return { title: 'Biometric Enrollment', subtitle: 'Manage employee face enrollments' };
    return { title: 'Time & Attendance Management', subtitle: 'Manage employee timekeeping' };
  }

  // Schedules sub-routes
  if (pathname.startsWith('/dashboard/schedules')) {
    if (pathname.endsWith('/overview')) return { title: 'Schedule Calendar', subtitle: 'View and manage shifts calendar' };
    if (pathname.endsWith('/shifts')) return { title: 'Shift Management', subtitle: 'Manage shift configuration' };
    return { title: 'Schedules Management', subtitle: 'Manage employee work schedules' };
  }

  // Leaves sub-routes
  if (pathname.startsWith('/dashboard/leaves')) {
    if (pathname.endsWith('/pending')) return { title: 'Pending Leaves', subtitle: 'Approve or reject leave requests' };
    if (pathname.endsWith('/balances')) return { title: 'Leave Balances', subtitle: 'View employee leave balances' };
    return { title: 'Leave Requests', subtitle: 'Manage leave applications' };
  }

  // Overtime sub-routes
  if (pathname.startsWith('/dashboard/overtime')) {
    if (pathname.endsWith('/new')) return { title: 'Log Overtime', subtitle: 'Create an overtime request' };
    return { title: 'Overtime Requests', subtitle: 'Manage overtime requests' };
  }

  // Payroll sub-routes
  if (pathname.startsWith('/dashboard/payroll')) {
    if (pathname.endsWith('/manage')) return { title: 'Run Payroll', subtitle: 'Process employee payroll' };
    if (pathname.endsWith('/batches')) return { title: 'Payroll Batches', subtitle: 'View processed payroll batches' };
    if (pathname.endsWith('/approvals')) return { title: 'Payroll Approvals', subtitle: 'Approve payroll runs' };
    if (pathname.endsWith('/salary-structure')) return { title: 'Salary Structures', subtitle: 'Manage salary components and templates' };
    return { title: 'Payroll Management', subtitle: 'Compensation and payroll runs' };
  }

  // Department Head / Team sub-routes
  if (pathname.startsWith('/dashboard/my-department')) {
    if (pathname.endsWith('/team-balances')) return { title: 'Team Balances', subtitle: 'View team leave balances' };
    return { title: 'My Department', subtitle: 'Manage department team members' };
  }

  // Timesheets sub-routes
  if (pathname.startsWith('/dashboard/timesheets')) {
    return { title: 'Timesheets Management', subtitle: 'Manage timesheets' };
  }
  if (pathname.startsWith('/dashboard/my-timesheets')) {
    return { title: 'My Timesheets', subtitle: 'View and manage your timesheets' };
  }

  // Generic Dynamic Routing Fallback
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 1) {
    const lastSegment = segments[segments.length - 1];
    // Check if UUID, MongoDB ObjectId, or purely numeric ID
    const isId = /^[0-9a-fA-F-]+$/.test(lastSegment) || !isNaN(Number(lastSegment)) || lastSegment.length > 20;
    if (isId) {
      const parentSegment = segments[segments.length - 2];
      const name = parentSegment
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      const singular = name.endsWith('s') ? name.slice(0, -1) : name;
      return { title: `${singular} Details`, subtitle: `Viewing detail page for this ${singular.toLowerCase()}` };
    } else {
      const title = lastSegment
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      return { title, subtitle: '' };
    }
  }

  return { title: 'Dashboard', subtitle: '' };
};

export default function TopHeader({ onMenuClick }: { onMenuClick?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const t = useTranslations('topHeader');
  const searchQuery = useGlobalSearchStore((s) => s.query);
  const setSearchQuery = useGlobalSearchStore((s) => s.setQuery);

  // Directory-wide search (dropdown) is only available to roles that can
  // actually view other employees/departments — EMPLOYEE gets a plain,
  // page-scoped search box instead (see placeholder below).
  const canSearchDirectory = user?.role !== 'EMPLOYEE';
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [employeeResults, setEmployeeResults] = useState<Employee[]>([]);
  const [allDepartments, setAllDepartments] = useState<Department[]>([]);
  const searchRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounce(searchQuery, 300);

  // TopHeader lives OUTSIDE the DashboardLayout `key={selectedBranchId}` remount
  // boundary, so it must re-fetch branch-scoped data itself when the branch
  // switches. Departments are few — fetch on branch change and filter client-side.
  const selectedBranchId = useBranchStore((s) => s.selectedBranchId);
  useEffect(() => {
    if (!canSearchDirectory) return;
    departmentService.getAll().then((res) => setAllDepartments(res.data || [])).catch(() => {});
  }, [canSearchDirectory, selectedBranchId]);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!canSearchDirectory || q.length < 2) {
      setEmployeeResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    employeeService.getDirectory(q)
      .then((res) => { if (!cancelled) setEmployeeResults((res.data || []).slice(0, 5)); })
      .catch(() => { if (!cancelled) setEmployeeResults([]); })
      .finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
  }, [debouncedQuery, canSearchDirectory]);

  const departmentResults = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return [];
    return allDepartments.filter((d) => d.name.toLowerCase().includes(q)).slice(0, 5);
  }, [allDepartments, debouncedQuery]);

  const showSearchDropdown = canSearchDirectory && searchOpen && searchQuery.trim().length >= 2;

  const goToEmployee = (id: string) => {
    setSearchOpen(false);
    router.push(`/dashboard/employees/${id}`);
  };
  const goToDepartment = (id: string) => {
    setSearchOpen(false);
    router.push(`/dashboard/departments/${id}`);
  };

  // Get current page info dynamically
  const currentPage = getPageInfo(pathname);
  const PageIcon = currentPage.icon;
  // Only the Dashboard landing page is translated in this PoC — every other
  // route keeps its current hardcoded English title/subtitle.
  const isDashboardHome = pathname === '/dashboard';

  // A page may declare its own heading via `usePageHeader` (see
  // store/pageHeaderStore.ts). That wins over the static map below, because the
  // page owns the translated text and can express per-record titles the map
  // cannot. Guarded on pathname so an entry left by the page we just navigated
  // away from never paints over the new one.
  const declaredHeader = usePageHeaderStore((s) => s.entry);
  const declared = declaredHeader?.pathname === pathname ? declaredHeader : null;

  // Search is page-scoped: clear it whenever the user navigates away so it
  // doesn't linger and silently filter an unrelated page.
  useEffect(() => {
    setSearchQuery('');
    setSearchOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  const displayTitle =
    declared?.title ?? (isDashboardHome ? t('dashboardTitle') : currentPage.title);
  const displaySubtitle =
    declared?.subtitle ?? (isDashboardHome ? t('dashboardSubtitle') : currentPage.subtitle);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setSearchOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };

  const handleRefresh = () => {
    window.location.reload();
  };

  const displayName = user?.employee?.fullName || user?.email?.split('@')[0] || 'User';
  const initials = displayName
    .split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <header className="h-16 bg-header-bg flex items-center justify-between px-4 md:px-6 sticky top-0 z-30">
      {/* Left: Hamburger (mobile) + Page Title */}
      <div className="flex items-center gap-2 md:gap-4 min-w-0">
        {/* Employees reach the drawer from the phone tab bar's "More" tab, so
            the hamburger would be a second control for the same thing — and at
            390px the ~38px it costs is the difference between "Dashboard" and
            "Dashboa…". Every other role still needs it: their nav is too wide
            for a five-slot bar, so they have no bar. */}
        <button
          onClick={onMenuClick}
          className={`${user?.role === 'EMPLOYEE' ? 'hidden' : 'md:hidden'} p-2 -ms-1 rounded-lg text-text-body hover:bg-surface-page transition-colors shrink-0`}
          aria-label="Open menu"
        >
          <Menu size={22} />
        </button>
        <div className="min-w-0">
          <h1 className="text-base md:text-xl font-bold text-text-heading truncate">{displayTitle}</h1>
          {displaySubtitle && (
            <p className="text-xs text-text-muted truncate hidden sm:block">{displaySubtitle}</p>
          )}
        </div>
      </div>

      {/* Center: Search (desktop only) */}
      <div className="hidden md:flex flex-1 justify-center md:mx-4" ref={searchRef}>
        <div className="relative w-full">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
          <input
            type="text"
            placeholder={user?.role === 'EMPLOYEE' ? 'Search...' : 'Search for employees, departments...'}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchOpen(e.target.value.trim().length >= 2);
            }}
            onFocus={() => { if (searchQuery.trim().length >= 2) setSearchOpen(true); }}
            className="w-full ps-10 pe-4 py-2 border border-surface-border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary text-sm bg-surface-card text-text-body"
          />

          {showSearchDropdown && (
            // `data-clarity-mask` — these rows are employee names, codes and
            // avatars, and the empty state echoes back what was typed into the
            // box. The box itself is masked by Clarity in every mode; its
            // results are not, so they are masked here.
            <div data-clarity-mask="true" className="absolute top-full inset-x-0 mt-2 bg-surface-overlay border border-surface-border rounded-lg shadow-lg max-h-96 overflow-y-auto z-50">
              {searching ? (
                <div className="px-4 py-6 flex items-center justify-center gap-2 text-sm text-text-muted">
                  <Loader2 size={14} className="animate-spin" />
                  Searching...
                </div>
              ) : employeeResults.length === 0 && departmentResults.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-text-muted">
                  No results found for &quot;{searchQuery}&quot;
                </div>
              ) : (
                <>
                  {employeeResults.length > 0 && (
                    <div className="py-1">
                      <p className="px-4 pt-2 pb-1 text-xs font-semibold text-text-muted uppercase">Employees</p>
                      {employeeResults.map((emp) => (
                        <button
                          key={emp.id}
                          onClick={() => goToEmployee(emp.id)}
                          className="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-page text-start"
                        >
                          <Avatar src={emp.avatarUrl} name={emp.fullName} size="sm" alt={emp.fullName} />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-text-heading truncate">{emp.fullName}</p>
                            <p className="text-xs text-text-muted truncate">{emp.employeeCode} · {emp.department?.name || '--'}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {departmentResults.length > 0 && (
                    <div className="py-1 border-t border-surface-border-light">
                      <p className="px-4 pt-2 pb-1 text-xs font-semibold text-text-muted uppercase">Departments</p>
                      {departmentResults.map((dept) => (
                        <button
                          key={dept.id}
                          onClick={() => goToDepartment(dept.id)}
                          className="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-page text-start"
                        >
                          <div className="w-8 h-8 rounded-lg bg-status-info-bg/40 flex items-center justify-center shrink-0">
                            <Building2 size={16} className="text-status-info" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-text-heading truncate">{dept.name}</p>
                            <p className="text-xs text-text-muted truncate">{dept.code}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
        {/* Multi-branch switcher — single point that re-scopes the whole app.
            Renders only for ADMIN / HR_MANAGER (usePermission.canSwitchBranch). */}
        <BranchPicker />

        {/* Refresh Button (only on dashboard) */}
        {pathname === '/dashboard' && (
          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 px-3 py-2 hover:bg-surface-page rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw size={18} className="text-brand-primary" />
          </button>
        )}

        {/* Notifications */}
        <NotificationBell />

        {/* Settings (hidden on mobile — reachable via the drawer) */}
        <button
          onClick={() => router.push('/dashboard/settings')}
          className="hidden sm:block p-2 hover:bg-surface-page rounded-lg transition-colors"
        >
          <Settings size={20} className="text-text-muted" />
        </button>

        {/* Divider */}
        <div className="w-px h-6 bg-surface-border"></div>

        {/* User Menu */}
        {/* `data-clarity-mask` — the signed-in person's name, email address and
            photo. Their ROLE is what Clarity needs to segment a session, and
            that already travels as a custom tag from ClarityProvider. */}
        <div data-clarity-mask="true" className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="flex items-center gap-3 hover:bg-surface-page rounded-lg p-2 transition-colors"
          >
            <div className="text-end hidden sm:block">
              <p className="text-sm font-medium text-text-heading">{displayName}</p>
              <p className="text-xs text-text-muted">{roleLabels[user?.role || 'EMPLOYEE']}</p>
            </div>
            <Avatar
              src={user?.employee?.avatarUrl}
              name={displayName}
              size="md"
              alt={displayName}
            />
            <ChevronDown size={16} className={`text-text-muted transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
          </button>

          {/* Dropdown Menu */}
          {showDropdown && (
            <div className="absolute end-0 mt-2 w-64 bg-surface-overlay rounded-xl shadow-lg border border-surface-border py-2 z-50">
              <div className="px-4 py-3 border-b border-surface-border-light">
                <p className="text-sm font-medium text-text-heading">{displayName}</p>
                <p className="text-xs text-text-muted mb-2">{user?.email}</p>
                {/* Role Badge */}
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-status-info-bg border border-status-info/30 rounded-lg">
                  <div className="w-2 h-2 rounded-full bg-status-info"></div>
                  <span className="text-xs font-semibold text-status-info">
                    {roleLabels[user?.role || 'EMPLOYEE']}
                  </span>
                </div>
              </div>

              <div className="py-1">
                <button
                  onClick={() => {
                    setShowDropdown(false);
                    router.push('/dashboard/profile');
                  }}
                  className="w-full px-4 py-2 text-start text-sm text-text-body hover:bg-surface-page flex items-center gap-3"
                >
                  <User size={16} />
                  Personal Information
                </button>
                <button
                  onClick={() => {
                    setShowDropdown(false);
                    router.push('/dashboard/payroll');
                  }}
                  className="w-full px-4 py-2 text-start text-sm text-text-body hover:bg-surface-page flex items-center gap-3"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                  My paycheck
                </button>
                <button
                  onClick={() => {
                    setShowDropdown(false);
                    router.push('/dashboard/settings');
                  }}
                  className="w-full px-4 py-2 text-start text-sm text-text-body hover:bg-surface-page flex items-center gap-3"
                >
                  <Settings size={16} />
                  Setting
                </button>
              </div>

              <div className="border-t border-surface-border-light pt-1">
                <button
                  onClick={handleLogout}
                  className="w-full px-4 py-2 text-start text-sm text-status-error hover:bg-status-error-bg flex items-center gap-3"
                >
                  <LogOut size={16} />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
