import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolExecutorService } from './tool-executor.service';
import { ToolRegistryService } from './tool-registry.service';
import { HrmPrincipal } from './tool.types';

/**
 * Builds a per-request, per-user McpServer (stateless transport). Only tools
 * the caller's role allows are registered, so tools/list is auto-filtered.
 */
@Injectable()
export class McpServerFactory {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly executor: ToolExecutorService,
  ) {}

  build(user: HrmPrincipal): McpServer {
    const server = new McpServer({ name: 'hrm-mcp', version: '1.0.0' });

    for (const def of this.registry.toolsForRole(user.role)) {
      const inputSchema =
        def.kind === 'read'
          ? def.inputSchema
          : {
              ...def.inputSchema,
              confirm: z
                .boolean()
                .optional()
                .describe(
                  'Write confirmation. Omit or false to get a preview only. Set true to execute after the user approved the preview.',
                ),
            };

      server.registerTool(
        def.name,
        {
          description: def.description,
          inputSchema,
          annotations: {
            readOnlyHint: def.kind === 'read',
            destructiveHint: def.kind === 'destructive',
            idempotentHint: false,
          },
        },
        (async (args: Record<string, any>) => this.executor.run(def, args, user)) as any,
      );
    }

    return server;
  }
}
