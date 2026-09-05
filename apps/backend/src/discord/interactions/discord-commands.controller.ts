import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ActionRegistryService } from '../../whatsapp/router/action-registry.service';
import { DiscordApiClient } from '../api/discord-api.client';
import { DiscordSettingsService } from '../discord-settings.service';
import { buildCommands } from './discord-command.registry';

/**
 * Publishing the slash-command set to Discord.
 *
 * Separate from DiscordController because it needs the action catalogue, which
 * lives in the inbound (leaf) module — the outbound module must stay free of
 * that dependency to remain cycle-safe.
 */
@ApiTags('discord')
@ApiBearerAuth('JWT-auth')
@Controller('discord/commands')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class DiscordCommandsController {
  constructor(
    private readonly settings: DiscordSettingsService,
    private readonly api: DiscordApiClient,
    private readonly registry: ActionRegistryService,
  ) {}

  @Post('register')
  @ApiOperation({
    summary: 'Publish the slash commands derived from the ESS action catalogue.',
    description:
      'A full overwrite, so the catalogue stays the single source of truth and stale commands ' +
      'cannot linger. Global commands can take up to an hour to appear in every client.',
  })
  async register() {
    const cfg = await this.settings.ensureCredentials();
    if (!cfg) {
      return {
        success: false,
        message: 'Set the application ID and bot token first.',
      };
    }

    const commands = buildCommands(this.registry.getAll());
    const res = await this.api.registerGlobalCommands(cfg, commands);
    return res.ok
      ? { success: true, data: { registered: res.count, commands: commands.map((c) => c.name) } }
      : { success: false, message: res.error };
  }

  @Post('preview')
  @ApiOperation({ summary: 'What would be published, without publishing it.' })
  preview() {
    const commands = buildCommands(this.registry.getAll());
    return { success: true, data: commands };
  }
}
