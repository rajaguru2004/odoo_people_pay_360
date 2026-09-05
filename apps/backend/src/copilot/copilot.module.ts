import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { McpModule } from '../mcp/mcp.module';
import { AgentLoopService } from './agent/agent-loop.service';
import { CopilotRateLimitGuard } from './copilot-rate-limit.guard';
import { CopilotController } from './copilot.controller';
import { CopilotService } from './copilot.service';
import { OpenRouterToolsClient } from './llm/openrouter-tools.client';
import { InProcessToolTransport } from './mcp/in-process.transport';
import { McpHttpToolTransport } from './mcp/mcp-http.transport';
import { COPILOT_TOOL_TRANSPORT } from './mcp/tool-transport';

@Module({
  // McpModule exports the tool registry + executor for the in-process transport.
  imports: [AuditModule, McpModule],
  controllers: [CopilotController],
  providers: [
    CopilotService,
    AgentLoopService,
    OpenRouterToolsClient,
    CopilotRateLimitGuard,
    InProcessToolTransport,
    McpHttpToolTransport,
    {
      // Default: in-process (near-zero overhead). Set COPILOT_TOOL_TRANSPORT_MODE=http
      // to force the loopback MCP client (e.g. to dogfeed the external contract).
      provide: COPILOT_TOOL_TRANSPORT,
      useFactory: (
        config: ConfigService,
        inproc: InProcessToolTransport,
        http: McpHttpToolTransport,
      ) => (config.get('COPILOT_TOOL_TRANSPORT_MODE') === 'http' ? http : inproc),
      inject: [ConfigService, InProcessToolTransport, McpHttpToolTransport],
    },
  ],
})
export class CopilotModule {}
