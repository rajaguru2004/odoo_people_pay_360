import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DiscordApiClient } from './api/discord-api.client';
import { DiscordCheckinTokenService } from './checkin/discord-checkin-token.service';
import { DiscordController, DiscordMeController } from './discord.controller';
import { DiscordOutboxService } from './discord-outbox.service';
import { DiscordSettingsService } from './discord-settings.service';
import { DiscordIdentityService } from './identity/discord-identity.service';

/**
 * Discord channel — OUTBOUND half (notifications, identity, admin).
 *
 * Same import discipline as WhatsAppModule, and for the same reason:
 * NotificationsModule imports this for the delivery tee, and ~20 domain modules
 * import NotificationsModule. Depending only on PrismaModule and AuditModule
 * keeps this edge cycle-free; the inbound half, which needs McpModule, lives in
 * DiscordInboundModule as a leaf.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [DiscordController, DiscordMeController],
  providers: [
    DiscordSettingsService,
    DiscordApiClient,
    DiscordIdentityService,
    DiscordOutboxService,
    DiscordCheckinTokenService,
  ],
  exports: [
    DiscordSettingsService,
    DiscordApiClient,
    DiscordIdentityService,
    DiscordOutboxService,
    DiscordCheckinTokenService,
  ],
})
export class DiscordModule {}
