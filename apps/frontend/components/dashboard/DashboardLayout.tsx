'use client';

import React, { useState, useEffect, memo, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import Sidebar from './Sidebar';
import TopHeader from './TopHeader';
import MobileTabBar from './MobileTabBar';
import ChatbotWidget from '../chatbot/ChatbotWidget';
import PageBreadcrumbs from '@/components/common/PageBreadcrumbs';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { useBranchStore } from '@/store/branchStore';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import systemSettingsService from '@/services/systemSettingsService';
import { setDefaultCurrency, setDefaultDateFormat } from '@/utils/formatters';

interface DashboardLayoutProps {
  children: React.ReactNode;
  disableMainScroll?: boolean;
}

const DashboardLayout = memo(function DashboardLayout({ children, disableMainScroll }: DashboardLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();

  // Use selectors to prevent re-renders when unrelated state changes
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isLoading = useAuthStore((state) => state.isLoading);
  const loadUser = useAuthStore((state) => state.loadUser);
  const userDateFormat = useAuthStore((state) => state.user?.dateFormat);
  // The phone tab bar is an ESS affordance: five slots cannot carry the
  // admin/HR nav tree, and those roles' mobile pass has not been designed yet.
  const isEssUser = useAuthStore((state) => state.user?.role) === 'EMPLOYEE';
  const { branding } = useBrandingStore();
  const isMobile = useIsMobile();
  // Active branch selector. Changing it re-keys the page content below so the
  // whole screen remounts and re-fetches under the new X-Branch-Id header —
  // covering both react-query and plain useEffect/useState screens without a
  // full browser reload.
  const selectedBranchId = useBranchStore((state) => state.selectedBranchId);

  // Seed from viewport width so the mobile drawer starts closed on first paint
  // (no open-then-close flash). The shell only renders after `mounted`, so this
  // never causes a hydration mismatch.
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 768
  );
  const [mounted, setMounted] = useState(false);
  // Bumped once the global payroll currency loads, to re-render children that
  // already painted amounts with the fallback currency.
  const [, setCurrencyReady] = useState(false);

  // Default the sidebar to hidden (drawer) on mobile and expanded on desktop.
  // Only fires when the breakpoint actually crosses, so it never fights a
  // desktop user who manually collapsed the rail.
  useEffect(() => {
    setSidebarOpen(!isMobile);
  }, [isMobile]);

  // Close the mobile drawer on navigation so it doesn't cover the new page.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [pathname, isMobile]);

  // Overtime route guard
  useEffect(() => {
    if (mounted && branding?.overtime_enabled === false) {
      if (pathname.startsWith('/dashboard/overtime') || pathname.startsWith('/dashboard/my-overtime')) {
        router.push('/dashboard');
      }
    }
  }, [mounted, branding?.overtime_enabled, pathname, router]);

  // Memoize toggle function to prevent re-creating on every render
  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  // Load user only once on mount
  useEffect(() => {
    setMounted(true);
    loadUser();
  }, [loadUser]);

  // Apply the employee's personal date-format preference so every formatDate()/
  // formatDateTime() across the dashboard renders in their chosen order.
  useEffect(() => {
    setDefaultDateFormat(userDateFormat);
  }, [userDateFormat]);

  // Load the global payroll currency once so every formatCurrency() call across
  // the dashboard renders the configured currency/symbol (e.g. OMR "ر.ع." for an
  // Oman preset) instead of the hardcoded INR default. Uses the public settings
  // endpoint so it works for all roles, including employees viewing payslips.
  useEffect(() => {
    systemSettingsService
      .getPublic()
      .then((res) => {
        if (res?.success) {
          setDefaultCurrency(
            res.data?.payroll_currency,
            res.data?.payroll_currency_symbol,
            res.data?.payroll_currency_display,
          );
          setCurrencyReady(true);
        }
      })
      .catch(() => {
        /* non-fatal: fall back to INR default */
      });
  }, []);

  // Redirect if not authenticated (after mount to avoid hydration mismatch)
  useEffect(() => {
    if (mounted && !isLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [mounted, isAuthenticated, isLoading, router]);

  // Show loading state
  if (!mounted || isLoading) {
    return (
      <div className="min-h-screen bg-surface-page flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
          <p className="text-text-muted font-medium">Loading...</p>
        </div>
      </div>
    );
  }

  // Don't render if not authenticated
  if (!isAuthenticated) {
    return null;
  }

  return (
    <LocaleProvider>
      {/* `100svh`, not `100vh`: on mobile Safari `vh` is the viewport with the
          URL bar RETRACTED, so an `h-screen` shell is taller than what is
          actually on screen and the bottom of `<main>` — where the tab bar and
          the last card live — sits below the fold until the user scrolls the
          browser chrome away. `svh` equals `vh` on every desktop engine (no
          dynamic toolbar), so the approved desktop layout is unchanged. */}
      <div className="h-[100svh] overflow-hidden bg-surface-page flex">
        {/* Sidebar (off-canvas drawer on mobile, fixed rail on desktop) */}
        <Sidebar isOpen={sidebarOpen} onToggle={toggleSidebar} isMobile={isMobile} />

        {/* Mobile drawer backdrop — sits under the sidebar (z-50), over content */}
        <AnimatePresence>
          {isMobile && sidebarOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={toggleSidebar}
              className="fixed inset-0 bg-black/40 z-40 md:hidden"
              aria-hidden="true"
            />
          )}
        </AnimatePresence>

        {/* Main Content — no inline-start margin on mobile; rail-aware margin on desktop.
            Coupled to Sidebar's own start-0/w-[280px]/w-20 — must change together. */}
        {/* `min-w-0` alongside `min-h-0`: the sidebar is `fixed` and this column
            clears it with a 280px margin, so the column plus that margin has to
            fit inside a shell that is `overflow-hidden`. With the default
            `min-width: auto` the column refused to shrink below its content and
            the sum came to 1608px in a 1440px window — 168px of the right-hand
            side, including the fifth KPI card, was clipped away with no
            scrollbar to reveal it. */}
        <div className={`flex-1 min-h-0 min-w-0 flex flex-col transition-all duration-300 ms-0 ${sidebarOpen ? 'md:ms-[280px]' : 'md:ms-20'}`}>
          {/* Top Header */}
          <TopHeader onMenuClick={toggleSidebar} />

          {/* Page Content */}
          {/* `min-w-0` is load-bearing. Without it this flex child refuses to
              shrink below the max-content width of whatever it holds, and the
              shell it sits in is `overflow-hidden` — so the excess is not
              scrollable, it is CLIPPED. On the Organization hub that silently
              cut 144px off the right: the fifth KPI card and the edge of the
              branch panel were simply not on the page at 1440. */}
          {/* `data-clarity-mask` — session-replay privacy, and it is load-bearing.
              Clarity's default masking hides input boxes, numbers and email
              addresses but NOT plain text, so without this attribute a
              recording of the employee list uploads every name, and a
              recording of a grievance uploads its body. Masking the routed
              page (and its breadcrumbs, which carry record names) leaves the
              shell — sidebar, header, buttons, layout — readable, which is
              where the UX questions Clarity is here to answer actually live.
              The attribute overrides the project's masking mode, so this holds
              whatever the Clarity dashboard is set to. See
              docs/ANALYTICS-CLARITY.md. */}
          {/* `pb-mobile-tabbar` clears the fixed ESS tab bar (56px + the home
              indicator) so the last card on a phone is not sitting underneath
              it. Desktop padding is untouched — the class is a no-op at ≥768px. */}
          <main data-clarity-mask="true" className={`flex-1 min-w-0 p-4 md:p-6 overflow-y-auto custom-scrollbar ${isEssUser ? 'pb-mobile-tabbar' : ''} ${disableMainScroll ? 'lg:overflow-hidden' : ''}`}>
            {/*
              LOAD-BEARING: `key={selectedBranchId}` remounts the entire routed
              page subtree on branch switch, so every manual `useEffect` fetch
              re-runs under the new X-Branch-Id. Most pages/widgets do NOT include
              the selected branch in their effect deps and rely on this remount —
              do not remove this key without adding branch to those deps first.
            */}
            <div className="max-w-7xl mx-auto" key={selectedBranchId ?? 'all'}>
              {/*
                One trail for every screen, rendered here rather than in each
                page: the route already knows where it sits in the nav tree, so
                a hundred pages do not each have to say so, and a route that
                moves cannot leave a hand-written crumb behind.
              */}
              <PageBreadcrumbs />
              {children}
            </div>
          </main>
        </div>

        {/* ESS bottom tab bar — phones only, employees only. */}
        {isEssUser && <MobileTabBar onMoreClick={toggleSidebar} />}

        {/* Chatbot Widget */}
        <ChatbotWidget />
      </div>
    </LocaleProvider>
  );
});

export default DashboardLayout;
