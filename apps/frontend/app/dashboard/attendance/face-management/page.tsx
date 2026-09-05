'use client';

import { useMemo, useState } from 'react';
import { CheckCircle, Eye, Search, Users, XCircle } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useEmployees } from '@/hooks/useEmployees';
import { useFaceEnrollmentCounts } from '@/hooks/useFaceEnrollments';
import { FaceRegistration } from '@/components/face-recognition';
import { Card } from '@/components/ui/Card';
import { StatCard } from '@/components/common/StatCard';
import { EmptyState } from '@/components/common/EmptyState';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fullName } from '@/utils/formatters';
import { resolveFileUrl } from '@/utils/fileUrl';
import type { Employee } from '@/types/employee';

const PAGE_SIZE = 20;

/** Initials, for the rows where nobody has uploaded a photograph. */
function initialsOf(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function Enrolment() {
  const [selected, setSelected] = useState<Employee | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  usePageHeader(
    'Biometric enrolment',
    'Register the faces the attendance terminals match against',
  );

  const employees = useEmployees({ limit: 200, sortBy: 'firstName' });
  const countsQuery = useFaceEnrollmentCounts();

  const rows = employees.data?.data ?? [];
  const countsData = countsQuery.data?.data;

  // Counted in the DATABASE and looked up by id, so a row says how many
  // templates that person actually holds rather than how many happened to fit
  // on a page of the enrolment list.
  const counts = useMemo(
    () => new Map((countsData?.counts ?? []).map((row) => [row.employeeId, row.count])),
    [countsData],
  );
  const maxAllowed = countsData?.maxAllowed ?? 5;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (employee) =>
        fullName(employee).toLowerCase().includes(needle) ||
        employee.employeeCode.toLowerCase().includes(needle),
    );
  }, [rows, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const registered = rows.filter((employee) => (counts.get(employee.id) ?? 0) > 0).length;

  if (selected) {
    const name = fullName(selected);
    return (
      <div className="space-y-4">
        <button
          type="button"
          data-testid="bio-back"
          onClick={() => setSelected(null)}
          className="inline-flex items-center gap-2 text-sm text-text-body hover:text-text-heading"
        >
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
          Back to the list
        </button>

        <Card className="p-5">
          <div className="mb-6 flex items-center gap-4">
            {resolveFileUrl(selected.avatarUrl) ? (
              <img
                src={resolveFileUrl(selected.avatarUrl)!}
                alt=""
                className="h-14 w-14 rounded-full object-cover"
              />
            ) : (
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-primary/10 text-sm font-semibold text-brand-primary">
                {initialsOf(name)}
              </span>
            )}
            <div>
              <h2 className="text-lg font-semibold text-text-heading">{name}</h2>
              <p className="text-sm text-text-muted">
                {selected.employeeCode} • {selected.department?.name ?? 'No department'}
              </p>
            </div>
          </div>

          <FaceRegistration employeeId={selected.id} employeeName={name} />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Employees"
          value={rows.length}
          icon={<Users className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Enrolled"
          value={registered}
          icon={<CheckCircle className="h-5 w-5 text-status-success" aria-hidden />}
          hint="Holding at least one capture"
        />
        <StatCard
          label="Not enrolled"
          value={rows.length - registered}
          icon={<XCircle className="h-5 w-5 text-status-warning" aria-hidden />}
          hint="Cannot punch at a terminal yet"
        />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-surface-border p-4">
          <div className="relative">
            <Search
              className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
              aria-hidden
            />
            <input
              data-testid="bio-search"
              type="search"
              aria-label="Search by name or code"
              placeholder="Search by name or code"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card py-2 pe-4 ps-10 text-sm text-text-body focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
            />
          </div>
        </div>

        {employees.isLoading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary border-t-transparent" />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            title="Nobody matches that search"
            description="Clear the search to see everybody who can be enrolled."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-surface-page">
                  <tr>
                    <th className="px-6 py-3 text-start text-xs font-semibold uppercase text-text-muted">
                      Employee
                    </th>
                    <th className="px-6 py-3 text-start text-xs font-semibold uppercase text-text-muted">
                      Code
                    </th>
                    <th className="px-6 py-3 text-start text-xs font-semibold uppercase text-text-muted">
                      Department
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-semibold uppercase text-text-muted">
                      Status
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-semibold uppercase text-text-muted">
                      Captures
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-semibold uppercase text-text-muted">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border-light">
                  {visible.map((employee) => {
                    const name = fullName(employee);
                    const count = counts.get(employee.id) ?? 0;
                    const isEnrolled = count > 0;
                    return (
                      <tr
                        key={employee.id}
                        data-testid={`bio-row-${employee.employeeCode}`}
                        data-employee-id={employee.id}
                        data-enrolled={isEnrolled}
                        data-face-count={count}
                        className="transition-colors hover:bg-surface-page/50"
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            {resolveFileUrl(employee.avatarUrl) ? (
                              <img
                                src={resolveFileUrl(employee.avatarUrl)!}
                                alt=""
                                className="h-8 w-8 rounded-full object-cover"
                              />
                            ) : (
                              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-primary">
                                {initialsOf(name)}
                              </span>
                            )}
                            <span className="font-semibold text-text-heading">{name}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 font-mono text-sm text-text-body">
                          {employee.employeeCode}
                        </td>
                        <td className="px-6 py-4 text-sm text-text-body">
                          {employee.department?.name ?? '—'}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                              isEnrolled
                                ? 'bg-status-success-bg/40 text-status-success'
                                : 'bg-status-warning-bg/40 text-status-warning'
                            }`}
                          >
                            {isEnrolled ? 'Enrolled' : 'Not enrolled'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center text-sm">
                          <span
                            className={`font-semibold tabular-nums ${
                              isEnrolled ? 'text-status-success' : 'text-text-muted'
                            }`}
                          >
                            {count}/{maxAllowed}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <button
                            type="button"
                            data-testid={`bio-open-${employee.employeeCode}`}
                            onClick={() => setSelected(employee)}
                            className="inline-flex items-center gap-1 rounded-[var(--radius-button)] bg-brand-primary/10 px-3 py-1.5 text-sm font-semibold text-brand-primary transition-colors hover:bg-brand-primary/20"
                          >
                            <Eye className="h-3.5 w-3.5" aria-hidden />
                            {isEnrolled ? 'View or edit' : 'Register'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-surface-border px-6 py-3">
                <p className="text-sm text-text-muted">
                  {(current - 1) * PAGE_SIZE + 1}–
                  {Math.min(current * PAGE_SIZE, filtered.length)} of {filtered.length}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    aria-label="Previous page"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={current === 1}
                    className="rounded-[var(--radius-button)] border border-surface-border p-1.5 hover:bg-surface-page disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label="Next page"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={current === totalPages}
                    className="rounded-[var(--radius-button)] border border-surface-border p-1.5 hover:bg-surface-page disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

export default function FaceManagementPage() {
  return (
    <ProtectedRoute>
      <Enrolment />
    </ProtectedRoute>
  );
}
