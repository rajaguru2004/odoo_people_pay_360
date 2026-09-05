import { ActorChannelName, getActorChannel } from '../context/channel-context';

/**
 * What a conversational channel may accept in place of a live face scan when
 * `attendance_face_only` is on.
 *
 * Deliberately an ordered ladder of ASSURANCE rather than of convenience:
 *
 *   OFF             proves nothing, so the channel may not punch at all.
 *   IDENTITY_ONLY   proves possession of an enrolled account — the link was
 *                   made with a one-time code that had to cross BOTH an
 *                   authenticated web session and the handset, so neither
 *                   alone could have produced it.
 *   SELFIE_IN_CHAT  adds a photo that matches the employee's enrolled face.
 *                   It does NOT prove presence: a saved photo and a live
 *                   capture are indistinguishable at the wire level.
 *   SECURE_LINK     adds a live camera frame and a GPS fix collected in one
 *                   submit from a page we served.
 *
 * Only IDENTITY_ONLY is an *exemption*. The other two do not skip the face
 * check — they satisfy it, arriving as `byFace: true` from a path that really
 * matched a descriptor.
 */
export const VERIFICATION_MODE = {
  OFF: 'OFF',
  IDENTITY_ONLY: 'IDENTITY_ONLY',
  SELFIE_IN_CHAT: 'SELFIE_IN_CHAT',
  SECURE_LINK: 'SECURE_LINK',
} as const;
export type VerificationMode = (typeof VERIFICATION_MODE)[keyof typeof VERIFICATION_MODE];

/**
 * Which punch a policy or a proof is for.
 *
 * Always a compile-time literal written at the enforcement sites in
 * AttendancesService. It is never read off the wire, which is what lets it be
 * a parameter without reopening the hole the actor-channel lookup closes.
 */
export const VERIFICATION_PURPOSE = {
  CHECKIN: 'CHECKIN',
  CHECKOUT: 'CHECKOUT',
  LUNCH_IN: 'LUNCH_IN',
  LUNCH_OUT: 'LUNCH_OUT',
} as const;
export type VerificationPurpose =
  (typeof VERIFICATION_PURPOSE)[keyof typeof VERIFICATION_PURPOSE];

/** Absent, misspelt, or written by a newer deploy all mean OFF. Never throws. */
export function parseVerificationMode(raw: string | null | undefined): VerificationMode {
  const v = (raw ?? '').trim().toUpperCase();
  return (Object.values(VERIFICATION_MODE) as string[]).includes(v)
    ? (v as VerificationMode)
    : VERIFICATION_MODE.OFF;
}

/**
 * Per-channel policy key.
 *
 * A channel absent from this map can NEVER be exempt and can never mint a
 * verification capability, whatever settings exist. Every channel is absent
 * today: `web`, `copilot`, `mcp` and `system` all punch through the ordinary
 * authenticated paths, so none of them may claim an exemption. A conversational
 * channel that needs one adds its key here and nowhere else.
 *
 * Kept out of AttendancesService so the enforcement site and its test read the
 * same map instead of the test hand-copying one that can silently drift.
 */
export const VERIFICATION_SETTING_KEYS: Partial<Record<ActorChannelName, string>> = {};

/**
 * Global kill switch. Not namespaced to any channel, so no channel's own
 * settings page can flip it back on.
 */
export const VERIFICATION_KILL_SWITCH_KEY = 'attendance_channel_verification_enabled';

/**
 * The policy in force for ONE action, on the channel this request arrived over.
 *
 * The channel comes from AsyncLocalStorage, exactly as it did before there was
 * an enum: there is no parameter for it and no way for a caller to supply one.
 * `purpose` IS a parameter, but every value of it is a literal written at an
 * enforcement site, so it is not reachable from the wire either.
 *
 * Precedence: kill switch > per-action key > channel key > OFF.
 *
 * This function is the single resolver the whole feature reads through. Before
 * it, three call sites disagreed about the default — the settings service said
 * true, the enforcement site said false — so the admin toggle rendered ON while
 * nothing was actually exempt.
 */
export async function resolveVerificationMode(
  getSetting: (key: string, fallback: string) => Promise<string>,
  purpose: VerificationPurpose,
): Promise<VerificationMode> {
  const channel = getActorChannel()?.channel;
  const base = channel ? VERIFICATION_SETTING_KEYS[channel] : undefined;
  if (!base || !channel) return VERIFICATION_MODE.OFF;

  if ((await getSetting(VERIFICATION_KILL_SWITCH_KEY, 'true')) !== 'true') {
    return VERIFICATION_MODE.OFF;
  }

  const perAction = await getSetting(`${base}.${purpose}`, '');
  if (perAction) return parseVerificationMode(perAction);

  const channelWide = await getSetting(base, '');
  if (channelWide) return parseVerificationMode(channelWide);

  return VERIFICATION_MODE.OFF;
}

/** Which proofs a mode demands before the punch may run. */
export function proofsFor(
  mode: VerificationMode,
  geofenceRequired: boolean,
): { face: boolean; location: boolean } {
  return {
    face:
      mode === VERIFICATION_MODE.SELFIE_IN_CHAT || mode === VERIFICATION_MODE.SECURE_LINK,
    location: geofenceRequired,
  };
}

/**
 * How a mode's proofs are actually collected.
 *
 * A geofenced SELFIE_IN_CHAT escalates to SECURE_LINK rather than growing a
 * two-attachment protocol: one page already collects a live frame and a
 * position in a single submit, which is exactly the problem. Deterministic, and
 * it needs no extra setting.
 */
export function effectiveMode(
  mode: VerificationMode,
  geofenceRequired: boolean,
): VerificationMode {
  return mode === VERIFICATION_MODE.SELFIE_IN_CHAT && geofenceRequired
    ? VERIFICATION_MODE.SECURE_LINK
    : mode;
}
