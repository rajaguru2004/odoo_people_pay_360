'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  EyeOff,
  Lock,
  MessageSquareWarning,
  Send,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/common/EmptyState';
import { StatCard } from '@/components/common/StatCard';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useAddGrievanceNote,
  useGrievance,
  useGrievanceStats,
  useGrievances,
  useUpdateGrievance,
} from '@/hooks/useGrievances';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateTime } from '@/utils/formatDate';
import type { Grievance, GrievanceStatus } from '@/types/grievance';

const STATUSES: GrievanceStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'RESOLVED',
  'CLOSED',
  'WITHDRAWN',
];

const STATUS_TONE: Record<
  GrievanceStatus,
  'neutral' | 'success' | 'warning' | 'error' | 'info'
> = {
  OPEN: 'warning',
  ACKNOWLEDGED: 'info',
  INVESTIGATING: 'info',
  RESOLVED: 'success',
  CLOSED: 'neutral',
  WITHDRAWN: 'neutral',
};

/**
 * The handler's view of one case.
 *
 * The trail is loaded on expand rather than with the list: a grievance's notes
 * are the confidential half, and fetching every case's notes to draw a list
 * would put them on the wire for cases nobody opened.
 */
function GrievanceDetail({ row }: { row: Grievance }) {
  const detail = useGrievance(row.id);
  const update = useUpdateGrievance();
  const addNote = useAddGrievanceNote();

  const [resolution, setResolution] = useState(row.resolution ?? '');
  const [note, setNote] = useState('');
  const [internal, setInternal] = useState(true);

  const grievance = detail.data?.data;

  const setStatus = async (next: GrievanceStatus) => {
    try {
      await update.mutateAsync({
        id: row.id,
        payload: {
          status: next,
          ...(next === 'RESOLVED' && resolution.trim()
            ? { resolution: resolution.trim() }
            : {}),
        },
      });
      toast.success(`Marked ${next.toLowerCase()}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not update that grievance.'));
    }
  };

  const submitNote = async () => {
    if (!note.trim()) {
      toast.warning('Write something first');
      return;
    }
    try {
      await addNote.mutateAsync({ id: row.id, note: note.trim(), isInternal: internal });
      toast.success(
        internal ? 'Internal note added' : 'Note shared with the employee',
      );
      setNote('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not add that note.'));
    }
  };

  if (detail.isLoading) {
    return <p className="p-5 text-sm text-text-muted">Loading the case…</p>;
  }
  if (!grievance) {
    return (
      <p className="p-5 text-sm text-status-error">
        {apiErrorMessage(detail.error, 'Could not load that grievance.')}
      </p>
    );
  }

  return (
    <div className="border-t border-surface-border-light p-5">
      <p className="mb-4 whitespace-pre-wrap text-sm text-text-body">
        {grievance.description}
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STATUSES.filter(
          (value) => value !== grievance.status && value !== 'WITHDRAWN',
        ).map((value) => (
          <Button
            key={value}
            size="sm"
            variant="outline"
            onClick={() => void setStatus(value)}
            isLoading={update.isPending}
            data-testid={`grievance-set-${value.toLowerCase()}-${row.id}`}
          >
            Mark {value.toLowerCase()}
          </Button>
        ))}
      </div>

      <div className="mb-4">
        <Textarea
          label="Resolution (recorded when the case is marked resolved)"
          rows={2}
          value={resolution}
          onChange={(event) => setResolution(event.target.value)}
        />
      </div>

      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Trail
        </h3>
        <ol className="space-y-2">
          {(grievance.events ?? []).map((event) => (
            <li
              key={event.id}
              className="rounded-[var(--radius-input)] bg-surface-page px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>{formatDateTime(event.createdAt)}</span>
                {event.actor?.email && <span>· {event.actor.email}</span>}
                {event.isInternal && (
                  <span className="inline-flex items-center gap-1 text-status-warning">
                    <EyeOff className="h-3 w-3" aria-hidden />
                    internal
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-text-body">
                {event.type === 'STATUS_CHANGE'
                  ? `${event.fromStatus ?? '—'} → ${event.toStatus}`
                  : ''}
                {event.note ? ` ${event.note}` : ''}
              </p>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <Input
            aria-label="Add a note to the trail"
            placeholder="Add a note…"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 pb-2.5 text-sm text-text-body">
          <input
            type="checkbox"
            className="h-4 w-4 rounded-sm border-surface-border accent-brand-primary"
            checked={internal}
            onChange={(event) => setInternal(event.target.checked)}
          />
          Internal only
        </label>
        <Button onClick={() => void submitNote()} isLoading={addNote.isPending}>
          <Send className="h-4 w-4" aria-hidden />
          Add
        </Button>
      </div>
    </div>
  );
}

function GrievancesQueue() {
  const [status, setStatus] = useState<GrievanceStatus | ''>('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useGrievances(status || undefined);
  const stats = useGrievanceStats();

  const rows = data?.data ?? [];
  const figures = stats.data?.data;

  usePageHeader('Grievances', 'Employee concerns and how they are being handled');

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatCard
          label="Open cases"
          value={figures?.open ?? 0}
          icon={<MessageSquareWarning className="h-5 w-5" aria-hidden />}
          hint="Raised, acknowledged or under investigation"
        />
        <StatCard
          label="Waiting over 14 days"
          value={figures?.olderThan14Days ?? 0}
          hint="Age matters more than the count"
        />
        <StatCard
          label="Oldest opened"
          value={
            figures?.oldestOpenAt ? formatDateTime(figures.oldestOpenAt) : '—'
          }
        />
      </div>

      <div className="w-56">
        <Select
          aria-label="Filter by status"
          placeholder="All statuses"
          value={status}
          onChange={(event) => setStatus(event.target.value as GrievanceStatus | '')}
        >
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </div>

      {isLoading && (
        <Card className="p-6">
          <p className="text-sm text-text-muted">Loading the desk…</p>
        </Card>
      )}

      {isError && (
        <Card className="p-6">
          <p className="text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load the grievance desk.')}
          </p>
        </Card>
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<MessageSquareWarning className="h-6 w-6" aria-hidden />}
            title="No grievances"
            description="Nothing has been raised under this filter."
          />
        </Card>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const open = expanded === row.id;
          return (
            <Card key={row.id} data-testid={`grievance-row-${row.id}`}>
              <button
                type="button"
                onClick={() => setExpanded(open ? null : row.id)}
                aria-expanded={open}
                className="flex w-full items-start justify-between gap-3 p-4 text-start"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <MessageSquareWarning
                      className="h-4 w-4 text-brand-primary"
                      aria-hidden
                    />
                    <span className="text-sm font-semibold text-text-heading">
                      {row.subject}
                    </span>
                    <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                    {row.isConfidential && (
                      <Badge>
                        <Lock className="me-1 h-3 w-3" aria-hidden />
                        Confidential
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {row.employee?.fullName} ({row.employee?.employeeCode}) ·{' '}
                    {row.category}
                    {row.againstEmployee
                      ? ` · about ${row.againstEmployee.fullName}`
                      : ''}
                  </p>
                </div>
                {open ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
                ) : (
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-text-muted rtl:rotate-180"
                    aria-hidden
                  />
                )}
              </button>

              {open && <GrievanceDetail row={row} />}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export default function GrievancesQueuePage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <GrievancesQueue />
    </ProtectedRoute>
  );
}
