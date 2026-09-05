import { ForbiddenException } from '@nestjs/common';
import { SystemSettingsController } from './system-settings.controller';

/**
 * The partial developer-key gate on `POST /system-settings`.
 *
 * Regression cover for a production outage: the settings page resubmitted its
 * whole form on every Save, `mail_*` included, so an unelevated ADMIN got a
 * flat 403 on saves that touched nothing operator-owned and could not change
 * ANY setting at all. The client no longer sends those keys unelevated; these
 * assertions pin the server half of the contract.
 */
function makeController(opts: { enforced: boolean; elevated: boolean }) {
  const settingsService = {
    updateSettings: jest.fn().mockResolvedValue({ success: true }),
  } as any;
  const devMode = {
    isEnforced: () => opts.enforced,
    isElevated: () => opts.elevated,
  } as any;
  return {
    controller: new SystemSettingsController(settingsService, devMode),
    settingsService,
  };
}

const TENANT_PAYLOAD = { company_name: 'Acme', overtime_regular_rate: '1.5' };

describe('SystemSettingsController.updateSettings', () => {
  it('writes a tenant-only payload for an unelevated admin', async () => {
    const { controller, settingsService } = makeController({ enforced: true, elevated: false });

    await controller.updateSettings({ settings: TENANT_PAYLOAD } as any, {});

    expect(settingsService.updateSettings).toHaveBeenCalledWith(TENANT_PAYLOAD);
  });

  it('refuses the whole payload when it smuggles a developer key', async () => {
    const { controller, settingsService } = makeController({ enforced: true, elevated: false });

    await expect(
      controller.updateSettings(
        { settings: { ...TENANT_PAYLOAD, mail_host: 'smtp.evil.test' } } as any,
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // A half-applied save is worse than a refused one: nothing is written.
    expect(settingsService.updateSettings).not.toHaveBeenCalled();
  });

  it('names the blocked keys so an unrelated save failure is diagnosable', async () => {
    const { controller } = makeController({ enforced: true, elevated: false });

    await expect(
      controller.updateSettings(
        { settings: { ...TENANT_PAYLOAD, mail_host: '', 'copilot.model': 'x' } } as any,
        {},
      ),
    ).rejects.toThrow(/mail_host.*copilot\.model|copilot\.model.*mail_host/);
  });

  it('lets an elevated admin write developer keys', async () => {
    const { controller, settingsService } = makeController({ enforced: true, elevated: true });
    const payload = { ...TENANT_PAYLOAD, mail_host: 'smtp.acme.test' };

    await controller.updateSettings({ settings: payload } as any, {});

    expect(settingsService.updateSettings).toHaveBeenCalledWith(payload);
  });

  it('is inert before the rollout switch is flipped', async () => {
    const { controller, settingsService } = makeController({ enforced: false, elevated: false });
    const payload = { ...TENANT_PAYLOAD, mail_host: 'smtp.acme.test' };

    await controller.updateSettings({ settings: payload } as any, {});

    expect(settingsService.updateSettings).toHaveBeenCalledWith(payload);
  });
});
