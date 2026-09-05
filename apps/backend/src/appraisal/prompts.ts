import { OrMessage } from '../copilot/llm/openrouter-tools.client';
import {
  DiscoveredEmployee,
  RECOMMENDATIONS,
  RunPeriod,
  SCORE_DIMENSIONS,
  ScoreSet,
} from './appraisal.types';

const fmt = (d: Date) => d.toISOString().slice(0, 10);

const JSON_ONLY =
  'Respond with ONLY a single valid JSON object. No markdown, no code fences, no commentary before or after.';

/** Phase "plan": the agent chooses which read-only tools to run per employee. */
export function buildPlanningMessages(
  tools: Array<{ name: string; description: string }>,
  period: RunPeriod,
  employeeCount: number,
): OrMessage[] {
  const inventory = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You are an experienced HR analyst planning an autonomous, unbiased performance appraisal. ' +
        'You will be run once per employee with the tools you select here. Choose the tool set that ' +
        'gives the fullest, fairest picture of individual performance (attendance, punctuality, leave, ' +
        'overtime, tasks, projects, time logging, timesheets, conduct, team involvement). Prefer ' +
        'period-bounded per-employee summary tools over company-wide reports. Select between 6 and 12 tools.\n' +
        JSON_ONLY,
    },
    {
      role: 'user',
      content:
        `Appraisal period: ${fmt(period.start)} to ${fmt(period.end)} (${period.label}). ` +
        `Employees to evaluate: ${employeeCount}.\n\nAvailable read-only tools:\n${inventory}\n\n` +
        'Return JSON: {"tools": [{"tool": "<tool_name>", "reason": "<why this signal matters>"}]}',
    },
  ];
}

/** Phase "analyze": one structured evaluation per employee. */
export function buildAnalysisMessages(
  employee: DiscoveredEmployee,
  period: RunPeriod,
  collected: Record<string, unknown>,
  baseline: ScoreSet,
): OrMessage[] {
  const dims = SCORE_DIMENSIONS.join(', ');
  const data = Object.entries(collected)
    .map(([tool, payload]) => `### ${tool}\n${JSON.stringify(payload).slice(0, 2000)}`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You are a senior, impartial HR performance analyst. Evaluate ONE employee strictly from the ' +
        'data provided (gathered live from the HR system). Be fair and evidence-based: do not invent ' +
        'facts, cite concrete numbers from the data in your reasoning, and treat missing data as ' +
        'neutral rather than negative. Scores are integers 0-100.\n' +
        JSON_ONLY,
    },
    {
      role: 'user',
      content:
        `Employee: ${employee.fullName} (${employee.employeeCode}), position: ${employee.position ?? 'n/a'}, ` +
        `department: ${employee.departmentName ?? 'n/a'}, joined: ${fmt(employee.startDate)}.\n` +
        `Appraisal period: ${fmt(period.start)} to ${fmt(period.end)}.\n\n` +
        `Collected data by tool:\n${data}\n\n` +
        `Deterministic baseline scores (guidance, override only with evidence): ${JSON.stringify(baseline)}\n\n` +
        'Return JSON exactly in this shape:\n' +
        `{"scores": {${SCORE_DIMENSIONS.map((d) => `"${d}": <0-100>`).join(', ')}},\n` +
        ' "strengths": ["..."], "improvements": ["..."], "risks": ["..."],\n' +
        ' "summary": "<4-6 sentence performance summary citing concrete numbers>",\n' +
        ` "recommendation": "<one of ${RECOMMENDATIONS.join('|')}>"}\n` +
        `Score dimensions: ${dims}.`,
    },
  ];
}

/** Phase "synthesize": org-level executive summary + insights. */
export function buildSynthesisMessages(
  period: RunPeriod,
  ranked: Array<{
    name: string;
    department: string | null;
    overall: number;
    recommendation: string | null;
  }>,
  departments: Array<{ department: string; avgScore: number; count: number }>,
): OrMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are an HR director writing the executive readout of an organization-wide AI appraisal ' +
        'cycle. Be concise, specific and actionable; reference real names, departments and scores ' +
        'from the data.\n' +
        JSON_ONLY,
    },
    {
      role: 'user',
      content:
        `Appraisal period: ${fmt(period.start)} to ${fmt(period.end)} (${period.label}).\n` +
        `Ranked employees (best first): ${JSON.stringify(ranked.slice(0, 60))}\n` +
        `Department averages: ${JSON.stringify(departments)}\n\n` +
        'Return JSON:\n' +
        '{"executiveSummary": "<5-8 sentence executive summary>",\n' +
        ' "departmentInsights": [{"department": "...", "insight": "..."}],\n' +
        ' "organizationInsights": ["..."],\n' +
        ' "needsAttention": ["<employee name — one-line concern>"]}',
    },
  ];
}

/** Extract the first JSON object from an LLM response (tolerates fences/prose). */
export function extractJson(text: string | null | undefined): any | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  // Walk to the matching closing brace (string-aware).
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      if (inStr) esc = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
