/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THEME RESOLVER
 * ─────────────────────────────────────────────────────────────────────────────
 * Combines a color preset + a font choice (+ optional custom overrides) into a
 * single ThemeConfig the ThemeProvider applies to the DOM. The resolved `id`
 * encodes every input so the provider's Google-font de-dupe re-injects when
 * anything changes.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { ThemeConfig, ThemeColors } from './types';
import { getPreset } from './presets';
import { getFont, buildGoogleFontUrl } from './fonts';

/** Brand color keys the user may override in "Custom" mode. */
export const CUSTOM_COLOR_KEYS = [
  'brandPrimary',
  'brandPrimaryDark',
  'brandPrimaryLight',
  'brandAccent',
  'brandAccentDark',
] as const;

export type CustomColorKey = (typeof CUSTOM_COLOR_KEYS)[number];
export type CustomColors = Partial<Pick<ThemeColors, CustomColorKey>>;

export interface ThemeCustom {
  /** Brand color overrides (used when presetId === 'custom'). */
  colors?: CustomColors;
  /** Google Font family name (used when fontId === 'custom'). */
  fontFamily?: string;
  /** Optional full stylesheet URL override; takes precedence over fontFamily. */
  fontUrl?: string;
}

const isHex = (v: unknown): v is string =>
  typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());

export function resolveTheme(
  presetId: string | undefined | null,
  fontId: string | undefined | null,
  custom?: ThemeCustom,
): ThemeConfig {
  const isCustomColors = presetId === 'custom';
  const base = getPreset(isCustomColors ? 'default' : presetId);

  // ── Colors ────────────────────────────────────────────────────────────────
  let colors = base.config.colors;
  if (isCustomColors && custom?.colors) {
    const overrides: CustomColors = {};
    for (const key of CUSTOM_COLOR_KEYS) {
      const val = custom.colors[key];
      if (isHex(val)) overrides[key] = val.trim();
    }
    colors = { ...colors, ...overrides };
  }

  // ── Font ──────────────────────────────────────────────────────────────────
  let fontSans: string;
  let googleFontsUrl: string | null;
  let fontTag: string;
  if (fontId === 'custom' && custom?.fontFamily?.trim()) {
    const family = custom.fontFamily.trim();
    fontSans = `"${family}", system-ui, -apple-system, sans-serif`;
    googleFontsUrl = custom.fontUrl?.trim() || buildGoogleFontUrl(family);
    fontTag = `custom-${family.toLowerCase().replace(/\s+/g, '-')}`;
  } else {
    const font = getFont(fontId);
    fontSans = font.fontStack;
    googleFontsUrl = font.googleFontsUrl;
    fontTag = font.id;
  }

  // Encode every input into the id so font/CSS re-apply on any change.
  const colorTag = isCustomColors
    ? `custom-${CUSTOM_COLOR_KEYS.map((k) => colors[k]).join('')}`
    : base.id;

  return {
    ...base.config,
    id: `${colorTag}__${fontTag}`,
    colors,
    typography: {
      ...base.config.typography,
      fontSans,
      googleFontsUrl,
    },
  };
}
