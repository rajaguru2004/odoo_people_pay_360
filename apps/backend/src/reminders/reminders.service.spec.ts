import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { RemindersService } from './reminders.service';
import {
  REMINDER_SOURCES,
  type ReminderCandidate,
  type ReminderSource,
} from './reminder-source';

const DAY = 86_400_000;

function inDays(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + n * DAY);
}

/** In-memory stand-in for the unique index on reminder_dispatches. */
function makeDispatchStore() {
  const rows: Array<{
    sourceKey: string;
    entityId: string;
    threshold: number;
    expiryDate: Date;
  }> = [];
  const key = (r: any) =>
    `${r.sourceKey}|${r.entityId}|${r.threshold}|${new Date(r.expiryDate)
      .toISOString()
      .slice(0, 10)}`;

  return {
    rows,
    findMany: jest.fn(async ({ where }: any) =>
      rows.filter(
        (r) =>
          r.sourceKey === where.sourceKey &&
          where.entityId.in.includes(r.entityId),
      ),
    ),
    createMany: jest.fn(async ({ data }: any) => {
      const seen = new Set(rows.map(key));
      let count = 0;
      for (const row of data) {
        if (seen.has(key(row))) continue;
        seen.add(key(row));
        rows.push(row);
        count++;
      }
      return { count };
    }),
  };
}

function makeSource(candidates: ReminderCandidate[]): ReminderSource {
  return {
    key: 'test_source',
    thresholdSettingKey: 'reminder_days_test',
    defaultThresholds: [90, 60, 30, 7],
    notificationType: 'INFO',
    findExpiring: jest.fn(async (from: Date, to: Date) =>
      candidates.filter((c) => c.expiryDate >= from && c.expiryDate <= to),
    ),
    recipients: jest.fn(async () => [
      { userId: 'hr-1', email: 'hr@test.local', name: 'HR', isOwner: false },
    ]),
  };
}

function candidate(id: string, days: number): ReminderCandidate {
  return {
    id,
    expiryDate: inDays(days),
    entityLabel: 'Visa',
    subjectName: 'Alice',
    link: '/dashboard/x',
    fields: [],
  };
}

