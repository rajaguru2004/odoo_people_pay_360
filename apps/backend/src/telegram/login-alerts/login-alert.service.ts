import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { DateTime } from 'luxon';
import { runWithBranchBypass } from '../../common/branch/branch-context';
import { RequestMeta } from '../../common/utils/request-meta.util';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramOutboxService } from '../telegram-outbox.service';
import { TelegramSettingsService } from '../telegram-settings.service';
import { b, code, escapeTelegramHtml, kv } from '../render/telegram-format';
import { describeDevice, parseUserAgent } from './device-meta';
import { IpGeoService } from './ip-geo.service';

/** Why a login failed. Shown verbatim in the alert. */
export type LoginFailureReason =
  | 'UNKNOWN_EMAIL'
  | 'ACCOUNT_DISABLED'
  | 'BAD_PASSWORD';

const FAILURE_LABELS: Record<LoginFailureReason, string> = {
  UNKNOWN_EMAIL: 'No account with that email',
  ACCOUNT_DISABLED: 'Account is disabled',
  BAD_PASSWORD: 'Wrong password',
};

export interface LoginAlertUser {
  id: string;
  email: string;
  role?: string | null;
  employeeId?: string | null;
  fullName?: string | null;
  employeeCode?: string | null;
  branchName?: string | null;
  branchId?: string | null;
}

/**
 * Posts every login to the ops Telegram group.
 *
 * Two rules govern everything here.
 *
 * **It must never affect the login.** Every entry point returns void, swallows
 * its own errors and is called without await from AuthService. A Telegram
 * outage, a slow geo lookup or a malformed User-Agent cannot make a correct
 * password fail — the whole feature is observability, and observability that
 * can deny service is worse than none.
 *
 * **A failed login is attacker-controlled input.** Anyone on the internet can
 * hit /auth/login with any email and any User-Agent, which makes the failure
 * alert a free amplification path into a group chat. Hence the per-IP hourly
 * cap, the one-and-only-one suppression notice when it trips, and the fact that
 * every interpolated value goes through `escapeTelegramHtml` — an email of
 * `<b>x</b>@y` must not be able to inject markup into an ops alert.
 */
@Injectable()
export class LoginAlertService {
  private readonly logger = new Logger(LoginAlertService.name);

  /** ip -> { hourBucket, count, noticeSent }. In-process, deliberately. */
  private readonly failureCounters = new Map<
    string,
    { bucket: string; count: number; noticeSent: boolean }
  >();

  constructor(
    private readonly settings: TelegramSettingsService,
    private readonly outbox: TelegramOutboxService,
    private readonly geo: IpGeoService,
    private readonly prisma: PrismaService,
  ) {}

  /** Fire-and-forget. Call without await. */
  onLoginSuccess(user: LoginAlertUser, meta: RequestMeta): void {
    void this.handleSuccess(user, meta).catch((e) =>
      this.logger.debug(`Login alert (success) failed: ${(e as Error).message}`),
    );
  }

  /** Fire-and-forget. Call without await. */
  onLoginFailure(email: string, reason: LoginFailureReason, meta: RequestMeta): void {
    void this.handleFailure(email, reason, meta).catch((e) =>
      this.logger.debug(`Login alert (failure) failed: ${(e as Error).message}`),
    );
  }

  // --------------------------------------------------------------- internals

  private async handleSuccess(user: LoginAlertUser, meta: RequestMeta): Promise<void> {
    const cfg = await this.settings.get();
    if (!this.alertsOn(cfg)) return;

    // Empty list = every role. An empty CSV must not silently mean "nobody".
    if (cfg.loginAlertRoles.length && !cfg.loginAlertRoles.includes(String(user.role ?? '').toUpperCase())) {
      return;
    }

    const [when, device, geoLine] = await Promise.all([
      this.companyLocalNow(),
      Promise.resolve(this.deviceLines(meta)),
      this.geoLine(cfg.loginAlertGeo, meta.ip, cfg.geoLookupUrl),
    ]);

    const body = [
      `🔐 ${b('Login')}`,
      '',
      kv('User', user.fullName || user.email),
      kv('Email', user.email),
      kv('Employee', user.employeeCode),
      kv('Role', user.role),
      kv('Branch', user.branchName),
      kv('When', when),
      '',
      `${b('IP:')} ${code(meta.ip ?? 'unknown')}`,
      geoLine,
      ...device,
    ]
      .filter((l) => l !== '')
      .join('\n');

    await this.outbox.enqueueToChat({
      chatId: cfg.alertChatId,
      templateKey: 'login_alert',
      body,
      // Minute-bucketed, so a double-submitted login form is one alert while a
      // genuine second login a minute later is still reported.
      dedupeKey: this.dedupeKey('login', user.id, meta.ip, new Date()),
      userId: user.id,
      employeeId: user.employeeId ?? null,
      branchId: user.branchId ?? null,
      notificationType: 'SECURITY',
    });
  }

