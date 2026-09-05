import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_DEVELOPER_KEY } from './dev-mode.constants';
import { DevModeService } from './dev-mode.service';

/**
 * Denies any route marked `@RequireDeveloper()` unless the caller is an ADMIN
 * holding a live elevation token for their own session.
 *
 * Two deliberate behaviours:
 *
 *  - When `DEV_MODE_ENFORCED` is off the guard is a no-op, so the feature can be
 *    deployed and elevation exercised before it starts denying anyone. Turn it
 *    on only after `DEV_MODE_PASSWORD_HASH` is set, otherwise these settings
 *    become unreachable for everybody.
 *  - The refusal is a flat 403 with a generic message. It never says "developer
 *    mode required", because the whole point is that an admin should not learn
 *    that a hidden surface exists.
 */
@Injectable()
export class DevModeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly devMode: DevModeService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_DEVELOPER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) return true;
    if (!this.devMode.isEnforced()) return true;

    const req = context.switchToHttp().getRequest();
    if (this.devMode.isElevated(req)) return true;

    throw new ForbiddenException('You do not have access to this resource');
  }
}
