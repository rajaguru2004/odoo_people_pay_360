import { jidToE164 } from '../utils/phone.util';

/**
 * Pure parsing of Evolution webhook envelopes. No I/O, no state — everything
 * here is exercised by fixtures, because a silent parse miss produces a dead
 * channel that looks healthy from every dashboard.
 */

export type InboundKind = 'text' | 'callback' | 'location' | 'poll' | 'image' | 'unsupported';

/**
 * Enough to fetch the bytes later — never the bytes themselves.
 *
 * The envelope is persisted and rendered in an admin UI, so an inline image
 * would put megabytes of a person's face into a log table. The id is the handle
 * `EvolutionClient.getBase64FromMediaMessage` takes when something actually
 * needs the picture.
 */
export interface ParsedInboundMedia {
  /** `key.id`. Same value as ParsedInbound.waMessageId, carried for clarity. */
  messageId: string;
  mimetype: string | null;
  caption: string | null;
  fileLength: number | null;
  /**
   * Evolution's CDN url when present. NOT fetchable without the media key, so
   * this is diagnostic only — never treat it as a download link.
   */
  url: string | null;
  /**
   * A view-once image may be unrecoverable once opened, so a fetch that fails
   * on one of these is expected rather than a fault.
   */
  viewOnce: boolean;
}

export interface ParsedInbound {
  instance: string;
  waMessageId: string;
  /** Where to reply. May be an @lid privacy id — never treat it as identity. */
  remoteJid: string;
  /** Who sent it, when resolvable. This is the identity key. */
  phoneE164: string | null;
  pushName: string | null;
  kind: InboundKind;
  /** Trimmed message text for `kind: 'text'`, or the caption of an image. */
  text: string | null;
  /** Button / list selection id for `kind: 'callback'`. */
  callbackId: string | null;
  location: { latitude: number; longitude: number } | null;
  /** Attachment handle for `kind: 'image'`. */
  media: ParsedInboundMedia | null;
}

export type ParseResult =
  | { ok: true; message: ParsedInbound }
  | { ok: false; reason: string };

/** Events we act on. Everything else is acknowledged and dropped. */
export const HANDLED_EVENTS = new Set([
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
]);

export function eventNameOf(body: any): string {
  // Evolution sends 'messages.upsert' on some builds and 'MESSAGES_UPSERT' on
  // others; normalise rather than matching one spelling and silently ignoring
  // every message on the other.
  return String(body?.event ?? '')
    .replace(/[.\-\s]/g, '_')
    .toUpperCase();
}

/**
 * Strip the instance credential and any inline media before the envelope is
 * persisted. The webhook body carries `apikey` and `server_url`; storing them
 * would put a live credential in a table the admin UI renders.
 */
