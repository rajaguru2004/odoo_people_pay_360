import { LoginAlertService, LoginAlertUser } from './login-alert.service';
import { IpGeoService } from './ip-geo.service';
import { RequestMeta } from '../../common/utils/request-meta.util';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const META: RequestMeta = { ip: '203.0.113.9', userAgent: CHROME_UA };

const USER: LoginAlertUser = {
  id: 'user-1',
  email: 'asha@example.com',
  role: 'HR_MANAGER',
  employeeId: 'emp-1',
  fullName: 'Asha Rao',
  employeeCode: 'EMP-0042',
  branchName: 'Muscat HO',
  branchId: 'branch-1',
};

const BASE_CFG = {
  enabled: true,
  loginAlertsEnabled: true,
  loginAlertFailures: true,
  loginAlertGeo: false,
  geoLookupUrl: 'http://example.invalid/{ip}',
  loginAlertRoles: [] as string[],
  loginAlertFailureMaxPerHour: 3,
  alertChatId: '-5544539023',
};

function build(cfgOverrides: Partial<typeof BASE_CFG> = {}) {
  const cfg = { ...BASE_CFG, ...cfgOverrides };
  const enqueueToChat = jest.fn().mockResolvedValue(true);
  const lookup = jest.fn().mockResolvedValue(null);

  const svc = new LoginAlertService(
    { get: jest.fn().mockResolvedValue(cfg) } as any,
    { enqueueToChat } as any,
    { lookup } as unknown as IpGeoService,
    {
      systemSetting: { findUnique: jest.fn().mockResolvedValue({ value: 'Asia/Muscat' }) },
    } as any,
  );

  return { svc, enqueueToChat, lookup };
}

/** The service is fire-and-forget; drain the microtask queue it detaches into. */
const settle = () => new Promise((r) => setImmediate(r));

