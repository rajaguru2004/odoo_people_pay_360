import { Body, Controller, ForbiddenException, Get, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DiscordSettingsService } from './discord-settings.service';
import { DiscordIdentityService } from './identity/discord-identity.service';
import { DiscordOutboxService } from './discord-outbox.service';
import { UpdateDiscordSettingsDto } from './dto/update-discord-settings.dto';

/**
 * Discord channel administration.
 *
 * ADMIN only, and outside the generic /system-settings surface for the same
 * reason as WhatsApp: `getSettingsList()` is a hardcoded catalogue, so keeping
 * every `discord.*` key out of it means GET /system-settings never carries the
 * bot token for any role. The read projection is typed as DiscordPublicConfig,
 * which structurally has no `botToken` field.
 */
@ApiTags('discord')
@ApiBearerAuth('JWT-auth')
@Controller('discord')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class DiscordController {
  constructor(
    private readonly settings: DiscordSettingsService,
    private readonly identities: DiscordIdentityService,
    private readonly outbox: DiscordOutboxService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Discord channel settings (bot token masked, never returned)' })
  async getSettings() {
    return { success: true, data: await this.settings.getPublic() };
  }

  @Put('settings')
  @ApiOperation({ summary: 'Update Discord channel settings' })
  async updateSettings(@Body() dto: UpdateDiscordSettingsDto) {
    return { success: true, data: await this.settings.update(dto) };
  }

  @Get('identities/stats')
  @ApiOperation({ summary: 'How many Discord accounts are linked' })
  async stats() {
    return { success: true, data: await this.identities.stats() };
  }

  @Post('outbox/drain')
  @ApiOperation({ summary: 'Run the DM drainer immediately' })
  async drain() {
    return { success: true, data: await this.outbox.drain() };
  }
}

/**
 * Employee self-service. Scoped from @CurrentUser() with no id parameter, so
 * there is no shape in which one employee links another one's account.
 */
@ApiTags('discord')
@ApiBearerAuth('JWT-auth')
@Controller('discord/me')
@UseGuards(JwtAuthGuard)
export class DiscordMeController {
  constructor(
    private readonly identities: DiscordIdentityService,
    private readonly settings: DiscordSettingsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Is my Discord account linked?' })
  async me(@CurrentUser() user: any) {
    const [status, cfg] = await Promise.all([this.identities.getMine(user.id), this.settings.get()]);
    return {
      success: true,
      data: {
        ...status,
        // Lets the profile screen hide the section entirely rather than offering
        // a link that would be refused at /link time.
        available: cfg.enabled && cfg.linkingEnabled,
        // Not secret; it is the invite URL every server admin already sees.
        applicationId: cfg.applicationId || null,
      },
    };
  }

  @Post('link/start')
  @ApiOperation({
    summary: 'Get a one-time code to run as /link in Discord.',
    description:
      'Issued in the browser and redeemed from Discord, so neither side alone completes the link.',
  })
  async startLink(@CurrentUser() user: any) {
    const cfg = await this.settings.get();
    // Without this the code issues fine and then fails at redemption, which
    // reads as a broken bot rather than a switched-off channel.
    if (!cfg.enabled || !cfg.linkingEnabled) {
      throw new ForbiddenException('Discord linking is not enabled.');
    }
    return { success: true, data: await this.identities.startLink(user.id) };
  }

  @Post('unlink')
  @ApiOperation({ summary: 'Unlink my Discord account. Link history is kept.' })
  async unlink(@CurrentUser() user: any) {
    return { success: true, data: await this.identities.revoke(user.id) };
  }
}
