import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DevModeGuard } from './dev-mode.guard';

function contextFor(req: any) {
  return {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

function makeGuard(opts: {
  required: boolean;
  enforced: boolean;
  elevated: boolean;
}) {
  const reflector = { getAllAndOverride: () => opts.required } as unknown as Reflector;
  const devMode = {
    isEnforced: () => opts.enforced,
    isElevated: () => opts.elevated,
  } as any;
  return new DevModeGuard(reflector, devMode);
}

describe('DevModeGuard', () => {
  it('lets ungated routes through untouched', () => {
    const guard = makeGuard({ required: false, enforced: true, elevated: false });
    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('is inert before the rollout switch is flipped', () => {
    // The whole point of shipping with DEV_MODE_ENFORCED=false: the code is
    // deployed and elevation can be exercised without denying any admin yet.
    const guard = makeGuard({ required: true, enforced: false, elevated: false });
    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('allows an elevated caller on a gated route', () => {
    const guard = makeGuard({ required: true, enforced: true, elevated: true });
    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('refuses an unelevated caller once enforced', () => {
    const guard = makeGuard({ required: true, enforced: true, elevated: false });
    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
  });

  it('gives away nothing in the refusal message', () => {
    const guard = makeGuard({ required: true, enforced: true, elevated: false });
    try {
      guard.canActivate(contextFor({}));
      fail('expected a refusal');
    } catch (e: any) {
      // Must not mention developer mode, elevation, or a password prompt.
      expect(e.message).toBe('You do not have access to this resource');
    }
  });
});
