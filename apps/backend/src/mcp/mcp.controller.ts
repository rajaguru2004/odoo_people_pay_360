import { Body, Controller, Delete, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CopilotSettingsService } from '../copilot-settings/copilot-settings.service';
import { McpServerFactory } from './mcp-server.factory';
import type { HrmPrincipal } from './tool.types';

/**
 * Stateless MCP endpoint (Streamable HTTP). Every POST is an ordinary
 * authenticated Nest request, so BranchContextMiddleware + JwtAuthGuard +
 * BranchContextInterceptor all run first — tool handlers execute inside this
 * request's async context and inherit branch scoping automatically.
 *
 * Deliberately NOT decorated with @AuditResource: tool-level audit rows
 * (action 'MCP_TOOL') replace the HTTP-level audit interceptor here.
 */
@ApiExcludeController()
@Controller('mcp')
@UseGuards(JwtAuthGuard)
export class McpController {
  constructor(
    private readonly factory: McpServerFactory,
    private readonly settings: CopilotSettingsService,
  ) {}

  @Post()
  async handle(
    @Req() req: any,
    @Res() res: any,
    @Body() body: unknown,
    @CurrentUser() user: HrmPrincipal,
  ) {
    if (!(await this.settings.get()).mcpEnabled) {
      return res.status(404).json(this.rpcError(-32601, 'MCP is disabled'));
    }

    const server = this.factory.build(user);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no Mcp-Session-Id
      enableJsonResponse: true, // plain JSON responses; no SSE stream needed for tools-only
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json(this.rpcError(-32603, 'Internal server error'));
      }
    }
  }

  @Get()
  notAllowedGet(@Res() res: any) {
    res.status(405).json(this.rpcError(-32000, 'Method not allowed. Stateless server: POST only.'));
  }

  @Delete()
  notAllowedDelete(@Res() res: any) {
    res.status(405).json(this.rpcError(-32000, 'Method not allowed. Stateless server: POST only.'));
  }

  private rpcError(code: number, message: string) {
    return { jsonrpc: '2.0', error: { code, message }, id: null };
  }
}
