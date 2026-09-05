import { Injectable } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CopilotSettingsService } from '../../copilot-settings/copilot-settings.service';
import { parseMcpResult } from './schema-mapper';
import { AuthForwardContext, CopilotTool, CopilotToolTransport } from './tool-transport';

/**
 * Loopback MCP transport: connects to this backend's own /mcp endpoint,
 * forwarding the requesting user's Authorization and X-Branch-Id headers
 * verbatim so guards, RBAC, branch scoping and audit apply identically to
 * an external MCP client. The server is stateless, so a fresh client per
 * call is cheap and avoids session lifetime issues.
 */
@Injectable()
export class McpHttpToolTransport implements CopilotToolTransport {
  constructor(private readonly settings: CopilotSettingsService) {}

  private async url(): Promise<URL> {
    // Blank setting → derive from the server port. The server bind PORT is
    // legitimately an infra/env concern; the loopback override is dynamic.
    const configured = (await this.settings.get()).mcpLoopbackUrl?.trim();
    return new URL(configured || `http://127.0.0.1:${process.env.PORT ?? 3001}/mcp`);
  }

  private async withClient<T>(
    auth: AuthForwardContext,
    fn: (c: Client) => Promise<T>,
  ): Promise<T> {
    const transport = new StreamableHTTPClientTransport(await this.url(), {
      requestInit: {
        headers: {
          Authorization: auth.authorization,
          ...(auth.branchId ? { 'X-Branch-Id': auth.branchId } : {}),
        },
      },
    });
    const client = new Client({ name: 'hrm-copilot', version: '1.0.0' });
    try {
      await client.connect(transport);
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async listTools(auth: AuthForwardContext): Promise<CopilotTool[]> {
    return this.withClient(auth, async (c) => {
      const res = await c.listTools();
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    });
  }

  async callTool(
    auth: AuthForwardContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<any> {
    return this.withClient(auth, async (c) => {
      const res = await c.callTool({ name, arguments: args });
      return parseMcpResult(res);
    });
  }
}
