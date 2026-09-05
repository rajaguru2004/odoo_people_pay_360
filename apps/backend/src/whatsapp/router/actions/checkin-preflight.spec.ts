import { essActions } from './ess.actions';
import type { PreflightCtx } from '../action.types';
import { VERIFICATION_MODE } from '../../../common/verification/verification.types';

/**
 * The check-in gate answers three questions in a fixed order, and the order is
 * the point:
 *
 *   1. report what is already true,
 *   2. ask for identity proof if the company requires it,
 *   3. ask for a location if the branch requires one.
 *
 * (1) moved ahead of (2) when face verification stopped being a flat refusal.
 * It is now sometimes a PROMPT — "send me a selfie" — and prompting somebody
 * who is already checked in both wastes their time and mints a single-use
 * capability that can only ever be spent on a duplicate-check-in error.
 *
 * (2) stays ahead of (3) because when both are needed the face prompt is a link
 * that collects the position too; asking for a location first would send the
 * employee round a loop that ends at the same page.
 */

const checkIn = () => essActions().find((a) => a.key === 'attendance.checkin')!;

function ctx(over: Partial<PreflightCtx> = {}): PreflightCtx {
  return {
    getSetting: async (_k, fallback = '') => fallback,
    hasEmployee: true,
    geofenceRequired: false,
    verificationMode: VERIFICATION_MODE.OFF,
    faceProofPrompt: async () => 'SEND-A-SELFIE',
    locationPrompt: async () => 'SHARE-LOCATION',
    todayStatus: async () => null,
    timeZone: 'Asia/Kolkata',
    ...over,
  } as PreflightCtx;
}

/** Face-only attendance switched on company-wide. */
const faceOnly = async (key: string, fallback = '') =>
  key === 'attendance_face_only' ? 'true' : fallback;

describe('check-in preflight', () => {
  it('lets a normal check-in through', async () => {
    expect(await checkIn().preflight!(ctx())).toBeNull();
  });

  it('reports an open session instead of asking for a location', async () => {
    // The bug this guards: a geofenced branch handing out a location prompt to
    // somebody already checked in, whose only possible outcome is a duplicate
    // check-in error several steps later.
    const refusal = await checkIn().preflight!(
      ctx({
        geofenceRequired: true,
        todayStatus: async () => ({ checkIn: '2026-08-08T08:12:00.000Z' }),
      }),
    );

    expect(refusal).toContain('Already checked in');
    // Rendered in the reader's zone, not UTC: 08:12Z is 13:42 in Kolkata.
    expect(refusal).toContain('13:42');
    expect(refusal).not.toContain('SHARE-LOCATION');
  });

  it('allows a fresh check-in after the previous session was closed', async () => {
    // Checked in AND out is a finished session, not an open one.
    expect(
      await checkIn().preflight!(
        ctx({
          todayStatus: async () => ({
            checkIn: '2026-08-08T08:12:00.000Z',
            checkOut: '2026-08-08T12:00:00.000Z',
          }),
        }),
      ),
    ).toBeNull();
  });

  it('asks for a location when the branch is geofenced and nothing is open', async () => {
    expect(await checkIn().preflight!(ctx({ geofenceRequired: true }))).toBe('SHARE-LOCATION');
  });

  it('proceeds when today cannot be read', async () => {
    // A failed status read must not block a check-in; the service decides.
    expect(await checkIn().preflight!(ctx({ todayStatus: async () => null }))).toBeNull();
  });

  describe('when the company requires face verification', () => {
    it('refuses outright when this channel may not verify', async () => {
      const refusal = await checkIn().preflight!(
        ctx({ getSetting: faceOnly, geofenceRequired: true }),
      );
      expect(refusal).toContain('face verification');
      expect(refusal).not.toContain('SHARE-LOCATION');
    });

    it('proceeds when the linked account is accepted as the identity check', async () => {
      expect(
        await checkIn().preflight!(
          ctx({ getSetting: faceOnly, verificationMode: VERIFICATION_MODE.IDENTITY_ONLY }),
        ),
      ).toBeNull();
    });

    it.each([VERIFICATION_MODE.SELFIE_IN_CHAT, VERIFICATION_MODE.SECURE_LINK])(
      'asks for a face proof under %s',
      async (verificationMode) => {
        expect(
          await checkIn().preflight!(ctx({ getSetting: faceOnly, verificationMode })),
        ).toBe('SEND-A-SELFIE');
      },
    );

    it('asks for the face proof INSTEAD of a separate location prompt', async () => {
      // A geofenced selfie escalates to the link, and one page collects both —
      // so asking for a location as well would be a loop back to the same page.
      expect(
        await checkIn().preflight!(
          ctx({
            getSetting: faceOnly,
            verificationMode: VERIFICATION_MODE.SELFIE_IN_CHAT,
            geofenceRequired: true,
          }),
        ),
      ).toBe('SEND-A-SELFIE');
    });

    it('reports an open session rather than asking for a selfie', async () => {
      // Prompting here would mint a single-use capability whose only possible
      // outcome is a duplicate-check-in error.
      const refusal = await checkIn().preflight!(
        ctx({
          getSetting: faceOnly,
          verificationMode: VERIFICATION_MODE.SELFIE_IN_CHAT,
          todayStatus: async () => ({ checkIn: '2026-08-08T08:12:00.000Z' }),
        }),
      );
      expect(refusal).toContain('Already checked in');
      expect(refusal).not.toContain('SEND-A-SELFIE');
    });
  });
});

