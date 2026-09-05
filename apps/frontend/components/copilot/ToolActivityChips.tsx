'use client';

import { AlertCircle, CheckCircle2, Clock3, Wrench } from 'lucide-react';
import { ToolActivityEntry } from '@/types/copilot';

export default function ToolActivityChips({ activity }: { activity: ToolActivityEntry[] }) {
  if (!activity?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {activity.map((a) => (
        <span
          key={a.toolCallId}
          title={a.resultSummary}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-mono ${
            a.status === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : a.status === 'pending_confirmation'
              ? 'border-amber-200 bg-amber-50 text-amber-700'
              : 'border-slate-200 bg-slate-50 text-slate-600'
          }`}
        >
          {a.status === 'error' ? (
            <AlertCircle size={11} />
          ) : a.status === 'pending_confirmation' ? (
            <Clock3 size={11} />
          ) : (
            <CheckCircle2 size={11} />
          )}
          <Wrench size={10} className="opacity-60" />
          {a.tool}
          {typeof a.durationMs === 'number' && (
            <span className="opacity-50">{Math.round(a.durationMs / 100) / 10}s</span>
          )}
        </span>
      ))}
    </div>
  );
}
