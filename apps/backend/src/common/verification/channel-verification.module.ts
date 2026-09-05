import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ChannelVerificationTokenService } from './channel-verification-token.service';

/**
 * The verification capability, shared by every conversational channel.
 *
 * Depends on nothing but Prisma, which is what lets McpModule import it — the
 * attendance tools need `spendFaceProof`, and anything heavier in this graph
 * would put a cycle between the tool layer and the channels that call it.
 */
@Module({
  imports: [PrismaModule],
  providers: [ChannelVerificationTokenService],
  exports: [ChannelVerificationTokenService],
})
export class ChannelVerificationModule {}
