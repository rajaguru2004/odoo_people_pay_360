import { Injectable } from '@nestjs/common';
import { ActionRegistryService } from './action-registry.service';
import { WhatsAppActionDef } from './action.types';
import { decodeCallback, decodeControl, isCallbackId } from './callback-id';
import { SessionRow, WhatsAppSessionService } from '../session/whatsapp-session.service';
import { normaliseText } from './normalise-text';

export { normaliseText };

/** Verbs that always win, even mid-flow. */
export type ControlVerb =
  | 'cancel'
  | 'back'
  | 'menu'
  | 'help'
  | 'stop'
  | 'start'
  | 'yes'
  | 'no'
  /** The full numbered list, when the menu rendered as a group picker. */
  | 'menu_all'
  /** "hi". Answered with the menu — see CONTROLS for why this exists. */
  | 'greeting';

export type Resolution =
  | { type: 'control'; verb: ControlVerb }
  | { type: 'action'; action: WhatsAppActionDef; params: Record<string, string> }
  | { type: 'flow-input' }
  /** A photo, which only means something if a challenge is open for it. */
  | { type: 'face-proof' }
  /** A shared location pin — retired as an input; answered with guidance. */
  | { type: 'location-attachment' }
  | { type: 'no-match'; text: string };

export interface RouterInput {
  kind: 'text' | 'callback' | 'location' | 'poll' | 'image' | 'unsupported';
  text: string | null;
  callbackId: string | null;
}

const CONTROL_VERBS = new Set<string>([
  'cancel',
  'back',
  'menu',
  'help',
  'stop',
  'start',
  'yes',
  'no',
  'menu_all',
  'greeting',
]);

const CONTROLS: Array<[RegExp, ControlVerb]> = [
  [/^(cancel|abort|quit|exit|stop flow)$/, 'cancel'],
  // A greeting is the single most likely first message anybody sends, and
  // without this it fell all the way through to no-match — so saying hello to
  // the assistant answered "I did not understand that", which reads as broken
  // however well everything after it works.
  //
  // Skipped entirely mid-flow (see resolve): a greeting is a courtesy, not an
  // instruction, and it must not abandon a half-finished leave application.
  //
  // Deliberately anchored and exact. "hi" is a greeting; "hi there, can I
  // check in" is not, and guessing at the second is how a bot checks somebody
  // in who was only being polite.
  [
    /^(hi+|hey+|hello+|hai|yo|hiya|howdy|greetings|good (morning|afternoon|evening|day)|(salaam|salam|assalamualaikum|namaste|vanakkam))$/,
    'greeting',
  ],
  [/^(back|previous|prev)$/, 'back'],
  [/^(menu|main|main menu|options|0)$/, 'menu'],
  [/^(all|everything|full menu|full list)$/, 'menu_all'],
  [/^(help|\?|commands)$/, 'help'],
  [/^(stop|unsubscribe|opt ?out)$/, 'stop'],
  [/^(start|begin|subscribe|opt ?in)$/, 'start'],
  [/^(yes|y|confirm|ok|okay|1\.?\s*yes)$/, 'yes'],
  [/^(no|n|cancel that|2\.?\s*no)$/, 'no'],
];



/**
 * Deterministic routing. No LLM is reachable from this file, by design and by
 * an ESLint boundary — a language model that can pick an action is a language
 * model that can pick the wrong one, and some of these actions write.
 */
@Injectable()
export class CommandRouterService {
  constructor(
    private readonly registry: ActionRegistryService,
    private readonly sessions: WhatsAppSessionService,
  ) {}

  /**
   * Normalise the way a phone actually sends text: smart quotes, emoji,
   * variation selectors, non-breaking spaces, stray leading slashes.
   */
  normalise(raw: string | null | undefined): string {
    return normaliseText(raw);
  }


