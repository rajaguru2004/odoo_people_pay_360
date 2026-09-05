'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  IdCard,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { StatCard } from '@/components/common/StatCard';
import { useDebounce } from '@/hooks/useDebounce';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useCancelVisa, useRenewVisa, useVisaSummary, useVisas } from '@/hooks/useVisas';
import { apiErrorMessage } from '@/utils/apiError';
import { expiryLabel, expiryTone } from '@/utils/contractExpiry';
import { formatDateOnly } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type {
  LegalDocument,
  LegalDocumentListQuery,
  LegalDocumentStatus,
} from '@/types/legalDocument';

const STATUS_TONE: Record<LegalDocumentStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
  ACTIVE: 'success',
  EXPIRED: 'error',
  RENEWED: 'neutral',
  CANCELLED: 'neutral',
};

const STATUS_OPTIONS: LegalDocumentStatus[] = ['ACTIVE', 'EXPIRED', 'RENEWED', 'CANCELLED'];

/** The windows a compliance officer actually works to. */
const EXPIRY_WINDOWS = [7, 15, 30, 60, 90];

const PAGE_SIZE = 20;

function humanise(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

/**
 * Renewal, which creates a SUCCESSOR rather than editing the permit in place.
 *
 * The old document stays on file pointing at the new one. A permit's history is
 * what an audit asks for, and overwriting the dates would leave the record
 * saying the person was always compliant.
 */
function RenewDialog({
  permit,
  busy,
  onConfirm,
  onCancel,
}: {
  permit: LegalDocument;
  busy: boolean;
  onConfirm: (values: { documentNumber: string; issueDate: string; expiryDate: string }) => void;
  onCancel: () => void;
}) {
  const [documentNumber, setDocumentNumber] = useState(permit.documentNumber);
  const [issueDate, setIssueDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');

  const invalid = !issueDate || !expiryDate || expiryDate <= issueDate;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="renew-permit-title"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-[var(--radius-card)] bg-surface-overlay p-6 shadow-2xl">
        <h2 id="renew-permit-title" className="text-lg font-semibold text-text-heading">
          Renew this permit
        </h2>
        <p className="mt-2 text-sm text-text-muted">
          {permit.documentNumber} stays on file as history and the new document takes its place as
          the current one.
        </p>

        <div className="mt-4 space-y-4">
          <Input
            label="New document number"
            value={documentNumber}
            onChange={(event) => setDocumentNumber(event.target.value)}
          />
          <Input
            type="date"
            label="New issue date"
            value={issueDate}
            onChange={(event) => setIssueDate(event.target.value)}
          />
          <Input
            type="date"
            label="New expiry date"
            value={expiryDate}
            onChange={(event) => setExpiryDate(event.target.value)}
            error={
              issueDate && expiryDate && expiryDate <= issueDate
                ? 'The expiry has to fall after the issue date'
                : undefined
            }
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            isLoading={busy}
            disabled={invalid || !documentNumber.trim()}
            onClick={() => onConfirm({ documentNumber: documentNumber.trim(), issueDate, expiryDate })}
          >
            Record the renewal
          </Button>
        </div>
      </div>
    </div>
  );
}

function VisaReports() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [expiringWithin, setExpiringWithin] = useState('');
  const [page, setPage] = useState(1);
  const [renewing, setRenewing] = useState<LegalDocument | null>(null);
  const [cancelling, setCancelling] = useState<LegalDocument | null>(null);

  const debouncedSearch = useDebounce(search, 300);

  // Narrowing the list resets the page in the same handler. Left to an effect,
  // the reader sees page 4 of the shorter result — an empty table that reads as
  // "no matches" — before it corrects itself.
  const narrow = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const query = useMemo<LegalDocumentListQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      search: debouncedSearch || undefined,
      status: (status || undefined) as LegalDocumentStatus | undefined,
      expiringWithinDays: expiringWithin ? Number(expiringWithin) : undefined,
    }),
    [page, debouncedSearch, status, expiringWithin],
  );

  const { data, isLoading, isError } = useVisas(query);
  const summaryQuery = useVisaSummary();
  const renewVisa = useRenewVisa();
  const cancelVisa = useCancelVisa();

  const permits = data?.data ?? [];
  const summary = summaryQuery.data?.data;
  const total = data?.meta?.total;

  usePageHeader(
    'Visa reports',
    total === undefined ? undefined : `${total} permit${total === 1 ? '' : 's'}`,
  );

  const filtered = Boolean(debouncedSearch || status || expiringWithin);

  const handleRenew = async (values: {
    documentNumber: string;
    issueDate: string;
    expiryDate: string;
  }) => {
    if (!renewing) return;
    try {
      await renewVisa.mutateAsync({ id: renewing.id, payload: values });
      toast.success('Renewal recorded');
      setRenewing(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not record that renewal'));
    }
  };

  const handleCancel = async () => {
    if (!cancelling) return;
    try {
      await cancelVisa.mutateAsync(cancelling.id);
      toast.success('Permit cancelled');
      setCancelling(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not cancel that permit'));
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="In date"
          value={summary ? summary.active : '—'}
          hint="Current permits with time left"
          icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
        />
        {/* The window is stated, not implied. "Expiring soon" with no horizon is
            not a fact anybody can act on, and the horizon is a company setting
            the server owns. */}
        <StatCard
          label="Expiring soon"
          value={summary ? summary.expiringSoon : '—'}
          hint={summary ? `Within the next ${summary.alertDays} days` : 'Window not known'}
          icon={<AlertTriangle className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Expired"
          value={summary ? summary.expired : '—'}
          hint="Past their expiry date"
          icon={<XCircle className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Renewed this year"
          value={summary ? summary.renewedThisYear : '—'}
          hint="Successors issued since January"
          icon={<RefreshCw className="h-5 w-5" aria-hidden />}
        />
      </div>

      {summary && (
        <p className="text-sm text-text-muted">
          Alerts start {summary.alertDays} days before a permit expires. Change the window in
          system settings.
        </p>
      )}

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="xl:col-span-2">
            <Input
              value={search}
              onChange={(event) => narrow(() => setSearch(event.target.value))}
              aria-label="Search permits"
              placeholder="Permit number, employee code or name"
              icon={<Search className="h-4 w-4" aria-hidden />}
            />
          </div>
          <Select
            aria-label="Filter by permit status"
            placeholder="Every status"
            value={status}
            onChange={(event) => narrow(() => setStatus(event.target.value))}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by how soon it expires"
            placeholder="Any expiry date"
            value={expiringWithin}
            onChange={(event) => narrow(() => setExpiringWithin(event.target.value))}
          >
            {EXPIRY_WINDOWS.map((days) => (
              <option key={days} value={days}>
                Expiring within {days} days
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card>
        {isLoading && <p className="p-6 text-sm text-text-muted">Loading permits…</p>}

        {isError && (
          // Never an empty table with a reassuring caption: a request that did
          // not answer says nothing about who is compliant.
          <p className="p-6 text-sm text-status-error">
            Could not load permits. Nothing here should be read as an all-clear.
          </p>
        )}

        {!isLoading && !isError && permits.length === 0 && (
          <EmptyState
            icon={<IdCard className="h-6 w-6" aria-hidden />}
            title={filtered ? 'No matches' : 'No permits on file'}
            description={
              filtered
                ? 'Nothing matches that search. Try a wider window or a different status.'
                : 'Permits are recorded against an employee record.'
            }
          />
        )}

        {permits.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-sm">
              <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Employee</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Number</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Type</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Country</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Issued</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Expires</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Remaining</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Status</th>
                  <th scope="col" className="px-5 py-3 text-end font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border-light">
                {permits.map((permit) => {
                  const tone = expiryTone(permit.daysUntilExpiry, summary?.alertDays);

                  return (
                    <tr key={permit.id} className="hover:bg-surface-border-light/60">
                      <td className="px-5 py-3">
                        <Link
                          href={`/dashboard/employees/${permit.employeeId}`}
                          className="font-medium text-brand-primary hover:underline"
                        >
                          {fullName(permit.employee)}
                        </Link>
                        <p className="mt-0.5 text-xs text-text-muted">
                          {[permit.employee?.employeeCode, permit.employee?.department?.name]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </td>
                      <td className="px-5 py-3 font-medium text-text-heading">
                        {permit.documentNumber}
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {permit.documentType ?? humanise(permit.category)}
                      </td>
                      <td className="px-5 py-3 text-text-body">{permit.country}</td>
                      <td className="px-5 py-3 text-text-body">
                        {formatDateOnly(permit.issueDate)}
                      </td>
                      <td className="px-5 py-3 text-text-body">
                        {formatDateOnly(permit.expiryDate)}
                      </td>
                      <td className="px-5 py-3">
                        {permit.status === 'ACTIVE' ? (
                          <span
                            className={
                              tone === 'error'
                                ? 'font-semibold text-status-error'
                                : tone === 'warning'
                                  ? 'font-semibold text-status-warning'
                                  : 'text-text-body'
                            }
                          >
                            {expiryLabel(permit.daysUntilExpiry)}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={STATUS_TONE[permit.status]}>{humanise(permit.status)}</Badge>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {permit.status === 'ACTIVE' || permit.status === 'EXPIRED' ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                aria-label={`Renew permit ${permit.documentNumber}`}
                                onClick={() => setRenewing(permit)}
                              >
                                Renew
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Cancel permit ${permit.documentNumber}`}
                                onClick={() => setCancelling(permit)}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <span className="text-xs text-text-muted">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination meta={data?.meta} onPageChange={setPage} />
      </Card>

      {renewing && (
        <RenewDialog
          permit={renewing}
          busy={renewVisa.isPending}
          onConfirm={handleRenew}
          onCancel={() => setRenewing(null)}
        />
      )}

      {cancelling && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="cancel-permit-title"
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-[var(--radius-card)] bg-surface-overlay p-6 shadow-2xl">
            <h2 id="cancel-permit-title" className="text-lg font-semibold text-text-heading">
              Cancel this permit?
            </h2>
            <p className="mt-3 text-sm text-text-body">
              {cancelling.documentNumber} stops counting towards compliance and{' '}
              {fullName(cancelling.employee)} is left with no current permit of this kind. The
              record stays on file.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setCancelling(null)}
                disabled={cancelVisa.isPending}
              >
                Keep it
              </Button>
              <Button variant="danger" isLoading={cancelVisa.isPending} onClick={handleCancel}>
                Cancel the permit
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VisaReportsPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <VisaReports />
    </ProtectedRoute>
  );
}
