import { WhatsAppOutboxService } from './whatsapp-outbox.service';
import { OUTBOX_STATUS, WhatsAppResolvedConfig } from './whatsapp.types';

/**
 * Outbox behaviour under mocked Prisma. The cases here are the ones where being
 * wrong is expensive: double-messaging a human, burning retry attempts on a
 * request that can never succeed, or delivering to somebody who never consented.
 */

const CFG: WhatsAppResolvedConfig = {
  enabled: true,
  baseUrl: 'https://wa.example.com',
  instanceName: 'inst',
  apiKey: 'k',
  apiKeySource: 'db',
  adminNumber: '',
  defaultRegion: 'OM',
  appBaseUrl: 'https://ess.example.com',
  publicApiUrl: 'https://api.ess.example.com',
  minGapMs: 0,
  maxPerMinute: 1000,
  timeoutMs: 5000,
  maxAttempts: 5,
  requireOptIn: true,
  requireVerified: true,
  allowGenericFallback: false,
  disabledTemplates: [],
  redirectAllTo: '',
  redirectMisconfigured: false,
  redirectAllToRaw: '',
  // Off by default here so the pre-existing cases keep asserting delivery to
  // the seeded identity rather than to whatever auto-enrolment would find.
  autoEnroll: false,
  // Off in the fixture: the copy is an opt-in debugging aid, and every
  // pre-existing case here asserts the single-recipient behaviour.
  carbonCopyEnabled: false,
  carbonCopyTo: '',
  carbonCopyMisconfigured: false,
  carbonCopyToRaw: '',
  inboundEnabled: false,
  enrollmentEnabled: true,
  mutationsEnabled: true,
  approvalsEnabled: false,
  aiFallbackEnabled: false,
  actionDenylist: [],
  requirePinForSensitive: true,
  interactiveMode: 'auto',
  attendanceVerification: 'OFF',
  supportContact: '',
  quietHoursStart: '',
  quietHoursEnd: '',
  quietHoursOverrideTemplates: [],
  selfieDailyCap: 4,
  selfieChallengeSeconds: 120,
  verificationLinkTtlMinutes: 10,
  attendanceFaceOverride: true,
  sessionIdleMinutes: 30,
  flowTtlMinutes: 15,
  pendingActionTtlMinutes: 10,
  approvalTokenTtlMinutes: 60,
  pinTtlMinutes: 10,
  webhookSecret: 'wh-secret',
  logMessageBodies: true,
  inboundRetentionDays: 90,
  ratePerPhone5Min: 20,
  ratePerUserHour: 60,
  rateMutations10Min: 5,
  dryRun: false,
  retentionDays: 90,
  staleHours: 24,
  drainBatchSize: 50,
};

const IDENTITY = {
  id: 'i1',
  userId: 'u1',
  employeeId: 'e1',
  branchId: 'b1',
  phoneE164: '+96890010000',
  createdAt: new Date(),
  failureCount: 0,
};

function makeHarness(over: { cfg?: Partial<WhatsAppResolvedConfig> } = {}) {
  const cfg = { ...CFG, ...over.cfg };

  const prisma: any = {
    whatsAppIdentity: {
      findMany: jest.fn().mockResolvedValue([IDENTITY]),
      findUnique: jest.fn().mockResolvedValue(IDENTITY),
      update: jest.fn().mockResolvedValue(IDENTITY),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    whatsAppMessage: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockImplementation(({ data }: any) => ({ id: 'm1', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'u1', email: 'a@b.c', employee: { fullName: 'Aisha' } },
      ]),
    },
  };

  const settings: any = {
    get: jest.fn().mockResolvedValue(cfg),
    // Sending gate: honours the kill switch.
    ensureConfigured: jest.fn().mockResolvedValue(cfg.enabled ? cfg : null),
    // Diagnostics gate: credentials only.
    ensureCredentials: jest.fn().mockResolvedValue(cfg),
    getCompanyName: jest.fn().mockResolvedValue('Acme HR'),
  };

  const evolution: any = {
    sendText: jest.fn().mockResolvedValue({ ok: true, providerMessageId: 'wa1', retryable: false }),
    setPacing: jest.fn(),
  };

  // Minting is only reachable for a notification that carries a `decision`,
  // which none of these fixtures do — the stub proves that, loudly.
  const tokens: any = {
    issue: jest.fn().mockResolvedValue({ token: 'tok', id: 'tid' }),
    revoke: jest.fn().mockResolvedValue(0),
  };

  const svc = new WhatsAppOutboxService(prisma, settings, evolution, tokens);
  return { svc, prisma, settings, evolution, tokens, cfg };
}