  private async handleFailure(
    email: string,
    reason: LoginFailureReason,
    meta: RequestMeta,
  ): Promise<void> {
    const cfg = await this.settings.get();
    if (!this.alertsOn(cfg) || !cfg.loginAlertFailures) return;

    const verdict = this.countFailure(meta.ip, cfg.loginAlertFailureMaxPerHour);
    if (verdict === 'suppressed') return;

    if (verdict === 'cap-reached') {
      await this.outbox.enqueueToChat({
        chatId: cfg.alertChatId,
        templateKey: 'login_alert_throttled',
        body: [
          `🛑 ${b('Failed-login alerts paused')}`,
          '',
          `More than ${cfg.loginAlertFailureMaxPerHour} failed logins this hour from ` +
            `${code(meta.ip ?? 'unknown')}. Further alerts from this address are suppressed ` +
            'until the next hour.',
        ].join('\n'),
        dedupeKey: this.dedupeKey('login-throttle', meta.ip ?? 'unknown', null, new Date(), 13),
        notificationType: 'SECURITY',
      });
      return;
    }

    const [when, geoLine] = await Promise.all([
      this.companyLocalNow(),
      this.geoLine(cfg.loginAlertGeo, meta.ip, cfg.geoLookupUrl),
    ]);

    const body = [
      `⚠️ ${b('Failed login')}`,
      '',
      kv('Email tried', email),
      kv('Reason', FAILURE_LABELS[reason]),
      kv('When', when),
      '',
      `${b('IP:')} ${code(meta.ip ?? 'unknown')}`,
      geoLine,
      ...this.deviceLines(meta),
    ]
      .filter((l) => l !== '')
      .join('\n');

    await this.outbox.enqueueToChat({
      chatId: cfg.alertChatId,
      templateKey: 'login_alert_failed',
      body,
      dedupeKey: this.dedupeKey(`login-fail:${reason}`, email, meta.ip, new Date()),
      notificationType: 'SECURITY',
    });
  }

  /** Off unless the channel is on, alerts are on, and a chat is configured. */
  private alertsOn(cfg: { enabled: boolean; loginAlertsEnabled: boolean; alertChatId: string }) {
    return Boolean(cfg.enabled && cfg.loginAlertsEnabled && cfg.alertChatId);
  }

  private deviceLines(meta: RequestMeta): string[] {
    const device = parseUserAgent(meta.userAgent);
    return [
      `${b('Device:')} ${escapeTelegramHtml(describeDevice(device))} (${escapeTelegramHtml(device.deviceType)})`,
      device.isBot ? `${b('Note:')} the User-Agent looks automated, not a browser.` : '',
      `${b('User-Agent:')} ${code(meta.userAgent ?? 'not sent')}`,
    ].filter(Boolean);
  }

  /**
   * The `.catch()` is not belt-and-braces. `IpGeoService.lookup` swallows its
   * own transport errors, but this line sits inside a `Promise.all` — so if it
   * ever did reject, the whole alert would be lost to the outer catch and the
   * failure mode would be "logins stopped being reported", which is exactly the
   * silence this feature exists to prevent. A missing location line is the
   * correct degradation; a missing alert is not.
   */
  private async geoLine(on: boolean, ip: string | null, url: string): Promise<string> {
    if (!on) return '';
    const geo = await this.geo.lookup(ip, url).catch(() => null);
    const text = IpGeoService.describe(geo);
    return text ? `${b('Location:')} ${escapeTelegramHtml(text)}` : '';
  }

  /**
   * Per-IP hourly cap on failure alerts.
   *
   * Returns 'ok' below the cap, 'cap-reached' exactly once at the cap (so the
   * group is told why it went quiet), and 'suppressed' after that. In-process
   * state on purpose: a shared counter would be a DB write on every failed
   * login attempt, which is precisely the traffic an attacker controls.
   * Per-instance counting means N instances allow at most N times the cap —
   * still bounded, still far short of a flood.
   */
  private countFailure(ip: string | null, max: number): 'ok' | 'cap-reached' | 'suppressed' {
    const key = ip ?? 'unknown';
    const bucket = new Date().toISOString().slice(0, 13);
    const entry = this.failureCounters.get(key);

    if (!entry || entry.bucket !== bucket) {
      this.failureCounters.set(key, { bucket, count: 1, noticeSent: false });
      this.pruneCounters(bucket);
      return 'ok';
    }

    entry.count++;
    if (entry.count <= max) return 'ok';
    if (!entry.noticeSent) {
      entry.noticeSent = true;
      return 'cap-reached';
    }
    return 'suppressed';
  }

  /** Drop last hour's counters so a long-lived process does not grow forever. */
  private pruneCounters(currentBucket: string): void {
    if (this.failureCounters.size < 1000) return;
    for (const [k, v] of this.failureCounters) {
      if (v.bucket !== currentBucket) this.failureCounters.delete(k);
    }
  }

  /**
   * Stable per-(subject, ip, minute) key.
   *
   * Hashed because the raw parts include an email, and the dedupe key column is
   * 200 chars — an email plus an IPv6 address plus a prefix can overrun it, and
   * a truncated key silently collides.
   */
  private dedupeKey(
    prefix: string,
    subject: string,
    ip: string | null,
    at: Date,
    bucketLength = 16,
  ): string {
    const bucket = at.toISOString().slice(0, bucketLength);
    const hash = createHash('sha1')
      .update([prefix, subject, ip ?? '', bucket].join('|'))
      .digest('hex')
      .slice(0, 32);
    return `${prefix}:${hash}`;
  }

  /** "29 Aug 2026, 17:42 (Asia/Kolkata)" in the company timezone. */
  private async companyLocalNow(): Promise<string> {
    const tz = await this.companyTimezone();
    return `${DateTime.now().setZone(tz).toFormat('dd LLL yyyy, HH:mm:ss')} (${tz})`;
  }

  /**
   * Read the timezone straight from settings rather than through
   * TimezoneService. TimezoneModule pulls in SystemSettingsModule, and
   * TelegramModule is imported by NotificationsModule, which ~20 domain modules
   * import — the same import discipline the Discord and WhatsApp modules
   * document, for the same cycle-avoidance reason.
   */
  private async companyTimezone(): Promise<string> {
    const row = await runWithBranchBypass(() =>
      this.prisma.systemSetting.findUnique({ where: { key: 'system_timezone' } }),
    ).catch(() => null);
    const tz = row?.value?.trim();
    return tz && DateTime.now().setZone(tz).isValid ? tz : 'Asia/Kolkata';
  }
}
