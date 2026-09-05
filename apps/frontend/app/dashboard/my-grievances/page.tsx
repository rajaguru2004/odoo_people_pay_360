'use client';

import { useState } from 'react';
import { Ban, Lock, MessageSquareWarning, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/common/EmptyState';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useGrievances,
  useRaiseGrievance,
  useWithdrawGrievance,
} from '@/hooks/useGrievances';
import { useLibraryItems } from '@/hooks/useLibraryItems';
import { useEmployees } from '@/hooks/useEmployees';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDate } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type { CreateGrievanceData, GrievanceStatus } from '@/types/grievance';

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

/** The statuses a complainant may still take a case back from. */
const WITHDRAWABLE = ['OPEN', 'ACKNOWLEDGED'];

const EMPTY_FORM: CreateGrievanceData = {
  category: '',
  subject: '',
  description: '',
};

function MyGrievancesScreen() {
  const { data, isLoading, isError, error } = useGrievances();
  const categories = useLibraryItems({ type: 'GRIEVANCE_CATEGORY', activeOnly: true });
  const people = useEmployees({ status: 'ACTIVE', limit: 200, sortBy: 'firstName' });
  const raise = useRaiseGrievance();
  const withdraw = useWithdrawGrievance();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateGrievanceData>(EMPTY_FORM);

  const rows = data?.data ?? [];

  usePageHeader('My grievances', 'Raise a concern and follow how it is handled');

  const submit = async () => {
    if (!form.category || !form.subject.trim() || !form.description.trim()) {
      toast.warning('A category, a subject and a description are all needed');
      return;
    }
    try {
      await raise.mutateAsync({
        ...form,
        subject: form.subject.trim(),
        description: form.description.trim(),
      });
      toast.success('Raised. HR will pick it up.');
      setShowForm(false);
      setForm(EMPTY_FORM);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not raise that grievance.'));
    }
  };

  const takeBack = async (id: string) => {
    try {
      await withdraw.mutateAsync(id);
      toast.success('Withdrawn');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not withdraw that grievance.'));
    }
  };

  return (
    <div className="space-y-5" data-testid="ess-my-grievances">
      <div className="flex justify-end">
        <Button
          onClick={() => setShowForm((open) => !open)}
          data-testid="grievance-open-form"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Raise a grievance
        </Button>
      </div>

      {showForm && (
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-heading">
              New grievance
            </h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              aria-label="Close the grievance form"
              className="text-text-muted hover:text-text-body"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Select
              label="Category"
              placeholder="Choose a category…"
              value={form.category}
              onChange={(event) =>
                setForm({ ...form, category: event.target.value })
              }
              data-testid="grievance-category"
            >
              {(categories.data?.data ?? []).map((item) => (
                <option key={item.id} value={item.label}>
                  {item.label}
                </option>
              ))}
            </Select>
            <Select
              label="Is this about a particular person?"
              placeholder="No — it is not about one person"
              value={form.againstEmployeeId ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  againstEmployeeId: event.target.value || undefined,
                })
              }
              data-testid="grievance-against"
            >
              {(people.data?.data ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {fullName(person)} ({person.employeeCode})
                </option>
              ))}
            </Select>
            <div className="md:col-span-2">
              <Input
                label="Subject"
                placeholder="A line that says what this is about"
                value={form.subject}
                onChange={(event) =>
                  setForm({ ...form, subject: event.target.value })
                }
                data-testid="grievance-subject"
              />
            </div>
            <div className="md:col-span-2">
              <Textarea
                label="What happened?"
                rows={5}
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                data-testid="grievance-description"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-text-body md:col-span-2">
              <input
                type="checkbox"
                className="h-4 w-4 rounded-sm border-surface-border accent-brand-primary"
                checked={form.isConfidential ?? false}
                onChange={(event) =>
                  setForm({ ...form, isConfidential: event.target.checked })
                }
              />
              Handle this confidentially
            </label>
          </div>

          <p className="mt-3 text-xs text-text-muted">
            If you name a person, they can never see this grievance — whatever
            their role.
          </p>

          <div className="mt-4 flex justify-end">
            <Button
              onClick={() => void submit()}
              isLoading={raise.isPending}
              data-testid="grievance-submit"
            >
              Submit
            </Button>
          </div>
        </Card>
      )}

      {isLoading && (
        <Card className="p-6">
          <p className="text-sm text-text-muted">Loading your grievances…</p>
        </Card>
      )}

      {isError && (
        <Card className="p-6">
          <p className="text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load your grievances.')}
          </p>
        </Card>
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<MessageSquareWarning className="h-6 w-6" aria-hidden />}
            title="Nothing raised"
            description="A grievance you raise goes to HR with a trail of what is done about it, and you can follow it here."
          />
        </Card>
      )}

      <div className="space-y-3">
        {rows.map((row) => (
          <Card
            key={row.id}
            className="p-4"
            data-testid={`my-grievance-row-${row.id}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <MessageSquareWarning
                    className="h-4 w-4 text-brand-primary"
                    aria-hidden
                  />
                  <p className="text-sm font-semibold text-text-heading">
                    {row.subject}
                  </p>
                  <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                  {row.isConfidential && (
                    <Badge>
                      <Lock className="me-1 h-3 w-3" aria-hidden />
                      Confidential
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  {row.category} · raised {formatDate(row.createdAt)}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-text-body">
                  {row.description}
                </p>
                {row.resolution && (
                  <p className="mt-2 rounded-[var(--radius-input)] bg-status-success-bg px-3 py-2 text-sm text-status-success">
                    <span className="font-semibold">Resolution:</span>{' '}
                    {row.resolution}
                  </p>
                )}
              </div>

              {WITHDRAWABLE.includes(row.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void takeBack(row.id)}
                  isLoading={withdraw.isPending}
                  aria-label={`Withdraw ${row.subject}`}
                  data-testid={`grievance-withdraw-${row.id}`}
                >
                  <Ban className="h-4 w-4" aria-hidden />
                  Withdraw
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function MyGrievancesPage() {
  return (
    <ProtectedRoute>
      <MyGrievancesScreen />
    </ProtectedRoute>
  );
}
