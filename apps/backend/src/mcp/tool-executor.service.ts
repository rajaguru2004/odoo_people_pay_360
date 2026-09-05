import { HttpException, Injectable, Logger } from '@nestjs/common';
import { getBranchContext } from '../common/branch/branch-context';
import { CopilotSettingsService } from '../copilot-settings/copilot-settings.service';
import { buildPreviewEnvelope } from './confirm-gate';
import { IdEnricherService } from './id-enricher.service';
import { McpAuditHelper } from './mcp-audit.helper';
import { toToolJson } from './serialize';
import { HrmPrincipal, McpToolDef, ToolOutcome, ToolTextResult } from './tool.types';

/**
 * Uniform execution pipeline for every MCP tool call:
 * role check → self-scope → fail-closed branch assertion → confirm gate →
 * service invocation → audit → serialization. Domain errors surface as tool
 * error CONTENT (so the LLM can react), never as JSON-RPC protocol errors.
 */
@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger('McpTools');

  constructor(
    private readonly audit: McpAuditHelper,
    private readonly settings: CopilotSettingsService,
    private readonly enricher: IdEnricherService,
  ) {}

  async run(
    def: McpToolDef,
    rawArgs: Record<string, any>,
    user: HrmPrincipal,
  ): Promise<ToolTextResult> {
    const started = Date.now();
    let args = rawArgs ?? {};

    // 1. Role check (ANY-match — mirrors RolesGuard). Unauthorized tools are
    //    not even registered for the caller; this is defense-in-depth.
    if (!def.roles.includes(user.role)) {
      await this.auditWrite(def, args, user, 'DENIED', started);
      return this.err(403, 'Forbidden', `Your role (${user.role}) cannot use ${def.name}.`);
    }

    // 2. Self-scoping: restricted roles always target their own employee record.
    if (def.selfScope && def.selfScope.forRoles.includes(user.role)) {
      if (!user.employeeId) {
        return this.err(400, 'BadRequest', 'No employee profile is linked to your account.');
      }
      args = { ...args, [def.selfScope.param]: user.employeeId };
    }

    // 3. Fail-closed branch assertion: a branch-scoped principal must have a
    //    seeded ALS store — otherwise Prisma's $use backstop would silently
    //    run unscoped (fail-open). Refuse instead.
    if (!user.isGlobalBranchAccess && getBranchContext() === null) {
      this.logger.error(`branch context missing for ${def.name} — refusing to execute`);
      return this.err(500, 'BranchContextMissing', 'Server misconfiguration: branch scope unavailable.');
    }

    // 4. Confirm-first gate for every mutation; destructive tools have no bypass.
    if (def.kind !== 'read' && args.confirm !== true) {
      try {
        const preview = def.preview
          ? await def.preview(this.stripConfirm(args), user)
          : { arguments: this.stripConfirm(args) };
        await this.auditWrite(def, args, user, 'PREVIEW', started);
        // Resolve raw ids to names so the confirmation card reads human.
        const enrichedPreview = await this.enricher.enrich(toToolJson(preview));
        return this.ok(buildPreviewEnvelope(def, enrichedPreview));
      } catch (e) {
        return this.mapError(def, args, user, started, e);
      }
    }

    // 5. Invoke the domain service in-process.
    try {
      const result = await def.execute(this.stripConfirm(args), user);
      await this.auditWrite(def, args, user, 'SUCCESS', started);
      const maxItems = this.limitFrom(args) ?? (await this.settings.get()).mcpMaxItems;
      // Resolve raw foreign-key ids (employee/department/branch) to
      // names AFTER trimming, so we only look up what is actually returned.
      return this.ok(await this.enricher.enrich(toToolJson(result, { maxItems })));
    } catch (e) {
      return this.mapError(def, args, user, started, e);
    }
  }

  private async mapError(
    def: McpToolDef,
    args: Record<string, any>,
    user: HrmPrincipal,
    started: number,
    e: unknown,
  ): Promise<ToolTextResult> {
    await this.auditWrite(def, args, user, 'ERROR', started, e);
    if (e instanceof HttpException) {
      const r = e.getResponse() as any;
      const message =
        typeof r === 'string' ? r : Array.isArray(r?.message) ? r.message.join('; ') : (r?.message ?? e.message);
      return this.err(e.getStatus(), e.name, message);
    }
    this.logger.error(`tool ${def.name} failed: ${(e as Error).message}`, (e as Error).stack);
    return this.err(500, 'InternalError', 'Unexpected error executing the tool.');
  }

  /**
   * Audit off the hot path: fire-and-forget for reads and normal writes (removes
   * a remote-DB write RTT from every tool call), but AWAITED for destructive
   * tools so delete/finalize/lock always have a persisted trail before returning.
   * AuditService.log swallows its own errors, so a detached promise is safe.
   */
  private auditWrite(
    def: McpToolDef,
    args: Record<string, any>,
    user: HrmPrincipal,
    outcome: ToolOutcome,
    started: number,
    error?: unknown,
  ): Promise<void> | void {
    const p = this.audit.log(def, args, user, outcome, started, error).catch(() => undefined);
    if (def.kind === 'destructive') return p;
    return undefined;
  }

  private limitFrom(args: Record<string, any>): number | undefined {
    const v = Number(args?.limit);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }

  private stripConfirm(args: Record<string, any>): Record<string, any> {
    const { confirm: _confirm, ...rest } = args;
    return rest;
  }

  private ok(payload: unknown): ToolTextResult {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  private err(status: number, code: string, message: string): ToolTextResult {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: { status, code, message } }) }],
    };
  }
}
