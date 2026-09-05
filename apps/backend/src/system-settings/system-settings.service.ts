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

const DEFAULTS: Record<string, string> = {
  company_name: 'People Pay 360',
  company_short_name: 'PP360',
  primary_color: '#00358F',
  accent_color: '#f66600',
  default_currency: 'OMR',
  default_timezone: 'Asia/Muscat',
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
