import { MenuOption } from '../session/whatsapp-session.service';
import { RenderCtx, WaNextStep, WaOutbound, WhatsAppActionDef, replyBtn } from './action.types';
import { CONTROL_PREFIX, encodeCallback, encodeControl } from './callback-id';
import { WA_BUTTONS } from '../render/wa-limits';
import { italic } from '../render/wa-format';

/**
 * Turns "here is your leave balance" into "here is your leave balance, and here
 * is what people usually do next".
 *
 * The whole point of doing this centrally rather than in each renderer is that
 * the follow-ups are FILTERED: a target the caller cannot see — wrong role, no
 * linked employee, switched off in settings, or gated behind a kill switch —
 * silently stops being offered. A renderer that built its own callback ids
 * would happily suggest all of them.
 */

/** Always present, always last: somewhere to go from anywhere. */
const MENU_STEP: WaNextStep = { target: `${CONTROL_PREFIX}menu`, label: 'Menu' };

export function withNextSteps(
  out: WaOutbound,
  action: WhatsAppActionDef,
  payload: unknown,
  ctx: RenderCtx,
  visible: Set<string>,
): WaOutbound {
  // A confirmation, or anything that already has its own tappable surface,
  // is left exactly as the renderer wrote it.
  if (out.buttons?.items.length || out.list) return out;

  const declared =
    typeof action.nextSteps === 'function'
      ? action.nextSteps(payload, ctx)
      : (action.nextSteps ?? []);

  const steps: WaNextStep[] = [];
  const seen = new Set<string>();

  for (const step of [...declared, MENU_STEP]) {
    if (steps.length >= WA_BUTTONS.replyMax) break;
    if (seen.has(step.target)) continue;
    if (step.when && !step.when(payload, ctx)) continue;
    // Two exemptions from the visibility check. Control verbs have no registry
    // entry and are the same handful for everyone. A link is only ever text —
    // it names no action, so there is nothing to check it against; its
    // `target` exists purely to deduplicate.
    if (!step.url && !step.target.startsWith(CONTROL_PREFIX) && !visible.has(step.target)) {
      continue;
    }
    seen.add(step.target);
    steps.push(step);
  }

  if (!steps.length) return out;

  // Links cannot be buttons here: Evolution refuses reply and url buttons in
  // one message, and the reply buttons are the ones that do something.
  const links = steps.filter((s) => s.url);
  const taps = steps.filter((s) => !s.url);

  const startAt = (out.menu?.length ?? 0) + 1;
  const appended: MenuOption[] = taps
    .filter((s) => !s.target.startsWith(CONTROL_PREFIX))
    .map((s, i) => ({
      n: startAt + i,
      label: s.label,
      actionKey: s.target,
      params: s.params,
    }));

  const trailer = [
    taps.length ? italic(`Next: ${taps.map((s) => s.label).join(' · ')}`) : '',
    ...links.map((s) => `${s.label}: ${s.url!(ctx)}`),
  ]
    .filter(Boolean)
    .join('\n');

  const plain = trailer ? `${out.plain}\n\n${trailer}` : out.plain;

  return {
    ...out,
    plain,
    menu: appended.length ? [...(out.menu ?? []), ...appended] : out.menu,
    buttons: taps.length
      ? {
          // The ANSWER goes in the card, not a generic prompt.
          //
          // A button card renders its own title/description and never shows
          // `plain`, so hard-coding "What next? / Pick one, or reply MENU."
          // here deleted the reply: a successful check-in arrived on the
          // handset as nothing but that prompt. It looked like the action had
          // silently failed, and it only showed up in production because
          // buttons fall back to text wherever the account cannot render them
          // — which is exactly where it had been tested.
          title: headline(out.plain),
          description: cardBody(plain),
          items: taps.map((s) =>
            replyBtn(
              s.label,
              s.target.startsWith(CONTROL_PREFIX)
                ? encodeControl(s.target.slice(CONTROL_PREFIX.length))
                : encodeCallback(s.target, s.params ?? {}),
            ),
          ),
        }
      : undefined,
  };
}

/** First non-empty line, unwrapped from its bold markers and length-capped. */
function headline(plain: string): string {
  const first = (plain ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  const bare = (first ?? 'Done').replace(/^\*+|\*+$/g, '');
  return bare.slice(0, WA_BUTTONS.title) || 'Done';
}

/**
 * The message body for a button card: everything after the headline, which the
 * card already shows above it. Falls back to the whole text when there is only
 * one line, so a one-line confirmation is never blank.
 */
function cardBody(plain: string): string {
  const lines = (plain ?? '').split('\n');
  const firstIdx = lines.findIndex((l) => l.trim());
  const rest = lines
    .slice(firstIdx + 1)
    .join('\n')
    .trim();
  return (rest || (plain ?? '').trim() || 'Pick one, or reply MENU.').slice(
    0,
    WA_BUTTONS.description,
  );
}
