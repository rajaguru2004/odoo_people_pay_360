import { ChannelVerificationController } from './channel-verification.controller';

/**
 * The browser half of a verified punch: the token is the only credential AND
 * the only instruction, and the page is told the outcome of the one action the
 * row was minted for — including the time it actually happened, formatted in
 * the employee's own zone.
 */

const ROW = {
  id: 'row-1',
  channel: 'web',
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
    employee: {
      findUnique: jest.fn(async () => ({ timezone: 'Asia/Kolkata' })),
    },
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
    tzSvc,
  );
  return { ctrl, tokens, faces, caller, prisma, row };
}

describe('/channel/verify — the outcome reaches the page', () => {
  it('confirms a successful punch in the employee timezone', async () => {
    const { ctrl } = harness();
    const res = await ctrl.verify('tok', { latitude: 13.08, longitude: 80.27 } as any);

    expect(res.success).toBe(true);
    // 05:00Z is 10:30 in Kolkata — the zone conversion is part of the promise.
    // The page gets the label already formatted; it used to choose between
    // checkIn and checkOut itself and formatted in the browser's zone.
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
    const { ctrl, prisma } = harness();
    prisma.employee.findUnique.mockResolvedValue({ timezone: null });

    const res = await ctrl.verify('tok', { latitude: 13.08, longitude: 80.27 } as any);

    expect((res.data as any).atLabel).toBe('10:30');
  });

  it('shows a geofence denial VERBATIM and leaves the link usable', async () => {
    // ForbiddenException surfaces as a 403. It is the one rejection whose text
    // is the only thing the employee can act on.
    const { ctrl, caller, tokens } = harness();
    caller.call.mockResolvedValue({
      error: {
        status: 403,
        message: 'You are out of office range (240m away, allowed 100m). Check-in denied.',
      },
    });

    const res = await ctrl.verify('tok', { latitude: 1, longitude: 1 } as any);

    expect(res.success).toBe(false);
    expect((res.data as any).message).toContain('out of office range');
    expect((res.data as any).retryable).toBe(true);
    // Released, so walking fifty metres and retrying does not need a new link.
    expect(tokens.release).toHaveBeenCalled();
  });

  it('keeps a failed face capture retryable while attempts remain', async () => {
    const { ctrl, faces } = harness({ row: { requireFace: true } });
    faces.verifyAndRecord.mockResolvedValue({ ok: false, message: 'Too blurry.' });

    const res = await ctrl.verify('tok', { image: 'x', latitude: 1, longitude: 1 } as any);

    expect((res.data as any).retryable).toBe(true);
  });

  it('stops retrying once face attempts are exhausted', async () => {
    const { ctrl, faces, tokens } = harness({ row: { requireFace: true } });
    faces.verifyAndRecord.mockResolvedValue({ ok: false, message: 'That does not look like you.' });
    tokens.bumpAttempts.mockResolvedValue(5); // == maxAttempts: terminal

    const res = await ctrl.verify('tok', { image: 'x', latitude: 1, longitude: 1 } as any);

    expect((res.data as any).retryable).toBe(false);
  });

  it('does nothing at all for an unknown or replayed token', async () => {
    // A guessed token must never cause any observable side effect.
    const { ctrl, tokens, caller } = harness();
    tokens.consume.mockResolvedValue({ ok: false, reason: 'replay' });

    const res = await ctrl.verify('tok', {} as any);

    expect(res.success).toBe(false);
    expect(caller.call).not.toHaveBeenCalled();
  });
});
