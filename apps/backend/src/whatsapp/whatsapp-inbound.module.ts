import { Module, forwardRef } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { McpModule } from '../mcp/mcp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { WhatsAppModule } from './whatsapp.module';

import { WhatsAppWebhookController } from './inbound/whatsapp-webhook.controller';
import { WhatsAppActionsController } from './inbound/whatsapp-actions.controller';
import { WhatsAppFaceProofService } from './inbound/whatsapp-face-proof.service';
import { WhatsAppInboundService } from './inbound/whatsapp-inbound.service';
import { WhatsAppInboundScheduler } from './inbound/whatsapp-inbound.scheduler';
import { WhatsAppSessionService } from './session/whatsapp-session.service';
import { WhatsAppPrincipalService } from './runtime/whatsapp-principal.service';
import { ChannelPrincipalService } from '../common/channel/channel-principal.service';
import { ChannelVerificationModule } from '../common/verification/channel-verification.module';
import { ChannelFaceVerificationService } from '../common/verification/channel-face-verification.service';
import { FaceRecognitionModule } from '../face-recognition/face-recognition.module';
import { EssActionsModule } from '../ess-actions/ess-actions.module';
import { CommandRouterService } from './router/command-router.service';
import { FlowEngineService } from './router/flow-engine.service';
import { MessageComposerService } from './render/message-composer.service';
import { NullWhatsAppAiPort, WHATSAPP_AI_PORT } from './ai/whatsapp-ai.port';

/**
 * WhatsApp channel — INBOUND half (webhook, router, conversational ESS).
 *
 * Deliberately a leaf: nothing else in the application imports it, which is
 * what lets it depend on McpModule (and therefore, transitively, on the domain
 * modules) without creating a cycle back through NotificationsModule.
 *
 * McpModule rather than CopilotModule is the important choice. CopilotModule
 * also provides the OpenRouter client and the agent loop, so importing it would
 * put an LLM dependency inside the path that is specifically required not to
 * have one. McpModule exports ToolCallerService, which is all this needs.
 */
@Module({
  imports: [
    TimezoneModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    McpModule,
    WhatsAppModule,
    EssActionsModule,
    ChannelVerificationModule,
    // The face detector lives behind this; the inbound path needs it for the
    // selfie challenge, and it is a leaf so nothing else inherits the weight.
    FaceRecognitionModule,
  ],
  controllers: [WhatsAppWebhookController, WhatsAppActionsController],
  providers: [
    WhatsAppSessionService,
    ChannelPrincipalService,
    WhatsAppPrincipalService,
    CommandRouterService,
    // Circular by nature: the processor starts flows, and a completed flow runs
    // its action back through the processor. Local to this module, and small.
    FlowEngineService,
    MessageComposerService,
    WhatsAppInboundService,
    WhatsAppFaceProofService,
    ChannelFaceVerificationService,
    WhatsAppInboundScheduler,
    // The seam exists; the AI does not.
    { provide: WHATSAPP_AI_PORT, useClass: NullWhatsAppAiPort },
  ],
  // EssActionsModule owns the catalogue now; re-export the module so any
  // consumer of this one still resolves ActionRegistryService.
  exports: [WhatsAppInboundService, EssActionsModule],
})
export class WhatsAppInboundModule {}
