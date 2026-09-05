/**
 * Convert the ESS renderers' WhatsApp markup to Telegram HTML.
 *
 * The action catalogue's `render` functions are shared across channels and emit
 * WhatsApp markup (`*bold*`, `_italic_`). Telegram has no WhatsApp-compatible
 * mode: its own "Markdown" reserves `_ * [ ] ( ) ~ > # + - = | { } . !`, and an
 * unescaped one of those anywhere in a rendered payslip is a 400 from the API,
 * not a cosmetic problem. So this channel sends `parse_mode: HTML`, where the
 * only three characters that ever need escaping are `& < >`.
 *
 * Order matters and is the whole trick: escape FIRST, then insert tags. Doing it
 * the other way round would escape the tags we just wrote.
 *
 *   WhatsApp        Telegram HTML
 *   *bold*          <b>bold</b>
 *   _italic_        <i>italic</i>
 *   ~strike~        <s>strike</s>
 */

/** Telegram HTML recognises exactly these three entities. */
export function escapeTelegramHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function toTelegramHtml(waText: string): string {
  if (!waText) return '';

  return escapeTelegramHtml(waText)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>');
}

/** Telegram's hard cap on a message body. */
export const TELEGRAM_MAX_CHARS = 4096;

/**
 * Split on line boundaries, never mid-word.
 *
 * Deliberately identical to `chunkDiscord` rather than shared with it: the two
 * caps differ, and a chunker that has to satisfy both channels is a chunker
 * that gets changed for one and breaks the other. The duplication is nine
 * lines; the coupling would be permanent.
 *
 * Chunking runs on the ALREADY-CONVERTED HTML, so a split can in principle fall
 * between `<b>` and `</b>`. In practice every template emits bold within a
 * single line and the split is on line boundaries — and `sendMessage` failing
 * one chunk is a retry, not a lost message.
 */
export function chunkTelegram(text: string, max = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (current) {
        out.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max) {
      out.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

/** `<b>…</b>` around already-escaped text. */
export function b(text: string): string {
  return `<b>${escapeTelegramHtml(text)}</b>`;
}

/** `<code>…</code>` — used for IPs and user agents, which are tap-to-copy. */
export function code(text: string): string {
  return `<code>${escapeTelegramHtml(text)}</code>`;
}

/** "*Label:* value" as a Telegram HTML line. Empty values drop the whole line. */
export function kv(label: string, value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  return `${b(`${label}:`)} ${escapeTelegramHtml(String(value))}`;
}
