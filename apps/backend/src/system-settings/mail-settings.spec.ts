/**
 * The SMTP form and the transporter must resolve the mail keys identically.
 *
 * The incident this pins: a settings save wrote EMPTY strings over all eight
 * `mail_*` rows of a live tenant. The transporter kept working — it reads every
 * key as `stored || env` — while `getSettingsList()` resolved with `??`, which
 * only falls through when the row is ABSENT. So the admin screen rendered an
 * empty SMTP form, and an empty form says "not configured" about a server that
 * was still sending mail.
 *
 * Both branches are pinned here: an empty row must fall through to the
 * environment, and a non-empty row must still win over it.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { SystemSettingsService } from './system-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import {
  MAIL_SETTING_KEYS,
  resolveMailConfig,
  resolveMailSetting,
} from './mail-settings';

const ENV = {
  MAIL_ENABLED: 'true',
  MAIL_HOST: 'smtp.hostinger.test',
  MAIL_PORT: '465',
  MAIL_USER: 'hr@acme.test',
  MAIL_PASSWORD: 'env-secret',
  MAIL_FROM: 'noreply@acme.test',
  MAIL_FROM_NAME: 'Acme HR',
  MAIL_BCC: 'archive@acme.test',
};

describe('resolveMailSetting', () => {
  it('prefers a stored value over the environment', () => {
    expect(resolveMailSetting('mail_host', 'smtp.stored.test', ENV)).toBe(
      'smtp.stored.test',
    );
  });

  it('treats an EMPTY stored value as unset and falls through to the env', () => {
    expect(resolveMailSetting('mail_host', '', ENV)).toBe('smtp.hostinger.test');
    expect(resolveMailSetting('mail_password', '', ENV)).toBe('env-secret');
    // The blanked row that started this: 'false' is a real stored value and
    // must NOT be overridden, but '' must read MAIL_ENABLED.
    expect(resolveMailSetting('mail_enabled', '', ENV)).toBe('true');
    expect(resolveMailSetting('mail_enabled', 'false', ENV)).toBe('false');
  });

  it('treats an absent row the same as an empty one', () => {
    expect(resolveMailSetting('mail_user', undefined, ENV)).toBe('hr@acme.test');
    expect(resolveMailSetting('mail_user', null, ENV)).toBe('hr@acme.test');
  });

  it('falls back to the built-in default when the env var is unset or empty', () => {
    expect(resolveMailSetting('mail_host', '', {})).toBe('smtp.gmail.com');
    expect(resolveMailSetting('mail_port', '', {})).toBe('587');
    expect(resolveMailSetting('mail_from_name', '', {})).toBe('HR System');
    expect(resolveMailSetting('mail_enabled', '', {})).toBe('false');
    expect(resolveMailSetting('mail_host', '', { MAIL_HOST: '' })).toBe(
      'smtp.gmail.com',
    );
  });

  it('covers mail_bcc, which the transporter used to read from the DB only', () => {
    expect(resolveMailSetting('mail_bcc', '', ENV)).toBe('archive@acme.test');
    expect(resolveMailSetting('mail_bcc', 'ops@acme.test', ENV)).toBe(
      'ops@acme.test',
    );
    expect(resolveMailSetting('mail_bcc', '', {})).toBe('');
  });

  it('resolves every transport key from a stored map', () => {
    const cfg = resolveMailConfig(
      new Map([
        ['mail_host', ''],
        ['mail_user', 'stored@acme.test'],
      ]),
      ENV,
    );
    expect(Object.keys(cfg).sort()).toEqual([...MAIL_SETTING_KEYS].sort());
    expect(cfg.mail_host).toBe('smtp.hostinger.test');
    expect(cfg.mail_user).toBe('stored@acme.test');
    expect(cfg.mail_from).toBe('noreply@acme.test');
  });
});

describe('SystemSettingsService — mail transport resolution', () => {
  let service: SystemSettingsService;
  let db: Record<string, string>;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(async () => {
    envBackup = { ...process.env };
    Object.assign(process.env, ENV);

    db = {};
    const prisma = {
      systemSetting: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where: { key } }: any) =>
            Promise.resolve(key in db ? { key, value: db[key] } : null),
          ),
        findMany: jest.fn().mockImplementation((args: any) => {
          const wanted: string[] | undefined = args?.where?.key?.in;
          return Promise.resolve(
            Object.entries(db)
              .filter(([key]) => !wanted || wanted.includes(key))
              .map(([key, value]) => ({ key, value })),
          );
        }),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: UploadService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(SystemSettingsService);
  });

  afterEach(() => {
    process.env = envBackup;
  });

  const listValue = async (key: string) => {
    const list = await service.getSettingsList();
    return list.find((e) => e.key === key)?.value;
  };

  it('shows the env-configured server when the rows were blanked', async () => {
    // Exactly the production state: all eight rows present and empty.
    for (const key of MAIL_SETTING_KEYS) db[key] = '';

    await expect(listValue('mail_host')).resolves.toBe('smtp.hostinger.test');
    await expect(listValue('mail_port')).resolves.toBe('465');
    await expect(listValue('mail_user')).resolves.toBe('hr@acme.test');
    await expect(listValue('mail_from')).resolves.toBe('noreply@acme.test');
    await expect(listValue('mail_enabled')).resolves.toBe('true');
  });

  it('shows the stored value when one is configured', async () => {
    db.mail_host = 'smtp.stored.test';
    db.mail_enabled = 'false';

    await expect(listValue('mail_host')).resolves.toBe('smtp.stored.test');
    await expect(listValue('mail_enabled')).resolves.toBe('false');
  });

  it('getMailConfig() returns what the settings list shows', async () => {
    for (const key of MAIL_SETTING_KEYS) db[key] = '';
    db.mail_user = 'stored@acme.test';

    const cfg = await service.getMailConfig();
    for (const key of MAIL_SETTING_KEYS) {
      await expect(listValue(key)).resolves.toBe(cfg[key]);
    }
    expect(cfg.mail_user).toBe('stored@acme.test');
    expect(cfg.mail_host).toBe('smtp.hostinger.test');
  });

  it('still reports the built-in defaults on a fresh install with no env', async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];

    await expect(listValue('mail_enabled')).resolves.toBe('false');
    await expect(listValue('mail_host')).resolves.toBe('smtp.gmail.com');
    await expect(listValue('mail_port')).resolves.toBe('587');
  });
});
