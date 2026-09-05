'use client';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THEME PROVIDER
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads the active ThemeConfig and writes all tokens as CSS custom properties
 * onto <html> at runtime. Also handles:
 *   - Dynamic Google Fonts injection (per-theme font loading)
 *   - Favicon injection (per-client favicon)
 *   - React context so any component can read typed theme values
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { activeTheme } from './index';
import { resolveTheme } from './resolveTheme';
import { setChartTheme } from './chartColors';
import { useBrandingStore } from '@/store/brandingStore';
import type { ThemeConfig } from './types';

// ── Context ───────────────────────────────────────────────────────────────────

const ThemeContext = createContext<ThemeConfig>(activeTheme);

/**
 * Hook — access the current theme config from any component.
 * Usage: const theme = useTheme();
 */
export function useTheme(): ThemeConfig {
  return useContext(ThemeContext);
}

// ── CSS variable map ──────────────────────────────────────────────────────────

function applyThemeToDom(theme: ThemeConfig): void {
  const root = document.documentElement;
  const c = theme.colors;
  const s = theme.shape;
  const t = theme.typography;

  const vars: Record<string, string> = {
    // Brand
    '--color-brand-primary':       c.brandPrimary,
    '--color-brand-primary-dark':  c.brandPrimaryDark,
    '--color-brand-primary-light': c.brandPrimaryLight,
    '--color-brand-accent':        c.brandAccent,
    '--color-brand-accent-dark':   c.brandAccentDark,

    // Status
    '--color-status-success':    c.statusSuccess,
    '--color-status-success-bg': c.statusSuccessBg,
    '--color-status-warning':    c.statusWarning,
    '--color-status-warning-bg': c.statusWarningBg,
    '--color-status-error':      c.statusError,
    '--color-status-error-bg':   c.statusErrorBg,
    '--color-status-info':       c.statusInfo,
    '--color-status-info-bg':    c.statusInfoBg,

    // Surface
    '--color-surface-page':         c.surfacePage,
    '--color-surface-card':         c.surfaceCard,
    '--color-surface-overlay':      c.surfaceOverlay,
    '--color-surface-border':       c.surfaceBorder,
    '--color-surface-border-light': c.surfaceBorderLight,

    // Text
    '--color-text-heading':   c.textHeading,
    '--color-text-body':      c.textBody,
    '--color-text-muted':     c.textMuted,
    '--color-text-on-brand':  c.textOnBrand,
    '--color-text-on-accent': c.textOnAccent,

    // Sidebar
    '--color-sidebar-bg':              c.sidebarBg,
    '--color-sidebar-border':          c.sidebarBorder,
    '--color-sidebar-text':            c.sidebarText,
    '--color-sidebar-text-muted':      c.sidebarTextMuted,
    '--color-sidebar-active-bg':       c.sidebarActiveBg,
    '--color-sidebar-active-text':     c.sidebarActiveText,
    '--color-sidebar-hover-bg':        c.sidebarHoverBg,
    '--color-sidebar-hover-text':      c.sidebarHoverText,
    '--color-sidebar-sub-active-bg':   c.sidebarSubActiveBg,
    '--color-sidebar-sub-active-text': c.sidebarSubActiveText,

    // Header
    '--color-header-bg':     c.headerBg,
    '--color-header-border': c.headerBorder,
    '--color-header-text':   c.headerText,

    // Shape
    '--radius-card':   s.radiusCard,
    '--radius-button': s.radiusButton,
    '--radius-input':  s.radiusInput,
    '--radius-badge':  s.radiusBadge,

    // Typography
    '--font-brand-sans': t.fontSans,
    '--font-brand-mono': t.fontMono,
  };

  for (const [property, value] of Object.entries(vars)) {
    root.style.setProperty(property, value);
  }
}

// ── Google Fonts injection ────────────────────────────────────────────────────

function injectGoogleFont(url: string, themeId: string): void {
  const existingId = `theme-font-${themeId}`;
  if (document.getElementById(existingId)) return; // already injected

  // Remove any previously injected theme font link
  const old = document.querySelector('[data-theme-font]');
  old?.remove();

  const link = document.createElement('link');
  link.id = existingId;
  link.rel = 'stylesheet';
  link.href = url;
  link.setAttribute('data-theme-font', 'true');
  document.head.appendChild(link);
}

// ── Favicon injection ─────────────────────────────────────────────────────────

function injectFavicon(faviconUrl: string): void {
  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = faviconUrl;
}

// ── Provider component ────────────────────────────────────────────────────────

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  // Resolve the live theme from the company-wide branding settings. The store
  // is seeded with the defaults and hydrated by fetchBranding() on mount, so
  // changing the preset/font (in Settings or after a fetch) re-applies live.
  const presetId = useBrandingStore((s) => s.branding.theme_preset);
  const fontId = useBrandingStore((s) => s.branding.theme_font);
  const customColorsJson = useBrandingStore((s) => s.branding.theme_custom_colors);
  const customFontFamily = useBrandingStore((s) => s.branding.theme_custom_font_family);
  const customFontUrl = useBrandingStore((s) => s.branding.theme_custom_font_url);
  const theme = useMemo(() => {
    let colors;
    try {
      colors = customColorsJson ? JSON.parse(customColorsJson) : undefined;
    } catch {
      colors = undefined;
    }
    return resolveTheme(presetId, fontId, {
      colors,
      fontFamily: customFontFamily,
      fontUrl: customFontUrl,
    });
  }, [presetId, fontId, customColorsJson, customFontFamily, customFontUrl]);

  useEffect(() => {
    // Keep Recharts (which reads hex values, not CSS vars) in sync
    setChartTheme(theme);

    // Apply CSS vars to DOM
    applyThemeToDom(theme);

    // Inject Google Fonts if theme requires it
    if (theme.typography.googleFontsUrl) {
      injectGoogleFont(theme.typography.googleFontsUrl, theme.id);
    }

    // Inject favicon if theme overrides it
    if (theme.brand.faviconUrl) {
      injectFavicon(theme.brand.faviconUrl);
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={theme}>
      {children}
    </ThemeContext.Provider>
  );
}
