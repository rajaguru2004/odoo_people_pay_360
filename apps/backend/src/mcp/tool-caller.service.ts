import { Injectable } from '@nestjs/common';
import { z, ZodObject } from 'zod';
import { ToolExecutorService } from './tool-executor.service';
import { ToolRegistryService } from './tool-registry.service';
import { HrmPrincipal, McpToolDef } from './tool.types';

const CONFIRM_FIELD = z
  .boolean()
  .optional()
  .describe('Write confirmation. Omit or false to get a preview only. Set true to execute.');

/**
 * Call an MCP tool by name, in-process, with the same validation the HTTP
 * transport applies.
 *
 * Extracted from `copilot/mcp/in-process.transport.ts` so a non-LLM caller can
 * reuse it without depending on CopilotModule — which also provides the
 * OpenRouter client and the agent loop, i.e. exactly the LLM coupling such a
 * caller is required not to have.
 *
 * Everything that makes a tool call safe still happens inside
 * ToolExecutorService: role check, self-scope injection, the fail-closed branch
 * assertion, the confirm gate, and the audit row. This class only adds argument
 * validation and unwraps the text envelope.
 */
@Injectable()
export class ToolCallerService {
  private validators = new Map<string, ZodObject<any>>();

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly executor: ToolExecutorService,
  ) {}

  /**
   * Returns the tool's decoded JSON payload, or an `{ error: {...} }` envelope.
   * Never throws for an unknown tool or bad arguments — those are results, not
   * exceptions, so a caller can render them to a user.
   */
  async call(
    user: HrmPrincipal,
    name: string,
    args: Record<string, unknown>,
  ): Promise<any> {
    const def = this.registry.getByName(name);
    if (!def) {
      return { error: { status: 404, code: 'UnknownTool', message: `Unknown tool: ${name}` } };
    }

    // Replicates the SDK's pre-handler schema validation (strips unknown keys,
    // rejects malformed args) so in-process behaviour matches HTTP exactly.
    const parsed = this.validatorFor(def).safeParse(args ?? {});
    if (!parsed.success) {
      return {
        error: {
          status: 400,
          code: 'ValidationError',
          message: parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
        },
      };
    }

    const res = await this.executor.run(def, parsed.data, user);
    try {
      return JSON.parse(res.content[0].text);
    } catch {
      return { error: { status: 500, code: 'ParseError', message: 'Malformed tool output' } };
    }
  }

  /** zod v4 native JSON Schema (the SDK produced the same over HTTP). */
  toJsonSchema(def: McpToolDef): any {
    try {
      return z.toJSONSchema(this.validatorFor(def), { unrepresentable: 'any' });
    } catch {
      return { type: 'object', properties: {} };
    }
  }

  validatorFor(def: McpToolDef): ZodObject<any> {
    let v = this.validators.get(def.name);
    if (!v) {
      const shape =
        def.kind === 'read' ? def.inputSchema : { ...def.inputSchema, confirm: CONFIRM_FIELD };
      v = z.object(shape);
      this.validators.set(def.name, v);
    }
    return v;
  }
}