const notification = (over: any = {}) => ({
  userId: 'u1',
  title: 'Leave approved',
  message: 'Your leave was approved.',
  type: 'LEAVE_APPROVED',
  link: '/dashboard/leaves',
  ...over,
});

describe('WhatsAppOutboxService — enqueue', () => {
  it('creates one row for a notification whose type resolves a template', async () => {
    const { svc, prisma } = makeHarness();
    const n = await svc.enqueueFromNotifications([notification()]);

    expect(n).toBe(1);
    const { data } = prisma.whatsAppMessage.createMany.mock.calls[0][0];
    expect(data).toHaveLength(1);
    expect(data[0].templateKey).toBe('leave_approved');
    expect(data[0].toPhoneE164).toBe('+96890010000');
    expect(data[0].body).toContain('Leave approved');
  });

  it('creates nothing when no template resolves', async () => {
    // The gate that keeps ~40 chatty call sites off WhatsApp entirely.
    const { svc, prisma } = makeHarness();
    const n = await svc.enqueueFromNotifications([notification({ type: 'INFO' })]);

    expect(n).toBe(0);
    expect(prisma.whatsAppMessage.createMany).not.toHaveBeenCalled();
    // Not even a recipient lookup: template resolution comes first.
    expect(prisma.whatsAppIdentity.findMany).not.toHaveBeenCalled();
  });

  it('lets an explicit waTemplate override a generic type', async () => {
    const { svc, prisma } = makeHarness();
    await svc.enqueueFromNotifications([
      notification({ type: 'INFO', waTemplate: 'loan_decision' }),
    ]);
    expect(prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0].templateKey).toBe(
      'loan_decision',
    );
  });

  it('ignores an unknown template key rather than throwing', async () => {
    const { svc, prisma } = makeHarness();
    const n = await svc.enqueueFromNotifications([notification({ waTemplate: 'nope' })]);
    expect(n).toBe(0);
    expect(prisma.whatsAppMessage.createMany).not.toHaveBeenCalled();
  });

  describe('admin per-update switches', () => {
    it('sends nothing for an update the admin switched off', async () => {
      const { svc, prisma } = makeHarness({ cfg: { disabledTemplates: ['leave_approved'] } });
      const n = await svc.enqueueFromNotifications([notification()]);

      expect(n).toBe(0);
      expect(prisma.whatsAppMessage.createMany).not.toHaveBeenCalled();
    });

    it('still sends the updates that remain switched on', async () => {
      const { svc, prisma } = makeHarness({ cfg: { disabledTemplates: ['leave_rejected'] } });
      const n = await svc.enqueueFromNotifications([notification()]);

      expect(n).toBe(1);
      expect(prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0].templateKey).toBe(
        'leave_approved',
      );
    });

    it('applies to explicitly named templates too, not just type-resolved ones', async () => {
      const { svc, prisma } = makeHarness({ cfg: { disabledTemplates: ['loan_decision'] } });
      const n = await svc.enqueueFromNotifications([
        notification({ type: 'INFO', waTemplate: 'loan_decision' }),
      ]);

      expect(n).toBe(0);
      expect(prisma.whatsAppMessage.createMany).not.toHaveBeenCalled();
    });

    it('drops only the switched-off entries from a mixed batch', async () => {
      const { svc, prisma } = makeHarness({ cfg: { disabledTemplates: ['leave_approved'] } });
      prisma.whatsAppMessage.createMany.mockResolvedValue({ count: 1 });

      await svc.enqueueFromNotifications([
        notification(),
        notification({ type: 'LEAVE_REJECTED', title: 'Leave declined' }),
      ]);

      const data = prisma.whatsAppMessage.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
      expect(data[0].templateKey).toBe('leave_rejected');
    });

    it('sends everything when nothing is switched off', async () => {
      const { svc } = makeHarness({ cfg: { disabledTemplates: [] } });
      await expect(svc.enqueueFromNotifications([notification()])).resolves.toBe(1);
    });

    // enqueueDirect used to skip this check entirely. Login credentials go out
    // through it, so "Login credentials: off" in the admin list was a switch
    // that did nothing — the one update that bypasses consent was also the one
    // the admin could not stop.
    it('honours the switch on the direct path too', async () => {
      const { svc, prisma } = makeHarness({
        cfg: { disabledTemplates: ['welcome_credentials'] },
      });
      const res = await svc.enqueueDirect({
        toE164: '+96890010000',
        templateKey: 'welcome_credentials',
        body: 'creds',
      });

      expect(res.queued).toBe(false);
      expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
    });

    it('never lets a switched-off update block the admin test send', async () => {
      // Test sends carry a 'test:' prefix, so they cannot collide with a
      // registry key. Proving the channel works is not messaging staff.
      const { svc } = makeHarness({ cfg: { disabledTemplates: ['leave_approved'] } });
      const res = await svc.enqueueDirect({
        toE164: '+96890010000',
        templateKey: 'test:leave_approved',
        body: 'probe',
      });

      expect(res.queued).toBe(true);
    });
  });

  /**
   * Auto-enrolment, from the outbox's side.
   *
   * The product model is that an admin switches the channel on for the company.
   * These pin that the enqueue path actually reaches for it, and that test mode
   * — which messages nobody real — never does.
   */
  describe('auto-enrolment on the way to sending', () => {
    const withIdentities = (over: Partial<WhatsAppResolvedConfig> = {}) => {
      const h = makeHarness({ cfg: { autoEnroll: true, ...over } });
      const identities = { autoEnrollUsers: jest.fn().mockResolvedValue(1) };
      const svc = new WhatsAppOutboxService(
        h.prisma,
        h.settings,
        h.evolution,
        h.tokens,
        identities as any,
      );
      return { ...h, svc, identities };
    };

    it('makes the batch reachable before looking for recipients', async () => {
      const { svc, identities } = withIdentities();
      await svc.enqueueFromNotifications([notification()]);

      expect(identities.autoEnrollUsers).toHaveBeenCalledWith(['u1']);
    });

    it('does not run when the admin switched it off', async () => {
      const { svc, identities } = withIdentities({ autoEnroll: false });
      await svc.enqueueFromNotifications([notification()]);

      expect(identities.autoEnrollUsers).not.toHaveBeenCalled();
    });

    it('does not run in test mode, where nobody real is messaged', async () => {
      const { svc, identities } = withIdentities({ redirectAllTo: '+919952982836' });
      await svc.enqueueFromNotifications([notification()]);

      expect(identities.autoEnrollUsers).not.toHaveBeenCalled();
    });

    it('still delivers when auto-enrolment finds nobody new', async () => {
      const { svc, prisma, identities } = withIdentities();
      identities.autoEnrollUsers.mockResolvedValue(0);

      expect(await svc.enqueueFromNotifications([notification()])).toBe(1);
      expect(prisma.whatsAppMessage.createMany).toHaveBeenCalled();
    });
  });

  /**
   * The watcher copy, added to diagnose a live channel that was reaching nobody.
   *
   * The distinction that matters throughout: `redirectAllTo` TAKES delivery away
   * from the employee, this one does not. If a copy ever costs an employee their
   * message, the feature is worse than the bug it was built to find.
   */
  describe('carbon copy to a watcher number', () => {
    const CC = '+917603941558';
    const copying = (over: Partial<WhatsAppResolvedConfig> = {}) =>
      makeHarness({ cfg: { carbonCopyEnabled: true, carbonCopyTo: CC, ...over } });

    const rowsOf = (prisma: any) => prisma.whatsAppMessage.createMany.mock.calls[0][0].data;

    it('sends the employee their message AND one copy', async () => {
      const { svc, prisma } = copying();
      await svc.enqueueFromNotifications([notification()]);

      const rows = rowsOf(prisma);
      expect(rows).toHaveLength(2);
      expect(rows.map((r: any) => r.toPhoneE164).sort()).toEqual([CC, '+96890010000'].sort());
    });

    it('does not change what the employee receives', async () => {
      const { svc, prisma } = copying();
      await svc.enqueueFromNotifications([notification()]);

      const employee = rowsOf(prisma).find((r: any) => r.toPhoneE164 === '+96890010000');
      expect(employee.body).not.toContain('COPY');
      expect(employee.employeeId).toBe(IDENTITY.employeeId);
    });

    it('marks the copy and says who it was for', async () => {
      const { svc, prisma } = copying();
      await svc.enqueueFromNotifications([notification()]);

      const copy = rowsOf(prisma).find((r: any) => r.toPhoneE164 === CC);
      expect(copy.body).toContain('COPY');
      expect(copy.body).toContain('Aisha');
      expect(copy.body).toContain('also sent to');
    });

    it('still emits a copy when NOBODY could be reached', async () => {
      // The whole diagnostic point: without this, "no confirmed numbers" and
      // "the channel is broken" produce exactly the same evidence — nothing.
      const { svc, prisma } = copying();
      prisma.whatsAppIdentity.findMany.mockResolvedValue([]);

      const n = await svc.enqueueFromNotifications([notification()]);

      expect(n).toBe(1);
      const rows = rowsOf(prisma);
      expect(rows).toHaveLength(1);
      expect(rows[0].toPhoneE164).toBe(CC);
      expect(rows[0].body).toContain('no confirmed WhatsApp number on file');
    });

    it('creates nothing at all when the copy is off and nobody is reachable', async () => {
      const { svc, prisma } = makeHarness();
      prisma.whatsAppIdentity.findMany.mockResolvedValue([]);

      expect(await svc.enqueueFromNotifications([notification()])).toBe(0);
      expect(prisma.whatsAppMessage.createMany).not.toHaveBeenCalled();
    });

    it('gives the copy its own dedupe key', async () => {
      // Sharing the employee's key would make skipDuplicates drop one of them.
      const { svc, prisma } = copying();
      await svc.enqueueFromNotifications([notification()]);

      const [a, b] = rowsOf(prisma).map((r: any) => r.dedupeKey);
      expect(a).not.toBe(b);
      expect(rowsOf(prisma).some((r: any) => r.dedupeKey.endsWith(':cc'))).toBe(true);
    });

    it('does not attach the copy to the employee record', async () => {
      // Otherwise a dead watcher number would count failures against the
      // employee's identity and eventually suspend a working number.
      const { svc, prisma } = copying();
      await svc.enqueueFromNotifications([notification()]);

      const copy = rowsOf(prisma).find((r: any) => r.toPhoneE164 === CC);
      expect(copy.employeeId).toBeNull();
      expect(copy.branchId).toBeNull();
      // Still records WHOSE notification it was, which is the point of the log.
      expect(copy.userId).toBe('u1');
    });

    it('is off while test mode is on, so the tester is not messaged twice', async () => {
      const { svc, prisma } = copying({ redirectAllTo: '+919952982836' });
      await svc.enqueueFromNotifications([notification()]);

      const rows = rowsOf(prisma);
      expect(rows).toHaveLength(1);
      expect(rows[0].toPhoneE164).toBe('+919952982836');
    });

    it('sends nothing extra when switched off', async () => {
      const { svc, prisma } = makeHarness({ cfg: { carbonCopyEnabled: false, carbonCopyTo: CC } });
      await svc.enqueueFromNotifications([notification()]);

      expect(rowsOf(prisma)).toHaveLength(1);
    });

    it('sends nothing extra when no number is set', async () => {
      const { svc, prisma } = makeHarness({ cfg: { carbonCopyEnabled: true, carbonCopyTo: '' } });
      await svc.enqueueFromNotifications([notification()]);

      expect(rowsOf(prisma)).toHaveLength(1);
    });

    it('respects the admin switching an update off', async () => {
      const { svc, prisma } = copying({ disabledTemplates: ['leave_approved'] });
      expect(await svc.enqueueFromNotifications([notification()])).toBe(0);
      expect(prisma.whatsAppMessage.createMany).not.toHaveBeenCalled();
    });
  });

  describe('test mode (redirect all messages to one number)', () => {
    const TEST_NUMBER = '+919952982836';
    const redirected = () => makeHarness({ cfg: { redirectAllTo: TEST_NUMBER } });

    it('addresses every message to the test number, not the employee', async () => {
      const { svc, prisma } = redirected();
      await svc.enqueueFromNotifications([notification()]);

      const row = prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0];
      expect(row.toPhoneE164).toBe(TEST_NUMBER);
      expect(row.toPhoneE164).not.toBe(IDENTITY.phoneE164);
    });

    it('works even when nobody has opted in — the point of the mode', async () => {
      // On a dev database no employee has consented, so requiring consent would
      // make test mode produce nothing at all.
      const { svc, prisma } = redirected();
      prisma.whatsAppIdentity.findMany.mockResolvedValue([]);

      const n = await svc.enqueueFromNotifications([notification()]);
      expect(n).toBe(1);
      expect(prisma.whatsAppIdentity.findMany).not.toHaveBeenCalled();
    });

    it('says who the message was really for', async () => {
      const { svc, prisma } = redirected();
      await svc.enqueueFromNotifications([notification()]);

      const body = prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0].body;
      expect(body).toContain('TEST MODE');
      expect(body).toContain('Aisha');
      expect(body).toContain('Leave approved'); // the real content is still there
    });

    it('still records the intended recipient on the row', async () => {
      // The delivery log must answer "whose notification was this?".
      const { svc, prisma } = redirected();
      await svc.enqueueFromNotifications([notification()]);

      const row = prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0];
      expect(row.userId).toBe('u1');
    });

    it('still honours the kill switch and the per-update switches', async () => {
      const off = makeHarness({ cfg: { redirectAllTo: TEST_NUMBER, enabled: false } });
      await expect(off.svc.enqueueFromNotifications([notification()])).resolves.toBe(0);

      const disabled = makeHarness({
        cfg: { redirectAllTo: TEST_NUMBER, disabledTemplates: ['leave_approved'] },
      });
      await expect(disabled.svc.enqueueFromNotifications([notification()])).resolves.toBe(0);
    });

    it('captures the admin test send too', async () => {
      const { svc, prisma } = redirected();
      const res = await svc.enqueueDirect({
        toE164: '+96890010000',
        templateKey: 'test:generic',
        body: 'hello',
      });

      expect(res.redirected).toBe(true);
      expect(res.deliveredTo).toBe(TEST_NUMBER);
      expect(prisma.whatsAppMessage.create.mock.calls[0][0].data.toPhoneE164).toBe(TEST_NUMBER);
    });

    it('does not blame an employee identity for a redirected failure', async () => {
      // The row's number is the catcher, so a failure says nothing about the
      // employee — and must not suspend whoever owns the test handset.
      const h = redirected();
      h.evolution.sendText.mockResolvedValue({ ok: false, retryable: false, error: 'gone' });
      h.prisma.whatsAppMessage.findMany.mockResolvedValue([{ id: 'm1' }]);
      h.prisma.whatsAppMessage.findUnique.mockResolvedValue({
        id: 'm1',
        toPhoneE164: TEST_NUMBER,
        templateKey: 'leave_approved',
        body: 'x',
        attempts: 1,
        maxAttempts: 5,
      });

      await h.svc.drain();
      expect(h.prisma.whatsAppIdentity.update).not.toHaveBeenCalled();
    });
  });

  it('does nothing at all when the kill switch is off', async () => {
    const { svc, prisma } = makeHarness({ cfg: { enabled: false } });
    const n = await svc.enqueueFromNotifications([notification()]);
    expect(n).toBe(0);
    expect(prisma.whatsAppIdentity.findMany).not.toHaveBeenCalled();
    expect(prisma.whatsAppMessage.createMany).not.toHaveBeenCalled();
  });

  it('uses skipDuplicates so a replayed trigger cannot double-message', async () => {
    const { svc, prisma } = makeHarness();
    await svc.enqueueFromNotifications([notification({ waDedupeKey: 'k1' } as any)]);
    expect(prisma.whatsAppMessage.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('honours a caller-supplied dedupe key verbatim', async () => {
    const { svc, prisma } = makeHarness();
    await svc.enqueueFromNotifications([{ ...notification(), dedupeKey: 'reminder:visa:1:30' }]);
    expect(prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0].dedupeKey).toBe(
      'reminder:visa:1:30',
    );
  });

  it('derives a stable dedupe key from content when none is given', async () => {
    const a = makeHarness();
    await a.svc.enqueueFromNotifications([notification()]);
    const b = makeHarness();
    await b.svc.enqueueFromNotifications([notification()]);

    const keyA = a.prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0].dedupeKey;
    const keyB = b.prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0].dedupeKey;
    expect(keyA).toBe(keyB);
    expect(keyA).toMatch(/^auto:[0-9a-f]{32}:\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  describe('consent gates', () => {
    it('queries only opted-in and verified identities by default', async () => {
      const { svc, prisma } = makeHarness();
      await svc.enqueueFromNotifications([notification()]);
      expect(prisma.whatsAppIdentity.findMany.mock.calls[0][0].where).toMatchObject({
        optedIn: true,
        verified: true,
      });
    });

    it('creates no row when nobody has a deliverable identity', async () => {
      const { svc, prisma } = makeHarness();
      prisma.whatsAppIdentity.findMany.mockResolvedValue([]);
      const n = await svc.enqueueFromNotifications([notification()]);
      expect(n).toBe(0);
      expect(prisma.whatsAppMessage.createMany).not.toHaveBeenCalled();
    });

    it('drops the gates when the settings say so', async () => {
      const { svc, prisma } = makeHarness({
        cfg: { requireOptIn: false, requireVerified: false },
      });
      await svc.enqueueFromNotifications([notification()]);
      const where = prisma.whatsAppIdentity.findMany.mock.calls[0][0].where;
      expect(where.optedIn).toBeUndefined();
      expect(where.verified).toBeUndefined();
    });
  });

  it('marks rows SKIPPED and sends nothing in dry-run', async () => {
    const { svc, prisma, evolution } = makeHarness({ cfg: { dryRun: true } });
    await svc.enqueueFromNotifications([notification()]);
    const row = prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0];
    expect(row.status).toBe(OUTBOX_STATUS.SKIPPED);
    expect(row.lastError).toBe('dry-run');
    expect(evolution.sendText).not.toHaveBeenCalled();
  });

  it('never rejects, even when Prisma throws', async () => {
    // The tee runs inside business transactions; this must be unconditional.
    const { svc, prisma } = makeHarness();
    prisma.whatsAppIdentity.findMany.mockRejectedValue(new Error('db down'));
    await expect(svc.enqueueFromNotifications([notification()])).resolves.toBe(0);
  });

  it('batches a fan-out into a single insert', async () => {
    const { svc, prisma } = makeHarness();
    prisma.whatsAppIdentity.findMany.mockResolvedValue([
      IDENTITY,
      { ...IDENTITY, id: 'i2', userId: 'u2', phoneE164: '+96890010001' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', email: 'a@b.c', employee: { fullName: 'A' } },
      { id: 'u2', email: 'd@e.f', employee: { fullName: 'B' } },
    ]);
    prisma.whatsAppMessage.createMany.mockResolvedValue({ count: 2 });

    await svc.enqueueFromNotifications([notification(), notification({ userId: 'u2' })]);
    expect(prisma.whatsAppMessage.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppMessage.createMany.mock.calls[0][0].data).toHaveLength(2);
  });
});

describe('WhatsAppOutboxService — approval decisions', () => {
  const decision = () =>
    notification({
      type: 'APPROVAL_REQUESTED',
      decision: { requestType: 'LEAVE', requestId: '11111111-1111-1111-1111-111111111111' },
    });

  const enabled: any = {
    cfg: { approvalsEnabled: true, inboundEnabled: true, interactiveMode: 'auto' },
  };

  it('mints one capability per option and puts only the callback ids on the row', async () => {
    const { svc, prisma, tokens } = makeHarness(enabled);
    await svc.enqueueFromNotifications([decision()]);

    expect(tokens.issue).toHaveBeenCalledTimes(2);
    // A capability is scoped to ONE request, from the server side.
    expect(tokens.issue.mock.calls[0][0].args).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
    });

    const row = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(row.interactiveJson.items.map((i: any) => i.label)).toEqual(['Approve', 'Reject']);
    // The raw token exists exactly once — inside the message that went out.
    expect(JSON.stringify(row.interactiveJson)).not.toContain('"tokenHash"');
    expect(row.body).toBeTruthy();
  });

  it('revokes both capabilities when it loses the dedupe race', async () => {
    // Otherwise a replayed enqueue leaves two live approve/reject capabilities
    // attached to a message nobody ever received.
    const { svc, prisma, tokens } = makeHarness(enabled);
    prisma.whatsAppMessage.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );

    const n = await svc.enqueueFromNotifications([decision()]);

    expect(n).toBe(0);
    expect(tokens.issue).toHaveBeenCalledTimes(2);
    expect(tokens.revoke).toHaveBeenCalledWith(['tid', 'tid']);
  });

  it.each([
    ['approvals are off', { approvalsEnabled: false }],
    ['nobody can reply', { inboundEnabled: false }],
    ['nothing is tappable', { interactiveMode: 'text' }],
  ])('mints nothing when %s', async (_why, cfg) => {
    const { svc, tokens } = makeHarness({ cfg: { ...enabled.cfg, ...(cfg as any) } } as any);
    await svc.enqueueFromNotifications([decision()]);
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('mints nothing for a request type with no reviewed action pair', async () => {
    const { svc, tokens } = makeHarness(enabled);
    await svc.enqueueFromNotifications([
      notification({
        type: 'APPROVAL_REQUESTED',
        decision: { requestType: 'GRIEVANCE', requestId: 'x' },
      }),
    ]);
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('leaves ordinary notifications on the bulk path', async () => {
    const { svc, prisma, tokens } = makeHarness(enabled);
    await svc.enqueueFromNotifications([notification({ waTemplate: 'leave_approved' })]);

    expect(tokens.issue).not.toHaveBeenCalled();
    expect(prisma.whatsAppMessage.createMany).toHaveBeenCalledTimes(1);
    // The transient marker must never reach Prisma.
    const row = prisma.whatsAppMessage.createMany.mock.calls[0][0].data[0];
    expect(row).not.toHaveProperty('__decision');
  });
});

describe('WhatsAppOutboxService — delivery', () => {
  const queuedRow = (over: any = {}) => ({
    id: 'm1',
    toPhoneE164: '+96890010000',
    templateKey: 'leave_approved',
    body: 'hello',
    attempts: 1,
    maxAttempts: 5,
    ...over,
  });

  async function drainOne(h: ReturnType<typeof makeHarness>, row: any) {
    h.prisma.whatsAppMessage.findMany.mockResolvedValue([{ id: row.id }]);
    h.prisma.whatsAppMessage.findUnique.mockResolvedValue(row);
    return h.svc.drain();
  }

  it('claims with a conditional update and marks SENT on success', async () => {
    const h = makeHarness();
    const res = await drainOne(h, queuedRow());

    // The claim is the lock: status must be part of the where clause, and
    // attempts must increment at claim time, not at outcome.
    const claim = h.prisma.whatsAppMessage.updateMany.mock.calls.find(
      (c: any[]) => c[0].where?.id === 'm1',
    )[0];
    expect(claim.where.status).toBe(OUTBOX_STATUS.QUEUED);
    expect(claim.data.attempts).toEqual({ increment: 1 });

    expect(res.sent).toBe(1);
    const update = h.prisma.whatsAppMessage.update.mock.calls[0][0];
    expect(update.data.status).toBe(OUTBOX_STATUS.SENT);
    expect(update.data.providerMessageId).toBe('wa1');
  });

  it('does not deliver when another worker won the claim', async () => {
    const h = makeHarness();
    h.prisma.whatsAppMessage.updateMany.mockImplementation(async (args: any) =>
      args.where?.id === 'm1' ? { count: 0 } : { count: 1 },
    );
    const res = await drainOne(h, queuedRow());

    expect(h.evolution.sendText).not.toHaveBeenCalled();
    expect(res.sent).toBe(0);
  });

  it('fails immediately on a non-retryable 4xx instead of burning backoff', async () => {
    const h = makeHarness();
    h.evolution.sendText.mockResolvedValue({
      ok: false,
      retryable: false,
      error: 'number does not exist',
      status: 400,
    });
    const res = await drainOne(h, queuedRow({ attempts: 1 }));

    expect(res.failed).toBe(1);
    expect(h.prisma.whatsAppMessage.update.mock.calls[0][0].data.status).toBe(
      OUTBOX_STATUS.FAILED,
    );
  });

  it('requeues with backoff on a retryable error', async () => {
    const h = makeHarness();
    h.evolution.sendText.mockResolvedValue({ ok: false, retryable: true, error: '503' });
    const before = Date.now();
    await drainOne(h, queuedRow({ attempts: 1 }));

    const data = h.prisma.whatsAppMessage.update.mock.calls[0][0].data;
    expect(data.status).toBe(OUTBOX_STATUS.QUEUED);
    // First tier is 60s, +/- 10% jitter.
    const delay = new Date(data.nextAttemptAt).getTime() - before;
    expect(delay).toBeGreaterThan(53_000);
    expect(delay).toBeLessThan(67_000);
  });

  it('dead-letters once attempts reach the cap', async () => {
    const h = makeHarness();
    h.evolution.sendText.mockResolvedValue({ ok: false, retryable: true, error: '503' });
    await drainOne(h, queuedRow({ attempts: 5, maxAttempts: 5 }));

    expect(h.prisma.whatsAppMessage.update.mock.calls[0][0].data.status).toBe(
      OUTBOX_STATUS.FAILED,
    );
  });

  it('counts hard failures against the identity and suspends a dead number', async () => {
    const h = makeHarness();
    h.evolution.sendText.mockResolvedValue({ ok: false, retryable: false, error: 'gone' });
    h.prisma.whatsAppIdentity.findUnique.mockResolvedValue({ ...IDENTITY, failureCount: 4 });
    await drainOne(h, queuedRow());

    expect(h.prisma.whatsAppIdentity.update.mock.calls[0][0].data).toMatchObject({
      failureCount: 5,
      verified: false,
    });
  });

  it('does not suspend an identity for a transient gateway error', async () => {
    // A run of 5xx says nothing about the recipient's number.
    const h = makeHarness();
    h.evolution.sendText.mockResolvedValue({ ok: false, retryable: true, error: '502' });
    await drainOne(h, queuedRow({ attempts: 5, maxAttempts: 5 }));

    expect(h.prisma.whatsAppIdentity.update).not.toHaveBeenCalled();
  });

  it('reclaims rows stuck in SENDING and expires stale queued rows', async () => {
    const h = makeHarness();
    await h.svc.drain();

    const wheres = h.prisma.whatsAppMessage.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(wheres).toContainEqual(
      expect.objectContaining({ where: expect.objectContaining({ status: OUTBOX_STATUS.SENDING }) }),
    );
    const stale = wheres.find((w: any) => w.data?.lastError === 'stale');
    expect(stale.data.status).toBe(OUTBOX_STATUS.SKIPPED);
  });

  it('does nothing when the channel is not configured', async () => {
    const h = makeHarness();
    h.settings.ensureConfigured.mockResolvedValue(null);
    const res = await h.svc.drain();
    expect(res).toEqual({ processed: 0, sent: 0, failed: 0 });
    expect(h.prisma.whatsAppMessage.findMany).not.toHaveBeenCalled();
  });

  it('the cron drain stays gated on the kill switch', async () => {
    const h = makeHarness();
    h.settings.ensureConfigured.mockResolvedValue(null); // sending disabled
    await h.svc.drain();
    expect(h.settings.ensureCredentials).not.toHaveBeenCalled();
    expect(h.prisma.whatsAppMessage.findMany).not.toHaveBeenCalled();
  });

  it('a forced drain runs on credentials alone, so admin retry works while disabled', async () => {
    const h = makeHarness();
    h.settings.ensureConfigured.mockResolvedValue(null);
    await h.svc.drain({ force: true });
    expect(h.settings.ensureCredentials).toHaveBeenCalled();
    expect(h.prisma.whatsAppMessage.findMany).toHaveBeenCalled();
  });

  it('does not run two drains concurrently', async () => {
    // @nestjs/schedule does not prevent a slow run from overlapping the next
    // tick, so the service guards in-process (and the DB claim guards beneath).
    const h = makeHarness();
    let release!: (rows: unknown[]) => void;
    const gate = new Promise<unknown[]>((r) => (release = r));
    h.prisma.whatsAppMessage.findMany.mockReturnValue(gate);

    const first = h.svc.drain();
    const second = await h.svc.drain(); // must short-circuit while `first` runs
    expect(second).toEqual({ processed: 0, sent: 0, failed: 0 });

    release([]);
    await first;

    // ...and the guard releases afterwards.
    h.prisma.whatsAppMessage.findMany.mockResolvedValue([]);
    await expect(h.svc.drain()).resolves.toEqual({ processed: 0, sent: 0, failed: 0 });
    expect(h.prisma.whatsAppMessage.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('WhatsAppOutboxService — maintenance', () => {
  it('sweeps only terminal successes, never the failure evidence', async () => {
    const { svc, prisma } = makeHarness();
    await svc.sweep();
    const where = prisma.whatsAppMessage.deleteMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual([OUTBOX_STATUS.SENT, OUTBOX_STATUS.SKIPPED]);
    expect(where.status.in).not.toContain(OUTBOX_STATUS.FAILED);
  });

  it('retry resets a failed row to the front of the queue', async () => {
    const { svc, prisma } = makeHarness();
    await svc.retry('m1');
    const call = prisma.whatsAppMessage.updateMany.mock.calls[0][0];
    expect(call.where.status.in).toEqual([OUTBOX_STATUS.FAILED, OUTBOX_STATUS.SKIPPED]);
    expect(call.data).toMatchObject({ status: OUTBOX_STATUS.QUEUED, attempts: 0 });
  });

  it('retry reports false when nothing matched', async () => {
    const { svc, prisma } = makeHarness();
    prisma.whatsAppMessage.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.retry('nope')).resolves.toBe(false);
  });
});
