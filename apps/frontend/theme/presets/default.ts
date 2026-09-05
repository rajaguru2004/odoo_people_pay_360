import type { ThemeConfig } from '../types';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DEFAULT PRESET — Current HRM Brand (The Company)
 * ─────────────────────────────────────────────────────────────────────────────
 * Primary:  #00358F  (brand blue)
 * Accent:   #f66600  (brand orange — TRS signature color)
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const defaultTheme: ThemeConfig = {
  id: 'default',
  name: 'HRM Default',

  colors: {
    // ── Brand ───────────────────────────────────────────────────────────────
    brandPrimary: '#00358F',
    brandPrimaryDark: '#002570',
    brandPrimaryLight: '#AECCFF',

    brandAccent: '#f66600',
    brandAccentDark: '#cc5200',

    // ── Status ──────────────────────────────────────────────────────────────
    statusSuccess: '#10b981',
    statusSuccessBg: '#d1fae5',
    statusWarning: '#f59e0b',
    statusWarningBg: '#fef3c7',
    statusError: '#ef4444',
    statusErrorBg: '#fee2e2',
    statusInfo: '#3b82f6',
    statusInfoBg: '#dbeafe',

    // ── Surface ─────────────────────────────────────────────────────────────
    surfacePage: '#F4F6FC',
    surfaceCard: '#ffffff',
    surfaceOverlay: '#ffffff',
    surfaceBorder: '#e2e8f0',   // slate-200
    surfaceBorderLight: '#f1f5f9',   // slate-100

    // ── Text ────────────────────────────────────────────────────────────────
    textHeading: '#0f172a',   // slate-900
    textBody: '#334155',   // slate-700
    textMuted: '#64748b',   // slate-500
    textOnBrand: '#ffffff',
    textOnAccent: '#ffffff',

    // ── Sidebar ─────────────────────────────────────────────────────────────
    sidebarBg: '#ffffff',
    sidebarBorder: '#f1f5f9',
    sidebarText: '#475569',   // slate-600
    sidebarTextMuted: '#94a3b8',   // slate-400
    sidebarActiveBg: '#f1f5f9',   // slate-100
    sidebarActiveText: '#0f172a',   // slate-900
    sidebarHoverBg: '#f8fafc',   // slate-50
    sidebarHoverText: '#0f172a',
    sidebarSubActiveBg: '#eff6ff',   // blue-50
    sidebarSubActiveText: '#2563eb',   // blue-600

    // ── Header ──────────────────────────────────────────────────────────────
    headerBg: '#ffffff',
    headerBorder: '#e2e8f0',
    headerText: '#0f172a',
  },

  typography: {
    fontSans: '"Montserrat", sans-serif',
    fontMono: 'var(--font-geist-mono), ui-monospace, monospace',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap',
  },

  shape: {
    radiusCard: '0.75rem',   // 12px — rounded-xl
    radiusButton: '0.5rem',    // 8px  — rounded-lg
    radiusInput: '0.5rem',    // 8px  — rounded-lg
    radiusBadge: '9999px',    // rounded-full
  },

  brand: {
    appName: 'ESS Portal',
    faviconUrl: null,   // Uses /favicon.ico from public/
  },
};
