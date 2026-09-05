import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Keys safe to serve unauthenticated.
 *
 * An allow-list rather than a deny-list: the /public endpoint is read by the
 * login page before anyone has signed in, so a key added later must be opted
 * IN to reach it. A deny-list would leak every new key by default, and this
 * table also holds integration credentials.
 */
const PUBLIC_KEYS = [
  'company_name',
  'company_logo_url',
  'company_short_name',
  'primary_color',
  'accent_color',
  'default_currency',
  'default_timezone',
] as const;

/**
 * The value every key falls back to on a database that has never been
 * configured.
 *
 * Merged UNDER the stored rows, so a fresh install renders and an administrator
 * who has tuned a key keeps their value. Each module's operating parameters are
 * here rather than hard-coded at the point of use: a grace period read from a
 * constant in the attendance service cannot be changed without a deploy, and it
 * is exactly the kind of number a payroll manager needs to change on a Tuesday.
 */
const DEFAULTS: Record<string, string> = {
  // Branding
  company_name: 'People Pay 360',
  company_short_name: 'PP360',
  primary_color: '#00358F',
  accent_color: '#f66600',
  default_currency: 'OMR',
  default_timezone: 'Asia/Muscat',

  // Organisation
  organization_trend_months: '6',

  // People
  contract_expiry_alert_days: '60',
  probation_alert_days: '30',
  visa_expiry_alert_days: '30',
  default_notice_period_days: '30',
  default_annual_leave_days: '30',

  // Time and attendance. The office window is a WALL CLOCK in
  // `default_timezone`, and a branch may override any of these three — see the
  // nullable columns on Branch.
  attendance_office_start: '08:00',
  attendance_office_end: '17:00',
  attendance_grace_minutes: '15',
  /** ISO weekday numbers, 1 = Monday. Friday and Saturday for the Gulf. */
  attendance_weekly_off_days: '5,6',
  /** Below this fraction of the expected hours a day is HALF_DAY, not PRESENT. */
  attendance_half_day_threshold: '0.5',
  /** Until this passes, an absence count is a prediction rather than a fact. */
  attendance_day_end: '20:00',
  attendance_geofence_default_radius_m: '150',
  face_recognition_min_quality: '0.6',
};

@Injectable()
export class SystemSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Unauthenticated. Defaults are merged in so a fresh database still renders. */
  async getPublic() {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: [...PUBLIC_KEYS] }, isSecret: false },
    });
    return {
      ...DEFAULTS,
      ...Object.fromEntries(rows.map((r) => [r.key, r.value])),
    };
  }

  /** Authenticated. Secret values are reported as present, never returned. */
  async getAll() {
    const rows = await this.prisma.systemSetting.findMany({
      orderBy: { key: 'asc' },
    });
    return {
      ...DEFAULTS,
      ...Object.fromEntries(
        rows.map((r) => [r.key, r.isSecret ? '••••••••' : r.value]),
      ),
    };
  }

  /**
   * One setting, with its default applied.
   *
   * Other modules read their parameters through this rather than through
   * `getAll()`, which masks secrets and would hand back the mask string.
   */
  async get(key: string): Promise<string | undefined> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    return row?.value ?? DEFAULTS[key];
  }

  /** The same, parsed, refusing to return NaN when a row holds nonsense. */
  async getNumber(key: string, fallback: number): Promise<number> {
    const raw = await this.get(key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  async update(settings: Record<string, string>) {
    const entries = Object.entries(settings);
    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        this.prisma.systemSetting.upsert({
          where: { key },
          update: { value: String(value) },
          create: { key, value: String(value) },
        }),
      ),
    );
    return this.getAll();
  }
}
