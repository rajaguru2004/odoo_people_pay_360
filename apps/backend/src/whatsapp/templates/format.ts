/**
 * WhatsApp text formatting primitives.
 *
 * WhatsApp supports only `*bold*`, `_italic_`, `~strike~` and ```monospace```.
 * No tables, no headings, no link-with-text. Column alignment is pointless
 * because the client renders in a proportional font.
 */

/** WhatsApp's practical text ceiling is ~4096; stay well inside it. */
export const WA_MAX_CHARS = 3500;

export const bold = (s: string): string => `*${s}*`;
export const italic = (s: string): string => `_${s}_`;
export const mono = (s: string): string => `\`\`\`${s}\`\`\``;

/**
 * Escape user-supplied text before interpolating it.
 *
 * Without this a leave reason containing an asterisk silently corrupts the
 * formatting of the whole message. WhatsApp has no escape character, so the
 * only safe move is to strip the markers.
 */
export function escapeWa(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[*_~`]/g, '');
}

/**
 * Punctuation that reaches a WhatsApp reader unchanged.
 *
 * Anything the server generates and then *delivers* to a person over WhatsApp —
 * a temporary password above all — must be drawn from a pool this narrow.
 * escapeWa strips markup characters silently, so a secret containing one arrives
 * shorter than the secret that was hashed, and the only symptom is a login that
 * can never succeed. Deliberately excludes `*`, `_`, `~` and a backtick.
 */
export const WA_SAFE_SYMBOLS = '!@#$%^&+=?';

/** "*Label:* value" — the workhorse line. */
export function kv(label: string, value: unknown): string {
  return `${bold(`${label}:`)} ${escapeWa(value)}`;
}

export function bullet(s: string): string {
  return `• ${s}`;
}

export function rule(): string {
  return '──────────';
}

/** Join non-empty lines, collapsing runs of blanks. */
export function lines(...parts: Array<string | null | undefined | false>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * ISO or Date -> "08 Aug 2026". Falls back to the raw string if unparseable.
 *
 * Formatted by hand rather than through Intl: `toLocaleDateString` output
 * varies with the runtime's ICU build (Node renders September as "Sept" under
 * en-GB, other builds as "Sep"), and a user-facing message should not change
 * shape when the container image does.
 */
export function fmtDate(value: unknown): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return escapeWa(value);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Money with an optional symbol. Amounts are already in major units here. */
export function fmtMoney(amount: unknown, symbol = ''): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return escapeWa(amount);
  const formatted = n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
  return symbol ? `${symbol} ${formatted}` : formatted;
}

/**
 * Turn an in-app notification link into an absolute URL.
 * Notification.link is stored as a frontend path such as '/dashboard/leaves'.
 */
export function deepLink(appBaseUrl: string, link?: string | null): string {
  if (!link) return '';
  if (/^https?:\/\//i.test(link)) return link;
  const base = appBaseUrl.replace(/\/+$/, '');
  const path = link.startsWith('/') ? link : `/${link}`;
  return `${base}${path}`;
}

/**
 * Split a long body on line boundaries, never mid-word, and prefix "(1/3)".
 * Chunks are sent sequentially so ordering is preserved — Evolution is
 * fire-and-forget per call and does not otherwise guarantee it.
 */
export function chunk(text: string, max = WA_MAX_CHARS): string[] {
  if (text.length <= max) return [text];

  const out: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    // A single line longer than the budget still has to be broken somewhere.
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

  const total = out.length;
  return total > 1 ? out.map((c, i) => `(${i + 1}/${total})\n${c}`) : out;
}
