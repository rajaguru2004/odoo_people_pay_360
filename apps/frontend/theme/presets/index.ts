/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THEME PRESET REGISTRY
 * ─────────────────────────────────────────────────────────────────────────────
 * All selectable color presets, keyed by id. The Settings "Theme & Appearance"
 * picker renders from `THEME_PRESETS`; the runtime resolver looks them up via
 * `getPreset(id)`. Adding a preset = create a file + add one entry here.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { ThemeConfig } from '../types';
import { defaultTheme } from './default';
import { emeraldTheme } from './emerald';
import { violetTheme } from './violet';
import { sunsetTheme } from './sunset';

export interface ThemePresetEntry {
  id: string;
  name: string;
  /** Swatch colors shown in the picker card. */
  swatch: {
    primary: string;
    accent: string;
    surface: string;
    sidebar: string;
  };
  config: ThemeConfig;
}

function toEntry(config: ThemeConfig, name: string): ThemePresetEntry {
  const c = config.colors;
  return {
    id: config.id,
    name,
    swatch: {
      primary: c.brandPrimary,
      accent: c.brandAccent,
      surface: c.surfacePage,
      sidebar: c.sidebarSubActiveText,
    },
    config,
  };
}

export const THEME_PRESETS: ThemePresetEntry[] = [
  toEntry(defaultTheme, 'Ocean Blue'),
  toEntry(emeraldTheme, 'Emerald'),
  toEntry(violetTheme, 'Violet'),
  toEntry(sunsetTheme, 'Sunset'),
];

export const DEFAULT_PRESET_ID = 'default';

const PRESET_MAP: Record<string, ThemePresetEntry> = Object.fromEntries(
  THEME_PRESETS.map((p) => [p.id, p]),
);

/** Resolve a preset by id, falling back to the default preset. */
export function getPreset(id: string | undefined | null): ThemePresetEntry {
  return (id && PRESET_MAP[id]) || PRESET_MAP[DEFAULT_PRESET_ID];
}
