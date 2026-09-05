import { MenuOption } from '../session/whatsapp-session.service';
import { WaOutbound } from '../router/action.types';

/**
 * WhatsApp text primitives.
 *
 * WhatsApp supports only *bold*, _italic_, ~strike~ and ```mono```. No tables,
 * no headings, and no column alignment worth attempting — the client renders in
 * a proportional font, so padded columns come out ragged.
 */
export const WA_MAX_CHARS = 3500;

export const bold = (s: string) => `*${s}*`;
export const italic = (s: string) => `_${s}_`;
export const mono = (s: string) => `\`\`\`${s}\`\`\``;
export const rule = () => '──────────';

/**
 * Strip WhatsApp's formatting markers from user-supplied text.
 *
 * There is no escape character in WhatsApp markup, so a leave reason containing
 * an asterisk would otherwise corrupt the formatting of the whole message.
 */
export function escapeWa(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[*_~`]/g, '');
}

/** Re-exported so this module and templates/format.ts cannot drift apart on the
 *  one constant where disagreeing would hand somebody an unusable password. */
export { WA_SAFE_SYMBOLS } from '../templates/format';

export function kv(label: string, value: unknown): string {
  return `${bold(`${label}:`)} ${escapeWa(value)}`;
}

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
 * Wall-clock fields for an instant in a given zone.
 *
 * Only NUMERIC parts are taken from Intl. Its month NAMES vary with the
 * runtime's ICU build (Node renders September as "Sept" under en-GB) and a
 * user-facing message should not change shape with the base image, so the name
 * still comes from MONTHS above.
 */
function zoned(d: Date, timeZone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      // h23 rather than hour12:false, which renders midnight as "24" on some
      // ICU builds.
      hourCycle: 'h23',
    }).formatToParts(d);
  } catch {
    // An unknown zone makes Intl throw. A stale employee.timezone must degrade
    // to a UTC clock in one message, not blow up the whole reply.
    return { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN };
  }

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/**
 * "08 Aug 2026", in the reader's zone.
 *
 * `timeZone` is not optional in spirit: attendance rows are stored as UTC
 * instants, so rendering them without a zone is wrong for everyone east or
 * west of Greenwich — an 8pm check-in in Chennai reads as 14:56, and one after
 * 5:30am UTC reads as the wrong DAY. It stays optional only because a few call
 * sites render values that carry no employee to resolve a zone from.
 */
export function fmtDate(value: unknown, timeZone?: string): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return escapeWa(value);

  if (timeZone) {
    const z = zoned(d, timeZone);
    if (!Number.isNaN(z.day)) {
      return `${String(z.day).padStart(2, '0')} ${MONTHS[z.month - 1]} ${z.year}`;
    }
  }
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "20:26", in the reader's zone. See fmtDate on why the zone matters. */
export function fmtTime(value: unknown, timeZone?: string): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return escapeWa(value);

  if (timeZone) {
    const z = zoned(d, timeZone);
    if (!Number.isNaN(z.hour)) {
      return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
    }
  }
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function fmtMoney(amount: unknown, symbol = ''): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return escapeWa(amount);
  const formatted = n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
  return symbol ? `${symbol} ${formatted}` : formatted;
}

export function deepLink(appBaseUrl: string, path: string): string {
  const base = appBaseUrl.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Render numbered options and hand back the menu for the session to remember. */
export function renderMenu(options: MenuOption[]): string {
  return options.map((o) => `${bold(String(o.n))}. ${escapeWa(o.label)}`).join('\n');
}

export function outbound(plain: string, menu?: MenuOption[]): WaOutbound {
  return menu?.length ? { plain, menu } : { plain };
}

/**
 * Split on line boundaries, never mid-word, and label the parts. Chunks are
 * sent sequentially because Evolution is fire-and-forget per call and does not
 * otherwise guarantee ordering.
 */
export function chunk(text: string, max = WA_MAX_CHARS): string[] {
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

  const total = out.length;
  return total > 1 ? out.map((c, i) => `(${i + 1}/${total})\n${c}`) : out;
}

/**
 * Services wrap results inconsistently — some in `{success, data}`, some not.
 * Every renderer starts here rather than each inventing its own unwrap.
 */
export function unwrapData(payload: any): any {
  if (payload && typeof payload === 'object' && 'data' in payload && 'success' in payload) {
    return payload.data;
  }
  return payload;
}

/** Coerce a tool payload to an array whether it is one, or wraps one. */
export function asArray(payload: any): any[] {
  const d = unwrapData(payload);
  if (Array.isArray(d)) return d;
  for (const k of ['items', 'rows', 'results', 'requests', 'data']) {
    if (Array.isArray(d?.[k])) return d[k];
  }
  return [];
}
