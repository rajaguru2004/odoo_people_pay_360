'use client';

import { useMemo, useState } from 'react';
import { Check, Download, FileSignature, ShieldCheck, UserMinus, X } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useIssueLetter,
  useLetterQueue,
  useLetterTemplates,
  useRejectLetter,
} from '@/hooks/useLetters';
import vaultService from '@/services/vaultService';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import type { LetterRequest, LetterStatus } from '@/types/letter';

/**
 * Mirrors `RejectLetterDto`: trimmed, at least 5 characters, at most 500.
 *
 * Checked at the keystroke as well as at the door — the employee reads the
 * reason verbatim, and a one-character refusal explains nothing to the person
 * who has to decide whether to ask again.
 */
const REASON_MIN = 5;
const REASON_MAX = 500;

const STATUS_TONE: Record<LetterStatus, 'warning' | 'success' | 'error'> = {
  PENDING: 'warning',
  ISSUED: 'success',
  REJECTED: 'error',
};

function LettersQueue() {
  const [status, setStatus] = useState<LetterStatus | ''>('PENDING');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const queue = useLetterQueue(status || undefined);
  const templates = useLetterTemplates(false);
  const issue = useIssueLetter();
  const reject = useRejectLetter();

  const rows = queue.data?.data ?? [];
  const allTemplates = useMemo(() => templates.data?.data ?? [], [templates.data]);

  usePageHeader(
    'Letter requests',
    'Issue salary certificates, NOCs and the rest of the letter desk',
  );

  const doIssue = async (row: LetterRequest) => {
    try {
      const result = await issue.mutateAsync(row.id);
      toast.success(`Issued — reference ${result.data?.serialNumber ?? ''}`);
      // A sibling of `data`, not a field in it: both statements are true and
      // they say different things. Held longer because it needs reading.
      if (result.warning) toast.warning(result.warning, { duration: 12_000 });
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not issue that letter.'));
    }
  };

  const doReject = async (row: LetterRequest) => {
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) {
      toast.warning(
        `Give a reason of at least ${REASON_MIN} characters — the employee reads it verbatim`,
      );
      return;
    }
    try {
      const result = await reject.mutateAsync({ id: row.id, reason: trimmed });
      toast.success('Rejected');
      if (result.warning) toast.warning(result.warning, { duration: 12_000 });
      setRejecting(null);
      setReason('');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not reject that request.'));
    }
  };

  const download = async (documentId: string, name: string) => {
    try {
      await vaultService.download('employee-document', documentId, name);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not download that letter.'));
    }
  };

  return (
    <div className="space-y-5">
      <div className="w-56">
        <Select
          aria-label="Filter by status"
          placeholder="All statuses"
          value={status}
          onChange={(event) => setStatus(event.target.value as LetterStatus | '')}
          data-testid="letter-status-filter"
        >
          <option value="PENDING">Pending</option>
          <option value="ISSUED">Issued</option>
          <option value="REJECTED">Rejected</option>
        </Select>
      </div>

      {queue.isLoading && (
        <Card className="p-6">
          <p className="text-sm text-text-muted">Loading the queue…</p>
        </Card>
      )}

      {queue.isError && (
        <Card className="p-6">
          <p className="text-sm text-status-error">
            {apiErrorMessage(queue.error, 'Could not load the letter queue.')}
          </p>
        </Card>
      )}

      {!queue.isLoading && !queue.isError && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<FileSignature className="h-6 w-6" aria-hidden />}
            title="Nothing here"
            description={
              status === 'PENDING'
                ? 'No letter is waiting to be issued.'
                : 'No letter request matches that filter.'
            }
          />
        </Card>
      )}

      <div className="space-y-3">
        {rows.map((row) => {
          const template = allTemplates.find(
            (t) => t.key === row.templateKey && t.locale === row.locale,
          );
          const busy =
            (issue.isPending && issue.variables === row.id) ||
            (reject.isPending && reject.variables?.id === row.id);

          return (
            <Card key={row.id} className="p-4" data-testid={`letter-row-${row.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <FileSignature
                      className="h-4 w-4 text-brand-primary"
                      aria-hidden
                    />
                    <p className="text-sm font-semibold text-text-heading">
                      {template?.name ?? row.templateKey}
                    </p>
                    <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                    {row.locale === 'ar' && <Badge>العربية</Badge>}
                    {row.employee?.isFormerEmployee && (
                      <Badge tone="warning">
                        <UserMinus className="me-1 h-3 w-3" aria-hidden />
                        Former employee
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {row.employee?.fullName} ({row.employee?.employeeCode})
                    {row.employee?.department
                      ? ` · ${row.employee.department.name}`
                      : ''}{' '}
                    · requested {formatDateOnly(row.createdAt)}
                  </p>
                  {(row.addressedTo || row.purpose) && (
                    <p className="mt-1 text-sm text-text-body">
                      {row.addressedTo ? `To: ${row.addressedTo}` : ''}
                      {row.addressedTo && row.purpose ? ' · ' : ''}
                      {row.purpose ? `Purpose: ${row.purpose}` : ''}
                    </p>
                  )}
                  {row.serialNumber && (
                    <p className="mt-1 font-mono text-xs text-text-muted">
                      {row.serialNumber}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {row.status === 'PENDING' && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => void doIssue(row)}
                        isLoading={busy}
                        data-testid={`letter-issue-${row.id}`}
                      >
                        <Check className="h-4 w-4" aria-hidden />
                        Issue
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setRejecting(rejecting === row.id ? null : row.id)
                        }
                        data-testid={`letter-reject-${row.id}`}
                      >
                        <X className="h-4 w-4" aria-hidden />
                        Reject
                      </Button>
                    </>
                  )}
                  {row.status === 'ISSUED' && row.documentId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void download(
                          row.documentId!,
                          `${row.serialNumber ?? row.templateKey}.html`,
                        )
                      }
                      data-testid={`letter-download-${row.id}`}
                    >
                      <ShieldCheck
                        className="h-3.5 w-3.5 text-status-success"
                        aria-hidden
                      />
                      <Download className="h-4 w-4" aria-hidden />
                      Download
                    </Button>
                  )}
                </div>
              </div>

              {rejecting === row.id && (
                <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-surface-border-light pt-3">
                  <div className="min-w-[18rem] flex-1">
                    <Input
                      label="Reason for rejection"
                      placeholder={`At least ${REASON_MIN} characters — the employee reads it verbatim`}
                      minLength={REASON_MIN}
                      maxLength={REASON_MAX}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      data-testid={`letter-reject-reason-${row.id}`}
                    />
                  </div>
                  <Button
                    variant="danger"
                    onClick={() => void doReject(row)}
                    isLoading={busy}
                    data-testid={`letter-reject-submit-${row.id}`}
                  >
                    Confirm rejection
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export default function LettersQueuePage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <LettersQueue />
    </ProtectedRoute>
  );
}
