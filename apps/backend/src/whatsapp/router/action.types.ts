import { Role } from '../../mcp/tool.types';
import { MenuOption } from '../session/whatsapp-session.service';
import { VerificationMode } from '../../common/verification/verification.types';

/** Anything that shows salary, balances or another person's data. */
export type WaSensitivity = 'normal' | 'sensitive';

/**
 * How a write is confirmed.
 *
 *  - `none`     — reads only.
 *  - `explicit` — two calls: preview from the tool, then "reply 1 to confirm".
 *  - `implicit` — confirm on the first call. Allowed ONLY for a nullary
 *                 self-scoped write (see rule 7 in ActionRegistryService), i.e.
 *                 a clock punch, where the preview would render "{}" and a
 *                 reflexive YES would teach users to ignore the real ones.
 */
export type WaConfirmPolicy = 'none' | 'explicit' | 'implicit';

/**
 * A tappable button.
 *
 * Evolution refuses a message that mixes `reply` with any of the others
 * ("Reply buttons cannot be mixed with other button types"), so a bubble is
 * EITHER callbacks OR links — never both. That is why `plain` must repeat
 * anything a `url` button points at: on a message that also has reply buttons,
 * the link cannot be a button at all.
 */
export type WaButton =
  | { kind: 'reply'; label: string; callbackId: string }
  | { kind: 'url'; label: string; url: string }
  | { kind: 'copy'; label: string; copyCode: string }
  | { kind: 'call'; label: string; phoneE164: string };

export interface WaListRow {
  title: string;
  description?: string;
  /**
   * ZERO AUTHORITY, exactly as callback-id.ts requires: only
   * `encodeCallback(actionKey, literalParams)` or `encodeControl(verb)`. Never
   * a resource id, never a token — a row can be tapped from a month-old chat by
   * whoever is holding the handset.
   */
  rowId: string;
}

/**
 * A sectioned, tappable menu.
 *
 * Presence of this field IS the request to render one — there is no separate
 * mode flag, so every outbound that does not set it behaves exactly as before.
 */
export interface WaList {
  /** Header of the collapsed bubble. */
  title: string;
  /** Body of the collapsed bubble — all the user sees before tapping. */
  description: string;
  /** Label on the button that opens the sheet. */
  buttonText: string;
  /** Required on the wire; the client fills a blank rather than omitting it. */
  footerText?: string;
  sections: Array<{ title: string; rows: WaListRow[] }>;
}

export interface WaOutbound {
  /** Authoritative rendering. Always deliverable, whatever the client supports. */
  plain: string;
  /** Numbered choices, so a reply of "2" is resolvable. */
  menu?: MenuOption[];
  /** Question shown above the options when the menu is rendered as a poll. */
  pollTitle?: string;
  /**
   * The menu rendered as a tappable list. Strictly a rendering of `menu`: row
   * i must name the same action as `menu[i]`, or tapping the second row and
   * typing "2" would do different things.
   */
  list?: WaList;
  /**
   * Tappable quick replies — at most 3 reply buttons, or 2 CTA buttons.
   *
   * Buttons go where tapping actually earns its keep: confirmations and the two
   * or three most common next steps. A longer catalogue belongs in `list`.
   *
   * `plain` must still say everything the buttons do — it is what gets sent if
   * the interactive send fails.
   */
  buttons?: {
    title: string;
    description: string;
    footer?: string;
    items: WaButton[];
  };
  media?: {
    mediatype: 'image' | 'video' | 'document';
    mimetype: string;
    media: string;
    fileName: string;
    caption?: string;
  };
}

/** Convenience for the common case. */
export function replyBtn(label: string, callbackId: string): WaButton {
  return { kind: 'reply', label, callbackId };
}

