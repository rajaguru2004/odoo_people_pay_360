import { useBranchStore } from '@/store/branchStore';
import { CopilotStreamEvent } from '@/types/copilot';
import { API_BASE } from '@/lib/apiBase';


/**
 * Stream a copilot turn over SSE. Uses fetch (not axios) so we can read the
 * response body incrementally. Calls `onEvent` for each server event.
 */
export async function streamCopilotChat(
  body: { message: string; conversationId?: string },
  onEvent: (event: CopilotStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  const branchId = useBranchStore.getState().selectedBranchId;

  const res = await fetch(`${API_BASE}/copilot/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(branchId ? { 'X-Branch-Id': branchId } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
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
        onEvent(JSON.parse(data) as CopilotStreamEvent);
      } catch {
        /* partial/non-JSON frame — ignore */
      }
    }
  }
}

/** Rotating "thinking" phrases shown while the model works (Claude-style). */
export const THINKING_PHRASES = [
  'Thinking',
  'Gathering the details',
  'Connecting the dots',
  'Making sense of the data',
  'Almost there',
];

/** Turn a raw tool name into a warm, user-facing status. */
export function friendlyToolStatus(tool: string): string {
  const t = tool.toLowerCase();
  const phrase =
    t.startsWith('leave_balance') ? 'Checking leave balances'
    : t.startsWith('leave') ? 'Reviewing leave requests'
    : t.startsWith('employee') ? 'Looking up employee records'
    : t === 'report_today_snapshot' ? "Taking today's snapshot"
    : t.startsWith('report') ? 'Compiling the report'
    : t.startsWith('payslip') ? 'Pulling up the payslip'
    : t.startsWith('payroll') ? 'Working through payroll'
    : t.startsWith('attendance') ? 'Checking attendance'
    : t.startsWith('holiday') ? 'Checking the holiday calendar'
    : t.startsWith('shift') || t.startsWith('calendar') ? 'Reviewing the schedule'
    : t.startsWith('department') ? 'Looking at the departments'
    : t.startsWith('project') ? 'Reviewing the projects'
    : t.startsWith('task') ? 'Going through the tasks'
    : 'Fetching the details';
  return `${phrase}…`;
}
