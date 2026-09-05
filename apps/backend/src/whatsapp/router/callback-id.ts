/**
 * Encoding for button / list selection ids.
 *
 * Format: `v1|<actionKey>|<querystring>`, capped at 200 chars.
 *
 * These ids carry ZERO authority. A user can type any string, and can re-tap a
 * button from a month-old chat, so the router treats an id purely as "name an
 * action and its literal parameters". Role checks, self-scope, branch scope,
 * token consumption and the confirm gate all run afterwards — and any resource
 * id reaches a tool only from a server-side row, never from here.
 */
export const CALLBACK_PREFIX = 'v1|';
export const CALLBACK_MAX = 200;

export interface DecodedCallback {
  actionKey: string;
  params: Record<string, string>;
}

export function encodeCallback(actionKey: string, params: Record<string, string> = {}): string {
  const qs = new URLSearchParams(params).toString();
  const raw = `${CALLBACK_PREFIX}${actionKey}${qs ? `|${qs}` : ''}`;
  return raw.slice(0, CALLBACK_MAX);
}

export function isCallbackId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(CALLBACK_PREFIX);
}

export function decodeCallback(value: string): DecodedCallback | null {
  if (!isCallbackId(value)) return null;
  const [, actionKey, qs] = value.split('|');
  if (!actionKey) return null;

  const params: Record<string, string> = {};
  if (qs) {
    for (const [k, v] of new URLSearchParams(qs)) params[k] = v;
  }
  return { actionKey, params };
}

/**
 * Control verbs need to be tappable too (YES / NO on a confirmation), but they
 * are not actions and have no registry entry. Encoding them under a reserved
 * prefix keeps them inside the one callback grammar rather than inventing a
 * second one.
 */
export const CONTROL_PREFIX = '__ctl.';

export function encodeControl(verb: string): string {
  return encodeCallback(`${CONTROL_PREFIX}${verb}`);
}

export function decodeControl(actionKey: string): string | null {
  return actionKey.startsWith(CONTROL_PREFIX) ? actionKey.slice(CONTROL_PREFIX.length) : null;
}
