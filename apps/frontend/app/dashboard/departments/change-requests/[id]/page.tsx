'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  ClipboardList,
  Layers,
  Users,
  UsersRound,
  XCircle,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useCancelChangeRequest,
  useChangeRequest,
  useReviewChangeRequest,
} from '@/hooks/useChangeRequests';
import { useAuthStore } from '@/store/authStore';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly, formatDateTime } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type { RequestStatus } from '@/types/common';
import type { DepartmentChangeRequest } from '@/types/department';

const STATUS_TONE: Record<RequestStatus, 'warning' | 'success' | 'error' | 'neutral'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  CANCELLED: 'neutral',
};

const CHANGE_LABELS: Record<DepartmentChangeRequest['changeType'], string> = {
  MANAGER: 'Department head',
  PARENT: 'Reports to',
  RENAME: 'Name',
  DEACTIVATE: 'Status',
};

function beforeAfter(request: DepartmentChangeRequest): { before: string; after: string } {
  switch (request.changeType) {
    case 'MANAGER':
      return { before: fullName(request.oldManager), after: fullName(request.newManager) };
    case 'PARENT':
      return {
        before: request.oldParent?.name ?? 'Top level',
        after: request.newParent?.name ?? 'Top level',
      };
    case 'RENAME':
      return { before: request.oldName ?? '—', after: request.newName ?? '—' };
    case 'DEACTIVATE':
      return { before: 'Open', after: 'Closed' };
    default:
      return { before: '—', after: '—' };
  }
}

function personOf(actor: DepartmentChangeRequest['requestedBy']): string {
  if (!actor) return 'Unknown';
  return actor.employee ? fullName(actor.employee) : actor.email;
}

function ImpactFigure({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-4">
      <span className="flex items-center gap-2 text-xs font-medium text-text-muted">
        {icon}
        {label}
      </span>
      {/* An em dash rather than 0 when the impact block is missing: not knowing
          the blast radius and knowing it is zero are different answers. */}
      <p className="mt-2 text-2xl font-semibold tabular-nums text-text-heading">
        {value ?? '—'}
      </p>
    </div>
  );
}