export interface RenderCtx {
  /** Employee full name, or the account email. */
  recipientName: string;
  /** The caller's employee id, when they have one. */
  employeeId: string | null;
  appBaseUrl: string;
  currencySymbol: string;
  /**
   * IANA zone the reader's times should be shown in — the employee's, falling
   * back to the company's. Stored instants are UTC, so every date and time in
   * a message has to be converted through this or it is simply wrong.
   */
  timeZone: string;
  /** Everything the action collected, for renderers that need the request back. */
  args: Record<string, unknown>;
}

export interface FlowSlotInput {
  kind: 'text' | 'callback' | 'location' | 'image';
  text: string | null;
  callbackId: string | null;
  location: { latitude: number; longitude: number } | null;
}

/**
 * Extra context a renderer that does NOT call a tool needs.
 *
 * `visibleActions` is the same list the main menu is built from — role,
 * employee link, denylist and the mutations/approvals kill switches already
 * applied — so a locally-rendered sub-menu can never offer something the main
 * menu hides.
 */
export interface LocalRenderCtx extends RenderCtx {
  /** Literal params decoded from the callback id. Zero-authority, as always. */
  params: Record<string, string>;
  visibleActions: WhatsAppActionDef[];
}

export interface FlowStepCtx {
  slots: Record<string, unknown>;
  render: RenderCtx;
}

export interface WhatsAppFlowStep {
  slot: string;
  prompt: (ctx: FlowStepCtx) => WaOutbound;
  parse: (
    input: FlowSlotInput,
    ctx: FlowStepCtx,
  ) => { ok: true; value: unknown } | { ok: false; error: string };
  skipIf?: (slots: Record<string, unknown>) => boolean;
  /** Slot value is stored as '[REDACTED]' in the inbound log. */
  sensitive?: boolean;
}

export interface WhatsAppFlowDef {
  key: string;
  steps: WhatsAppFlowStep[];
  /** Turn the collected slots into tool arguments. */
  buildArgs: (slots: Record<string, unknown>) => Record<string, unknown>;
  ttlMinutes?: number;
  maxParseErrors?: number;
}

export interface PreflightCtx {
  getSetting: (key: string, fallback?: string) => Promise<string>;
  hasEmployee: boolean;
  /** Whether the caller's branch enforces a check-in geofence. */
  geofenceRequired: boolean;
  /**
   * How THIS channel asks for a location, since no two do it the same way.
   *
   * WhatsApp can carry coordinates in a message, so it asks for an attachment.
   * Discord has no location primitive at all, so it hands out a one-time link
   * that collects the position in a browser. The catalogue is shared, so the
   * instruction cannot be written into it — a channel supplies its own, and a
   * channel that has no answer says so.
   */
  locationPrompt: () => Promise<string>;
  /**
   * What THIS channel must prove before it may record attendance, for THIS
   * action, already resolved through the same precedence ladder
   * AttendancesService uses.
   *
   * It must agree with AttendancesService — a preflight that says yes while
   * the service says no turns a clear refusal into a confusing one two steps
   * later, which is the exact failure this field exists to prevent.
   */
  verificationMode: VerificationMode;
  /**
   * Ask for a face proof and return the prompt.
   *
   * Channel-supplied for the same reason `locationPrompt` is: WhatsApp mints a
   * challenge and asks for a photo in the chat, while Discord hands out a link
   * to a page with a camera. The catalogue is shared, so the instruction
   * cannot be written into it.
   */
  faceProofPrompt: () => Promise<string>;
  /**
   * Today's attendance for the caller, or null if it could not be read.
   *
   * Lazy, because only the check-in gate needs it. It comes from the same
   * `attendance_today_status` tool the "today" action uses rather than a local
   * query, so the attendance-day boundary is resolved in exactly one place.
   */
  todayStatus: () => Promise<
    { checkIn?: unknown; checkOut?: unknown; sessions?: unknown } | null
  >;
  /** As RenderCtx.timeZone — a refusal can quote a time too. */
  timeZone: string;
}

/**
 * A follow-up offered after an action succeeds.
 *
 * Declared on the action so no renderer hand-rolls a callback id: encoding
 * happens once, centrally, and every target is re-checked against the caller's
 * visible catalogue before it is offered. An action an admin has switched off
 * therefore stops being suggested without anyone editing a renderer.
 */
