import { Module } from '@nestjs/common';
import { McpModule } from '../mcp/mcp.module';

/**
 * The ESS action catalogue, shared by every conversational channel.
 *
 * The catalogue mapped an action key to an MCP tool plus a confirm policy. It
 * lived with the chat channels that consumed it and went with them, so this
 * module currently registers nothing; it is the seam a future conversational
 * channel would hang its catalogue on.
 */
@Module({
  imports: [McpModule],
})
export class EssActionsModule {}
