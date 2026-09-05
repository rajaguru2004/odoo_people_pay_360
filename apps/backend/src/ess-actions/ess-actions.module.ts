import { Module } from '@nestjs/common';
import { McpModule } from '../mcp/mcp.module';
import { ActionRegistryService } from '../whatsapp/router/action-registry.service';

/**
 * The ESS action catalogue, shared by every conversational channel.
 *
 * ActionRegistryService maps an action key to an MCP tool plus a confirm
 * policy, and validates the whole set at boot. None of that is WhatsApp
 * specific — it is the answer to "what can a chat channel do, and under what
 * rules" — so WhatsApp and Discord consume the same instance rather than each
 * registering their own and drifting apart.
 *
 * The class still lives under whatsapp/router/ to keep this change small; it is
 * the catalogue's home, not its owner.
 */
@Module({
  imports: [McpModule],
  providers: [ActionRegistryService],
  exports: [ActionRegistryService],
})
export class EssActionsModule {}
