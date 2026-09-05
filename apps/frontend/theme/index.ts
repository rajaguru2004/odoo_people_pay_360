/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THEME INDEX — SINGLE REBRAND CONTROL POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  TO REBRAND FOR A CLIENT:                                               │
 * │  1. Import the client's preset below                                    │
 * │  2. Set activeTheme = thatPreset                                        │
 * │  That's it. Every page, component, and chart updates automatically.     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Example — switch to Emerald:
 *   import { emeraldTheme } from './presets/emerald';
 *   export const activeTheme = emeraldTheme;
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { defaultTheme } from './presets/default';
// import { emeraldTheme } from './presets/emerald';  // ← uncomment to rebrand

import type { ThemeConfig } from './types';

/**
 * Active theme — change this import to switch the entire app brand.
 */
export const activeTheme: ThemeConfig = defaultTheme;

// Re-export types so consumers don't need to import from 'theme/types' directly
export type { ThemeConfig };