  /**
   * The resolution ladder.
   *
   * Order matters more than any individual rule. Controls come BEFORE flow
   * input so that "cancel" is never swallowed as a leave reason — the corollary
   * being that a free-text step must reject control words rather than store them.
   */
  resolve(session: SessionRow, input: RouterInput, hasActiveFlow: boolean): Resolution {
    // 1. A tapped button or list row.
    const rawCallback = input.callbackId ?? (isCallbackId(input.text) ? input.text : null);
    if (rawCallback) {
      const decoded = decodeCallback(rawCallback);
      if (decoded) {
        // A tapped YES/NO is a control verb, not an action — same grammar,
        // reserved prefix.
        const verb = decodeControl(decoded.actionKey);
        if (verb && CONTROL_VERBS.has(verb)) {
          return { type: 'control', verb: verb as ControlVerb };
        }
        const action = this.registry.getByKey(decoded.actionKey);
        if (action) return { type: 'action', action, params: decoded.params };
      }
      return { type: 'no-match', text: '' };
    }

    // 1a. A poll vote carries the option TEXT, not an id, so it resolves
    //     against the menu we rendered — the same store numeric replies use.
    if (input.kind === 'poll' && input.text) {
      const choice = this.sessions.resolveMenuLabel(session, input.text);
      if (choice) {
        const action = this.registry.getByKey(choice.actionKey);
        if (action) return { type: 'action', action, params: choice.params ?? {} };
      }
      // An unmatched vote falls through to the text ladder: the label may well
      // be a keyword ("Check in"), which is exactly what we want.
    }

    // 1b. A shared location is GUIDANCE now, never a punch. It used to
    //     auto-check-in, but an attachment is any pin the sender chooses —
    //     including a place they are not standing — so the secure link's
    //     browser fix replaced it. Answered kindly rather than falling through
    //     to "I did not understand", because old habits will keep sharing pins
    //     for a while.
    if (input.kind === 'location' && !hasActiveFlow) {
      return { type: 'location-attachment' };
    }

    // 1c. A photo outside a flow. Unlike a location it has NO inherent meaning
    //     — it could be a check-in, a check-out or a cat — so the meaning comes
    //     from a server-side challenge row, looked up by the caller. This
    //     router stays pure and synchronous and does not read the database.
    //
    //     A captioned photo still falls through to the text ladder below when
    //     no challenge is open, so "menu" written under a picture keeps working.
    if (input.kind === 'image' && !hasActiveFlow) {
      return { type: 'face-proof' };
    }

    const text = this.normalise(input.text);

    // 2. Global controls, which win even mid-flow — that is what makes CANCEL
    //    reliable no matter how deep somebody is in a leave application.
    //
    //    Greeting is the one exception. It is a courtesy, not an instruction,
    //    and treating it as one mid-flow would abandon the question the user is
    //    part-way through answering. Mid-flow it is just text.
    for (const [re, verb] of CONTROLS) {
      if (verb === 'greeting' && hasActiveFlow) continue;
      if (re.test(text)) return { type: 'control', verb };
    }

    // 3. Mid-flow, anything else is an answer to the current question.
    if (hasActiveFlow) return { type: 'flow-input' };

    // 4. A bare number, resolved ONLY against the menu we actually rendered.
    //    With no stored menu this is a no-match, never a guess: guessing here
    //    could fire a mutation the user never asked for.
    if (/^\d{1,2}$/.test(text)) {
      const choice = this.sessions.resolveMenuChoice(session, Number(text));
      if (choice) {
        const action = this.registry.getByKey(choice.actionKey);
        if (action) return { type: 'action', action, params: choice.params ?? {} };
      }
      return { type: 'no-match', text };
    }

    // 5. Exact keyword.
    const byKeyword = this.registry.getByKeyword(text);
    if (byKeyword) return { type: 'action', action: byKeyword, params: {} };

    // 6. Anchored patterns, in registry order.
    const byPattern = this.registry.matchPattern(text);
    if (byPattern) return { type: 'action', action: byPattern, params: {} };

    // 7. Nothing matched. NO fuzzy fallback: "in"/"out" and "approve"/"reject"
    //    are one typo apart in meaning, and an unrecoverable one.
    return { type: 'no-match', text };
  }
}
