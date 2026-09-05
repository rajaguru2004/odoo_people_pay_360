import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { CopilotSettingsService } from '../copilot-settings/copilot-settings.service';

/**
 * Per-user sliding-window rate limit for copilot endpoints. In-memory —
 * adequate for the current single-instance deployment; swap for
 * @nestjs/throttler + Redis if the backend ever scales out.
 */
@Injectable()
export class CopilotRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly settings: CopilotSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.id;
    if (!userId) return true; // auth guard rejects unauthenticated requests

    const cfg = await this.settings.get();
    const limit = cfg.rateLimit;
    const windowMs = cfg.rateWindowMs;
    const now = Date.now();

    const stamps = (this.hits.get(userId) ?? []).filter((t) => now - t < windowMs);
    if (stamps.length >= limit) {
      throw new HttpException(
        'Too many copilot requests. Please wait a moment.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    stamps.push(now);
    this.hits.set(userId, stamps);
    return true;
  }
}
