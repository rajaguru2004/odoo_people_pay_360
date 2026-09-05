import type { ThemeConfig } from '../types';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CLIENT-A PRESET — Example White-Label Rebrand
 * ─────────────────────────────────────────────────────────────────────────────
 * Demonstrates full rebrand capability:
 *   Primary:  #7C3AED  (violet — completely different from default blue)
 *   Accent:   #F59E0B  (amber)
 *   Font:     Inter from Google Fonts
 *
 * TO REBRAND: update theme/index.ts to import this preset.
 * This file is the only thing that changes per client deployment.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const clientATheme: ThemeConfig = {
  id: 'client-a',
  name: 'Client A — Violet Brand',

  colors: {
    // ── Brand ───────────────────────────────────────────────────────────────
    brandPrimary:      '#7C3AED',
    brandPrimaryDark:  '#6D28D9',
    brandPrimaryLight: '#EDE9FE',

    brandAccent:       '#F59E0B',
    brandAccentDark:   '#D97706',

    // ── Status ──────────────────────────────────────────────────────────────
    statusSuccess:   '#059669',
    statusSuccessBg: '#d1fae5',
    statusWarning:   '#D97706',
    statusWarningBg: '#fef3c7',
    statusError:     '#DC2626',
    statusErrorBg:   '#fee2e2',
    statusInfo:      '#7C3AED',
    statusInfoBg:    '#EDE9FE',

    // ── Surface ─────────────────────────────────────────────────────────────
    surfacePage:        '#F5F3FF',   // Violet-tinted page bg
    surfaceCard:        '#ffffff',
    surfaceOverlay:     '#ffffff',
    surfaceBorder:      '#e2e8f0',
    surfaceBorderLight: '#f1f5f9',

    // ── Text ────────────────────────────────────────────────────────────────
    textHeading:  '#1e1b4b',   // Indigo-950
    textBody:     '#374151',
    textMuted:    '#6b7280',
    textOnBrand:  '#ffffff',
    textOnAccent: '#ffffff',

    // ── Sidebar ─────────────────────────────────────────────────────────────
    sidebarBg:            '#1e1b4b',   // Deep violet sidebar
    sidebarBorder:        '#2e2b5e',
    sidebarText:          '#c4b5fd',   // violet-300
    sidebarTextMuted:     '#7c6fcd',
    sidebarActiveBg:      '#7C3AED',
    sidebarActiveText:    '#ffffff',
    sidebarHoverBg:       '#2e2b5e',
    sidebarHoverText:     '#ffffff',
    sidebarSubActiveBg:   '#6D28D9',
    sidebarSubActiveText: '#ffffff',

    // ── Header ──────────────────────────────────────────────────────────────
    headerBg:     '#ffffff',
    headerBorder: '#e2e8f0',
    headerText:   '#1e1b4b',
  },

  typography: {
    fontSans:       "'Inter', system-ui, -apple-system, sans-serif",
    fontMono:       "'JetBrains Mono', ui-monospace, monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },

  shape: {
    radiusCard:   '1rem',      // 16px — more rounded
    radiusButton: '0.625rem',  // 10px
    radiusInput:  '0.625rem',
    radiusBadge:  '9999px',
  },

  brand: {
    appName:    'Nexus HR',
    faviconUrl: null,
  },
};
