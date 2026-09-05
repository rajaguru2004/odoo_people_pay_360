/**
 * `ensureTransporter()` is the kill switch every send goes through, and it now
 * reads the same resolver the SMTP settings screen reads
 * (`SystemSettingsService.getMailConfig()`).
 *
 * Both branches are pinned: a stored `mail_enabled = 'false'` shuts mail off,
 * and a BLANK `mail_enabled` row falls through to `MAIL_ENABLED` in the
 * environment rather than reading as "off" — the behaviour the transporter
 * already had before the resolver was extracted, which must not regress.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MailerService } from '@nestjs-modules/mailer';
import { MailService } from './mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { resolveMailConfig } from '../system-settings/mail-settings';

const ENV = {
  MAIL_ENABLED: 'true',
  MAIL_HOST: 'smtp.hostinger.test',
  MAIL_PORT: '465',
  MAIL_USER: 'hr@acme.test',
  MAIL_PASSWORD: 'env-secret',
  MAIL_FROM: 'noreply@acme.test',
  MAIL_FROM_NAME: 'Acme HR',
};

describe('MailService — transport configuration', () => {
  let service: MailService;
  let mailer: any;
  let db: Record<string, string>;
  let createTransport: jest.Mock;

  const boot = async () => {
    createTransport = jest.fn().mockReturnValue({ sendMail: jest.fn() });
    mailer = {
      sendMail: jest.fn().mockResolvedValue(undefined),
      transportFactory: { createTransport },
      initTemplateAdapter: jest.fn(),
      templateAdapter: {},
      mailerOptions: { defaults: {} },
      transporter: undefined,
    };
    const settings = {
      // The real resolver over the fake row set, so this spec follows the
      // service instead of restating its rules.
      getMailConfig: jest.fn().mockImplementation(async () =>
        resolveMailConfig(db, process.env),
      ),
      getSetting: jest
        .fn()
        .mockImplementation(async (key: string, def = '') => db[key] ?? def),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: MailerService, useValue: mailer },
        { provide: SystemSettingsService, useValue: settings },
      ],
    }).compile();
    service = moduleRef.get(MailService);
  };

  let envBackup: NodeJS.ProcessEnv;

  beforeEach(async () => {
    envBackup = { ...process.env };
    Object.assign(process.env, ENV);
    db = {};
    await boot();
  });

  afterEach(() => {
    process.env = envBackup;
  });

  const send = () =>
    service.sendLeaveApplied('someone@acme.test', {
      employeeName: 'A',
      leaveType: 'ANNUAL',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      days: 1,
      isUserRecipient: true,
    });

  it('sends through the env-configured server when every mail_* row is blank', async () => {
    for (const key of [
      'mail_enabled',
      'mail_host',
      'mail_port',
      'mail_user',
      'mail_password',
      'mail_from',
      'mail_from_name',
      'mail_bcc',
    ]) {
      db[key] = '';
    }

    await send();

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.hostinger.test',
        port: 465,
        secure: true,
        auth: { user: 'hr@acme.test', pass: 'env-secret' },
      }),
      expect.objectContaining({ from: 'noreply@acme.test' }),
    );
    expect(mailer.sendMail).toHaveBeenCalled();
  });

  it('honours a stored mail_enabled = false and sends nothing', async () => {
    db.mail_enabled = 'false';

    await send();

    expect(createTransport).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('prefers stored transport rows over the environment', async () => {
    db.mail_enabled = 'true';
    db.mail_host = 'smtp.stored.test';
    db.mail_port = '587';
    db.mail_user = 'stored@acme.test';
    db.mail_password = 'stored-secret';
    db.mail_from = 'stored-from@acme.test';
    db.mail_bcc = 'archive@acme.test';

    await send();

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.stored.test',
        port: 587,
        secure: false,
        auth: { user: 'stored@acme.test', pass: 'stored-secret' },
      }),
      expect.objectContaining({
        from: 'stored-from@acme.test',
        bcc: 'archive@acme.test',
      }),
    );
  });

  it('stays off on a fresh install with neither rows nor env', async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];

    await send();

    expect(createTransport).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });
});
