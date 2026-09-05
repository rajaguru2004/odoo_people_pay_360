'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, LogOut, X } from 'lucide-react';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/common/icons/directional';
import supervisorService from '@/services/supervisorService';
import approvalWorkflowService from '@/services/approvalWorkflowService';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { activeTheme } from '@/theme';
import { buildMenu, FLAG_ROUTES, type MenuItem } from './navConfig';

function SidebarLogo({ className = 'w-7 h-7' }: { className?: string }) {
  const { branding } = useBrandingStore();

  if (branding.company_logo_svg?.trim()) {
    return (
      <div
        className={`${className} flex items-center justify-center [&>svg]:w-full [&>svg]:h-full`}
        dangerouslySetInnerHTML={{ __html: branding.company_logo_svg }}
      />
    );
  }

  if (branding.company_logo_url?.trim()) {
    return (
      <img
        src={branding.company_logo_url}
        alt={branding.company_name}
        className={`${className} object-contain rounded-md`}
      />
    );
  }

  const primary = activeTheme.colors.brandPrimary;
  const primaryDark = activeTheme.colors.brandPrimaryDark;
  const primaryLight = activeTheme.colors.brandPrimaryLight;
  const accent = activeTheme.colors.brandAccent;
  const accentDark = activeTheme.colors.brandAccentDark;

  return (
    <svg viewBox="0 0 100 100" className={className}>
      <path d="M50,15 C55,30 75,35 65,55 C55,75 45,75 35,55 C25,35 45,30 50,15 Z" fill="url(#brandGradient)" />
      <circle cx="50" cy="20" r="6" fill={accent} />
      <path d="M50,45 C65,45 80,30 75,60 C70,90 50,85 50,85 C50,85 30,90 25,60 C20,30 35,45 50,45 Z" fill="url(#brandGradient2)" opacity="0.8" />
      <defs>
        <linearGradient id="brandGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={primaryLight} />
          <stop offset="50%" stopColor={primary} />
          <stop offset="100%" stopColor={primaryDark} />
        </linearGradient>
        <linearGradient id="brandGradient2" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={accent} />
          <stop offset="100%" stopColor={accentDark} />
        </linearGradient>
      </defs>
    </svg>
  );
}

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  /** Below `md`: render as an off-canvas drawer instead of a collapsible rail. */
  isMobile?: boolean;
}

const roleLabelKeys: Record<string, string> = {
  ADMIN: 'roleAdmin',
  HR_MANAGER: 'roleHrManager',
  MANAGER: 'roleManager',
  EMPLOYEE: 'roleEmployee',
};

// ─── Accordion sub-component ─────────────────────────────────────────────────
// Uses a ref to measure real scrollHeight so clipping never happens.
function SubMenu({ open, children }: { open: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    if (open) {
      // Measure after layout so scrollHeight is accurate
      setHeight(ref.current.scrollHeight);
    } else {
      setHeight(0);
    }
  }, [open, children]);

  return (
    <div
      style={{
        height: `${height}px`,
        overflow: 'hidden',
        transition: 'height 0.22s cubic-bezier(0.4,0,0.2,1)',
        willChange: 'height',
      }}
      aria-hidden={!open}
    >
      <div ref={ref}>{children}</div>
    </div>
  );
}

