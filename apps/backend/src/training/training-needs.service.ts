import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpenRouterToolsClient } from '../copilot/llm/openrouter-tools.client';

export interface TrainingNeed {
  appraisalResultId: string;
  employeeId: string | null;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  /** PROMOTE | REWARD | MAINTAIN | COACH | PIP — COACH/PIP are the strong signals. */
  recommendation: string | null;
  /** The improvement areas the appraisal actually recorded. */
  improvements: string[];
  /** Courses matched to those improvements, best first. */
  suggestedCourses: Array<{
    courseId: string;
    code: string;
    title: string;
    reason: string;
  }>;
  /** 'llm' when the model matched, 'keyword' on the deterministic fallback. */
  matchedBy: 'llm' | 'keyword' | 'none';
}

/** Recommendations that most strongly imply a development need. */
const DEVELOPMENT_RECOMMENDATIONS = new Set(['COACH', 'PIP']);

/**
 * Training needs derived from the AI appraisal engine.
 *
 * The competitive differentiator: both competitors claim to derive training
 * needs from appraisal results; this product actually has an appraisal engine
 * to derive them from. `AppraisalResult.improvementsJson` and `.recommendation`
 * are the evidence, and every nomination created from them keeps
 * `source='APPRAISAL'` + `appraisalResultId` so a suggestion can always be
 * traced back to what produced it.
 *
 * Output is a SUGGESTION LIST a human confirms. Never auto-nominates: an LLM
 * match is a starting point for a conversation about someone's development, not
 * a decision to spend their time and the company's money.
 */
@Injectable()
export class TrainingNeedsService {
  private readonly logger = new Logger(TrainingNeedsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: OpenRouterToolsClient,
  ) {}

  /** Improvement strings out of the appraisal's JSON blob, whatever its shape. */
  private extractImprovements(improvementsJson: unknown): string[] {
    if (!improvementsJson) return [];
    if (Array.isArray(improvementsJson)) {
      return improvementsJson
        .map((i) =>
          typeof i === 'string'
            ? i
            : typeof i === 'object' && i !== null
              ? String(
                  (i as any).area ??
                    (i as any).title ??
                    (i as any).description ??
                    '',
                )
              : '',
        )
        .filter(Boolean);
    }
    if (typeof improvementsJson === 'object') {
      const areas = (improvementsJson as any).areas ?? (improvementsJson as any).items;
      if (Array.isArray(areas)) return this.extractImprovements(areas);
    }
    return [];
  }