describe('check-out preflight', () => {
  const checkOut = () => essActions().find((a) => a.key === 'attendance.checkout')!;

  it('lets a normal check-out through', async () => {
    expect(
      await checkOut().preflight!(
        ctx({ todayStatus: async () => ({ checkIn: '2026-08-08T08:12:00.000Z' }) }),
      ),
    ).toBeNull();
  });

  it('says there is nothing to check out from', async () => {
    // The mirror of the "already checked in" guard: answer the question that
    // was asked before minting a capability whose only outcome is an error.
    const refusal = await checkOut().preflight!(
      ctx({ geofenceRequired: true, todayStatus: async () => ({}) }),
    );
    expect(refusal).toContain('not checked in');
    expect(refusal).not.toContain('SHARE-LOCATION');
  });

  it('reports an already-closed day instead of a link', async () => {
    const refusal = await checkOut().preflight!(
      ctx({
        geofenceRequired: true,
        todayStatus: async () => ({
          checkIn: '2026-08-08T08:12:00.000Z',
          checkOut: '2026-08-08T12:30:00.000Z',
        }),
      }),
    );
    expect(refusal).toContain('Already checked out');
    // 12:30Z rendered in Kolkata.
    expect(refusal).toContain('18:00');
  });

  it('asks for the location link when the branch is geofenced', async () => {
    // The SAME gate as check-in — an unverified checkout would make the
    // verified check-in theatre.
    expect(
      await checkOut().preflight!(
        ctx({
          geofenceRequired: true,
          todayStatus: async () => ({ checkIn: '2026-08-08T08:12:00.000Z' }),
        }),
      ),
    ).toBe('SHARE-LOCATION');
  });

  it('asks for the face proof under SECURE_LINK', async () => {
    expect(
      await checkOut().preflight!(
        ctx({
          getSetting: faceOnly,
          verificationMode: VERIFICATION_MODE.SECURE_LINK,
          todayStatus: async () => ({ checkIn: '2026-08-08T08:12:00.000Z' }),
        }),
      ),
    ).toBe('SEND-A-SELFIE');
  });

  it('proceeds when today cannot be read', async () => {
    // A failed status read must not block a check-out; the service decides.
    expect(await checkOut().preflight!(ctx({ todayStatus: async () => null }))).toBeNull();
  });
});

describe('multiple sessions in one day', () => {
  // The real row that produced the bug report: checked in, out, then in again.
  // BOTH columns hold a value, so any test written against them alone is
  // wrong in one direction or the other.
  const midShift = {
    checkIn: '2026-08-10T08:54:13.308Z',
    checkOut: '2026-08-10T09:01:54.953Z',
    sessions: [
      { checkIn: '2026-08-10T08:54:13.308Z', checkOut: '2026-08-10T09:01:54.953Z' },
      { checkIn: '2026-08-10T09:02:56.579Z', checkOut: null },
    ],
  };

  const checkOut = () => essActions().find((a) => a.key === 'attendance.checkout')!;

  it('reports the CURRENT session start, not the day opening', async () => {
    const refusal = await checkIn().preflight!(ctx({ todayStatus: async () => midShift }));
    // 09:02:56Z is 14:32 in Kolkata — the punch just made.
    expect(refusal).toContain('14:32');
    // 08:54Z is 14:24 — the morning, which is what it used to say.
    expect(refusal).not.toContain('14:24');
  });

  it('lets a mid-shift employee check OUT', async () => {
    // `checkIn && checkOut` was true here, so checkout was refused with
    // "already checked out" while the employee was still on the clock.
    expect(await checkOut().preflight!(ctx({ todayStatus: async () => midShift }))).toBeNull();
  });

  it('still refuses a check-out once every session is closed', async () => {
    const closed = {
      ...midShift,
      sessions: [
        { checkIn: '2026-08-10T08:54:13.308Z', checkOut: '2026-08-10T09:01:54.953Z' },
        { checkIn: '2026-08-10T09:02:56.579Z', checkOut: '2026-08-10T12:00:00.000Z' },
      ],
    };
    const refusal = await checkOut().preflight!(ctx({ todayStatus: async () => closed }));
    expect(refusal).toContain('Already checked out');
    // The LAST check-out (12:00Z = 17:30 IST), not the first.
    expect(refusal).toContain('17:30');
  });
});
