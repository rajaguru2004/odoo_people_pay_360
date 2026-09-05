'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Plus, Clock, CheckCircle2, XCircle, AlertCircle, FileText, RefreshCw } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import DataCard from '@/components/common/DataCard';
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import { formatWallClockDate } from '@/utils/formatters';
import { useAuthStore } from '@/store/authStore';
import timesheetService, { Timesheet } from '@/services/timesheetService';
import { TimesheetStatusBadge } from '@/components/timesheets/TimesheetStatusBadge';

export default function TimesheetsPage() {
  const router = useRouter();
  const { can } = usePermission();
  const { user } = useAuthStore();

  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [pending, setPending] = useState<Timesheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [activeView, setActiveView] = useState<'all' | 'pending'>('all');

  const isManager = ['ADMIN', 'HR_MANAGER', 'MANAGER'].includes(user?.role || '');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Timesheets', isManager ? 'Team timesheets' : 'Your timesheets');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [tsRes, pendingRes] = await Promise.all([
        isManager
          ? timesheetService.getAll({ status: statusFilter || undefined })
          : timesheetService.getMine({ status: statusFilter || undefined }),
        isManager ? timesheetService.getPending() : Promise.resolve({ data: [] }),
      ]) as [any, any];
      setTimesheets(tsRes.data || []);
      setPending(pendingRes.data || []);
    } finally {
      setLoading(false);
    }
  }, [isManager, statusFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleApprove = async (id: string) => {
    await timesheetService.approve(id);
    fetchData();
  };

  const handleReject = async (id: string) => {
    const reason = prompt('Rejection reason:');
    if (reason === null) return;
    await timesheetService.reject(id, reason);
    fetchData();
  };

  const displayed = activeView === 'pending' ? pending : timesheets;

  /**
   * The row's actions, defined once.
   *
   * The desktop table and the phone card list both render these, and they are
   * role- and status-conditional — two copies would drift the moment one of
   * those rules changes.
   */
  const RowActions = ({ ts }: { ts: Timesheet }) => (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => router.push(`/dashboard/timesheets/${ts.id}`)}
        className="text-xs font-semibold text-text-body border border-surface-border bg-surface-card hover:bg-surface-page rounded-[--radius-button] px-3 py-2.5 md:py-1.5 transition-all shadow-xs cursor-pointer touch-manipulation"
      >
        View
      </button>
      {isManager && ts.status === 'SUBMITTED' && (
        <>
          <button onClick={() => handleApprove(ts.id)} className="text-xs font-semibold text-status-success border border-status-success/30 bg-status-success-bg/40 hover:bg-status-success-bg/85 rounded-[--radius-button] px-3 py-2.5 md:py-1.5 transition-all cursor-pointer touch-manipulation">Approve</button>
          <button onClick={() => handleReject(ts.id)} className="text-xs font-semibold text-status-error border border-status-error/30 bg-status-error-bg/40 hover:bg-status-error-bg/85 rounded-[--radius-button] px-3 py-2.5 md:py-1.5 transition-all cursor-pointer touch-manipulation">Reject</button>
        </>
      )}
      {ts.status === 'DRAFT' && ts.employeeId === user?.employeeId && (
        <button
          onClick={async () => { await timesheetService.submit(ts.id); fetchData(); }}
          className="text-xs font-semibold text-brand-primary border border-brand-primary-light/40 bg-brand-primary-light/10 hover:bg-brand-primary-light/30 rounded-[--radius-button] px-3 py-2.5 md:py-1.5 transition-all cursor-pointer touch-manipulation"
        >
          Submit
        </button>
      )}
    </div>
  );

  return (
    <ProtectedRoute requiredPermission="VIEW_TIMESHEETS">
      <div className="space-y-6" data-testid="ess-timesheets">
        {/* Actions only — the title/subtitle live in the sticky TopHeader,
            declared via usePageHeader above. */}
        <PageActionRow
          action={
            <>
              <button onClick={fetchData} className="inline-flex min-w-11 md:min-w-0 items-center justify-center rounded-[--radius-button] border border-surface-border bg-surface-card p-2.5 text-text-body hover:bg-surface-page transition-all shadow-sm cursor-pointer touch-manipulation">
                <RefreshCw className="h-4 w-4" />
              </button>
              {can('CREATE_TIMESHEET') && (
                <motion.button
                  whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                  onClick={() => router.push('/dashboard/timesheets/new')}
                  className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary hover:bg-brand-primary-dark px-5 py-2.5 text-sm font-semibold text-text-on-brand shadow-md transition-all cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  Log Time
                </motion.button>
              )}
            </>
          }
        />

        {/* View Toggle + Filters */}
        <div className="flex flex-wrap items-center gap-3">
          {isManager && (
            <div className="flex rounded-[--radius-button] border border-surface-border bg-surface-card overflow-hidden shadow-sm">
              {(['all', 'pending'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setActiveView(v)}
                  className={`px-4 py-2.5 text-sm font-semibold transition-all cursor-pointer ${activeView === v ? 'bg-brand-primary text-text-on-brand' : 'text-text-body hover:bg-surface-page'}`}
                >
                  {v === 'pending' ? `Pending Approval (${pending.length})` : 'All'}
                </button>
              ))}
            </div>
          )}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-[--radius-input] border border-surface-border bg-surface-card px-4 py-2.5 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all shadow-sm"
          >
            <option value="">All Statuses</option>
            {['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Table */}
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-10 w-10 rounded-full border-2 border-brand-primary border-t-transparent animate-spin" />
          </div>
        ) : displayed.length === 0 ? (
          <div className="bg-surface-card border border-surface-border rounded-[--radius-card] p-16 text-center">
            <FileText className="h-12 w-12 text-text-muted mx-auto mb-4" />
            <p className="text-text-muted">No timesheets found</p>
          </div>
        ) : (
          /* The six-column table had no scroll wrapper at all, so at 390px it
             simply ran off the side of the page and took the layout with it.
             Scrolling inside its own box is the minimum honest fix; a card
             reflow is recorded as follow-up in docs/ESS-MOBILE-UI-TRACKER.md. */
          <div className="bg-surface-card border border-surface-border rounded-[--radius-card] overflow-x-auto shadow-sm">
            <table className="hidden w-full md:table">
              <thead>
                <tr className="border-b border-surface-border bg-surface-page">
                  {['Employee', 'Date', 'Hours', 'Task', 'Status', 'Actions'].map((h) => (
                    <th key={h} className="px-4 py-3.5 text-left text-xs font-bold text-text-muted uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayed.map((ts, i) => (
                  <motion.tr
                    key={ts.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.03 }}
                    className="border-b border-surface-border-light hover:bg-surface-page/50 transition-colors"
                  >
                    <td className="px-4 py-4">
                      <div>
                        <p className="text-sm font-bold text-text-heading">{ts.employee?.fullName || '—'}</p>
                        <p className="text-xs text-text-muted">{ts.employee?.department?.name}</p>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm text-text-body">{formatWallClockDate(ts.workDate)}</td>
                    <td className="px-4 py-4 text-sm font-mono font-bold text-status-success">{ts.hoursWorked}h</td>
                    <td className="px-4 py-4 text-xs text-text-muted font-semibold">{ts.task ? `[${ts.task.taskCode}] ${ts.task.title}` : '—'}</td>
                    <td className="px-4 py-4">
                      <TimesheetStatusBadge status={ts.status} size="sm" />
                    </td>
                    <td className="px-4 py-4">
                      <RowActions ts={ts} />
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>

            {/* Mobile cards — D-15. */}
            <div className="md:hidden p-4 space-y-3">
              {displayed.map((ts) => (
                <DataCard
                  key={`m-${ts.id}`}
                  testId="timesheet-card"
                  title={
                    <span className="flex flex-col">
                      <span>{ts.employee?.fullName || '—'}</span>
                      <span className="text-xs font-normal text-text-muted">
                        {ts.employee?.department?.name}
                      </span>
                    </span>
                  }
                  headerRight={<TimesheetStatusBadge status={ts.status} size="sm" />}
                  items={[
                    { label: 'Date', value: formatWallClockDate(ts.workDate) },
                    {
                      label: 'Hours',
                      value: <span className="font-mono font-bold text-status-success">{ts.hoursWorked}h</span>,
                    },
                    { label: 'Task', full: true, value: ts.task ? `[${ts.task.taskCode}] ${ts.task.title}` : '—' },
                  ]}
                  footer={<RowActions ts={ts} />}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </ProtectedRoute>
  );
}
