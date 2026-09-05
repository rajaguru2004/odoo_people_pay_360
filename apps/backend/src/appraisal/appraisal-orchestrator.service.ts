import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ZodOptional, ZodTypeAny } from 'zod';
import {
  BranchContext,
  runWithBranchStore,
  setBranchContext,
} from '../common/branch/branch-context';
import { OpenRouterToolsClient } from '../copilot/llm/openrouter-tools.client';
import { InProcessToolTransport } from '../copilot/mcp/in-process.transport';
import { ToolRegistryService } from '../mcp/tool-registry.service';
import { HrmPrincipal, McpToolDef } from '../mcp/tool.types';
import { PrismaService } from '../prisma/prisma.service';
import { AppraisalEventsService } from './appraisal-events.service';
import {
  DiscoveredEmployee,
  EmployeeAnalysis,
  RunPeriod,
  ScoreSet,
  ToolPlan,
} from './appraisal.types';
import {
  buildAnalysisMessages,
  buildPlanningMessages,
  buildSynthesisMessages,
  extractJson,
} from './prompts';
import {
  assignRanks,
  blendScores,
  clamp,
  computeOverall,
  DEFAULT_WEIGHTS,
  deterministicScores,
  fallbackRecommendation,
} from './scoring';

const EMPLOYEE_CONCURRENCY = 2;
const MAX_EMPLOYEES = 200;
const MAX_RUN_MS = 30 * 60_000;
const TOOL_PAYLOAD_CAP = 4_000;

/** Tools the collection phase always falls back to when planning fails. */
const DEFAULT_PLAN_TOOLS = [
  'attendance_employee_summary',
  'leave_employee_summary',
  'overtime_employee_summary',
  'task_employee_stats',
  'project_contribution_get',
  'worklog_employee_summary',
  'timesheet_employee_summary',
  'reimbursement_employee_summary',
  'conduct_records_get',
  'team_membership_get',
];

/** Plain-language names for tools when they surface in user-facing log lines. */
const TOOL_FRIENDLY: Record<string, string> = {
  employee_get: 'profile',
  attendance_employee_summary: 'attendance',
  leave_employee_summary: 'leave',
  overtime_employee_summary: 'overtime',
  task_employee_stats: 'tasks',
  project_contribution_get: 'projects',
  worklog_employee_summary: 'work hours',
  timesheet_employee_summary: 'timesheets',
  reimbursement_employee_summary: 'expense claims',
  conduct_records_get: 'conduct records',
  team_membership_get: 'team involvement',
};

const PHASE_LABELS: Record<string, string> = {
  init: 'Initializing Appraisal Agent...',
  discover: 'Discovering employees...',
  plan: 'Planning data collection strategy...',
  collect: 'Gathering evidence across HR systems...',
  analyze: 'Generating employee insights...',
  rank: 'Ranking employees...',
  synthesize: 'Preparing final appraisal report...',
  finalize: 'Finalizing...',
};

/**
 * The autonomous appraisal engine. One background run = plan (LLM picks the
 * MCP tools) → collect (real, audited, branch-scoped tool calls per employee)
 * → analyze (one structured LLM evaluation per employee, deterministic
 * fallback) → rank (reproducible weighted scores) → synthesize (org-level
 * executive summary). Every step is emitted as a persisted progress event.
 */
