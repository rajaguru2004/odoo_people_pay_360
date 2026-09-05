import { useBranchStore } from '@/store/branchStore';
import { AppraisalStreamEvent } from '@/types/appraisal';
import { API_BASE } from '@/lib/apiBase';


/**
 * Stream appraisal run progress over SSE (fetch-reader, same pattern as the
 * copilot stream — headers can't be set on EventSource). Every event carries a
 * monotonic `seq`; pass the last seen seq as `afterSeq` to resume after a
 * disconnect or page refresh without losing events.
 */
export async function streamAppraisalRun(
  runId: string,
  afterSeq: number,
  onEvent: (event: AppraisalStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  const branchId = useBranchStore.getState().selectedBranchId;

  const res = await fetch(
    `${API_BASE}/appraisal/runs/${runId}/stream?afterSeq=${afterSeq}`,
    {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(branchId ? { 'X-Branch-Id': branchId } : {}),
      },
      signal,
    },
  );

  if (!res.ok || !res.body) {
    let message = `Stream failed (${res.status})`;
    try {
      const j = await res.json();
      message = j?.message || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue; // heartbeat comment (": ping")
      const data = dataLine.slice(5).trim();
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AppraisalStreamEvent);
      } catch {
        /* partial/non-JSON frame — ignore */
      }
    }
  }
}

/** Warm status line for a tool call in the activity feed. */
export function friendlyAppraisalTool(tool: string): string {
  const map: Record<string, string> = {
    attendance_employee_summary: 'Analyzing attendance patterns',
    leave_employee_summary: 'Evaluating leave utilization',
    overtime_employee_summary: 'Reviewing overtime records',
    task_employee_stats: 'Analyzing completed tasks',
    project_contribution_get: 'Fetching project contributions',
    worklog_employee_summary: 'Calculating logged hours',
    timesheet_employee_summary: 'Checking timesheet discipline',
    reimbursement_employee_summary: 'Scanning reimbursement claims',
    conduct_records_get: 'Reviewing rewards & disciplinary records',
    team_membership_get: 'Mapping team involvement',
    employee_get: 'Reading the employee profile',
  };
  if (map[tool]) return map[tool];
  const t = tool.toLowerCase();
  if (t.startsWith('attendance')) return 'Fetching attendance records';
  if (t.startsWith('leave')) return 'Fetching leave history';
  if (t.startsWith('task')) return 'Analyzing tasks';
  if (t.startsWith('project')) return 'Fetching project data';
  if (t.startsWith('report')) return 'Compiling reports';
  return 'Gathering HR data';
}
