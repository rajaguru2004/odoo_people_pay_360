/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THEME CONFIG TYPE
 * ─────────────────────────────────────────────────────────────────────────────
 * All client presets MUST satisfy this interface.
 * Dark-mode tokens deferred — will be added in a future phase.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface ThemeColors {
  // ── Brand ─────────────────────────────────────────────────────────────────
  /** Primary brand color — CTA buttons, active nav, key accents */
  brandPrimary: string;
  /** Darker shade of primary — hover states */
  brandPrimaryDark: string;
  /** Very light tint of primary — subtle backgrounds, focus rings */
  brandPrimaryLight: string;
  /** Secondary/accent color — highlights, secondary CTAs */
  brandAccent: string;
  /** Darker shade of accent — hover states */
  brandAccentDark: string;

  // ── Status ────────────────────────────────────────────────────────────────
  statusSuccess: string;
  statusSuccessBg: string;
  statusWarning: string;
  statusWarningBg: string;
  statusError: string;
  statusErrorBg: string;
  statusInfo: string;
  statusInfoBg: string;

  // ── Surface ───────────────────────────────────────────────────────────────
  /** Page/app background */
  surfacePage: string;
  /** Card, panel, widget background */
  surfaceCard: string;
  /** Dropdown, modal, popover background */
  surfaceOverlay: string;
  /** Default border color */
  surfaceBorder: string;
  /** Subtle border color */
  surfaceBorderLight: string;

  // ── Text ──────────────────────────────────────────────────────────────────
  textHeading: string;
  textBody: string;
  textMuted: string;
  /** Text color to use ON brand-primary backgrounds */
  textOnBrand: string;
  /** Text color to use ON accent backgrounds */
  textOnAccent: string;

  // ── Sidebar ───────────────────────────────────────────────────────────────
  sidebarBg: string;
  sidebarBorder: string;
  sidebarText: string;
  sidebarTextMuted: string;
  sidebarActiveBg: string;
  sidebarActiveText: string;
  sidebarHoverBg: string;
  sidebarHoverText: string;
  /** Active sub-item background */
  sidebarSubActiveBg: string;
  /** Active sub-item text */
  sidebarSubActiveText: string;

  // ── Header ────────────────────────────────────────────────────────────────
  headerBg: string;
  headerBorder: string;
  headerText: string;
}

export interface ThemeTypography {
  /** Primary sans-serif font stack */
  fontSans: string;
  /** Monospace font stack */
  fontMono: string;
  /**
   * Optional Google Fonts URL to inject at runtime.
   * If null, no external font is loaded.
   * Example: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
   */
  googleFontsUrl: string | null;
}

export interface ThemeShape {
  /** Border radius for cards and panels */
  radiusCard: string;
  /** Border radius for buttons */
  radiusButton: string;
  /** Border radius for form inputs */
  radiusInput: string;
  /** Border radius for badges/chips */
  radiusBadge: string;
}

export interface ThemeBrand {
  /** Display name of the application/client */
  appName: string;
  /**
   * URL for the browser tab favicon.
   * If null, uses the Next.js default favicon.ico.
   */
  faviconUrl: string | null;
}

export interface ThemeConfig {
  /** Unique identifier for this preset (e.g. "default", "emerald") */
  id: string;
  /** Human-readable name for this theme */
  name: string;
  colors: ThemeColors;
  typography: ThemeTypography;
  shape: ThemeShape;
  brand: ThemeBrand;
}