// ─── Collapsed-rail tooltip ──────────────────────────────────────────────────
// The icon rail hides every label, so hovering is the only way to tell two
// icons apart. A native `title` is the wrong tool here: it waits about a second
// before appearing and cannot be styled. Positioned `fixed` through a portal
// because the nav scroller clips on the x axis (`overflow-x-hidden`), so
// anything absolutely positioned inside a row would be cut off at the rail edge.
function RailTooltip({
  label,
  enabled,
  children,
}: {
  label: string;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; rtl: boolean } | null>(null);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The rail is anchored with `start-0`, so in RTL it sits on the right and
    // the tooltip has to flip to the other side of the icon.
    const rtl = document.documentElement.dir === 'rtl';
    setPos({ top: r.top + r.height / 2, left: rtl ? r.left - 12 : r.right + 12, rtl });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  // Expanding the rail mid-hover would otherwise strand an open tooltip.
  useEffect(() => {
    if (!enabled) setPos(null);
  }, [enabled]);

  // Wrapping in a <div> only when collapsed keeps the expanded DOM unchanged.
  if (!enabled) return <>{children}</>;

  return (
    <div ref={ref} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: pos.rtl ? 'translate(-100%, -50%)' : 'translateY(-50%)',
            }}
            className="z-[60] pointer-events-none whitespace-nowrap rounded-lg border border-sidebar-border bg-sidebar-active-text px-2.5 py-1.5 text-xs font-semibold text-sidebar-bg shadow-lg"
          >
            {label}
          </div>,
          document.body,
        )}
    </div>
  );
}

