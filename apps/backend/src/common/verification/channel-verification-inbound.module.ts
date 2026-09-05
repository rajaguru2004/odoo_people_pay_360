import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { FaceRecognitionModule } from '../../face-recognition/face-recognition.module';
import { McpModule } from '../../mcp/mcp.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ChannelPrincipalService } from '../channel/channel-principal.service';
import { ChannelVerificationModule } from './channel-verification.module';
import { ChannelVerificationController } from './channel-verification.controller';
import { VerifyPageController } from './verify-page.controller';
import { ChannelFaceVerificationService } from './channel-face-verification.service';
import { WhatsAppModule } from '../../whatsapp/whatsapp.module';
import { DiscordModule } from '../../discord/discord.module';
import { TimezoneModule } from '../timezone/timezone.module';

/**
 * The browser half of channel verification.
 *
 * A LEAF, like WhatsAppInboundModule and DiscordInboundModule, and for the same
 * reason: nothing imports it, which is what lets it depend on McpModule and on
 * FaceRecognitionModule at once. Putting either of those inside the token
 * module would drag a TensorFlow model into the graph every tool call runs
 * through.
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    McpModule,
    FaceRecognitionModule,
    ChannelVerificationModule,
    // The outbox sinks, so the page's outcome lands back in the chat it
    // started from. Both are cycle-safe from a leaf.
    WhatsAppModule,
    DiscordModule,
    TimezoneModule,
  ],
  controllers: [ChannelVerificationController, VerifyPageController],
  providers: [ChannelPrincipalService, ChannelFaceVerificationService],
})
export class ChannelVerificationInboundModule {}
