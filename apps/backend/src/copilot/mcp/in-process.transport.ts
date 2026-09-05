import { Injectable } from '@nestjs/common';
import { ToolCallerService } from '../../mcp/tool-caller.service';
import { ToolRegistryService } from '../../mcp/tool-registry.service';
import { Role } from '../../mcp/tool.types';
import { AuthForwardContext, CopilotTool, CopilotToolTransport } from './tool-transport';

/**
 * Calls the MCP tool registry/executor DIRECTLY (same process) instead of over
 * a loopback HTTP hop. Eliminates, per tool call: a fresh MCP client + handshake,
 * a per-request McpServer build (~56 registerTool), and a re-authentication DB
 * lookup. Branch scope, RBAC, self-scope, confirm-gate, audit and validation all
 * still run — they live inside ToolExecutorService, which runs within the same
 * /copilot request's AsyncLocalStorage branch context.
 *
 * The call pipeline itself now lives in ToolCallerService so the WhatsApp
 * channel can reuse it without importing CopilotModule (and with it, the LLM
 * client). This class keeps the CopilotToolTransport contract and the per-role
 * tool-list cache.
 */
@Injectable()
export class InProcessToolTransport implements CopilotToolTransport {
  private toolListCache = new Map<Role, CopilotTool[]>();

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly caller: ToolCallerService,
  ) {}

  async listTools(auth: AuthForwardContext): Promise<CopilotTool[]> {
    const role = auth.user!.role;
    const cached = this.toolListCache.get(role);
    if (cached) return cached;

    const tools: CopilotTool[] = this.registry.toolsForRole(role).map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: this.caller.toJsonSchema(def),
    }));
    this.toolListCache.set(role, tools);
    return tools;
  }

  async callTool(
    auth: AuthForwardContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<any> {
    return this.caller.call(auth.user!, name, args);
  }
}
