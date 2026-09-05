import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainToolProvider, McpToolDef, MCP_TOOL_PROVIDERS, Role } from './tool.types';

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private tools: McpToolDef[] = [];

  constructor(
    @Inject(MCP_TOOL_PROVIDERS)
    private readonly providers: DomainToolProvider[],
  ) {}

  onModuleInit(): void {
    const all = this.providers.flatMap((p) => p.getTools());
    const seen = new Set<string>();
    for (const tool of all) {
      if (!TOOL_NAME_RE.test(tool.name)) {
        throw new Error(`MCP tool name '${tool.name}' must be snake_case (max 64 chars)`);
      }
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate MCP tool name '${tool.name}'`);
      }
      if (!tool.description?.trim()) {
        throw new Error(`MCP tool '${tool.name}' is missing a description`);
      }
      if (!tool.roles?.length) {
        throw new Error(`MCP tool '${tool.name}' declares no roles`);
      }
      seen.add(tool.name);
    }
    this.tools = all;
  }

  getAll(): McpToolDef[] {
    return this.tools;
  }

  getByName(name: string): McpToolDef | undefined {
    return this.tools.find((t) => t.name === name);
  }

  toolsForRole(role: Role): McpToolDef[] {
    return this.tools.filter((t) => t.roles.includes(role));
  }
}