export function redactEnvelope(body: any): any {
  if (!body || typeof body !== 'object') return null;
  const clone = JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === 'apikey' || key === 'server_url' || key === 'serverUrl') return undefined;
      // Base64 media blobs are megabytes and have no diagnostic value.
      if (key === 'base64' || key === 'mediaBase64') return '[stripped]';
      if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 200)}…[truncated]`;
      return value;
    }),
  );
  return clone;
}

/**
 * Unwrap the containers WhatsApp nests real content inside.
 *
 * Missing this is the classic "the bot ignores disappearing messages" bug: an
 * ephemeral or view-once chat wraps every message one or two levels deeper, and
 * a parser that only looks at the top level sees nothing at all.
 */
export function unwrap(message: any, depth = 0): any {
  if (!message || depth > 4) return message;
  const inner =
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message ??
    message.viewOnceMessageV2Extension?.message ??
    message.documentWithCaptionMessage?.message ??
    message.editedMessage?.message;
  return inner ? unwrap(inner, depth + 1) : message;
}

/** Was the content wrapped in a view-once container? Checked BEFORE unwrapping. */
function isViewOnce(message: any, depth = 0): boolean {
  if (!message || depth > 4) return false;
  if (
    message.viewOnceMessage ||
    message.viewOnceMessageV2 ||
    message.viewOnceMessageV2Extension
  ) {
    return true;
  }
  const inner =
    message.ephemeralMessage?.message ??
    message.documentWithCaptionMessage?.message ??
    message.editedMessage?.message;
  return inner ? isViewOnce(inner, depth + 1) : false;
}

/**
 * Pull the stored envelope's message node the same way the live path does.
 *
 * Exported because whatsapp-inbound.service.ts re-reads `raw_json` from the
 * database and has to unwrap identically — a location or a photo sent in a
 * disappearing chat is nested one or two levels deeper, and reading
 * `data.message` directly misses it entirely.
 */
export function unwrapStored(rawJson: any): any {
  const data = Array.isArray(rawJson?.data) ? rawJson.data[0] : rawJson?.data;
  return unwrap(data?.message);
}

export function parseInbound(body: any): ParseResult {
  const event = eventNameOf(body);
  if (event !== 'MESSAGES_UPSERT') return { ok: false, reason: `event:${event || 'unknown'}` };

  const data = Array.isArray(body?.data) ? body.data[0] : body?.data;
  const key = data?.key;
  if (!key?.id || !key?.remoteJid) return { ok: false, reason: 'missing-key' };

  // Our own outbound messages echo back through the same webhook.
  if (key.fromMe === true) return { ok: false, reason: 'from-me' };

  const remoteJid: string = String(key.remoteJid);
  if (
    remoteJid.endsWith('@g.us') ||
    remoteJid.endsWith('@newsletter') ||
    remoteJid.endsWith('@broadcast') ||
    remoteJid === 'status@broadcast'
  ) {
    return { ok: false, reason: 'group-or-broadcast' };
  }

  const messageType = String(data?.messageType ?? '');
  if (messageType === 'protocolMessage' || messageType === 'senderKeyDistributionMessage') {
    return { ok: false, reason: `type:${messageType}` };
  }

  const viewOnce = isViewOnce(data?.message);
  const message = unwrap(data?.message);
  if (!message) return { ok: false, reason: 'no-message' };
  if (message.protocolMessage || message.reactionMessage) {
    return { ok: false, reason: 'reaction-or-protocol' };
  }

  const base = {
    instance: String(body?.instance ?? ''),
    waMessageId: String(key.id),
    remoteJid,
    phoneE164: resolveSenderPhone(data, key),
    pushName: data?.pushName ? String(data.pushName).slice(0, 120) : null,
    media: null as ParsedInboundMedia | null,
  };

  // A poll vote. Polls are the one tappable primitive that renders natively on
  // every WhatsApp client (buttons are a Business-API feature that personal
  // accounts often show as plain text), so they are worth handling.
  //
  // The vote itself is encrypted; Evolution decrypts it when it can and exposes
  // the chosen option's TEXT. There is no id to carry, so the chosen text is
  // matched against the menu we last rendered — which the session already
  // stores for numeric replies.
  const pollChoice = extractPollChoice(message);
  if (pollChoice) {
    return {
      ok: true,
      message: {
        ...base,
        kind: 'poll',
        text: pollChoice,
        callbackId: null,
        location: null,
      },
    };
  }

  // Callback ids first: a button reply also carries display text, and routing on
  // the text would lose the parameters encoded in the id.
  const callbackId =
    message.buttonsResponseMessage?.selectedButtonId ??
    message.templateButtonReplyMessage?.selectedId ??
    message.listResponseMessage?.singleSelectReply?.selectedRowId ??
    nativeFlowId(message);

  if (callbackId) {
    return {
      ok: true,
      message: {
        ...base,
        kind: 'callback',
        text: null,
        callbackId: String(callbackId).slice(0, 220),
        location: null,
      },
    };
  }

  const loc = message.locationMessage ?? message.liveLocationMessage;
  if (loc && typeof loc.degreesLatitude === 'number' && typeof loc.degreesLongitude === 'number') {
    return {
      ok: true,
      message: {
        ...base,
        kind: 'location',
        text: null,
        callbackId: null,
        location: { latitude: loc.degreesLatitude, longitude: loc.degreesLongitude },
      },
    };
  }

  // A photo. Surfaced as its own kind because an image can be an ANSWER — a
  // selfie proving who is checking in — and the router needs to tell that apart
  // from a caption that happens to read like a command.
  //
  // The caption is still carried in `text`, deliberately: a photo captioned
  // "menu" routed to MENU before this branch existed, and it must keep doing so.
  // The router treats an image with text as falling through to the text ladder,
  // exactly as a poll vote already does.
  const img = message.imageMessage;
  if (img) {
    const caption = typeof img.caption === 'string' ? img.caption.trim() : '';
    return {
      ok: true,
      message: {
        ...base,
        kind: 'image',
        text: caption ? caption.slice(0, 4096) : null,
        callbackId: null,
        location: null,
        media: {
          messageId: base.waMessageId,
          mimetype: typeof img.mimetype === 'string' ? img.mimetype : null,
          caption: caption || null,
          fileLength: numeric(img.fileLength),
          url: typeof img.url === 'string' ? img.url : null,
          viewOnce,
        },
      },
    };
  }

  // Video and document captions deliberately stay `text`. Only a still image is
  // ever a face proof, and widening this would make every forwarded PDF look
  // like an answer to a challenge.
  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    null;

  if (typeof text === 'string' && text.trim()) {
    return {
      ok: true,
      message: {
        ...base,
        kind: 'text',
        text: text.trim().slice(0, 4096),
        callbackId: null,
        location: null,
      },
    };
  }

  return {
    ok: true,
    message: { ...base, kind: 'unsupported', text: null, callbackId: null, location: null },
  };
}

/** WhatsApp sends fileLength as a number, a string, or a {low,high} Long. */
function numeric(v: any): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  if (v && typeof v === 'object' && typeof v.low === 'number') return v.low;
  return null;
}

/**
 * The selected option text from a poll vote, when Evolution managed to decrypt
 * it. Shapes differ across builds, so several are tried; an undecryptable vote
 * yields null and the message is treated as unsupported rather than guessed at.
 */
function extractPollChoice(message: any): string | null {
  const upd = message?.pollUpdateMessage;
  if (!upd) return null;
  const candidates = [
    upd.vote?.selectedOptions?.[0]?.optionName,
    upd.vote?.selectedOptions?.[0]?.name,
    upd.selectedOptions?.[0]?.optionName,
    upd.pollUpdates?.[0]?.selectedOptions?.[0]?.optionName,
    typeof upd.vote?.selectedOptions?.[0] === 'string' ? upd.vote.selectedOptions[0] : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 200);
  }
  return null;
}

/**
 * The id behind a nativeFlow tap.
 *
 * This build sends reply buttons as `nativeFlowMessage.buttons[].name =
 * "quick_reply"` (probe P1), so the response comes back through
 * `interactiveResponseMessage`. Which key inside `paramsJson` carries the id
 * varies by client version, so every observed spelling is tried rather than
 * betting on one and silently dropping every tap on the others.
 */
function nativeFlowId(message: any): string | null {
  const raw = message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (typeof raw !== 'string') return null;
  try {
    const p = JSON.parse(raw);
    const candidates = [p?.id, p?.selectedId, p?.rowId, p?.selectedRowId, p?.params?.id];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the sender's real number.
 *
 * Current WhatsApp increasingly delivers `remoteJid` as `<n>@lid`, a privacy
 * identifier that is NOT a phone number. Treating it as one would either fail
 * to find the identity or — far worse — match a different person whose real
 * number happens to be those digits. So: prefer the explicit sender fields, and
 * accept `remoteJid` only when it is genuinely a phone JID.
 */
function resolveSenderPhone(data: any, key: any): string | null {
  // Deliberately NOT the top-level `sender` field: on Evolution that is the
  // instance owner's own JID, so trusting it would attribute every inbound
  // message to the bot's number.
  for (const c of [key?.senderPn, key?.participantPn, data?.senderPn]) {
    const e164 = jidToE164(c);
    if (e164) return e164;
  }
  const jid = String(key?.remoteJid ?? '');
  if (jid.endsWith('@s.whatsapp.net')) return jidToE164(jid);
  // An @lid-only sender is unresolvable. Returning null is correct: the caller
  // logs it and stays silent rather than guessing at an identity.
  return null;
}
