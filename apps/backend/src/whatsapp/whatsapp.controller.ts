import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditResource } from '../audit/audit-resource.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DevModeGuard } from '../dev-mode/dev-mode.guard';
import { RequireDeveloper } from '../dev-mode/require-developer.decorator';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import { WhatsAppOutboxService } from './whatsapp-outbox.service';
import { WhatsAppAdminService } from './whatsapp-admin.service';
import { UpdateWhatsAppSettingsDto } from './dto/update-whatsapp-settings.dto';
import {
  EnrollFromEmployeesDto,
  QueryIdentitiesDto,
  QueryOutboxDto,
  TestSendDto,
} from './dto/whatsapp-requests.dto';

/**
 * WhatsApp channel administration.
 *
 * ADMIN only, and deliberately NOT part of the generic /system-settings surface:
 * `SystemSettingsService.getSettingsList()` is a hardcoded catalogue, so keeping
 * every `whatsapp.*` key out of it means GET /system-settings never carries them
 * for any role. Nothing here can return the API key — the read projection is
 * typed as WhatsAppPublicConfig, which structurally has no `apiKey` field.
 *
 * Developer mode on top of ADMIN: the Evolution instance, its credentials and
 * the outbox are operator infrastructure shared across the deployment, not
 * tenant configuration. Note this also gates `POST test-send` and the outbox
 * drain, which can put real messages on real phones.
 */
@ApiTags('whatsapp')
@ApiBearerAuth('JWT-auth')
@Controller('whatsapp')
@UseGuards(JwtAuthGuard, RolesGuard, DevModeGuard)
@Roles('ADMIN')
@RequireDeveloper()
@AuditResource('WhatsAppSetting')
export class WhatsAppController {
  constructor(
    private readonly settings: WhatsAppSettingsService,
    private readonly identities: WhatsAppIdentityService,
    private readonly outbox: WhatsAppOutboxService,
    private readonly admin: WhatsAppAdminService,
  ) {}

  // ---------------------------------------------------------------- settings

  @Get('settings')
  @ApiOperation({ summary: 'WhatsApp channel settings (API key masked, never returned)' })
  async getSettings() {
    return { success: true, data: await this.settings.getPublic() };
  }

  @Put('settings')
  @ApiOperation({ summary: 'Update WhatsApp channel settings' })
  async updateSettings(@Body() dto: UpdateWhatsAppSettingsDto, @CurrentUser() user: any) {
    const data = await this.admin.updateSettings(dto, user);
    return { success: true, data };
  }

  // -------------------------------------------------------------- connection

  @Get('connection-state')
  @ApiOperation({ summary: 'Evolution instance connection state' })
  async connectionState() {
    return { success: true, data: await this.admin.connectionState() };
  }

  @Get('qr')
  @ApiOperation({ summary: 'Pairing QR / code for the Evolution instance' })
  async qr() {
    return { success: true, data: await this.admin.qr() };
  }

  @Post('test-send')
  @ApiOperation({ summary: 'Render a sample message and optionally send it' })
  async testSend(@Body() dto: TestSendDto, @CurrentUser() user: any) {
    return { success: true, data: await this.admin.testSend(dto, user) };
  }

  // --------------------------------------------------------------- templates

  @Post('webhook/register')
  @ApiOperation({
    summary: 'Point WhatsApp at our callback URL and rotate the shared secret.',
  })
  async registerWebhook(@Body() body: { url: string }, @CurrentUser() user: any) {
    return { success: true, data: await this.admin.registerWebhook(body?.url ?? '', user) };
  }

  @Get('webhook/status')
  @ApiOperation({ summary: 'What callback URL WhatsApp currently has for us.' })
  async webhookStatus() {
    return { success: true, data: await this.admin.webhookStatus() };
  }

  @Get('webhook/config')
  @ApiOperation({
    summary:
      'The callback URL to configure in the WhatsApp service, and whether that ' +
      'service already has it.',
  })
  async webhookConfig() {
    return { success: true, data: await this.admin.webhookConfig() };
  }

  @Get('templates')
  @ApiOperation({ summary: 'Which updates can go out, and whether each is switched on' })
  async templates() {
    return { success: true, data: await this.admin.templates() };
  }

  // -------------------------------------------------------------- recipients

  @Get('identities')
  @ApiOperation({ summary: 'Delivery identity roster (numbers masked)' })
  async listIdentities(@Query() q: QueryIdentitiesDto, @CurrentUser() user: any) {
    return { success: true, data: await this.admin.listIdentities(q, user) };
  }

  @Get('identities/stats')
  @ApiOperation({ summary: 'Counts of linked / opted-in / verified / suspended numbers' })
  async identityStats() {
    return { success: true, data: await this.identities.stats() };
  }

  @Post('identities/enroll-from-employees')
  @ApiOperation({
    summary: 'Link the phone numbers already on employee records (dry-run unless commit)',
  })
  async enrollFromEmployees(@Body() dto: EnrollFromEmployeesDto) {
    return { success: true, data: await this.identities.enrollFromEmployeePhones(dto) };
  }

  @Post('identities/verify-pending')
  @ApiOperation({ summary: 'Batch-check unverified numbers against WhatsApp' })
  async verifyPending() {
    return { success: true, data: await this.identities.verifyPending() };
  }

  // ------------------------------------------------------------------ outbox

  @Get('outbox')
  @ApiOperation({ summary: 'Delivery log (recipients masked)' })
  async outboxList(@Query() q: QueryOutboxDto, @CurrentUser() user: any) {
    return { success: true, data: await this.admin.listOutbox(q, user) };
  }

  @Post('outbox/:id/retry')
  @ApiOperation({ summary: 'Requeue a failed or skipped message and attempt it now' })
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    const ok = await this.outbox.retry(id);
    if (!ok) throw new BadRequestException('Message not found, or not in a retryable state.');
    // Drain immediately rather than waiting for the 2-minute cron — and with
    // force, so a retry still works while delivery is switched off.
    const result = await this.outbox.drain({ force: true });
    return { success: true, message: 'Requeued', data: result };
  }

  @Post('outbox/drain')
  @ApiOperation({ summary: 'Run the drainer immediately (normally every 2 minutes)' })
  async drain() {
    return { success: true, data: await this.outbox.drain({ force: true }) };
  }
}
