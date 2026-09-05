import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EvolutionClient } from './evolution/evolution.client';
import { WhatsAppAdminService } from './whatsapp-admin.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import { WhatsAppMeController } from './whatsapp-me.controller';
import { WhatsAppOutboxScheduler } from './whatsapp-outbox.scheduler';
import { WhatsAppOutboxService } from './whatsapp-outbox.service';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { WhatsAppEnrollmentService } from './identity/whatsapp-enrollment.service';
import { WhatsAppRateLimitService } from './runtime/whatsapp-rate-limit.service';
import { WhatsAppActionTokenService } from './approvals/whatsapp-action-token.service';
import { TimezoneModule } from '../common/timezone/timezone.module';

/**
 * WhatsApp channel — OUTBOUND half (notifications, identity, admin).
 *
 * Import discipline is the whole design of this module. NotificationsModule
 * imports it for the delivery tee, and ~20 domain modules import
 * NotificationsModule — so anything imported here is transitively imported by
 * most of the application.
 *
 * That is why it depends only on PrismaModule and AuditModule (both of which
 * import nothing but Prisma), and why the inbound half lives in a separate
 * module: WhatsAppInboundModule needs McpModule, and McpModule imports the
 * domain modules, which import NotificationsModule. Putting the two halves in
 * one module produced exactly that cycle
 * (AdvanceLoans → Notifications → WhatsApp → Mcp → AdvanceLoans).
 *
 * Splitting is not a workaround — inbound is a leaf that nothing else needs,
 * so it belongs at the edge of the graph.
 */
@Module({
  imports: [PrismaModule, AuditModule, TimezoneModule],
  controllers: [WhatsAppController, WhatsAppMeController],
  providers: [
    WhatsAppSettingsService,
    EvolutionClient,
    WhatsAppOutboxService,
    WhatsAppOutboxScheduler,
    WhatsAppIdentityService,
    WhatsAppEnrollmentService,
    WhatsAppRateLimitService,
    WhatsAppActionTokenService,
    WhatsAppAdminService,
  ],
  exports: [
    WhatsAppOutboxService,
    WhatsAppSettingsService,
    WhatsAppIdentityService,
    WhatsAppEnrollmentService,
    WhatsAppRateLimitService,
    // Exported so approval notifications can mint a single-use decision token.
    WhatsAppActionTokenService,
    EvolutionClient,
  ],
})
export class WhatsAppModule {}