describe('login alerts — success', () => {
  it('queues an alert carrying who, when, IP and User-Agent', async () => {
    const { svc, enqueueToChat } = build();
    svc.onLoginSuccess(USER, META);
    await settle();

    expect(enqueueToChat).toHaveBeenCalledTimes(1);
    const arg = enqueueToChat.mock.calls[0][0];
    expect(arg.chatId).toBe('-5544539023');
    expect(arg.templateKey).toBe('login_alert');
    expect(arg.userId).toBe('user-1');
    expect(arg.branchId).toBe('branch-1');
    expect(arg.body).toContain('Asha Rao');
    expect(arg.body).toContain('asha@example.com');
    expect(arg.body).toContain('EMP-0042');
    expect(arg.body).toContain('Muscat HO');
    expect(arg.body).toContain('203.0.113.9');
    expect(arg.body).toContain(CHROME_UA);
  });

  it('includes the parsed device, not only the raw User-Agent', async () => {
    const { svc, enqueueToChat } = build();
    svc.onLoginSuccess(USER, META);
    await settle();
    expect(enqueueToChat.mock.calls[0][0].body).toContain('Chrome 131 on Windows 10/11');
  });

  it('renders the time in the company timezone', async () => {
    const { svc, enqueueToChat } = build();
    svc.onLoginSuccess(USER, META);
    await settle();
    expect(enqueueToChat.mock.calls[0][0].body).toContain('(Asia/Muscat)');
  });

  it('says so when the caller looks automated', async () => {
    const { svc, enqueueToChat } = build();
    svc.onLoginSuccess(USER, { ip: '203.0.113.9', userAgent: 'curl/8.6.0' });
    await settle();
    expect(enqueueToChat.mock.calls[0][0].body).toContain('looks automated');
  });

  // Both branches of every switch, per the project rules.
  it.each([
    ['the channel is off', { enabled: false }],
    ['login alerts are off', { loginAlertsEnabled: false }],
    ['no alert chat is configured', { alertChatId: '' }],
  ])('sends nothing when %s', async (_label, override) => {
    const { svc, enqueueToChat } = build(override);
    svc.onLoginSuccess(USER, META);
    await settle();
    expect(enqueueToChat).not.toHaveBeenCalled();
  });

  it('honours a role allowlist', async () => {
    const { svc, enqueueToChat } = build({ loginAlertRoles: ['ADMIN'] });
    svc.onLoginSuccess(USER, META);
    await settle();
    expect(enqueueToChat).not.toHaveBeenCalled();
  });

  it('alerts on every role when the allowlist is empty', async () => {
    // An empty CSV must not silently mean "nobody" — that would switch the
    // feature off through a field nobody thinks of as a switch.
    const { svc, enqueueToChat } = build({ loginAlertRoles: [] });
    svc.onLoginSuccess({ ...USER, role: 'EMPLOYEE' }, META);
    await settle();
    expect(enqueueToChat).toHaveBeenCalledTimes(1);
  });

  it('looks up geo only when the setting is on', async () => {
    const off = build({ loginAlertGeo: false });
    off.svc.onLoginSuccess(USER, META);
    await settle();
    expect(off.lookup).not.toHaveBeenCalled();

    const on = build({ loginAlertGeo: true });
    on.lookup.mockResolvedValue({ city: 'Muscat', country: 'Oman', isp: 'Omantel' });
    on.svc.onLoginSuccess(USER, META);
    await settle();
    expect(on.lookup).toHaveBeenCalledWith('203.0.113.9', 'http://example.invalid/{ip}');
    expect(on.enqueueToChat.mock.calls[0][0].body).toContain('Muscat, Oman');
  });

  it('still alerts when the geo lookup rejects', async () => {
    // The failure mode this pins: geoLine sits inside a Promise.all, so a
    // rejection there would take the whole alert with it and logins would
    // silently stop being reported. A missing location line is acceptable
    // degradation; a missing alert is not.
    const { svc, enqueueToChat, lookup } = build({ loginAlertGeo: true });
    lookup.mockRejectedValue(new Error('provider down'));
    svc.onLoginSuccess(USER, META);
    await settle();
    expect(enqueueToChat).toHaveBeenCalledTimes(1);
    expect(enqueueToChat.mock.calls[0][0].body).not.toContain('Location:');
  });

  it('never throws back into the login, whatever the outbox does', async () => {
    const { svc, enqueueToChat } = build();
    enqueueToChat.mockRejectedValue(new Error('telegram exploded'));
    expect(() => svc.onLoginSuccess(USER, META)).not.toThrow();
    await settle();
  });

  it('survives a missing IP and a missing User-Agent', async () => {
    const { svc, enqueueToChat } = build();
    svc.onLoginSuccess(USER, { ip: null, userAgent: null });
    await settle();
    const body = enqueueToChat.mock.calls[0][0].body;
    expect(body).toContain('unknown');
    expect(body).toContain('not sent');
  });
});

