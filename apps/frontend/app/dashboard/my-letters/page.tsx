'use client';

import { useMemo, useState } from 'react';
import {
  Clock,
  Download,
  FileSignature,
  Plus,
  ShieldCheck,
  UserMinus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useLetterTemplates, useMyLetters, useRequestLetter } from '@/hooks/useLetters';
import vaultService from '@/services/vaultService';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDateOnly } from '@/utils/formatDate';
import type { LetterLocale, LetterStatus, RequestLetterData } from '@/types/letter';

const STATUS_TONE: Record<LetterStatus, 'warning' | 'success' | 'error'> = {
  PENDING: 'warning',
  ISSUED: 'success',
  REJECTED: 'error',
};

const EMPTY_FORM: RequestLetterData = { templateKey: '', locale: 'en' };

function MyLettersScreen() {
  const requests = useMyLetters();
  const templates = useLetterTemplates(true);
  const request = useRequestLetter();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<RequestLetterData>(EMPTY_FORM);

  const rows = requests.data?.data ?? [];
  const allTemplates = useMemo(() => templates.data?.data ?? [], [templates.data]);

  usePageHeader(
    'My letters',
    'Salary certificates, NOCs, experience and embassy letters',
  );

  // One entry per letter TYPE; the language is a separate choice, and a type
  // that exists in only one locale must still be offered.
  const letterTypes = useMemo(
    () => [...new Map(allTemplates.map((t) => [t.key, t])).values()],
    [allTemplates],
  );
  const selected = allTemplates.find(
    (t) => t.key === form.templateKey && t.locale === (form.locale ?? 'en'),
  );

  const submit = async () => {
    if (!selected) return;
    try {
      const result = await request.mutateAsync(form);
      toast.success(
        result.data?.status === 'ISSUED'
          ? 'Letter issued — it is in your documents'
          : 'Requested. HR will review and issue it.',
      );
      setShowForm(false);
      setForm(EMPTY_FORM);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not request that letter.'));
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
    <div className="space-y-5" data-testid="ess-my-letters">
      <div className="flex justify-end">
        <Button
          onClick={() => setShowForm((open) => !open)}
          data-testid="letter-request-open"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Request a letter
        </Button>
      </div>

      {showForm && (
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-heading">
              Request a letter
            </h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              aria-label="Close the request form"
              className="text-text-muted hover:text-text-body"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Select
              label="Letter type"
              placeholder="Choose a letter…"
              value={form.templateKey}
              onChange={(event) =>
                setForm({ ...form, templateKey: event.target.value })
              }
              data-testid="letter-request-type"
            >
              {letterTypes.map((template) => (
                <option key={template.key} value={template.key}>
                  {template.name}
                </option>
              ))}
            </Select>
            <Select
              label="Language"
              value={form.locale ?? 'en'}
              onChange={(event) =>
                setForm({ ...form, locale: event.target.value as LetterLocale })
              }
              data-testid="letter-request-locale"
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </Select>
            <Input
              label="Addressed to"
              placeholder="Bank Muscat"
              value={form.addressedTo ?? ''}
              onChange={(event) =>
                setForm({ ...form, addressedTo: event.target.value })
              }
              data-testid="letter-request-addressed-to"
            />
            <Input
              label="Purpose"
              placeholder="Appears in the body of the letter"
              value={form.purpose ?? ''}
              onChange={(event) => setForm({ ...form, purpose: event.target.value })}
              data-testid="letter-request-purpose"
            />
          </div>

          {form.templateKey && !selected && (
            <p className="mt-3 text-xs text-status-warning">
              This letter is not available in the chosen language yet.
            </p>
          )}
          {selected && (
            <p className="mt-3 text-xs text-text-muted">
              {selected.requiresApproval
                ? 'HR will review and issue this letter.'
                : 'This letter is issued the moment you ask for it.'}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <Button
              onClick={() => void submit()}
              disabled={!selected}
              isLoading={request.isPending}
              data-testid="letter-request-submit"
            >
              Request
            </Button>
          </div>
        </Card>
      )}

      {requests.isLoading && (
        <Card className="p-6">
          <p className="text-sm text-text-muted">Loading your letters…</p>
        </Card>
      )}

      {requests.isError && (
        <Card className="p-6">
          <p className="text-sm text-status-error">
            {apiErrorMessage(requests.error, 'Could not load your letters.')}
          </p>
        </Card>
      )}

      {!requests.isLoading && !requests.isError && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<FileSignature className="h-6 w-6" aria-hidden />}
            title="No letters yet"
            description="Ask for a salary certificate, an NOC, an experience letter or an embassy letter and track it here."
          />
        </Card>
      )}

      <div className="space-y-3">
        {rows.map((row) => {
          const template = allTemplates.find(
            (t) => t.key === row.templateKey && t.locale === row.locale,
          );
          return (
            <Card
              key={row.id}
              data-testid={`my-letter-row-${row.id}`}
              className="p-4"
            >
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
                    Requested {formatDateOnly(row.createdAt)}
                    {row.addressedTo ? ` · to ${row.addressedTo}` : ''}
                    {row.serialNumber ? ` · ref ${row.serialNumber}` : ''}
                  </p>
                  {row.status === 'PENDING' && (
                    <p className="mt-1 inline-flex items-center gap-1 text-xs text-status-warning">
                      <Clock className="h-3 w-3" aria-hidden />
                      Awaiting HR
                    </p>
                  )}
                  {row.rejectedReason && (
                    <p className="mt-1 text-xs italic text-status-error">
                      Rejected: {row.rejectedReason}
                    </p>
                  )}
                </div>

                {row.status === 'ISSUED' && row.documentId && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void download(
                        row.documentId!,
                        `${row.serialNumber ?? row.templateKey}.html`,
                      )
                    }
                    aria-label={`Download ${template?.name ?? row.templateKey}`}
                    data-testid={`my-letter-download-${row.id}`}
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
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export default function MyLettersPage() {
  return (
    <ProtectedRoute>
      <MyLettersScreen />
    </ProtectedRoute>
  );
}
