import { runWithChannel } from '../common/context/channel-context';
import {
  LEGACY_FACE_OVERRIDE_KEYS,
  VERIFICATION_KILL_SWITCH_KEY,
  VERIFICATION_MODE,
  VERIFICATION_SETTING_KEYS,
  VerificationMode,
  VerificationPurpose,
  parseVerificationMode,
  resolveVerificationMode,
} from '../common/verification/verification.types';

/**
 * Face-only attendance can be satisfied by a linked WhatsApp or Discord
 * identity, and — with a stricter policy — by a photo that actually matches.
 *
 * The security property that makes any of that acceptable is narrow and worth
 * pinning: the decision is made from the ACTOR CHANNEL, which the runtime sets,
 * and never from a method argument or tool parameter a caller controls.
 *
 * These tests exercise the REAL resolver rather than a copy of it. The previous
 * version mirrored both the key map and the predicate locally, so the file
 * could keep passing while the thing it describes drifted underneath it.
 */

/**
 * The one step AttendancesService adds on top of the resolver.
 *
 * Only IDENTITY_ONLY is an exemption. SELFIE_IN_CHAT and SECURE_LINK are
 * stricter policies, not looser ones — they arrive as byFace=true from a path
 * that matched a real descriptor, and must never skip the check by themselves.
 */
async function faceCheckSatisfiedByChannel(
  getSetting: (key: string, fallback: string) => Promise<string>,
  purpose: VerificationPurpose = 'CHECKIN',
): Promise<boolean> {
  return (await resolveVerificationMode(getSetting, purpose)) === VERIFICATION_MODE.IDENTITY_ONLY;
}

/** Settings reader over a plain map; anything absent yields the fallback. */
const settings =
  (map: Record<string, string>) =>
  async (key: string, fallback: string): Promise<string> =>
    map[key] ?? fallback;

const nothingSet = settings({});
const legacyOn = (channel: 'whatsapp' | 'discord') =>
  settings({ [LEGACY_FACE_OVERRIDE_KEYS[channel]!]: 'true' });
const modeSet = (channel: 'whatsapp' | 'discord', mode: VerificationMode) =>
  settings({ [VERIFICATION_SETTING_KEYS[channel]!]: mode });

const CHANNELS = ['whatsapp', 'discord'] as const;
const PURPOSES: VerificationPurpose[] = ['CHECKIN', 'CHECKOUT', 'LUNCH_IN', 'LUNCH_OUT'];
const MODES = Object.values(VERIFICATION_MODE);

