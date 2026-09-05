import { BadRequestException, Injectable } from '@nestjs/common';
import { AttendanceProvider } from '../types/attendance-provider.interface';
import { FusionAnalyticsProvider } from './fusion-analytics.provider';

/**
 * The list of attendance systems this deployment can talk to.
 *
 * To add a vendor: implement AttendanceProvider, then add one line to
 * `register()` below. Nothing else in the codebase needs to change — the admin
 * form, the sync engine, the cron and the run history are all provider-agnostic.
 */
@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<string, AttendanceProvider>();

  constructor(private readonly fusion: FusionAnalyticsProvider) {
    this.register(this.fusion);
  }

  private register(provider: AttendanceProvider): void {
    if (this.providers.has(provider.key)) {
      throw new Error(`Duplicate attendance provider key: ${provider.key}`);
    }
    this.providers.set(provider.key, provider);
  }

  /** Test seam: lets an e2e suite plug in a fake provider without a live vendor. */
  registerForTesting(provider: AttendanceProvider): void {
    this.providers.set(provider.key, provider);
  }

  list(): AttendanceProvider[] {
    return [...this.providers.values()];
  }

  has(key: string): boolean {
    return this.providers.has(key);
  }

  get(key: string): AttendanceProvider {
    const provider = this.providers.get(key);
    if (!provider) {
      throw new BadRequestException(
        `Unknown attendance provider '${key}'. Available: ${[...this.providers.keys()].join(', ')}`,
      );
    }
    return provider;
  }
}
