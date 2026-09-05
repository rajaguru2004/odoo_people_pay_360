/**
 * Shapes shared by the Finance, Talent and Workplace hub aggregates.
 *
 * There is no backend DTO class for any of them — the controllers return plain
 * objects, exactly as `/attendances/hub-summary` does — so these interfaces ARE
 * the contract. Same arrangement as `types/attendanceHub.ts`, and the same
 * obligation: change one of them and the server has to change with it.
 */

/** The window a hub measured, and the one it compares against. */
export interface HubWindow {
  /** `YYYY-MM`. */
  key: string;
  label: string;
  start: string;
  end: string;
  previous: {
    key: string;
    label: string;
    start: string;
    end: string;
  };
}

/**
 * A change against the previous window.
 *
 * `null` — not a zero-valued delta — when the baseline is unknown. Three hub
 * figures genuinely cannot be reconstructed for a past date (asset and project
 * status have no history table; neither `Reimbursement` nor `LetterRequest`
 * carries a `rejectedAt`), and a card with no badge is the honest rendering of
 * that. A `0%` badge would claim the number held steady.
 */
export interface HubDelta {
  /** Percent change, or 0 when the baseline was 0 and only `absolute` is usable. */
  value: number;
  direction: 'up' | 'down';
  absolute: number;
}

/** One bar of a hub's twelve-month series. */
export interface HubTrendBucket {
  /** `YYYY-MM`. */
  key: string;
  /** `Aug` — the axis label, produced server-side. */
  label: string;
  /** The bar's height: the sum of its segments. */
  value: number;
  segments: Array<{ key: string; value: number }>;
}

/** The envelope every hub controller answers with. */
export interface HubEnvelope<T> {
  success: boolean;
  data: T;
}
