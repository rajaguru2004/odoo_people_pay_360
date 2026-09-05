/**
 * Clean up a chat id the way it actually arrives from a human.
 *
 * Written after a deployment failed with `Bad Request: chat not found` while the
 * group, the token and the bot's membership were all verifiably fine. Telegram
 * gives that one message for every bad-chat cause, so a value that is merely
 * *dirty* is indistinguishable from a group the bot was never added to — and
 * chat ids reach this system by copy-paste, from a bot that prints them with a
 * label and from clients that render the minus as a typographic dash.
 *
 * All of these are the same chat and none of them work verbatim:
 *
 *   "Chat ID: -5544539023"   ← pasted with the label
 *   "-5544539023 "           ← trailing space or newline
 *   "−5544539023"       ← U+2212 MINUS SIGN, what some clients render
 *   "–5544539023"       ← U+2013 EN DASH, what autocorrect produces
 *   "-5,544,539,023"         ← digit grouping from a spreadsheet round trip
 *
 * Normalising rather than rejecting is deliberate. A refusal would be honest,
 * but the admin cannot see the difference between their string and the correct
 * one — the characters are visually identical — so "invalid chat id" reads as a
 * bug in the field.
 */

/** Every dash-like character a client might substitute for ASCII '-'. */
const DASHES = /[‐‑‒–—―−﹘﹣－]/g;

export interface ChatIdParse {
  /** The cleaned value, or '' when nothing usable was found. */
  value: string;
  /** True when cleaning actually changed something — worth telling the admin. */
  changed: boolean;
}

/**
 * @returns the normalised chat id, or '' if the input holds no chat id at all.
 *   An empty result is a legitimate value: it means "no alert chat", which is
 *   how the channel is switched off.
 */
export function normalizeChatId(raw: string | null | undefined): ChatIdParse {
  const original = String(raw ?? '');
  if (!original.trim()) return { value: '', changed: false };

  let s = original
    .replace(DASHES, '-')
    // Anything before a colon is a label — "Chat ID:", "chat_id:", "Group:".
    .replace(/^[^:]*:\s*/, '')
    .trim();

  // A @public_channel handle is a valid sendMessage target and is not a number.
  const handle = s.match(/@[A-Za-z0-9_]{4,32}/);
  if (handle) {
    const value = handle[0];
    return { value, changed: value !== original };
  }

  // Take the first signed integer in what is left. Digit separators are dropped
  // first so "-5,544,539,023" survives; a lone '-' with no digits does not.
  s = s.replace(/[\s,_]/g, '');
  const num = s.match(/-?\d+/);
  if (!num) return { value: '', changed: original.trim() !== '' };

  const value = num[0];
  return { value, changed: value !== original };
}

/**
 * Is this a shape Telegram can route at all?
 *
 * Deliberately NOT a claim that the chat exists — only `getChat` knows that.
 * This rules out the values that cannot be a chat under any circumstances, so
 * the admin screen can say "that is not a chat id" instead of waiting for a
 * send to fail an hour later.
 */
export function looksLikeChatId(value: string): boolean {
  if (!value) return false;
  if (/^@[A-Za-z0-9_]{4,32}$/.test(value)) return true;
  // Telegram ids fit comfortably inside 20 digits; the sign is what separates a
  // group from a user, and both are legitimate targets.
  return /^-?\d{1,20}$/.test(value);
}

/**
 * A positive id is a PRIVATE chat with one person, never a group.
 *
 * Its own check because it is the mistake with the worst failure mode: pasting
 * a group id without the minus does not error, it silently addresses a
 * different chat — one that usually does not exist, but might.
 */
export function looksLikeGroupChatId(value: string): boolean {
  return /^-\d+$/.test(value);
}