@Injectable()
export class AppraisalOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(AppraisalOrchestratorService.name);
  private readonly cancelRequests = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ToolRegistryService,
    private readonly transport: InProcessToolTransport,
    private readonly llm: OpenRouterToolsClient,
    private readonly events: AppraisalEventsService,
  ) {}

  /** Runs interrupted by a server restart can never finish — mark them. */
  async onModuleInit(): Promise<void> {
    const swept = await this.prisma.appraisalRun.updateMany({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'FAILED', error: 'Server restarted while the run was in progress.' },
    });
    if (swept.count) this.logger.warn(`marked ${swept.count} stale appraisal run(s) as FAILED`);
  }

  requestCancel(runId: string): void {
    this.cancelRequests.add(runId);
  }

  /** Fire-and-forget entrypoint — re-establishes the caller's branch scope. */
  launch(runId: string, user: HrmPrincipal, branchCtx: BranchContext | null): void {
    void runWithBranchStore(async () => {
      setBranchContext(branchCtx);
      await this.run(runId, user).catch(async (e) => {
        this.logger.error(`appraisal run ${runId} crashed: ${(e as Error).message}`, (e as Error).stack);
        await this.finishRun(runId, 'FAILED', (e as Error).message);
      });
    });
  }

  private async run(runId: string, user: HrmPrincipal): Promise<void> {
    const deadline = Date.now() + MAX_RUN_MS;
    const run = await this.prisma.appraisalRun.update({
      where: { id: runId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    const period: RunPeriod = {
      start: run.periodStart,
      end: run.periodEnd,
      label: run.periodLabel ?? 'Custom period',
    };

    await this.phase(runId, 'init');
    await this.events.emit(runId, 'log', {
      text: `Appraisal period: ${iso(period.start)} → ${iso(period.end)} (${period.label}).`,
    });

    // ---- discover -----------------------------------------------------------
    await this.phase(runId, 'discover');
    const employees = await this.discoverEmployees(run);
    if (!employees.length) {
      await this.finishRun(runId, 'FAILED', 'No active employees matched the run scope.');
      return;
    }
    await this.prisma.appraisalRun.update({
      where: { id: runId },
      data: { totalEmployees: employees.length },
    });
    await this.events.emit(runId, 'log', {
      text: `Found ${employees.length} active employee(s) in scope.`,
    });
    await this.events.emit(runId, 'progress', {
      completed: 0,
      total: employees.length,
      phase: 'discover',
    });
    if (await this.bailIfCancelled(runId)) return;

    // ---- plan ---------------------------------------------------------------
    await this.phase(runId, 'plan');
    const usable = this.usableTools(user, period);
    const plan = await this.planTools(runId, usable, period, employees.length);
    await this.prisma.appraisalRun.update({
      where: { id: runId },
      data: { toolPlanJson: plan as any, weightsJson: DEFAULT_WEIGHTS as any },
    });
    const reviewAreas = plan.tools.map((t) => TOOL_FRIENDLY[t.tool] ?? 'records');
    await this.events.emit(runId, 'log', {
      text: `Review plan ready — will check ${[...new Set(reviewAreas)].join(', ')} for every employee.`,
    });
    if (await this.bailIfCancelled(runId)) return;

    // ---- collect + analyze (pipelined per employee) --------------------------
    await this.phase(runId, 'collect');
    const results: Array<{
      employeeId: string;
      departmentId: string | null;
      overall: number;
    }> = [];
    let completed = 0;
    let toolCalls = 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.cancelRequests.has(runId) || Date.now() > deadline) return;
        const i = cursor++;
        if (i >= employees.length) return;
        const emp = employees[i];
        try {
          const { collected, calls } = await this.collectForEmployee(runId, emp, period, plan, user);
          toolCalls += calls;
          const analysis = await this.analyzeEmployee(runId, emp, period, collected);
          const saved = await this.saveResult(runId, emp, collected, analysis);
          results.push({
            employeeId: emp.id,
            departmentId: emp.departmentId,
            overall: saved.overall,
          });
          completed += 1;
          await this.prisma.appraisalRun.update({
            where: { id: runId },
            data: { completedEmployees: completed, toolCallCount: toolCalls },
          });
          await this.events.emit(runId, 'employee_completed', {
            employeeId: emp.id,
            name: emp.fullName,
            department: emp.departmentName,
            overallScore: saved.overall,
            recommendation: saved.recommendation,
            degraded: analysis.degraded,
          });
          await this.events.emit(runId, 'progress', {
            completed,
            total: employees.length,
            phase: 'analyze',
          });
        } catch (e) {
          this.logger.warn(`employee ${emp.employeeCode} failed: ${(e as Error).message}`);
          await this.prisma.appraisalResult.create({
            data: {
              runId,
              employeeId: emp.id,
              employeeCode: emp.employeeCode,
              employeeName: emp.fullName,
              position: emp.position,
              departmentId: emp.departmentId,
              departmentName: emp.departmentName,
              status: 'FAILED',
              error: (e as Error).message?.slice(0, 500),
            },
          });
          await this.events.emit(runId, 'employee_failed', {
            employeeId: emp.id,
            name: emp.fullName,
            error: (e as Error).message?.slice(0, 200),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(EMPLOYEE_CONCURRENCY, employees.length) }, worker),
    );
    if (await this.bailIfCancelled(runId)) return;
    if (Date.now() > deadline) {
      await this.finishRun(runId, 'FAILED', 'Run exceeded the maximum allowed duration.');
      return;
    }
    if (!results.length) {
      await this.finishRun(runId, 'FAILED', 'Every employee evaluation failed.');
      return;
    }

    // ---- rank ---------------------------------------------------------------
    await this.phase(runId, 'rank');
    const ranks = assignRanks(results);
    for (const r of results) {
      const rank = ranks.get(r.employeeId);
      if (!rank) continue;
      await this.prisma.appraisalResult.updateMany({
        where: { runId, employeeId: r.employeeId },
        data: { rankOverall: rank.rankOverall, rankDepartment: rank.rankDepartment },
      });
    }
    const top = [...results].sort((a, b) => b.overall - a.overall).slice(0, 3);
    const topNames = top.map(
      (t) => employees.find((e) => e.id === t.employeeId)?.fullName ?? 'unknown',
    );
    await this.events.emit(runId, 'log', {
      text: `Rankings computed. Top performers: ${topNames.join(', ')}.`,
    });

    // ---- synthesize ----------------------------------------------------------
    await this.phase(runId, 'synthesize');
    await this.synthesize(runId, period, employees);

    // ---- finalize ------------------------------------------------------------
    await this.phase(runId, 'finalize');
    await this.finishRun(runId, 'COMPLETED');
  }

  // === phase helpers =========================================================

  private async phase(runId: string, phase: string): Promise<void> {
    await this.prisma.appraisalRun
      .update({ where: { id: runId }, data: { currentPhase: phase } })
      .catch(() => undefined);
    await this.events.emit(runId, 'phase', { phase, label: PHASE_LABELS[phase] ?? phase });
  }

  private async bailIfCancelled(runId: string): Promise<boolean> {
    if (!this.cancelRequests.has(runId)) return false;
    await this.finishRun(runId, 'CANCELLED');
    return true;
  }

  private async finishRun(runId: string, status: string, error?: string): Promise<void> {
    this.cancelRequests.delete(runId);
    await this.prisma.appraisalRun
      .update({
        where: { id: runId },
        data: { status, error: error ?? null, completedAt: new Date() },
      })
      .catch(() => undefined);
    await this.events
      .emit(runId, status === 'FAILED' ? 'error' : 'final', {
        runId,
        status,
        ...(error ? { message: error } : {}),
      })
      .catch(() => undefined);
    if (status === 'FAILED') {
      await this.events.emit(runId, 'final', { runId, status }).catch(() => undefined);
    }
    this.events.release(runId);
  }

  // === discover ==============================================================

  private async discoverEmployees(run: {
    branchId: string | null;
    scopeJson: any;
    periodEnd: Date;
  }): Promise<DiscoveredEmployee[]> {
    const scope = (run.scopeJson ?? {}) as { departmentIds?: string[]; employeeIds?: string[] };
    const rows = await this.prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
        startDate: { lte: run.periodEnd },
        ...(run.branchId ? { branchId: run.branchId } : {}),
        ...(scope.departmentIds?.length ? { departmentId: { in: scope.departmentIds } } : {}),
        ...(scope.employeeIds?.length ? { id: { in: scope.employeeIds } } : {}),
      },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        position: true,
        departmentId: true,
        startDate: true,
        department: { select: { name: true } },
      },
      orderBy: { fullName: 'asc' },
      take: MAX_EMPLOYEES,
    });
    return rows.map((r) => ({
      id: r.id,
      employeeCode: r.employeeCode,
      fullName: r.fullName,
      position: r.position,
      departmentId: r.departmentId,
      departmentName: r.department?.name ?? null,
      startDate: r.startDate,
    }));
  }

  // === plan ==================================================================

  /** Read-only tools whose arguments we can derive from (employee, period). */
  private usableTools(user: HrmPrincipal, period: RunPeriod): McpToolDef[] {
    return this.registry
      .toolsForRole(user.role)
      .filter((t) => t.kind === 'read')
      .filter((t) => this.buildArgs(t, SAMPLE_EMPLOYEE_ID, period) !== null);
  }

  private async planTools(
    runId: string,
    usable: McpToolDef[],
    period: RunPeriod,
    employeeCount: number,
  ): Promise<ToolPlan> {
    const usableNames = new Set(usable.map((t) => t.name));
    const fallback: ToolPlan = {
      source: 'default',
      tools: DEFAULT_PLAN_TOOLS.filter((t) => usableNames.has(t)).map((tool) => ({ tool })),
    };
    try {
      const messages = buildPlanningMessages(
        usable.map((t) => ({ name: t.name, description: t.description })),
        period,
        employeeCount,
      );
      const { message } = await this.llm.complete({ messages, tools: [] });
      const parsed = extractJson(message.content);
      const tools = (Array.isArray(parsed?.tools) ? parsed.tools : [])
        .filter((t: any) => typeof t?.tool === 'string' && usableNames.has(t.tool))
        .map((t: any) => ({ tool: t.tool as string, reason: t.reason as string | undefined }));
      const unique = [...new Map(tools.map((t: any) => [t.tool, t])).values()] as ToolPlan['tools'];
      if (unique.length >= 4) return { source: 'ai', tools: unique.slice(0, 14) };
      await this.events.emit(runId, 'log', {
        text: 'Agent plan too small — falling back to the standard evidence set.',
      });
      return fallback;
    } catch (e) {
      this.logger.warn(`planning LLM failed: ${(e as Error).message}`);
      await this.events.emit(runId, 'log', {
        text: 'Planning model unavailable — using the standard evidence set.',
      });
      return fallback;
    }
  }

  /**
   * Derive concrete args for a tool from (employee, period) via its zod shape.
   * Returns null when a required argument cannot be derived (tool unusable
   * for autonomous collection).
   */
  private buildArgs(
    def: McpToolDef,
    employeeId: string,
    period: RunPeriod,
  ): Record<string, unknown> | null {
    const args: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(def.inputSchema)) {
      const optional = (schema as ZodTypeAny) instanceof ZodOptional || (schema as ZodTypeAny).isOptional();
      switch (key) {
        case 'employeeId':
          args.employeeId = employeeId;
          break;
        case 'startDate':
          args.startDate = iso(period.start);
          break;
        case 'endDate':
          args.endDate = iso(period.end);
          break;
        case 'month':
          args.month = period.end.getUTCMonth() + 1;
          break;
        case 'year':
          args.year = period.end.getUTCFullYear();
          break;
        case 'id':
          if (def.name === 'employee_get') args.id = employeeId;
          else if (!optional) return null;
          break;
        default:
          if (!optional) return null;
      }
    }
    return args;
  }

  // === collect ===============================================================

  private async collectForEmployee(
    runId: string,
    emp: DiscoveredEmployee,
    period: RunPeriod,
    plan: ToolPlan,
    user: HrmPrincipal,
  ): Promise<{ collected: Record<string, any>; calls: number }> {
    await this.events.emit(runId, 'employee_started', {
      employeeId: emp.id,
      name: emp.fullName,
      department: emp.departmentName,
      position: emp.position,
    });
    const collected: Record<string, any> = {};
    let calls = 0;
    for (const planned of plan.tools) {
      const def = this.registry.getByName(planned.tool);
      if (!def) continue;
      const args = this.buildArgs(def, emp.id, period);
      if (!args) continue;
      const started = Date.now();
      await this.events.emit(runId, 'tool_call', {
        phase: 'started',
        tool: def.name,
        employeeId: emp.id,
        employeeName: emp.fullName,
      });
      let ok = true;
      let summary: string;
      try {
        const result = await this.transport.callTool(
          { authorization: '', user },
          def.name,
          args,
        );
        calls += 1;
        if (result?.error) {
          ok = false;
          summary = String(result.error.message ?? result.error).slice(0, 120);
        } else {
          collected[def.name] = trimPayload(result);
          summary = summarizePayload(result);
        }
      } catch (e) {
        ok = false;
        calls += 1;
        summary = (e as Error).message?.slice(0, 120) ?? 'tool failed';
      }
      await this.events.emit(runId, 'tool_call', {
        phase: 'finished',
        tool: def.name,
        employeeId: emp.id,
        employeeName: emp.fullName,
        ok,
        durationMs: Date.now() - started,
        resultSummary: summary,
      });
    }
    return { collected, calls };
  }

  // === analyze ===============================================================

  private async analyzeEmployee(
    runId: string,
    emp: DiscoveredEmployee,
    period: RunPeriod,
    collected: Record<string, any>,
  ): Promise<EmployeeAnalysis> {
    const baseline = deterministicScores(collected);
    const messages = buildAnalysisMessages(emp, period, collected, baseline);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { message } = await this.llm.complete({
          messages:
            attempt === 0
              ? messages
              : [
                  ...messages,
                  {
                    role: 'user',
                    content: 'Your previous answer was not valid JSON. Return ONLY the JSON object.',
                  },
                ],
          tools: [],
        });
        const parsed = extractJson(message.content);
        if (!parsed?.scores) continue;
        const scores = blendScores(baseline, sanitizeScores(parsed.scores));
        return {
          scores,
          strengths: strList(parsed.strengths),
          improvements: strList(parsed.improvements),
          risks: strList(parsed.risks),
          summary:
            typeof parsed.summary === 'string' && parsed.summary.trim()
              ? parsed.summary.trim()
              : fallbackSummary(emp, scores),
          recommendation: isRecommendation(parsed.recommendation)
            ? parsed.recommendation
            : fallbackRecommendation(computeOverall(scores, DEFAULT_WEIGHTS)),
          degraded: false,
        };
      } catch (e) {
        this.logger.warn(
          `analysis LLM failed for ${emp.employeeCode} (attempt ${attempt + 1}): ${(e as Error).message}`,
        );
      }
    }

    // Deterministic fallback — the run keeps going without the LLM.
    const scores = blendScores(baseline, null);
    return {
      scores,
      strengths: [],
      improvements: [],
      risks: [],
      summary: fallbackSummary(emp, scores),
      recommendation: fallbackRecommendation(computeOverall(scores, DEFAULT_WEIGHTS)),
      degraded: true,
    };
  }

  private async saveResult(
    runId: string,
    emp: DiscoveredEmployee,
    collected: Record<string, any>,
    analysis: EmployeeAnalysis,
  ): Promise<{ overall: number; recommendation: string }> {
    const overall = computeOverall(analysis.scores, DEFAULT_WEIGHTS);
    const scores = { ...analysis.scores, overall };
    await this.prisma.appraisalResult.create({
      data: {
        runId,
        employeeId: emp.id,
        employeeCode: emp.employeeCode,
        employeeName: emp.fullName,
        position: emp.position,
        departmentId: emp.departmentId,
        departmentName: emp.departmentName,
        scoresJson: scores as any,
        strengthsJson: analysis.strengths as any,
        improvementsJson: analysis.improvements as any,
        risksJson: analysis.risks as any,
        summary: analysis.summary,
        recommendation: analysis.recommendation,
        metricsJson: collected as any,
        toolCallCount: Object.keys(collected).length,
        status: analysis.degraded ? 'DEGRADED' : 'COMPLETED',
      },
    });
    return { overall, recommendation: analysis.recommendation };
  }

  // === synthesize ============================================================

  private async synthesize(
    runId: string,
    period: RunPeriod,
    employees: DiscoveredEmployee[],
  ): Promise<void> {
    const rows = await this.prisma.appraisalResult.findMany({
      where: { runId, status: { in: ['COMPLETED', 'DEGRADED'] } },
      orderBy: { rankOverall: 'asc' },
    });
    const ranked = rows.map((r) => ({
      name: r.employeeName,
      department: r.departmentName,
      overall: (r.scoresJson as any)?.overall ?? 0,
      recommendation: r.recommendation,
    }));
    const byDept = new Map<string, { total: number; count: number }>();
    for (const r of ranked) {
      const key = r.department ?? 'Unassigned';
      const agg = byDept.get(key) ?? { total: 0, count: 0 };
      agg.total += r.overall;
      agg.count += 1;
      byDept.set(key, agg);
    }
    const departments = [...byDept.entries()]
      .map(([department, { total, count }]) => ({
        department,
        avgScore: Math.round(total / count),
        count,
      }))
      .sort((a, b) => b.avgScore - a.avgScore);

    let executiveSummary =
      `AI appraisal of ${ranked.length} employee(s) for ${period.label}. ` +
      `Top performer: ${ranked[0]?.name ?? 'n/a'}. ` +
      `Strongest department: ${departments[0]?.department ?? 'n/a'}.`;
    let orgInsights: any = { departmentInsights: [], organizationInsights: [], needsAttention: [] };
    // Two attempts with a pause — free-tier providers rate-limit right after
    // the burst of per-employee analysis calls.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { message } = await this.llm.complete({
          messages: buildSynthesisMessages(period, ranked, departments),
          tools: [],
        });
        const parsed = extractJson(message.content);
        if (parsed?.executiveSummary) {
          executiveSummary = String(parsed.executiveSummary);
          orgInsights = {
            departmentInsights: Array.isArray(parsed.departmentInsights)
              ? parsed.departmentInsights
              : [],
            organizationInsights: strList(parsed.organizationInsights),
            needsAttention: strList(parsed.needsAttention),
          };
        }
        break;
      } catch (e) {
        this.logger.warn(`synthesis LLM failed (attempt ${attempt + 1}): ${(e as Error).message}`);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 8_000));
      }
    }
    orgInsights.departmentAverages = departments;
    const models = await this.llm.models().catch(() => []);
    await this.prisma.appraisalRun.update({
      where: { id: runId },
      data: {
        executiveSummary,
        orgInsightsJson: orgInsights,
        model: models[0] ?? null,
      },
    });
    await this.events.emit(runId, 'log', { text: 'Executive summary ready.' });
    void employees;
  }
}

