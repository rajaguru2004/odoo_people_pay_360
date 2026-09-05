import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { AuditResource } from '../../audit/audit-resource.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { DevModeGuard } from '../../dev-mode/dev-mode.guard';
import { RequireDeveloper } from '../../dev-mode/require-developer.decorator';
import { ActionRegistryService } from '../router/action-registry.service';
import { WhatsAppSettingsService } from '../whatsapp-settings.service';
import { menuGroup } from '../router/menu-groups';

export class SetDisabledActionsDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  keys!: string[];
}

/**
 * The live action catalogue, for the admin UI.
 *
 * Deliberately NOT on WhatsAppController. The registry lives in
 * EssActionsModule -> McpModule -> ~20 domain modules -> NotificationsModule ->
 * WhatsAppModule, so importing it there would recreate exactly the cycle the
 * two-module split exists to break. WhatsAppInboundModule is a leaf, which is
 * what makes it the right home.
 *
 * The point of serving the registry rather than a hardcoded list is that the
 * settings page cannot drift from what the channel can actually do: a new
 * action appears in the admin UI the moment it is registered, and a removed one
 * disappears.
 */
@ApiTags('WhatsApp')
@Controller('whatsapp/actions')
@UseGuards(JwtAuthGuard, RolesGuard, DevModeGuard)
@Roles('ADMIN')
// Part of the WhatsApp settings tab, so it hides with it.
@RequireDeveloper()
@AuditResource('WhatsAppSetting')
export class WhatsAppActionsController {
  constructor(
    private readonly registry: ActionRegistryService,
    private readonly settings: WhatsAppSettingsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every registered action, with its current on/off state.' })
  async list() {
    const cfg = await this.settings.get();
    const disabled = new Set(cfg.actionDenylist);

    const rows = this.registry
      .getAll()
      .filter((a) => !a.localRender) // navigation is plumbing, not a capability
      .map((a) => ({
        key: a.key,
        label: a.menuLabel,
        group: a.menuGroup ?? '',
        groupLabel: menuGroup(a.menuGroup)?.label ?? 'Other',
        order: a.menuOrder ?? 99,
        roles: a.roles as string[],
        requiresEmployee: a.requiresEmployee,
        sensitive: a.sensitivity === 'sensitive',
        writes: a.confirmPolicy !== 'none',
        needsActionToken: Boolean(a.needsActionToken),
        toolName: a.tool?.name ?? null,
        keywords: a.keywords,
        enabled: !disabled.has(a.key),
      }));

    return { success: true, data: rows };
  }

  @Put('disabled')
  @ApiOperation({
    summary: 'Set which actions are switched off.',
    description:
      'Send the full list. Unknown keys are dropped — the same cleaning disabledTemplates ' +
      'gets, which cannot be done in the settings service because the registry is ' +
      'unreachable from there.',
  })
  async setDisabled(@Body() dto: SetDisabledActionsDto) {
    const known = new Set(this.registry.getAll().map((a) => a.key));
    const keys = [...new Set(dto.keys.filter((k) => known.has(k)))];
    await this.settings.update({ actionDenylist: keys });
    return { success: true, data: { disabled: keys } };
  }
}