export interface WaNextStep {
  /** A registered action key, or a control verb as `__ctl.<verb>`. */
  target: string;
  label: string;
  /** Literal params folded into the callback id. Zero-authority, as always. */
  params?: Record<string, string>;
  /** Offer only when this holds. Runs against the tool payload. */
  when?: (payload: unknown, ctx: RenderCtx) => boolean;
  /**
   * A portal deep link instead of a tappable callback.
   *
   * Rendered as text, not as a CTA button: Evolution refuses a message that
   * mixes reply buttons with url buttons, and the reply buttons are the ones
   * that carry meaning. A link that would have been a button becomes a line.
   */
  url?: (ctx: RenderCtx) => string;
}

export interface WhatsAppActionDef {
  /** Stable id, e.g. 'leave.apply'. Appears in callback ids and the audit log. */
  key: string;
  menuLabel: string;
  menuGroup?: string;
  menuOrder?: number;

  /** Pre-gate. The tool executor re-checks; this only shapes the menu. */
  roles: Role[];
  /** Actions that operate on the caller's own record need a linked employee. */
  requiresEmployee: boolean;
  sensitivity: WaSensitivity;

  /** Exact, normalised words that select this action. */
  keywords: string[];
  /** Anchored patterns, tried in registry order. No fuzzy matching, ever. */
  patterns?: RegExp[];

  tool?: {
    name: string;
    staticArgs?: Record<string, unknown>;
    /**
     * Server-derived arguments: the current year, the caller's own employee id.
     *
     * NEVER user-supplied — the caller cannot influence any of these, which is
     * why they do not violate the auto-confirm invariant's "no user-supplied
     * argument" rule. They are forbidden on `implicit` actions anyway
     * (invariant 13), so the distinction never has to be argued in review.
     */
    dynamicArgs?: (ctx: RenderCtx) => Record<string, unknown>;
  };
  flow?: WhatsAppFlowDef;
  /**
   * Renders from conversation state instead of calling a tool — navigation, a
   * sub-menu, a help card.
   *
   * Mutually exclusive with `tool` and `flow`, and legal only with
   * `confirmPolicy: 'none'`; all three are enforced at boot (invariant 10).
   * Without this, a tool-less action is a silent no-op: `execute()` returns
   * immediately and the user gets nothing at all.
   */
  localRender?: (ctx: LocalRenderCtx) => WaOutbound;
  confirmPolicy: WaConfirmPolicy;
  /** Approvals: the resource id must come from a server-side token, not the wire. */
  needsActionToken?: boolean;

  /**
   * Optional gate run BEFORE the tool, returning a user-facing reason to
   * decline. Exists so a policy the channel cannot satisfy (face-only
   * attendance, geofencing) reads as guidance rather than as a raw domain
   * exception the employee cannot act on.
   */
  preflight?: (ctx: PreflightCtx) => Promise<string | null>;

  render: (payload: any, ctx: RenderCtx) => WaOutbound;

  /**
   * Offered after a successful render — "checked in" becomes "checked in, and
   * here is Lunch / Check out / Menu".
   *
   * A renderer that sets `buttons` or `list` itself always wins: a confirmation
   * must never be diluted by follow-ups.
   */
  nextSteps?: WaNextStep[] | ((payload: any, ctx: RenderCtx) => WaNextStep[]);

  /**
   * The action's arguments come from a WhatsApp ATTACHMENT (a shared location),
   * never from typed text.
   *
   * This is the second — and only other — case where auto-confirm is allowed.
   * Sharing a location is already a deliberate act with its own confirmation
   * step in the WhatsApp UI, and a preview reading "check in: with location,
   * yes" carries no information the user does not already have. Validated at
   * boot alongside the nullary rule.
   */
  implicitFromAttachment?: boolean;

  /** Hidden from menus (control verbs like CANCEL). */
  hidden?: boolean;
}
