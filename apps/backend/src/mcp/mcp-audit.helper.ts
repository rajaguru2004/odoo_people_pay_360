import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { getBranchContext } from '../common/branch/branch-context';
import { channelUserAgent, getActorChannel } from '../common/context/channel-context';
import { CopilotSettingsService } from '../copilot-settings/copilot-settings.service';
import { HrmPrincipal, McpToolDef, ToolOutcome } from './tool.types';

/** Mirrors AuditInterceptor.sanitize — substring match, case-insensitive. */
const SENSITIVE_KEYS = [
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'password_hash',
];

export function redactArgs(args: Record<string, any>): Record<string, any> {
  try {
    const clone = JSON.parse(JSON.stringify(args ?? {}));
    const walk = (obj: any) => {
      for (const key in obj) {
        if (SENSITIVE_KEYS.some((k) => key.toLowerCase().includes(k))) {
          obj[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          walk(obj[key]);
        }
      }
    };
    walk(clone);
    return clone;
  } catch {
    return { note: '[UNPARSABLE ARGS]' };
  }
}

@Injectable()
export class McpAuditHelper {
  constructor(
    private readonly audit: AuditService,
    private readonly settings: CopilotSettingsService,
  ) {}

  async log(
    def: McpToolDef,
    args: Record<string, any>,
    user: HrmPrincipal,
    outcome: ToolOutcome,
    startedAt: number,
    error?: unknown,
  ): Promise<void> {
    if (def.kind === 'read' && outcome === 'SUCCESS' && !(await this.auditReads())) return;

    const resourceId =
      def.resourceIdArg && typeof args?.[def.resourceIdArg] === 'string'
        ? (args[def.resourceIdArg] as string)
        : undefined;

    await this.audit.log({
      userId: user.id,
      action: 'MCP_TOOL',
      resourceType: def.auditResourceType,
      resourceId,
      newData: {
        tool: def.name,
        kind: def.kind,
        outcome,
        durationMs: Date.now() - startedAt,
        args: redactArgs(args),
        // Which interface the actor used. Defaults to 'web' so pre-existing
        // rows and untagged paths stay meaningful.
        channel: getActorChannel()?.channel ?? 'web',
        ...(error ? { error: (error as Error).message?.slice(0, 500) } : {}),
      },
      // NEVER put a phone number in ipAddress: it is Inet-typed, Postgres would
      // reject the INSERT, and AuditService.log swallows the error — silently
      // losing the row. The channel ref goes in userAgent instead.
      userAgent: channelUserAgent(),
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });
  }

  private async auditReads(): Promise<boolean> {
    return (await this.settings.get()).mcpAuditReads;
  }
}
