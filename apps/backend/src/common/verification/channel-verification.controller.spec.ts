import { ChannelVerificationController } from './channel-verification.controller';

/**
 * The browser half of a verified punch, and the promise it closes: the person
 * taps Check in, opens the link, and the OUTCOME lands back in the chat they
 * started from — "✅ Checked in" or "❌ Not checked in" with the reason. The
 * page showing a result is not enough; the chat is where the conversation
 * lives, and a closed tab must not swallow the answer.
 */

const ROW = {
  id: 'row-1',
  channel: 'whatsapp',
  deliveryMode: 'LINK',
  identityId: 'i1',
  userId: 'u1',
  employeeId: 'e1',
  purpose: 'CHECKIN',
  requireLocation: true,
  requireFace: false,
  actionKey: 'attendance.checkin',
  toolName: 'attendance_check_in',
  args: {},
  attempts: 0,
  maxAttempts: 5,
  expiresAt: new Date(Date.now() + 600_000),
  faceVerifiedAt: null,
};

function harness(over: { row?: any } = {}) {
  const row = { ...ROW, ...(over.row ?? {}) };

  const tokens: any = {
    consume: jest.fn(async () => ({ ok: true, row })),
    release: jest.fn(async () => undefined),
    bumpAttempts: jest.fn(async () => 1),
  };
  const faces: any = {
    verifyAndRecord: jest.fn(async () => ({ ok: true })),
  };
  const principals: any = {
    runAs: jest.fn(async (_ch: string, _ref: string, _uid: string, fn: any) =>
      fn({ id: 'u1', role: 'EMPLOYEE', employeeId: 'e1' }),
    ),
  };
  const caller: any = {
    call: jest.fn(async () => ({
      success: true,
      data: { checkIn: '2026-08-09T05:00:00.000Z', status: 'PRESENT' },
    })),
  };
  const prisma: any = {
    whatsAppIdentity: {
      findUnique: jest.fn(async () => ({ phoneE164: '+918608721969', status: 'ACTIVE' })),
    },
    discordIdentity: {
      findUnique: jest.fn(async () => ({ discordUserId: 'D123', status: 'ACTIVE' })),
    },
    employee: {
      findUnique: jest.fn(async () => ({ timezone: 'Asia/Kolkata' })),
    },
  };
  const whatsappOutbox: any = {
    enqueueDirect: jest.fn(async () => ({ queued: true })),
  };
  const discordOutbox: any = {
    enqueueDirect: jest.fn(async () => true),
  };
  // The real resolver's contract: employee zone wins, company zone otherwise.
  const tzSvc: any = {
    getEffectiveTZ: jest.fn(async (tz: string | null) => tz ?? 'Asia/Kolkata'),
  };

  const ctrl = new ChannelVerificationController(
    tokens,
    faces,
    principals,
    caller,
    prisma,
    whatsappOutbox,
    discordOutbox,
    tzSvc,
  );
  return { ctrl, tokens, faces, caller, whatsappOutbox, discordOutbox, prisma, row };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('/channel/verify — the outcome reaches the chat', () => {
  it('confirms a successful punch into WhatsApp, in the employee timezone', async () => {
    const { ctrl, whatsappOutbox } = harness();
    const res = await ctrl.verify('tok', { latitude: 13.08, longitude: 80.27 } as any);
    await flush();

    expect(res.success).toBe(true);
    expect(whatsappOutbox.enqueueDirect).toHaveBeenCalledTimes(1);
    const sent = whatsappOutbox.enqueueDirect.mock.calls[0][0];
    expect(sent.toE164).toBe('+918608721969');
    expect(sent.body).toContain('Checked in');
    // 05:00Z is 10:30 in Kolkata — the zone conversion is part of the promise.
    expect(sent.body).toContain('10:30');
    // Dedupe on the token row id: a replayed POST cannot double-message.
    expect(sent.dedupeKey).toBe('verify:row-1:ok');

    // The PAGE gets the same label, already formatted. It used to choose
    // between checkIn and checkOut itself and formatted in the browser's zone,
    // so the two surfaces could disagree.
    expect((res.data as any).atLabel).toBe('10:30');
  });

  it('gives the page the punch just made, not the day opening', async () => {
    // A check-out was confirmed on the page as the morning's check-in, because
    // the day's first check-in is always set and the page preferred it.
    const { ctrl, caller } = harness({
      row: { purpose: 'CHECKOUT', toolName: 'attendance_check_out' },
    });
    caller.call.mockResolvedValue({
      success: true,
      data: {
        checkIn: '2026-08-09T05:00:00.000Z', // 10:30 IST — the day opening
        checkOut: '2026-08-09T12:30:00.000Z',
        sessions: [
          { checkIn: '2026-08-09T05:00:00.000Z', checkOut: '2026-08-09T12:30:00.000Z' },
        ],
      },
    });

    const res = await ctrl.verify('tok', { latitude: 13.08, longitude: 80.27 } as any);
    expect((res.data as any).atLabel).toBe('18:00'); // 12:30Z — the check-out
    expect((res.data as any).atLabel).not.toBe('10:30');
  });

  it('falls back to the COMPANY zone when the employee has none — never UTC', async () => {
    // The bug this pins: a hand-rolled `tz ?? 'UTC'` told somebody who checked
    // in at 14:24 IST that they checked in at 08:54. Most employees have no
    // personal timezone; the company zone is the answer for all of them.
    const { ctrl, whatsappOutbox, prisma } = harness();
    prisma.employee.findUnique.mockResolvedValue({ timezone: null });

    await ctrl.verify('tok', { latitude: 13.08, longitude: 80.27 } as any);
    await flush();

    expect(whatsappOutbox.enqueueDirect.mock.calls[0][0].body).toContain('10:30');
  });

  it('routes the confirmation to Discord for a Discord row', async () => {
    const { ctrl, discordOutbox, whatsappOutbox } = harness({ row: { channel: 'discord' } });
    await ctrl.verify('tok', { latitude: 13.08, longitude: 80.27 } as any);
    await flush();

    expect(discordOutbox.enqueueDirect).toHaveBeenCalledTimes(1);
    expect(discordOutbox.enqueueDirect.mock.calls[0][0].discordUserId).toBe('D123');
    expect(whatsappOutbox.enqueueDirect).not.toHaveBeenCalled();
  });

  it('shows a geofence denial VERBATIM and tells the chat', async () => {
    // ForbiddenException surfaces as a 403. It is the one rejection whose text
    // is the only thing the employee can act on, and — being the punch itself
    // refused — it is exactly "not checked in, and its reason".
    const { ctrl, caller, whatsappOutbox, tokens } = harness();
    caller.call.mockResolvedValue({
      error: { status: 403, message: 'You are out of office range (240m away, allowed 100m). Check-in denied.' },
    });

    const res = await ctrl.verify('tok', { latitude: 1, longitude: 1 } as any);
    await flush();

    expect(res.success).toBe(false);
    expect((res.data as any).message).toContain('out of office range');
    expect((res.data as any).retryable).toBe(true);
    // Released, so walking fifty metres and retrying does not need a new link.
    expect(tokens.release).toHaveBeenCalled();
    const sent = whatsappOutbox.enqueueDirect.mock.calls[0][0];
    expect(sent.body).toContain('Not checked in');
    expect(sent.body).toContain('out of office range');
    expect(sent.dedupeKey).toBe('verify:row-1:failed');
  });

  it('stays quiet in the chat while face retries are live on the page', async () => {
    // With attempts left the person is LOOKING at the page and retrying;
    // echoing every blurry photo would turn five retries into five pings.
    const { ctrl, faces, whatsappOutbox } = harness({ row: { requireFace: true } });
    faces.verifyAndRecord.mockResolvedValue({ ok: false, message: 'Too blurry.' });

    const res = await ctrl.verify('tok', { image: 'x', latitude: 1, longitude: 1 } as any);
    await flush();

    expect((res.data as any).retryable).toBe(true);
    expect(whatsappOutbox.enqueueDirect).not.toHaveBeenCalled();
  });

  it('tells the chat when face attempts are exhausted', async () => {
    const { ctrl, faces, tokens, whatsappOutbox } = harness({ row: { requireFace: true } });
    faces.verifyAndRecord.mockResolvedValue({ ok: false, message: 'That does not look like you.' });
    tokens.bumpAttempts.mockResolvedValue(5); // == maxAttempts: terminal

    const res = await ctrl.verify('tok', { image: 'x', latitude: 1, longitude: 1 } as any);
    await flush();

    expect((res.data as any).retryable).toBe(false);
    const sent = whatsappOutbox.enqueueDirect.mock.calls[0][0];
    expect(sent.body).toContain('Not checked in');
    expect(sent.dedupeKey).toBe('verify:row-1:failed');
  });

  it('sends nothing for an unknown or replayed token', async () => {
    // No identity was ever resolved, so there is nobody to message — and a
    // guessed token must never cause any observable side effect.
    const { ctrl, tokens, whatsappOutbox, discordOutbox } = harness();
    tokens.consume.mockResolvedValue({ ok: false, reason: 'replay' });

    const res = await ctrl.verify('tok', {} as any);
    await flush();

    expect(res.success).toBe(false);
    expect(whatsappOutbox.enqueueDirect).not.toHaveBeenCalled();
    expect(discordOutbox.enqueueDirect).not.toHaveBeenCalled();
  });

  it('says "Checked out" for a checkout row', async () => {
    const { ctrl, caller, whatsappOutbox } = harness({ row: { purpose: 'CHECKOUT', toolName: 'attendance_check_out' } });
    caller.call.mockResolvedValue({
      success: true,
      data: { checkOut: '2026-08-09T12:30:00.000Z' },
    });

    await ctrl.verify('tok', { latitude: 13.08, longitude: 80.27 } as any);
    await flush();

    const sent = whatsappOutbox.enqueueDirect.mock.calls[0][0];
    expect(sent.body).toContain('Checked out');
    // 12:30Z is 18:00 in Kolkata.
    expect(sent.body).toContain('18:00');
  });
});
