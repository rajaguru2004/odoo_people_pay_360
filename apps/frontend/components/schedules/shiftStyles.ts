import type { ShiftType } from '@/types/attendance';

/**
 * One palette for the roster, read by the grid, the calendar and the shift list.
 *
 * Colour is the only thing distinguishing a morning shift from a night one at a
 * glance across a month of 30px cells, so the mapping has to be the same on
 * every screen. Three copies of it is how a night shift ends up amber in one
 * place and indigo in another and the legend stops meaning anything.
 *
 * Every value is a token, never a raw hex: the portal ships a light and a dark
 * theme, and a hard-coded `#fff7ed` is a cell that is unreadable in one of them.
 */
export interface ShiftPalette {
  /** Cell fill. */
  background: string;
  /** Cell border, and the swatch in the legend. */
  border: string;
  /** Text on `background`. */
  text: string;
}

export const SHIFT_PALETTE: Record<ShiftType, ShiftPalette> = {
  MORNING: {
    background: 'color-mix(in srgb, var(--color-status-warning) 16%, transparent)',
    border: 'color-mix(in srgb, var(--color-status-warning) 45%, transparent)',
    text: 'var(--color-status-warning)',
  },
  AFTERNOON: {
    background: 'color-mix(in srgb, var(--color-brand-accent) 16%, transparent)',
    border: 'color-mix(in srgb, var(--color-brand-accent) 45%, transparent)',
    text: 'var(--color-brand-accent-dark, var(--color-brand-accent))',
  },
  FULL_DAY: {
    background: 'color-mix(in srgb, var(--color-brand-primary) 16%, transparent)',
    border: 'color-mix(in srgb, var(--color-brand-primary) 45%, transparent)',
    text: 'var(--color-brand-primary-dark, var(--color-brand-primary))',
  },
  NIGHT: {
    background: 'color-mix(in srgb, var(--color-status-info) 18%, transparent)',
    border: 'color-mix(in srgb, var(--color-status-info) 48%, transparent)',
    text: 'var(--color-status-info)',
  },
  FLEXIBLE: {
    background: 'color-mix(in srgb, var(--color-status-success) 16%, transparent)',
    border: 'color-mix(in srgb, var(--color-status-success) 45%, transparent)',
    text: 'var(--color-status-success)',
  },
};

/** The lanes that are not a shift: what the day is instead. */
export const DAY_PALETTE = {
  leave: {
    background: 'color-mix(in srgb, var(--color-status-warning) 22%, transparent)',
    border: 'color-mix(in srgb, var(--color-status-warning) 40%, transparent)',
    text: 'var(--color-status-warning)',
  },
  holiday: {
    background: 'color-mix(in srgb, var(--color-status-success) 14%, transparent)',
    border: 'color-mix(in srgb, var(--color-status-success) 30%, transparent)',
    text: 'var(--color-status-success)',
  },
  /**
   * A rest day is SHADING, not a badge.
   *
   * "Weekly off" rather than "weekend": the shaded columns come from the
   * BRANCH's own working week, and an Oman branch rests Friday and Saturday.
   * Calling them the weekend states something the business did not say.
   */
  weeklyOff: {
    background: 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
    border: 'var(--color-surface-border)',
    text: 'var(--color-text-muted)',
  },
} satisfies Record<string, ShiftPalette>;

/**
 * A stable colour for an avatar with no image.
 *
 * Hashed from the name so the same person is the same colour on every screen
 * and across reloads — an avatar that changes hue on refresh is a worse cue
 * than no colour at all.
 */
export function avatarTint(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 55% 45%)`;
}

/** "AB" from a full name, for an avatar with no image. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}
