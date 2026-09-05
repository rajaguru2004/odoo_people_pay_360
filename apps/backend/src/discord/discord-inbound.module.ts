import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ChannelPrincipalService } from '../common/channel/channel-principal.service';
import { EssActionsModule } from '../ess-actions/ess-actions.module';
import { McpModule } from '../mcp/mcp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { DiscordCheckinController } from './checkin/discord-checkin.controller';
import { ChannelVerificationModule } from '../common/verification/channel-verification.module';
import { DiscordModule } from './discord.module';
import { DiscordInteractionsController } from './interactions/discord-interactions.controller';
import { DiscordInteractionService } from './interactions/discord-interaction.service';
import { DiscordCommandsController } from './interactions/discord-commands.controller';

/**
 * Discord channel — INBOUND half (slash commands).
 *
 * A leaf, exactly like WhatsAppInboundModule: nothing imports it, which is what
 * lets it depend on McpModule (and transitively the domain modules) without a
 * cycle back through NotificationsModule.
 *
 * EssActionsModule supplies the SHARED action catalogue — the same instance the
 * WhatsApp router uses — so an action added once is available on both channels
 * under the same role, tool and confirm rules.
 */
@Module({
  imports: [ChannelVerificationModule, TimezoneModule, PrismaModule, AuditModule, AuthModule, McpModule, EssActionsModule, DiscordModule],
  controllers: [DiscordInteractionsController, DiscordCommandsController, DiscordCheckinController],
  providers: [ChannelPrincipalService, DiscordInteractionService],
  exports: [DiscordInteractionService],
})
export class DiscordInboundModule {}