describe('RemindersService', () => {
  let service: RemindersService;
  let dispatches: ReturnType<typeof makeDispatchStore>;
  let mail: { sendExpiryReminder: jest.Mock };
  let notifications: { create: jest.Mock };
  let source: ReminderSource;

  async function build(candidates: ReminderCandidate[], thresholds = '90,60,30,7') {
    dispatches = makeDispatchStore();
    mail = { sendExpiryReminder: jest.fn().mockResolvedValue(undefined) };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    source = makeSource(candidates);

    const moduleRef = await Test.createTestingModule({
      providers: [
        RemindersService,
        { provide: PrismaService, useValue: { reminderDispatch: dispatches } },
        { provide: MailService, useValue: mail },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: SystemSettingsService,
          useValue: { getSetting: jest.fn().mockResolvedValue(thresholds) },
        },
        { provide: REMINDER_SOURCES, useValue: [source] },
      ],
    }).compile();

    service = moduleRef.get(RemindersService);
  }

  it('fires the tightest crossed tier, not every crossed tier', async () => {
    // 45 days out crosses 90 and 60. 60 describes the real urgency.
    await build([candidate('doc-1', 45)]);

    await expect(service.runSource(source)).resolves.toBe(1);

    expect(mail.sendExpiryReminder).toHaveBeenCalledTimes(1);
    expect(mail.sendExpiryReminder.mock.calls[0][1]).toMatchObject({
      daysRemaining: 45,
    });
    // 90 is moot and must be burned so it can never fire later.
    expect(dispatches.rows.map((r) => r.threshold).sort((a, b) => b - a)).toEqual([
      90, 60,
    ]);
  });

  it('does not re-send a tier already dispatched', async () => {
    await build([candidate('doc-1', 45)]);
    await service.runSource(source);
    mail.sendExpiryReminder.mockClear();

    await expect(service.runSource(source)).resolves.toBe(0);
    expect(mail.sendExpiryReminder).not.toHaveBeenCalled();
  });

  it('fires each tier once as the date approaches', async () => {
    // The clock moves, the expiry does not. Mutating the expiry instead would
    // be a *renewal* to the engine, which legitimately re-arms every tier.
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'setInterval',
        'setImmediate',
        'nextTick',
        'queueMicrotask',
      ],
    });
    try {
      const expiry = new Date(2026, 3, 1); // 1 Apr 2026
      const c: ReminderCandidate = { ...candidate('doc-1', 0), expiryDate: expiry };

      jest.setSystemTime(new Date(2026, 0, 11)); // 80 days out -> tier 90
      await build([c]);
      await expect(service.runSource(source)).resolves.toBe(1);

      jest.setSystemTime(new Date(2026, 1, 10)); // 50 days -> tier 60
      await expect(service.runSource(source)).resolves.toBe(1);

      jest.setSystemTime(new Date(2026, 1, 20)); // 40 days -> tier 60, already sent
      await expect(service.runSource(source)).resolves.toBe(0);

      jest.setSystemTime(new Date(2026, 2, 12)); // 20 days -> tier 30
      await expect(service.runSource(source)).resolves.toBe(1);

      jest.setSystemTime(new Date(2026, 2, 29)); // 3 days -> tier 7
      await expect(service.runSource(source)).resolves.toBe(1);

      expect(mail.sendExpiryReminder).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('emits only one reminder for a record entered late in its life', async () => {
    // Entered with 5 days left: all four tiers are crossed at once. Only the
    // tightest may send; the rest are burned.
    await build([candidate('doc-late', 5)]);

    await expect(service.runSource(source)).resolves.toBe(1);
    expect(mail.sendExpiryReminder).toHaveBeenCalledTimes(1);
    expect(dispatches.rows).toHaveLength(4);
  });

  it('re-arms every tier when a renewal moves the expiry', async () => {
    const c = candidate('doc-1', 5);
    await build([c]);
    await service.runSource(source);
    expect(mail.sendExpiryReminder).toHaveBeenCalledTimes(1);

    // Renewed a year out, then time passes to 20 days remaining.
    c.expiryDate = inDays(20);
    await expect(service.runSource(source)).resolves.toBe(1);
    expect(mail.sendExpiryReminder).toHaveBeenCalledTimes(2);
  });

  it('ignores records that already expired', async () => {
    await build([candidate('doc-gone', -3)]);
    await expect(service.runSource(source)).resolves.toBe(0);
    expect(mail.sendExpiryReminder).not.toHaveBeenCalled();
  });

  it('ignores records beyond the widest tier', async () => {
    await build([candidate('doc-far', 200)]);
    await expect(service.runSource(source)).resolves.toBe(0);
  });

  it('sends both email and in-app to every recipient', async () => {
    await build([candidate('doc-1', 5)]);
    (source.recipients as jest.Mock).mockResolvedValue([
      { userId: 'hr-1', email: 'hr@test.local', name: 'HR', isOwner: false },
      { userId: 'emp-1', email: 'a@test.local', name: 'Alice', isOwner: true },
    ]);

    await service.runSource(source);

    expect(mail.sendExpiryReminder).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledTimes(2);
    // Owner copy is phrased in the second person.
    const owner = notifications.create.mock.calls.find(
      (c) => c[0].userId === 'emp-1',
    )![0];
    expect(owner.title).toMatch(/^Your /);
  });

  it('honours an admin-narrowed tier list', async () => {
    await build([candidate('doc-1', 45)], '30,7');
    // 45 days out crosses neither 30 nor 7.
    await expect(service.runSource(source)).resolves.toBe(0);
  });

  it('falls back to source defaults when the setting is unparseable', async () => {
    await build([candidate('doc-1', 45)], 'not,a,number');
    await expect(service.runSource(source)).resolves.toBe(1);
  });

  it('keeps running other sources when one throws', async () => {
    await build([candidate('doc-1', 5)]);
    const broken: ReminderSource = {
      ...makeSource([]),
      key: 'broken',
      findExpiring: jest.fn().mockRejectedValue(new Error('boom')),
    };
    (service as any).sources = [broken, source];

    const result = await service.runAll();

    expect(result.sent).toEqual({ broken: 0, test_source: 1 });
    expect(result.total).toBe(1);
  });

  it('consumes the tier when a candidate has no recipients', async () => {
    await build([candidate('doc-1', 5)]);
    (source.recipients as jest.Mock).mockResolvedValue([]);

    await expect(service.runSource(source)).resolves.toBe(0);
    expect(mail.sendExpiryReminder).not.toHaveBeenCalled();
    // Tier is still burned — an unaddressable record must not retry forever.
    expect(dispatches.rows.some((r) => r.threshold === 7)).toBe(true);
  });
});
