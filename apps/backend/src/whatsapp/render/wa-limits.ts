/**
 * WhatsApp's surface limits, in one file.
 *
 * Every value here was established by probing the live Evolution build against a
 * real handset rather than read off a spec, because the Business Cloud API and
 * the Baileys build behind Evolution disagree in both directions. Each constant
 * cites the probe that settled it; anything marked ASSUMED has not been observed
 * and is the conservative reading.
 *
 * Two of these are not cosmetic — exceeding them is a 400 from Evolution, which
 * means a dropped reply rather than a truncated one:
 *
 *  - more than THREE reply buttons             -> "Maximum of 3 reply buttons allowed"
 *  - mixing reply buttons with any other type  -> "Reply buttons cannot be mixed
 *                                                  with other button types"
 */

export const WA_BUTTONS = {
  /** Hard server-side cap. Exceeding it is a 400, not a silent drop. (P2) */
  replyMax: 3,
  /** CTA buttons (url/copy/call). WhatsApp's own UI documents 2. (P4) */
  ctaMax: 2,
  label: 20,
  /**
   * Card header and body. The card renders these INSTEAD of the plain text, so
   * the reply itself has to fit here — truncating is better than a card that
   * shows a prompt and drops the answer.
   */
  title: 60,
  description: 1024,
} as const;

export const WA_LIST = {
  /** The API accepted 6 sections without complaint. (P7) */
  maxSections: 10,
  maxRowsPerSection: 10,
  /**
   * TOTAL rows across all sections.
   *
   * Evolution accepted 15 (P7) — it does not enforce a cap — but the WhatsApp
   * client is the one that decides what renders, and the Cloud API's documented
   * limit is 10. Ten is therefore the number we design the menu around; the
   * group-picker path in menu-renderer.ts exists so exceeding it degrades to a
   * two-level menu instead of a silently truncated one. ASSUMED, pending a
   * handset render count.
   */
  maxRowsTotal: 10,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  buttonText: 20,
  title: 60,
  description: 1024,
  footerText: 60,
} as const;

export const WA_POLL = { maxOptions: 12, optionLen: 100 } as const;

/**
 * Callback ids and list row ids share a budget, because both are round-tripped
 * through WhatsApp and both are parsed by decodeCallback. A 200-char rowId was
 * accepted (P9), which is what makes an approval token survive inside one.
 */
export const WA_ID_MAX = 200;

/** Refuse a media payload larger than this rather than buffer it. */
export const WA_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Truncate to `max`, preferring a word boundary, with an ellipsis when cut.
 *
 * The ellipsis is a real character rather than three dots so it costs one unit
 * of the budget instead of three.
 */
export function fit(s: string, max: number): string {
  const t = (s ?? '').trim();
  if (t.length <= max) return t;
  const hard = t.slice(0, max - 1);
  const space = hard.lastIndexOf(' ');
  // Only honour a word boundary if it is not throwing away most of the budget.
  const cut = space > max * 0.6 ? hard.slice(0, space) : hard;
  return `${cut.trimEnd()}…`;
}