describe('login alerts — failures', () => {
  it.each([
    ['UNKNOWN_EMAIL', 'No account with that email'],
    ['ACCOUNT_DISABLED', 'Account is disabled'],
    ['BAD_PASSWORD', 'Wrong password'],
  ] as const)('reports %s', async (reason, label) => {
    const { svc, enqueueToChat } = build();
    svc.onLoginFailure('ghost@example.com', reason, META);
    await settle();
    const arg = enqueueToChat.mock.calls[0][0];
    expect(arg.templateKey).toBe('login_alert_failed');
    expect(arg.body).toContain(label);
    expect(arg.body).toContain('ghost@example.com');
    // A failed login for an unknown email has no user to attribute it to.
    expect(arg.userId ?? null).toBeNull();
  });

  it('sends nothing when failure alerts are switched off', async () => {
    const { svc, enqueueToChat } = build({ loginAlertFailures: false });
    svc.onLoginFailure('ghost@example.com', 'BAD_PASSWORD', META);
    await settle();
    expect(enqueueToChat).not.toHaveBeenCalled();
  });

  it('caps failure alerts per IP, then says once why it went quiet', async () => {
    // The group is reachable by anyone who can POST to /auth/login, so this cap
    // is the difference between an alert channel and an amplification channel.
    const { svc, enqueueToChat } = build({ loginAlertFailureMaxPerHour: 3 });
    for (let i = 0; i < 8; i++) {
      svc.onLoginFailure('ghost@example.com', 'BAD_PASSWORD', META);
      await settle();
    }

    const keys = enqueueToChat.mock.calls.map((c) => c[0].templateKey);
    expect(keys.filter((k) => k === 'login_alert_failed')).toHaveLength(3);
    expect(keys.filter((k) => k === 'login_alert_throttled')).toHaveLength(1);
  });

  it('counts per IP, so one attacker cannot mute everybody else', async () => {
    const { svc, enqueueToChat } = build({ loginAlertFailureMaxPerHour: 1 });
    svc.onLoginFailure('a@example.com', 'BAD_PASSWORD', { ...META, ip: '203.0.113.1' });
    await settle();
    svc.onLoginFailure('b@example.com', 'BAD_PASSWORD', { ...META, ip: '203.0.113.1' });
    await settle();
    svc.onLoginFailure('c@example.com', 'BAD_PASSWORD', { ...META, ip: '198.51.100.7' });
    await settle();

    const failed = enqueueToChat.mock.calls.filter((c) => c[0].templateKey === 'login_alert_failed');
    expect(failed.map((c) => c[0].body.includes('c@example.com'))).toContain(true);
    expect(failed).toHaveLength(2);
  });

  it('escapes markup smuggled in through the email field', async () => {
    // The email on a failed login is whatever the attacker typed.
    const { svc, enqueueToChat } = build();
    svc.onLoginFailure('<b>pwn</b>@x.com', 'UNKNOWN_EMAIL', META);
    await settle();
    const body = enqueueToChat.mock.calls[0][0].body;
    expect(body).toContain('&lt;b&gt;pwn&lt;/b&gt;@x.com');
    expect(body).not.toContain('<b>pwn</b>');
  });

  it('escapes markup smuggled in through the User-Agent', async () => {
    const { svc, enqueueToChat } = build();
    svc.onLoginFailure('x@y.com', 'BAD_PASSWORD', {
      ip: '203.0.113.9',
      userAgent: '</code><b>gotcha</b>',
    });
    await settle();
    expect(enqueueToChat.mock.calls[0][0].body).toContain('&lt;/code&gt;&lt;b&gt;gotcha');
  });
});

describe('dedupe keys', () => {
  it('collapses a double-submitted login into one alert', async () => {
    const { svc, enqueueToChat } = build();
    svc.onLoginSuccess(USER, META);
    await settle();
    svc.onLoginSuccess(USER, META);
    await settle();

    const [first, second] = enqueueToChat.mock.calls.map((c) => c[0].dedupeKey);
    // Same minute, same user, same IP -> the outbox unique index drops the second.
    expect(second).toBe(first);
  });

  it('separates two different users logging in from one office IP', async () => {
    const { svc, enqueueToChat } = build();
    svc.onLoginSuccess(USER, META);
    await settle();
    svc.onLoginSuccess({ ...USER, id: 'user-2', email: 'b@example.com' }, META);
    await settle();

    const [first, second] = enqueueToChat.mock.calls.map((c) => c[0].dedupeKey);
    expect(second).not.toBe(first);
  });

  it('keeps the key inside the 200-char column', async () => {
    const { svc, enqueueToChat } = build();
    svc.onLoginFailure('a'.repeat(300) + '@example.com', 'UNKNOWN_EMAIL', {
      ip: '2001:4860:4860:0000:0000:0000:0000:8888',
      userAgent: CHROME_UA,
    });
    await settle();
    // Prefixed with 'telegram:' downstream, so leave room for that too.
    expect(enqueueToChat.mock.calls[0][0].dedupeKey.length).toBeLessThan(180);
  });
});