// ─── Main sidebar ─────────────────────────────────────────────────────────────
export default function Sidebar({ isOpen, onToggle, isMobile = false }: SidebarProps) {
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const { branding } = useBrandingStore();
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [isSupervisor, setIsSupervisor] = useState(false);
  const [isApprover, setIsApprover] = useState(false);
  const t = useTranslations('sidebar');

  // A supervisor is any employee assigned supervisees. Drives visibility of the
  // "My Team" ESS item — a data-driven role, not an RBAC role.
  useEffect(() => {
    let active = true;
    if (!user?.employeeId) {
      setIsSupervisor(false);
      return;
    }
    supervisorService
      .getMyTeam()
      .then((res) => {
        if (active) setIsSupervisor(Array.isArray(res.data) && res.data.length > 0);
      })
      .catch(() => {
        if (active) setIsSupervisor(false);
      });
    return () => {
      active = false;
    };
  }, [user?.employeeId]);

  // "Approvals" is not supervisor-only: HR/Admin and department heads sit in the
  // configured chains too, so ask the backend who is actually an approver.
  useEffect(() => {
    let active = true;
    if (!user) {
      setIsApprover(false);
      return;
    }
    approvalWorkflowService
      .canApprove()
      .then((res) => {
        if (active) setIsApprover(Boolean(res.data?.isApprover));
      })
      .catch(() => {
        if (active) setIsApprover(false);
      });
    return () => {
      active = false;
    };
  }, [user?.id, user?.role]);

  // Every payroll-extension route, and the flag that reveals it.
  //
  // A table rather than a chain of `if`s so that adding the next feature is one
  // line here and one line in the menu, and so the dependency key below can be
  // derived from it instead of hand-maintained.
  const payrollFlagsKey = FLAG_ROUTES.map((r) => String(branding?.[r.flag])).join('|');

  // ── Stable menu list (avoid new ref every render which broke useEffect deps) ──
  //
  // The tree, the feature-flag gating and the per-child role narrowing all live
  // in navConfig, because the module landing pages render the same children as
  // tiles and must gate them identically. Only the two data-driven gates below
  // stay here — they depend on fetches this component already makes.
  const menuItems = useMemo(
    () =>
      buildMenu(user?.role, branding).filter((item) => {
        // "My Team" needs supervisees; "Approvals" needs a seat in a chain.
        // Both match on `item.href`, which is why neither may become a child.
        if (!isSupervisor && item.href === '/dashboard/my-team') return false;
        if (!isApprover && item.href === '/dashboard/approvals') return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      user?.role,
      branding?.overtime_enabled,
      branding?.reimbursement_enabled,
      // One derived scalar rather than one entry per flag.
      //
      // Enumerating them individually is the trap: adding a flag and forgetting
      // its dependency means the menu never updates after `fetchBranding()`
      // resolves, which reads as an intermittent bug rather than a missing line.
      payrollFlagsKey,
      isSupervisor,
      isApprover,
    ],
  );

  // ── Active-state helpers (stable via useCallback) ──
  const isItemActive = useCallback(
    (item: MenuItem): boolean => {
      if (item.href === pathname) return true;
      if (item.children) return item.children.some((c) => pathname.startsWith(c.href));
      return false;
    },
    [pathname],
  );

  const isSubItemActive = useCallback(
    (href: string): boolean => {
      if (pathname === href) return true;
      if (href === '/dashboard/departments' && pathname.startsWith('/dashboard/departments/')) {
        if (pathname.startsWith('/dashboard/departments/tree')) return false;
        if (pathname.startsWith('/dashboard/departments/change-requests')) return false;
        if (pathname.startsWith('/dashboard/departments/new')) return false;
        return true;
      }
      if (href === '/dashboard/contracts' && pathname.startsWith('/dashboard/contracts/')) {
        if (pathname.startsWith('/dashboard/contracts/new')) return false;
        if (pathname.startsWith('/dashboard/contracts/terminations')) return false;
        return true;
      }
      if (href === '/dashboard/employees' && pathname.startsWith('/dashboard/employees/')) {
        if (pathname.startsWith('/dashboard/employees/new')) return false;
        return true;
      }
      if (href === '/dashboard/leaves' && pathname.startsWith('/dashboard/leaves/')) {
        if (pathname.startsWith('/dashboard/leaves/new')) return false;
        if (pathname.startsWith('/dashboard/leaves/balances')) return false;
        if (pathname.startsWith('/dashboard/leaves/pending')) return false;
        return true;
      }
      if (href === '/dashboard/projects' && pathname.startsWith('/dashboard/projects/')) {
        return true;
      }
      // Keep Finance ▸ HR Budgets lit on the variance detail page.
      if (href === '/dashboard/budgets' && pathname.startsWith('/dashboard/budgets/')) {
        return true;
      }
      // Keep Talent ▸ Appraisals lit on a run's detail and results pages.
      if (href === '/dashboard/appraisal' && pathname.startsWith('/dashboard/appraisal/')) {
        return true;
      }
      // Organization ▸ Branches — /branches/new has no nav entry of its own.
      if (href === '/dashboard/branches' && pathname.startsWith('/dashboard/branches/')) {
        return true;
      }
      if (href === '/dashboard/timesheets' && pathname.startsWith('/dashboard/timesheets/')) {
        if (pathname.startsWith('/dashboard/timesheets/new')) return false;
        return true;
      }
      return false;
    },
    [pathname],
  );

  // ── Auto-expand only when a *child* route is open ──
  //
  // Landing on a group's own hub must leave the accordion shut: the group label
  // navigates, and the hub page already repeats the same children as tiles, so
  // springing the tree open duplicates what the page is showing. Deep-linking
  // into a child still expands, so the current page stays findable in the tree.
  useEffect(() => {
    const groups = menuItems.filter((item) => item.children?.length);
    // Hub check first, and across every group: a hub href can also appear as
    // one of its own children (ESS "My Attendance"), and there the hub wins.
    if (groups.some((item) => item.href === pathname)) {
      setExpandedItem(null);
      return;
    }
    for (const item of groups) {
      if (item.children!.some((c) => pathname.startsWith(c.href))) {
        setExpandedItem(item.labelKey);
        return; // stop at first match — no redundant setState calls
      }
    }
  }, [pathname]); // intentionally NOT including menuItems/isItemActive to avoid spurious runs

  // ── Accordion toggle ──
  //
  // Only the chevron calls this now. The group's label is a link to its module
  // hub, and the collapsed rail's icon links there too rather than prising the
  // rail open — the hub repeats the same children as tiles, so a user working
  // from the icon rail never has to expand it to get anywhere.
  const toggleExpanded = useCallback((labelKey: string) => {
    setExpandedItem((prev) => (prev === labelKey ? null : labelKey));
  }, []);

  return (
    // Pure CSS width transition — no framer spring, no mid-animation pointer misfire
    <aside
      className={[
        'fixed start-0 top-0 h-screen bg-sidebar-bg border-e border-sidebar-border z-50 flex flex-col shadow-lg',
        'transition-[width,transform] duration-300 ease-in-out will-change-transform',
        // Mobile: full-width drawer that slides in/out. Desktop: always visible,
        // width toggles between the 280px expanded rail and the 80px icon rail.
        isOpen
          ? 'w-[280px] translate-x-0'
          // -translate-x-full is a physical transform (translateX is not writing-mode-aware),
          // so it must flip to +translate-x-full under RTL now that the rail is anchored via
          // `start-0` (which resolves to the right edge in RTL) — otherwise the mobile drawer
          // would slide toward the center instead of off-screen when closed.
          : 'w-[280px] -translate-x-full rtl:translate-x-full md:w-20 md:translate-x-0 rtl:md:translate-x-0',
      ].join(' ')}
    >
      {/* ── Logo (extra padding on mobile reserves room for the ✕) ── */}
      <div className="h-20 flex items-center justify-between px-4 pe-14 md:pe-4 border-b border-sidebar-border bg-sidebar-bg shrink-0">
        {isOpen ? (
          <div className="flex items-center justify-between w-full">
            <Link href="/dashboard" className="flex items-center gap-3 min-w-0 flex-1 hover:opacity-90 transition-opacity">
              <div className="w-11 h-11 bg-surface-card border border-surface-border-light rounded-xl shadow-xs flex items-center justify-center p-1.5 shrink-0 select-none">
                <SidebarLogo className="w-7 h-7" />
              </div>
              {branding.company_name_image_url?.trim() ? (
                <div className="flex min-w-0 flex-1 items-center">
                  <img
                    src={branding.company_name_image_url}
                    alt={branding.company_name}
                    title={branding.company_name}
                    className="max-h-10 w-auto max-w-full object-contain select-none"
                  />
                </div>
              ) : (
                <div className="flex flex-col min-w-0 flex-1">
                  <span
                    className="font-bold text-sidebar-active-text text-[13px] leading-tight font-sans tracking-tight truncate select-none"
                    title={branding.company_name}
                  >
                    {branding.company_name}
                  </span>
                  <span
                    className="text-[10px] font-bold text-sidebar-text-muted tracking-wider uppercase mt-1 select-none truncate"
                    title={branding.company_subtitle}
                  >
                    {branding.company_subtitle}
                  </span>
                </div>
              )}
            </Link>
          </div>
        ) : (
          <Link
            href="/dashboard"
            className="w-11 h-11 bg-surface-card border border-surface-border-light rounded-xl shadow-xs flex items-center justify-center p-1.5 mx-auto shrink-0 select-none hover:bg-sidebar-hover-bg transition-all hover:scale-105 outline-none hover:opacity-90"
            title={branding.company_name}
          >
            <SidebarLogo className="w-7 h-7" />
          </Link>
        )}
      </div>

      {/* ── User Profile Card ── */}
      {user && (
        <div
          className={`shrink-0 transition-colors duration-200 ${
            isOpen
              ? 'mx-3 my-3 p-3 rounded-xl bg-sidebar-hover-bg border border-sidebar-border shadow-xs'
              : 'flex justify-center py-4 border-b border-sidebar-border'
          }`}
        >
          {isOpen ? (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-linear-to-r from-brand-primary to-brand-primary-dark text-text-on-brand flex items-center justify-center font-bold shadow-sm shrink-0 border border-brand-primary-light/20 select-none">
                {user.email?.substring(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-bold text-sidebar-active-text truncate leading-snug">
                  {roleLabelKeys[user.role] ? t(roleLabelKeys[user.role]) : user.role}
                </p>
                <p className="text-[10px] text-sidebar-text-muted font-bold mt-0.5 truncate uppercase tracking-wider select-none">
                  {user.role?.toLowerCase()}
                </p>
              </div>
            </div>
          ) : (
            <RailTooltip
              label={roleLabelKeys[user.role] ? t(roleLabelKeys[user.role]) : user.role}
              enabled={!isOpen}
            >
              <div className="w-10 h-10 rounded-full bg-linear-to-r from-brand-primary to-brand-primary-dark text-text-on-brand flex items-center justify-center font-bold shadow-sm shrink-0 border border-brand-primary-light/20 select-none">
                {user.email?.substring(0, 2).toUpperCase()}
              </div>
            </RailTooltip>
          )}
        </div>
      )}

      {/* ── Navigation ── */}
      <nav className="flex-1 py-4 overflow-y-auto overflow-x-hidden custom-scrollbar">
        <ul className="space-y-1 px-3">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = isItemActive(item);
            const isExpanded = expandedItem === item.labelKey;
            const hasChildren = Boolean(item.children?.length);

            return (
              <li key={item.labelKey}>
                {/* ── Parent row ── */}
                {hasChildren ? (
                  // Two sibling controls, never one nested in the other: the
                  // label navigates to the module hub, the chevron opens the
                  // accordion in place. A <button> inside an <a> is invalid
                  // markup and swallows one of the two intents.
                  <RailTooltip label={t(item.labelKey)} enabled={!isOpen}>
                  <div
                    className={[
                      'flex items-center rounded-xl',
                      'transition-colors duration-150',
                      isActive
                        ? 'bg-sidebar-active-bg text-sidebar-active-text font-bold shadow-sm'
                        : 'text-sidebar-text hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text',
                    ].join(' ')}
                  >
                    <Link
                      href={item.href!}
                      className={[
                        // `min-h-11` only below md: the drawer is what the phone
                        // tab bar's "More" opens, so these are real thumb
                        // targets there — 40px on a phone, unchanged at ≥768px
                        // where they are mouse targets in an always-open rail.
                        'flex items-center gap-3 min-w-0 flex-1 px-3 py-2.5 rounded-xl min-h-11 md:min-h-0',
                        'outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0',
                        !isOpen ? 'justify-center' : '',
                      ].join(' ')}
                    >
                      <Icon
                        size={20}
                        className={`shrink-0 ${isActive ? 'text-sidebar-active-text' : 'text-sidebar-text-muted'}`}
                      />
                      {isOpen && (
                        <span className="text-sm flex-1 text-start whitespace-nowrap truncate">
                          {t(item.labelKey)}
                        </span>
                      )}
                    </Link>
                    {isOpen && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(item.labelKey)}
                        aria-expanded={isExpanded}
                        aria-label={t('toggleSubmenu', { section: t(item.labelKey) })}
                        className={[
                          'shrink-0 flex items-center justify-center w-11 h-11 md:w-10 md:h-10 me-0.5 rounded-lg',
                          'hover:bg-sidebar-hover-bg',
                          'outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0',
                        ].join(' ')}
                      >
                        <ChevronDown
                          size={16}
                          className={[
                            isActive ? 'text-sidebar-active-text' : 'text-sidebar-text-muted',
                            'transition-transform duration-200 ease-in-out',
                            isExpanded ? 'rotate-180' : 'rotate-0',
                          ].join(' ')}
                        />
                      </button>
                    )}
                  </div>
                  </RailTooltip>
                ) : (
                  <RailTooltip label={t(item.labelKey)} enabled={!isOpen}>
                  <Link
                    href={item.href!}
                    className={[
                      'flex items-center gap-3 px-3 py-2.5 rounded-xl min-h-11 md:min-h-0',
                      'transition-colors duration-150',
                      'outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0',
                      isActive
                        ? 'bg-sidebar-active-bg text-sidebar-active-text font-bold shadow-sm'
                        : 'text-sidebar-text hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text',
                      !isOpen ? 'justify-center' : '',
                    ].join(' ')}
                  >
                    <Icon
                      size={20}
                      className={`shrink-0 ${isActive ? 'text-sidebar-active-text' : 'text-sidebar-text-muted'}`}
                    />
                    {isOpen && <span className="text-sm whitespace-nowrap">{t(item.labelKey)}</span>}
                  </Link>
                  </RailTooltip>
                )}

                {/* ── Submenu accordion (real scrollHeight, no guessing) ── */}
                {hasChildren && (
                  <SubMenu open={isOpen && isExpanded}>
                    <ul className="mt-1 ms-[22px] py-1 space-y-1">
                      {item.children!.map((child) => {
                        const childActive = isSubItemActive(child.href);
                        return (
                          <li
                            key={`${item.labelKey}-${child.href}`}
                            className={[
                              'relative',
                              // Trunk line — runs the full height of the row and bridges the
                              // space-y-1 gap into the next row; stops halfway on the last child.
                              "before:content-[''] before:absolute before:start-2 before:top-0 before:-bottom-1 before:w-px before:bg-sidebar-text-muted/25",
                              'last:before:bottom-auto last:before:h-1/2',
                              // Elbow curve — bends the trunk into this row.
                              "after:content-[''] after:absolute after:start-2 after:top-0 after:h-1/2 after:w-3",
                              'after:border-s after:border-b after:border-sidebar-text-muted/25 after:rounded-es-lg',
                            ].join(' ')}
                          >
                            <Link
                              href={child.href}
                              className={[
                                'relative flex items-center gap-2.5 ps-7 pe-3 py-2 rounded-xl text-sm min-h-11 md:min-h-0',
                                'transition-colors duration-150',
                                'outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0',
                                childActive
                                  ? 'bg-sidebar-sub-active-bg text-sidebar-sub-active-text font-semibold shadow-sm'
                                  : 'text-sidebar-text hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text',
                              ].join(' ')}
                            >
                              <span className="truncate">{t(child.labelKey)}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </SubMenu>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ── Logout ── */}
      <div className="p-3 border-t border-sidebar-border bg-sidebar-bg shrink-0">
        <RailTooltip label={t('logout')} enabled={!isOpen}>
        <button
          onClick={logout}
          className={[
            'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg min-h-11 md:min-h-0',
            'transition-colors duration-150 text-status-error hover:bg-status-error-bg hover:text-status-error font-medium text-sm',
            'outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0',
            !isOpen ? 'justify-center' : '',
          ].join(' ')}
        >
          <LogOut size={20} className="shrink-0" />
          {isOpen && <span>{t('logout')}</span>}
        </button>
        </RailTooltip>
      </div>

      {/* ── Mobile close button (drawer only; desktop uses the floating toggle) ── */}
      {isMobile && (
        <button
          onClick={onToggle}
          className="md:hidden absolute top-6 end-3 w-11 h-11 flex items-center justify-center rounded-lg text-sidebar-text hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text transition-colors z-50"
          aria-label="Close menu"
        >
          <X size={20} />
        </button>
      )}

      {/* ── Floating Toggle Button (desktop only) ── */}
      <button
        onClick={onToggle}
        className="hidden md:flex absolute top-[40px] -end-3.5 -translate-y-1/2 w-7 h-7 bg-sidebar-bg border border-sidebar-border rounded-full shadow-md items-center justify-center text-sidebar-text hover:bg-sidebar-hover-bg hover:text-sidebar-hover-text transition-all duration-200 hover:scale-110 z-50 outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 cursor-pointer"
        title={isOpen ? 'Collapse Menu' : 'Expand Menu'}
      >
        {isOpen ? <ChevronLeftIcon size={14} strokeWidth={2.5} /> : <ChevronRightIcon size={14} strokeWidth={2.5} />}
      </button>
    </aside>
  );
}