// === module-private helpers ==================================================

const SAMPLE_EMPLOYEE_ID = '00000000-0000-0000-0000-000000000000';

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function trimPayload(payload: any): any {
  const json = JSON.stringify(payload);
  if (json.length <= TOOL_PAYLOAD_CAP) return payload;
  return { truncated: true, preview: json.slice(0, TOOL_PAYLOAD_CAP) };
}

function summarizePayload(result: any): string {
  const data = Array.isArray(result) ? result : result?.data;
  if (Array.isArray(data)) return `${data.length} rows`;
  const json = JSON.stringify(result);
  return json.length > 100 ? `${json.slice(0, 97)}...` : json;
}

function sanitizeScores(raw: any): ScoreSet {
  const out: ScoreSet = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (Number.isFinite(n)) (out as any)[k] = clamp(n);
    }
  }
  return out;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string').slice(0, 10) : [];
}

function isRecommendation(v: unknown): v is EmployeeAnalysis['recommendation'] {
  return typeof v === 'string' && ['PROMOTE', 'REWARD', 'MAINTAIN', 'COACH', 'PIP'].includes(v);
}

function fallbackSummary(emp: DiscoveredEmployee, scores: ScoreSet): string {
  const overall = computeOverall(scores, DEFAULT_WEIGHTS);
  return (
    `${emp.fullName} scored ${overall}/100 overall for the period based on recorded attendance, ` +
    `tasks, projects and conduct data. (Automated metric-based evaluation — the language model was ` +
    `unavailable for a narrative summary.)`
  );
}