  /**
   * Deterministic fallback: token overlap between the improvement text and the
   * course title/category/description.
   *
   * Exists so the feature still works with no LLM configured, offline, or when
   * the provider is down — a demo that only works with a live API key is not a
   * differentiator.
   */
  private keywordMatch(
    improvements: string[],
    courses: Array<{ id: string; code: string; title: string; category: string | null; description: string | null }>,
  ) {
    const stop = new Set([
      'the', 'and', 'for', 'with', 'improve', 'improving', 'needs', 'need',
      'better', 'more', 'should', 'skills', 'skill', 'work', 'their', 'they',
      'this', 'that', 'from', 'have', 'has', 'was', 'are', 'a', 'an', 'to', 'of',
      'in', 'on', 'at', 'by', 'is', 'it', 'be',
    ]);
    const tokens = new Set(
      improvements
        .join(' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !stop.has(t)),
    );
    if (tokens.size === 0) return [];

    return courses
      .map((c) => {
        const haystack = `${c.title} ${c.category ?? ''} ${c.description ?? ''}`
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
        const hits = haystack.filter((w) => tokens.has(w));
        return { course: c, score: new Set(hits).size, hits: [...new Set(hits)] };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((m) => ({
        courseId: m.course.id,
        code: m.course.code,
        title: m.course.title,
        reason: `Matches development area keyword(s): ${m.hits.slice(0, 4).join(', ')}`,
      }));
  }

  /** Ask the model to map improvement areas onto the catalogue. */
  private async llmMatch(
    improvements: string[],
    recommendation: string | null,
    courses: Array<{ id: string; code: string; title: string; category: string | null }>,
  ) {
    const catalogue = courses
      .map((c) => `- ${c.code}: ${c.title}${c.category ? ` [${c.category}]` : ''}`)
      .join('\n');

    const res = await this.llm.complete({
      messages: [
        {
          role: 'system',
          content:
            'You map employee development areas onto a course catalogue. ' +
            'Reply with ONLY a JSON array, no prose, no code fences. Each element: ' +
            '{"code": "<course code from the catalogue>", "reason": "<one short sentence>"}. ' +
            'Pick at most 3, best first. Return [] when nothing in the catalogue genuinely fits — ' +
            'a bad match wastes an employee\'s time, so an empty answer is better than a stretch.',
        },
        {
          role: 'user',
          content:
            `Appraisal recommendation: ${recommendation ?? 'n/a'}\n` +
            `Development areas:\n${improvements.map((i) => `- ${i}`).join('\n')}\n\n` +
            `Course catalogue:\n${catalogue}`,
        },
      ],
      tools: [],
    });

    const raw = (res.message?.content ?? '').trim();
    // Models still wrap JSON in fences despite the instruction.
    const json = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    const byCode = new Map(courses.map((c) => [c.code.toLowerCase(), c]));
    return parsed
      .map((p: any) => {
        const course = byCode.get(String(p?.code ?? '').toLowerCase());
        if (!course) return null; // hallucinated code — drop it
        return {
          courseId: course.id,
          code: course.code,
          title: course.title,
          reason: String(p?.reason ?? 'Suggested from appraisal development areas'),
        };
      })
      .filter(Boolean)
      .slice(0, 3) as TrainingNeed['suggestedCourses'];
  }

  /**
   * Derive needs for one completed appraisal run.
   *
   * `onlyDevelopmentRecommendations` (default true) narrows to COACH/PIP — the
   * results that actually signal a development need. Turn it off to review the
   * whole cohort.
   */
  async deriveFromRun(
    runId: string,
    opts: { onlyDevelopmentRecommendations?: boolean } = {},
  ): Promise<{ success: true; data: TrainingNeed[]; meta: Record<string, unknown> }> {
    const run = await this.prisma.appraisalRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, periodLabel: true },
    });
    if (!run) throw new NotFoundException('Appraisal run not found');

    const onlyDev = opts.onlyDevelopmentRecommendations !== false;
    const results = await this.prisma.appraisalResult.findMany({
      where: {
        runId,
        status: { in: ['COMPLETED', 'DEGRADED'] },
        ...(onlyDev ? { recommendation: { in: [...DEVELOPMENT_RECOMMENDATIONS] } } : {}),
      },
      select: {
        id: true,
        employeeId: true,
        employeeName: true,
        employeeCode: true,
        departmentName: true,
        recommendation: true,
        improvementsJson: true,
      },
      orderBy: { rankOverall: 'desc' },
    });

    const courses = await this.prisma.course.findMany({
      where: { isActive: true },
      select: { id: true, code: true, title: true, category: true, description: true },
    });

    const needs: TrainingNeed[] = [];
    for (const result of results) {
      const improvements = this.extractImprovements(result.improvementsJson);
      if (improvements.length === 0) continue;

      let suggestedCourses: TrainingNeed['suggestedCourses'] = [];
      let matchedBy: TrainingNeed['matchedBy'] = 'none';

      if (courses.length > 0) {
        try {
          suggestedCourses = await this.llmMatch(
            improvements,
            result.recommendation,
            courses,
          );
          matchedBy = suggestedCourses.length > 0 ? 'llm' : 'none';
        } catch (e: any) {
          this.logger.warn(
            `LLM course match failed for result ${result.id}, falling back to keywords: ${e?.message ?? e}`,
          );
        }
        if (suggestedCourses.length === 0) {
          suggestedCourses = this.keywordMatch(improvements, courses);
          if (suggestedCourses.length > 0) matchedBy = 'keyword';
        }
      }

      needs.push({
        appraisalResultId: result.id,
        employeeId: result.employeeId,
        employeeName: result.employeeName,
        employeeCode: result.employeeCode,
        departmentName: result.departmentName,
        recommendation: result.recommendation,
        improvements,
        suggestedCourses,
        matchedBy,
      });
    }

    return {
      success: true,
      data: needs,
      meta: {
        runId,
        periodLabel: run.periodLabel,
        resultsConsidered: results.length,
        needsFound: needs.length,
        catalogueSize: courses.length,
        onlyDevelopmentRecommendations: onlyDev,
      },
    };
  }
}
