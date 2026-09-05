import type { ThemeConfig } from '../types';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EMERALD PRESET — Light, green/teal brand
 * ─────────────────────────────────────────────────────────────────────────────
 * Primary:  #047857  (emerald-700)
 * Accent:   #f59e0b  (amber)
 * Colors-only variant. Shape/typography/brand mirror the default preset; the
 * resolver overrides the font at runtime.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const emeraldTheme: ThemeConfig = {
  id: 'emerald',
  name: 'Emerald',

  colors: {
    // ── Brand ───────────────────────────────────────────────────────────────
    brandPrimary:      '#047857',
    brandPrimaryDark:  '#035e44',
    brandPrimaryLight: '#A7F3D0',

    brandAccent:       '#f59e0b',
    brandAccentDark:   '#d97706',

    // ── Status ──────────────────────────────────────────────────────────────
    statusSuccess:   '#10b981',
    statusSuccessBg: '#d1fae5',
    statusWarning:   '#f59e0b',
    statusWarningBg: '#fef3c7',
    statusError:     '#ef4444',
    statusErrorBg:   '#fee2e2',
    statusInfo:      '#0ea5e9',
    statusInfoBg:    '#e0f2fe',

    // ── Surface ─────────────────────────────────────────────────────────────
    surfacePage:        '#F1F8F5',   // faint emerald tint
    surfaceCard:        '#ffffff',
    surfaceOverlay:     '#ffffff',
    surfaceBorder:      '#e2e8f0',   // slate-200
    surfaceBorderLight: '#f1f5f9',   // slate-100

    // ── Text ────────────────────────────────────────────────────────────────
    textHeading:  '#0f172a',   // slate-900
    textBody:     '#334155',   // slate-700
    textMuted:    '#64748b',   // slate-500
    textOnBrand:  '#ffffff',
    textOnAccent: '#ffffff',

    // ── Sidebar (light) ─────────────────────────────────────────────────────
    sidebarBg:           '#ffffff',
    sidebarBorder:       '#f1f5f9',
    sidebarText:         '#475569',   // slate-600
    sidebarTextMuted:    '#94a3b8',   // slate-400
    sidebarActiveBg:     '#f1f5f9',   // slate-100
    sidebarActiveText:   '#0f172a',   // slate-900
    sidebarHoverBg:      '#f8fafc',   // slate-50
    sidebarHoverText:    '#0f172a',
    sidebarSubActiveBg:  '#ecfdf5',   // emerald-50
    sidebarSubActiveText:'#047857',   // emerald-700

    // ── Header ──────────────────────────────────────────────────────────────
    headerBg:     '#ffffff',
    headerBorder: '#e2e8f0',
    headerText:   '#0f172a',
  },

  typography: {
    fontSans:       '"Montserrat", sans-serif',
    fontMono:       'var(--font-geist-mono), ui-monospace, monospace',
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap',
  },

  shape: {
    radiusCard:   '0.75rem',
    radiusButton: '0.5rem',
    radiusInput:  '0.5rem',
    radiusBadge:  '9999px',
  },

  brand: {
    appName:    'People Pay 360',
    faviconUrl: null,
  },
};