describe('face-only exemption by channel', () => {
  it.each(CHANNELS)('exempts %s when the mode is IDENTITY_ONLY', async (channel) => {
    await runWithChannel({ channel, ref: 'actor-ref' }, async () => {
      expect(
        await faceCheckSatisfiedByChannel(modeSet(channel, VERIFICATION_MODE.IDENTITY_ONLY)),
      ).toBe(true);
    });
  });

  it.each(CHANNELS)('still honours the legacy boolean for %s', async (channel) => {
    // An admin who deliberately switched the old toggle on keeps exactly the
    // behaviour they chose, until the key is removed a release from now.
    await runWithChannel({ channel }, async () => {
      expect(await faceCheckSatisfiedByChannel(legacyOn(channel))).toBe(true);
    });
  });

  it.each(CHANNELS)('does not exempt %s when nothing is configured', async (channel) => {
    // The default is what an untouched install actually ENFORCED. It used to
    // read `true` in the settings service and `false` here, so the admin
    // toggle rendered on while nothing was exempt.
    await runWithChannel({ channel }, async () => {
      expect(await faceCheckSatisfiedByChannel(nothingSet)).toBe(false);
    });
  });

  it.each(CHANNELS)('is NARROWED, not widened, by the stricter modes for %s', async (channel) => {
    // The assertion that matters most about the enum: only IDENTITY_ONLY skips
    // the face check. The two modes that actually involve a face do not — they
    // satisfy it by matching one.
    await runWithChannel({ channel }, async () => {
      for (const mode of [
        VERIFICATION_MODE.OFF,
        VERIFICATION_MODE.SELFIE_IN_CHAT,
        VERIFICATION_MODE.SECURE_LINK,
      ]) {
        expect(await faceCheckSatisfiedByChannel(modeSet(channel, mode))).toBe(false);
      }
    });
  });

  it('reads a separate key per channel', async () => {
    // Enabling one channel must not enable the other: they are different
    // identity proofs and an admin may trust only one.
    await runWithChannel({ channel: 'discord' }, async () => {
      expect(
        await faceCheckSatisfiedByChannel(
          modeSet('whatsapp', VERIFICATION_MODE.IDENTITY_ONLY),
        ),
      ).toBe(false);
      expect(
        await faceCheckSatisfiedByChannel(modeSet('discord', VERIFICATION_MODE.IDENTITY_ONLY)),
      ).toBe(true);
    });
  });

  it('lets a per-action key beat the channel-wide one', async () => {
    await runWithChannel({ channel: 'whatsapp' }, async () => {
      const read = settings({
        [VERIFICATION_SETTING_KEYS.whatsapp!]: VERIFICATION_MODE.IDENTITY_ONLY,
        [`${VERIFICATION_SETTING_KEYS.whatsapp!}.CHECKIN`]: VERIFICATION_MODE.SECURE_LINK,
      });
      expect(await faceCheckSatisfiedByChannel(read, 'CHECKIN')).toBe(false);
      expect(await faceCheckSatisfiedByChannel(read, 'CHECKOUT')).toBe(true);
    });
  });

  it('ignores the legacy boolean once an enum value exists', async () => {
    await runWithChannel({ channel: 'whatsapp' }, async () => {
      expect(
        await faceCheckSatisfiedByChannel(
          settings({
            [LEGACY_FACE_OVERRIDE_KEYS.whatsapp!]: 'true',
            [VERIFICATION_SETTING_KEYS.whatsapp!]: VERIFICATION_MODE.OFF,
          }),
        ),
      ).toBe(false);
    });
  });

  it('is forced OFF by the global kill switch', async () => {
    await runWithChannel({ channel: 'whatsapp' }, async () => {
      expect(
        await faceCheckSatisfiedByChannel(
          settings({
            [VERIFICATION_KILL_SWITCH_KEY]: 'false',
            [VERIFICATION_SETTING_KEYS.whatsapp!]: VERIFICATION_MODE.IDENTITY_ONLY,
          }),
        ),
      ).toBe(false);
    });
  });

  it.each(['identity only', 'yes', 'TRUE', '', '  '])(
    'resolves the unparseable value %p to OFF',
    (raw) => {
      // A free-text typo must not become a fourth, accidental policy.
      expect(parseVerificationMode(raw)).toBe(VERIFICATION_MODE.OFF);
    },
  );

  it.each(['web', 'copilot', 'mcp', 'system'] as const)(
    'never exempts the %s channel, whatever is configured',
    async (channel) => {
      // A channel absent from the key map has no key to read, so no setting
      // and no purpose can switch face verification off for the web app or the
      // copilot. Swept exhaustively because this is the boundary.
      await runWithChannel({ channel }, async () => {
        for (const purpose of PURPOSES) {
          for (const mode of MODES) {
            const read = settings({
              'whatsapp.attendanceVerification': mode,
              'discord.attendanceVerification': mode,
              [`${channel}.attendanceVerification`]: mode,
              [`${channel}.attendanceVerification.${purpose}`]: mode,
              'whatsapp.attendanceFaceOverride': 'true',
              'discord.attendanceFaceOverride': 'true',
            });
            expect(await faceCheckSatisfiedByChannel(read, purpose)).toBe(false);
          }
        }
      });
    },
  );

  it('never exempts when there is no channel context at all', async () => {
    // Crons, scripts and any path that forgot to set a channel fail closed.
    expect(await faceCheckSatisfiedByChannel(legacyOn('whatsapp'))).toBe(false);
  });

  it('cannot be reached by a caller-supplied argument', async () => {
    // The whole point: there is no parameter for the channel. A tool argument
    // named "verifiedVia" would have let the copilot — or anyone holding an MCP
    // token — bypass face verification by asking nicely.
    //
    // `purpose` IS a parameter, so the assertion is on the parameter NAMES
    // rather than the arity: what must not exist is a channel or a mode.
    const src = resolveVerificationMode.toString();
    expect(src).toContain('getActorChannel');

    const params = src
      .slice(src.indexOf('(') + 1, src.indexOf(')'))
      .split(',')
      .map((p) => p.trim().split(/[:=\s]/)[0])
      .filter(Boolean);
    expect(params).toEqual(['getSetting', 'purpose']);
  });

  it('does not leak across sibling contexts', async () => {
    await runWithChannel({ channel: 'discord' }, async () => {
      expect(await faceCheckSatisfiedByChannel(legacyOn('discord'))).toBe(true);
    });
    // Back outside the Discord scope, the exemption is gone.
    expect(await faceCheckSatisfiedByChannel(legacyOn('discord'))).toBe(false);
  });
});