function ChangeRequestDetailContent({ id }: { id: string }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const canReview = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';

  const { data, isLoading, isError } = useChangeRequest(id);
  const request = data?.data;

  const review = useReviewChangeRequest();
  const cancel = useCancelChangeRequest();

  const [pendingAction, setPendingAction] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  usePageHeader(
    request?.department ? `${request.department.name} change` : 'Change request',
    request ? CHANGE_LABELS[request.changeType] : undefined,
  );

  if (isLoading) {
    return <Card className="p-6 text-sm text-text-muted">Loading the request…</Card>;
  }

  if (isError || !request) {
    return (
      <Card className="p-6 text-sm text-status-error">That request could not be read.</Card>
    );
  }

  const { before, after } = beforeAfter(request);
  const isOwner = Boolean(user?.id && user.id === request.requestedById);
  const isPending = request.status === 'PENDING';

  const submitReview = async () => {
    // A rejection with no note leaves the requester with a decision and no
    // reason, which is the one outcome they cannot act on.
    if (pendingAction === 'REJECT' && reviewNote.trim().length === 0) {
      setNoteError('Say why it is being turned down');
      return;
    }

    try {
      await review.mutateAsync({
        id,
        payload: {
          action: pendingAction === 'APPROVE' ? 'APPROVE' : 'REJECT',
          reviewNote: reviewNote.trim() || undefined,
        },
      });
      toast.success(pendingAction === 'APPROVE' ? 'Change applied' : 'Request turned down');
      setPendingAction(null);
      setReviewNote('');
      setNoteError(null);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The decision could not be recorded'));
    }
  };

  const handleCancel = async () => {
    if (!window.confirm('Withdraw this request?')) return;
    try {
      await cancel.mutateAsync(id);
      toast.success('Request withdrawn');
      router.push('/dashboard/departments/change-requests');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The request could not be withdrawn'));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[request.status]}>{request.status.toLowerCase()}</Badge>
          <Badge tone="neutral">{CHANGE_LABELS[request.changeType]}</Badge>
        </div>

        {isOwner && isPending && (
          <Button variant="outline" size="sm" onClick={handleCancel} isLoading={cancel.isPending}>
            <Ban className="h-4 w-4" aria-hidden />
            Withdraw
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="What this would change"
            subtitle="The before is the value as it stood when the request was raised."
          />
          <CardBody className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page px-4 py-2 text-sm text-text-muted line-through decoration-text-muted/50">
                {before}
              </span>
              <ArrowRight className="h-5 w-5 text-text-muted rtl:rotate-180" aria-hidden />
              <span className="rounded-[var(--radius-card)] border border-brand-primary/30 bg-brand-primary/10 px-4 py-2 text-sm font-semibold text-brand-primary">
                {after}
              </span>
            </div>

            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-text-muted">Department</dt>
                <dd className="mt-0.5 text-sm font-medium text-text-heading">
                  {request.department ? (
                    <Link
                      href={`/dashboard/departments/${request.department.id}`}
                      className="hover:text-brand-primary hover:underline"
                    >
                      {request.department.name}
                    </Link>
                  ) : (
                    'Unknown unit'
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-muted">Takes effect</dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums text-text-heading">
                  {formatDateOnly(request.effectiveDate)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-muted">Raised by</dt>
                <dd className="mt-0.5 text-sm font-medium text-text-heading">
                  {personOf(request.requestedBy)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-muted">Raised on</dt>
                <dd className="mt-0.5 text-sm font-medium text-text-heading">
                  {formatDateTime(request.createdAt)}
                </dd>
              </div>
            </dl>

            <div>
              <p className="text-xs text-text-muted">Reason</p>
              <p className="mt-1 text-sm leading-relaxed text-text-body">{request.reason}</p>
            </div>

            {request.reviewedAt && (
              <div className="rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-4">
                <p className="text-xs text-text-muted">
                  Reviewed by {personOf(request.reviewedBy)} on{' '}
                  {formatDateTime(request.reviewedAt)}
                </p>
                {request.reviewNote && (
                  <p className="mt-1.5 text-sm text-text-body">{request.reviewNote}</p>
                )}
              </div>
            )}
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Impact"
              subtitle="Counted today, not when the request was raised."
            />
            <CardBody className="grid grid-cols-2 gap-3">
              <ImpactFigure
                icon={<Users className="h-3.5 w-3.5" aria-hidden />}
                label="Affected employees"
                value={request.impact?.affectedEmployees}
              />
              <ImpactFigure
                icon={<UsersRound className="h-3.5 w-3.5" aria-hidden />}
                label="Affected teams"
                value={request.impact?.affectedTeams}
              />
              <ImpactFigure
                icon={<Layers className="h-3.5 w-3.5" aria-hidden />}
                label="Affected sub-units"
                value={request.impact?.affectedChildDepartments}
              />
              <ImpactFigure
                icon={<ClipboardList className="h-3.5 w-3.5" aria-hidden />}
                label="Pending corrections"
                value={request.impact?.pendingCorrections}
              />
            </CardBody>
          </Card>

          {canReview && isPending && (
            <Card>
              <CardHeader title="Decision" subtitle="Approving writes the change immediately." />
              <CardBody className="space-y-4">
                {pendingAction === null ? (
                  <div className="flex flex-wrap gap-3">
                    <Button onClick={() => setPendingAction('APPROVE')}>
                      <CheckCircle2 className="h-4 w-4" aria-hidden />
                      Approve
                    </Button>
                    <Button variant="danger" onClick={() => setPendingAction('REJECT')}>
                      <XCircle className="h-4 w-4" aria-hidden />
                      Reject
                    </Button>
                  </div>
                ) : (
                  <>
                    <div>
                      <label
                        htmlFor="review-note"
                        className="mb-1.5 block text-sm font-medium text-text-body"
                      >
                        {pendingAction === 'REJECT' ? 'Why it is refused' : 'Note (optional)'}
                      </label>
                      <textarea
                        id="review-note"
                        rows={3}
                        value={reviewNote}
                        onChange={(event) => {
                          setReviewNote(event.target.value);
                          setNoteError(null);
                        }}
                        className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                      />
                      {noteError && (
                        <p className="mt-1.5 text-sm text-status-error">{noteError}</p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-3">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setPendingAction(null);
                          setNoteError(null);
                        }}
                      >
                        Back
                      </Button>
                      <Button
                        variant={pendingAction === 'REJECT' ? 'danger' : 'primary'}
                        onClick={submitReview}
                        isLoading={review.isPending}
                      >
                        {pendingAction === 'REJECT' ? 'Confirm rejection' : 'Confirm approval'}
                      </Button>
                    </div>
                  </>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChangeRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <ProtectedRoute requiredPermission="VIEW_DEPARTMENTS">
      <ChangeRequestDetailContent id={id} />
    </ProtectedRoute>
  );
}
