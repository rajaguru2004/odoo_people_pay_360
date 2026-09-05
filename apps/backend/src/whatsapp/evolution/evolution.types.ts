/**
 * Evolution API v2.3 wire shapes — only the endpoints this project actually uses.
 *
 * IMPORTANT: v2 flattened the message bodies. There is no `options{}` wrapper and
 * no `textMessage{}` / `mediaMessage{}` nesting (those were v1). `delay`, `quoted`
 * and `linkPreview` are top-level siblings of `number`. Verified against the
 * "Evolution API | v2.3.*" Postman collection at the repository root.
 */

/** POST /message/sendText/{instance} */
export interface EvolutionSendTextBody {
  /** Bare digits with country code, no '+' and no JID suffix. */
  number: string;
  text: string;
  delay?: number;
  linkPreview?: boolean;
}

/** POST /message/sendMedia/{instance} — wired for Phase 2, unused in Phase 1. */
export interface EvolutionSendMediaBody {
  number: string;
  mediatype: 'image' | 'video' | 'document';
  mimetype: string;
  caption?: string;
  /** URL or base64 payload. */
  media: string;
  fileName: string;
  delay?: number;
}

/**
 * POST /message/sendList/{instance}
 *
 * Rows carry OUR callback id in `rowId`, which comes back as
 * `listResponseMessage.singleSelectReply.selectedRowId` — this build emits a
 * real `listMessage`, not a nativeFlow wrapper (probe P6).
 *
 * `footerText` is REQUIRED despite reading like a decoration: omitting it is a
 * 400 with `instance requires property "footerText"` (probe P8). Callers must
 * always supply one.
 */
export interface EvolutionSendListBody {
  number: string;
  title: string;
  description: string;
  buttonText: string;
  /** Mandatory. See above — an absent footer is a 400, not a plainer bubble. */
  footerText: string;
  sections: Array<{
    title: string;
    rows: Array<{ title: string; description?: string; rowId: string }>;
  }>;
  delay?: number;
}

/**
 * One button.
 *
 * The `type` discriminant selects which extra field the wire requires, and they
 * are mutually exclusive: a `url` button has no `id`, so it carries no callback
 * and whatever it points at must also appear in the message text.
 *
 * `pix` exists in the collection ({type,currency,name,keyType,key}) and is
 * deliberately not modelled — BRL-only, and an unused payment button in an HR
 * channel is a liability rather than a feature.
 */
export type EvolutionButton =
  | { type: 'reply'; displayText: string; id: string }
  | { type: 'url'; displayText: string; url: string }
  | { type: 'copy'; displayText: string; copyCode: string }
  | { type: 'call'; displayText: string; phoneNumber: string };

/** Reply buttons and CTA buttons are two families that cannot share a message. */
export type EvolutionButtonFamily = 'reply' | 'cta';

export function buttonFamily(b: EvolutionButton): EvolutionButtonFamily {
  return b.type === 'reply' ? 'reply' : 'cta';
}

/**
 * POST /message/sendButtons/{instance}
 *
 * Two server-enforced rules, both 400s rather than silent corrections:
 *
 *  1. At most THREE reply buttons — "Maximum of 3 reply buttons allowed" (P2).
 *  2. Reply buttons cannot be mixed with url/copy/call in one message —
 *     "Reply buttons cannot be mixed with other button types" (P3).
 *
 * Rule 2 is the load-bearing one for callers: a bubble is EITHER tappable
 * callbacks OR links, never both, so a "here it is, and here is the portal
 * link" message has to put the link in the text.
 */
export interface EvolutionSendButtonsBody {
  number: string;
  title: string;
  description: string;
  footer?: string;
  buttons: EvolutionButton[];
  delay?: number;
}

/**
 * POST /message/sendCarousel/{instance}
 *
 * Present on this build and rendering as `interactiveMessage.carouselMessage`
 * (probe P10), but absent from the v2.3 Postman collection, so the shape below
 * is observed rather than documented. Nothing in the render layer references
 * this yet — it is here so the next person does not re-derive it from a
 * screenshot.
 *
 * @experimental
 */
export interface EvolutionSendCarouselBody {
  number: string;
  title: string;
  body: string;
  footer?: string;
  cards: Array<{
    title: string;
    body: string;
    footer?: string;
    imageUrl: string;
    buttons: EvolutionButton[];
  }>;
  delay?: number;
}

/**
 * POST /chat/getBase64FromMediaMessage/{instance}
 *
 * Takes the message id and returns the decrypted bytes. Requires Evolution to
 * have stored the message; an unknown id answers 400 "Message not found"
 * (probe P11a), which is correctly non-retryable.
 */
export interface EvolutionGetBase64Body {
  message: { key: { id: string } };
  convertToMp4: boolean;
}

/** Builds differ on which field carries the payload, so all are optional. */
export interface EvolutionBase64Response {
  base64?: string;
  media?: string;
  data?: { base64?: string };
  mimetype?: string;
  mediaType?: string;
  fileName?: string;
  size?: number | { fileLength?: number };
}

/**
 * POST /message/sendPoll/{instance}
 *
 * The only tappable primitive that renders natively on personal WhatsApp
 * accounts. Votes come back as an encrypted `pollUpdateMessage`; Evolution
 * decrypts it and exposes the chosen option text.
 */
export interface EvolutionSendPollBody {
  number: string;
  name: string;
  selectableCount: number;
  values: string[];
}

/** POST /chat/whatsappNumbers/{instance} */
export interface EvolutionWhatsAppNumbersBody {
  numbers: string[];
}

/** One entry of the /chat/whatsappNumbers response array. */
export interface EvolutionNumberCheck {
  exists: boolean;
  jid?: string;
  number?: string;
}

/** GET /instance/connectionState/{instance} */
export interface EvolutionConnectionStateResponse {
  instance?: {
    instanceName?: string;
    state?: string;
  };
  state?: string;
}

/** GET /instance/connect/{instance} */
export interface EvolutionConnectResponse {
  base64?: string;
  code?: string;
  pairingCode?: string;
  count?: number;
}

/** Successful send response. Evolution nests the id under `key`. */
export interface EvolutionSendResponse {
  key?: {
    id?: string;
    remoteJid?: string;
    fromMe?: boolean;
  };
  status?: string;
  messageTimestamp?: string | number;
}
